/**
 * The transcript, kept on the phone.
 *
 * Without this, reopening a conversation starts from a blank screen and waits
 * on `GET /history` — the only place the message rows existed was the chat
 * screen's own state, which unmounting destroyed. The cache inverts the wait:
 * the last drawn rows come back first (memory across remounts, IndexedDB
 * across cold starts) and the history read, when it lands, stays the authority
 * that corrects them.
 *
 * The cache is an accelerator, never a source of truth. A kernel that rewrote
 * the conversation — rewind, compaction, work done on another device — makes
 * any local copy stale, so the read always runs and overwrites what was shown.
 * The OS clearing WebView storage costs speed, not correctness: every failure
 * here resolves to "nothing cached" and the screen falls back to the read.
 *
 * ## Why entries carry two keys
 *
 * A pane id (`runtimeId`) is minted by the kernel on every `POST /runtimes`,
 * so it changes each time the same conversation is opened again — the one case
 * a cold-start cache exists for. A `sessionPath` names the stored transcript
 * and survives reopen, which is why the reading position and the draft store
 * already key on it.
 *
 * Neither key is available at every moment: `sessionPath` only arrives with
 * the runtime list, and a brand-new conversation has no stored transcript at
 * all. So an entry is written under every key the caller knows and read back
 * under whichever key it has, which is what keeps the two paths from missing
 * each other.
 *
 * ## Why there are two stores
 *
 * The `transcripts` store holds the rows. The `meta` store holds the same
 * entry's shape — keys, row count, byte size — and no content. Statistics and
 * eviction read `meta` only: `getAll()` on the content store deserializes
 * every row of every conversation, and at the size limits below that is
 * hundreds of megabytes on a phone that only wanted to know how much space it
 * is using.
 *
 * The two stores are always written in one transaction, so a crash can never
 * leave a meta record pointing at rows that were never saved.
 */

import { loadRetainTranscript } from "../app/retainPref";
import type { Row } from "./transcript";

/**
 * Rows kept per conversation. Raised from 400 because an entry is now reached
 * by two keys: a conversation opened on a cold start has to repaint from the
 * copy the previous pane wrote, and 400 rows covered roughly one long turn.
 */
const MAX_ROWS = 800;
/** A serialized entry above this is skipped: writing it would stall more than it saves. */
const MAX_ENTRY_CHARS = 2_500_000;
/** Entries kept at all; the oldest are pruned whenever a write happens. */
const MAX_ENTRIES = 60;
/** Content budget across every entry, in UTF-8 bytes. */
const MAX_TOTAL_BYTES = 64_000_000;
/** Writes coalesce: a streaming turn replaces the rows many times a second. */
const WRITE_DELAY_MS = 800;

const DB_NAME = "reasonix.cache";
const DB_VERSION = 2;
const TRANSCRIPTS = "transcripts";
const META = "meta";
/** Marks a finished migration; it carries no ids, so readers skip it. */
const META_MARKER = "__reasonix.cache.meta.v2";

interface Entry {
  /** Every key this entry is filed under; pruning reads them in one call. */
  ids: string[];
  rows: Row[];
  savedAt: number;
}

/** What an entry looks like without its content. */
interface EntryMeta {
  ids: string[];
  rows: number;
  bytes: number;
  savedAt: number;
}

/** The keys a conversation can be reached by. Empty strings are dropped. */
export type CacheKeys = readonly (string | undefined)[];

export interface CacheStats {
  /** Conversations, not keys: one entry reached by two keys counts once. */
  entries: number;
  rows: number;
  bytes: number;
}

function usableKeys(keys: CacheKeys): string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    const trimmed = key?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * L1: this app process. A remounted chat screen reads it, which is the case
 * that matters — backing out of a conversation and going straight back in.
 */
const memory = new Map<string, Entry>();
/** Rows written since the last flush, so coalesced timers save the newest. */
const pending = new Map<string, Row[]>();
const timers = new Map<string, number>();
/**
 * Bumped by a clear. A flush that started before it must not write after it:
 * the person asked for the content to be gone, and a timer that was already
 * in flight would put it back.
 */
let epoch = 0;

/**
 * L2: opened once. A WebView without IndexedDB, or one that refuses the open
 * (private mode, eviction), loses only the cold-start layer.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;
/** The one-time migration into `meta`; every disk read waits on it. */
let ready: Promise<void> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise === null) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") {
          resolve(null);
          return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(TRANSCRIPTS)) db.createObjectStore(TRANSCRIPTS);
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    })
      .then((db) => {
        if (db !== null) ready = ensureMeta(db).catch(() => {});
        return db;
      })
      .catch(() => null);
  }
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("indexeddb request failed"));
  });
}

/** UTF-8 bytes, the unit the size budget is stated in. */
function byteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

/**
 * Fill `meta` from an older database, once.
 *
 * The marker makes this idempotent: every write is an overwrite and every
 * delete is a no-op when the key is gone, so a run that dies halfway is
 * finished by the next one instead of being skipped. A cursor reads one entry
 * at a time — `getAll()` here would deserialize the whole cache to build a
 * summary of it.
 */
async function ensureMeta(db: IDBDatabase): Promise<void> {
  try {
    const marker = await requestResult(
      db.transaction(META, "readonly").objectStore(META).get(META_MARKER),
    );
    if (marker) return;
  } catch {
    return;
  }

  const winners = new Map<string, EntryMeta>();
  const losers: string[][] = [];
  await new Promise<void>((resolve) => {
    let request: IDBRequest<IDBCursorWithValue | null>;
    try {
      request = db.transaction(TRANSCRIPTS, "readonly").objectStore(TRANSCRIPTS).openCursor();
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const entry = cursor.value as Entry | undefined;
      if (entry && Array.isArray(entry.ids) && entry.ids.length > 0) {
        const primary = entry.ids[0];
        if (primary) {
          const rows = Array.isArray(entry.rows) ? entry.rows : [];
          const record: EntryMeta = {
            ids: entry.ids,
            rows: rows.length,
            bytes: byteLength(JSON.stringify(rows)),
            savedAt: typeof entry.savedAt === "number" ? entry.savedAt : 0,
          };
          const prior = winners.get(primary);
          if (!prior) {
            winners.set(primary, record);
          } else if (prior.savedAt < record.savedAt) {
            losers.push(prior.ids);
            winners.set(primary, record);
          } else {
            losers.push(record.ids);
          }
        }
      }
      cursor.continue();
    };
    request.onerror = () => resolve();
  });

  try {
    const tx = db.transaction([TRANSCRIPTS, META], "readwrite");
    const transcripts = tx.objectStore(TRANSCRIPTS);
    const meta = tx.objectStore(META);
    const winnerKeys = new Set<string>();
    for (const record of winners.values()) {
      for (const id of record.ids) winnerKeys.add(id);
    }
    for (const record of winners.values()) {
      for (const id of record.ids) meta.put(record, id);
    }
    // A superseded entry's own pane id is dead weight: the new pane has its
    // own, and nothing will ever ask for the old one again. A key the winner
    // also carries is the shared session path and must survive.
    for (const ids of losers) {
      for (const id of ids) {
        if (winnerKeys.has(id)) continue;
        transcripts.delete(id);
        meta.delete(id);
      }
    }
    meta.put({ migratedAt: Date.now() }, META_MARKER);
  } catch {
    // A failed migration costs one more scan next time, not correctness.
  }
}

/** Remember an entry under all its keys, so either path finds it later. */
function remember(entry: Entry): void {
  for (const id of entry.ids) memory.set(id, entry);
  // The disk prunes inside flushRows; without its counterpart here every
  // conversation ever opened stays pinned in this process for its whole
  // lifetime. Count entries, not map slots — an entry is filed under several
  // keys, so keying the cap on size would halve it silently — and drop the
  // oldest until the entry count fits, deleting every id each dropped one
  // carries.
  const unique = [...new Set(memory.values())].sort((a, b) => a.savedAt - b.savedAt);
  const excess = unique.length - MAX_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    const stale = unique[index];
    if (stale) forget(stale.ids);
  }
}

function forget(ids: readonly string[]): void {
  for (const id of ids) memory.delete(id);
}

/**
 * The rows last drawn for this conversation, or null.
 *
 * Any of the caller's keys may hit: memory first, then IndexedDB, and a disk
 * hit feeds memory under every key the entry carries so one read per
 * conversation ever reaches disk.
 */
export async function loadCachedRows(keys: CacheKeys): Promise<Row[] | null> {
  // The person asked for the content not to stay on this phone. A leftover
  // entry from before the switch must not be readable either.
  if (!loadRetainTranscript()) return null;
  const wanted = usableKeys(keys);
  if (wanted.length === 0) return null;
  for (const id of wanted) {
    const fresh = memory.get(id);
    if (fresh) return fresh.rows;
  }
  const db = await openDb();
  if (!db) return null;
  if (ready) await ready;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(TRANSCRIPTS, "readonly").objectStore(TRANSCRIPTS);
      let settled = false;
      const finish = (rows: Row[] | null, entry?: Entry) => {
        if (settled) return;
        settled = true;
        if (rows && entry) remember(entry);
        resolve(rows);
      };
      // The callbacks fire in later tasks — the reads were only dispatched in
      // this one — so "nothing hit" is knowable only once every key has
      // answered. Counting down is what keeps a miss from either hanging or
      // resolving before the disk had its say.
      let outstanding = wanted.length;
      const miss = () => {
        outstanding -= 1;
        if (outstanding === 0) finish(null);
      };
      for (const id of wanted) {
        const request = store.get(id);
        request.onsuccess = () => {
          const entry = request.result as Entry | undefined;
          const rows = entry && Array.isArray(entry.rows) && entry.rows.length > 0 ? entry.rows : null;
          if (rows && entry) {
            finish(rows, entry);
            return;
          }
          miss();
        };
        request.onerror = () => miss();
      }
    } catch {
      resolve(null);
    }
  });
}

/**
 * Schedule the newest rows for this conversation to be kept.
 *
 * Cheap by design: memory is updated on the spot (a reference, rows are
 * replaced immutably by the fold), the serialization and disk write happen
 * once per coalesced timer, and an oversized transcript is skipped rather
 * than written.
 */
export function scheduleSaveRows(keys: CacheKeys, rows: Row[]): void {
  if (!loadRetainTranscript()) return;
  if (rows.length === 0) return;
  const ids = usableKeys(keys);
  if (ids.length === 0) return;
  const kept = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  const entry: Entry = { ids, rows: kept, savedAt: Date.now() };
  // Coalesce under the first key; the flush re-reads the pending entry so the
  // newest rows win regardless of which key scheduled it.
  const primary = ids[0];
  if (primary === undefined) return;
  pending.set(primary, kept);
  remember(entry);
  if (timers.has(primary)) return;
  timers.set(
    primary,
    window.setTimeout(() => {
      timers.delete(primary);
      void flushRows(primary);
    }, WRITE_DELAY_MS),
  );
}

async function flushRows(primary: string): Promise<void> {
  const rows = pending.get(primary);
  pending.delete(primary);
  if (!rows || rows.length === 0) return;
  // The entry in memory carries every key; the pending map only knows the one
  // that scheduled the flush, so recover the rest from there.
  const known = memory.get(primary);
  const ids = known?.ids ?? [primary];
  const generation = epoch;
  const json = JSON.stringify(rows);
  if (json.length > MAX_ENTRY_CHARS) {
    forget(ids);
    dropCachedRows(ids);
    return;
  }
  const bytes = byteLength(json);
  const db = await openDb();
  if (!db) return;
  if (ready) await ready;
  // A clear landed while this write was waiting on the database. The person
  // asked for the content to be gone; writing it now would undo that.
  if (generation !== epoch) return;
  try {
    const savedAt = Date.now();
    const entry: Entry = { ids, rows, savedAt };
    const record: EntryMeta = { ids, rows: rows.length, bytes, savedAt };
    const tx = db.transaction([TRANSCRIPTS, META], "readwrite");
    const transcripts = tx.objectStore(TRANSCRIPTS);
    const meta = tx.objectStore(META);
    for (const id of ids) {
      transcripts.put(entry, id);
      meta.put(record, id);
    }
    // Prune from `meta`, inside the same transaction: the content store is
    // never read to decide what to throw away.
    const all = meta.getAll();
    all.onsuccess = () => {
      const records = ((all.result as EntryMeta[]) ?? []).filter(
        (candidate) => candidate && Array.isArray(candidate.ids) && candidate.ids.length > 0,
      );
      const byPrimary = new Map<string, EntryMeta>();
      for (const candidate of records) {
        const key = candidate.ids[0];
        if (!key) continue;
        const prior = byPrimary.get(key);
        if (!prior || prior.savedAt < candidate.savedAt) byPrimary.set(key, candidate);
      }
      const ordered = [...byPrimary.values()].sort((a, b) => a.savedAt - b.savedAt);
      const survivors: EntryMeta[] = [];
      let total = 0;
      for (let index = ordered.length - 1; index >= 0 && survivors.length < MAX_ENTRIES; index -= 1) {
        const candidate = ordered[index];
        if (!candidate) continue;
        if (survivors.length > 0 && total + candidate.bytes > MAX_TOTAL_BYTES) break;
        survivors.push(candidate);
        total += candidate.bytes;
      }
      const keep = new Set(survivors.map((candidate) => candidate.ids[0]));
      // The entry just written stays even when it is the oldest by timestamp:
      // dropping the conversation on screen would defeat the cache.
      keep.add(primary);
      const survivorKeys = new Set(survivors.flatMap((candidate) => candidate.ids));
      for (const candidate of ordered) {
        const key = candidate.ids[0];
        if (!key || keep.has(key)) continue;
        for (const id of candidate.ids) {
          if (survivorKeys.has(id)) continue;
          transcripts.delete(id);
          meta.delete(id);
        }
      }
    };
    // A failed or aborted transaction costs this one write, not correctness.
  } catch {
    // Ignore: the history read remains the source of truth.
  }
}

/**
 * What the cache currently holds, without reading a single row.
 *
 * `null` means IndexedDB is unavailable or the read failed — the settings
 * screen shows "unavailable" rather than a zero that would look like "empty".
 */
export async function cacheStats(): Promise<CacheStats | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    if (ready) await ready;
    const records = await requestResult<EntryMeta[]>(
      db.transaction(META, "readonly").objectStore(META).getAll(),
    );
    const byPrimary = new Map<string, EntryMeta>();
    for (const candidate of records ?? []) {
      if (!candidate || !Array.isArray(candidate.ids) || candidate.ids.length === 0) continue;
      const key = candidate.ids[0];
      if (!key) continue;
      const prior = byPrimary.get(key);
      if (!prior || prior.savedAt < candidate.savedAt) byPrimary.set(key, candidate);
    }
    let rows = 0;
    let bytes = 0;
    for (const candidate of byPrimary.values()) {
      rows += candidate.rows;
      bytes += candidate.bytes;
    }
    return { entries: byPrimary.size, rows, bytes };
  } catch {
    return null;
  }
}

/**
 * Forget every conversation.
 *
 * `epoch` is bumped first, so a flush that was already waiting on the database
 * sees it and writes nothing. The in-process state is cleared synchronously
 * for the same reason: a timer that fires after this call must find nothing to
 * write. Returns how many conversations were dropped, so the screen does not
 * have to ask again.
 */
export async function clearAllCachedRows(): Promise<{ entries: number }> {
  epoch += 1;
  memory.clear();
  pending.clear();
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
  const db = await openDb();
  if (!db) return { entries: 0 };
  try {
    if (ready) await ready;
    const tx = db.transaction([TRANSCRIPTS, META], "readwrite");
    const transcripts = tx.objectStore(TRANSCRIPTS);
    const meta = tx.objectStore(META);
    // The count and the clear happen in the request's own callback: a
    // `setTimeout(0)` here would race the IndexedDB task queue and report zero
    // conversations on a phone where the clear did run.
    const entries = await new Promise<number>((resolve) => {
      const all = meta.getAll();
      all.onsuccess = () => {
        const records = ((all.result as EntryMeta[]) ?? []).filter(
          (candidate) => candidate && Array.isArray(candidate.ids) && candidate.ids.length > 0,
        );
        const count = new Set(records.map((candidate) => candidate.ids[0])).size;
        transcripts.clear();
        meta.clear();
        resolve(count);
      };
      all.onerror = () => resolve(0);
    });
    return { entries };
  } catch {
    return { entries: 0 };
  }
}

/** Forget this conversation's copy — the caller has reason to distrust it. */
export function dropCachedRows(keys: CacheKeys): void {
  const ids = usableKeys(keys);
  if (ids.length === 0) return;
  forget(ids);
  for (const id of ids) {
    pending.delete(id);
    const timer = timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(id);
    }
  }
  void (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction([TRANSCRIPTS, META], "readwrite");
      for (const id of ids) {
        tx.objectStore(TRANSCRIPTS).delete(id);
        tx.objectStore(META).delete(id);
      }
    } catch {
      // Ignore: a leftover entry is stale data the next read corrects.
    }
  })();
}

/** Reset everything. Tests only: module state would otherwise leak between them. */
export function resetTranscriptCache(): void {
  epoch += 1;
  memory.clear();
  pending.clear();
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
}

/**
 * A launch that starts with retention off may have died before the previous
 * clear finished. Sweeping once at startup closes that window.
 */
if (typeof window !== "undefined" && !loadRetainTranscript()) {
  void clearAllCachedRows();
}
