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
 */

import type { Row } from "./transcript";

/**
 * Rows kept per conversation. Raised from 400 because an entry is now reached
 * by two keys: a conversation opened on a cold start has to repaint from the
 * copy the previous pane wrote, and 400 rows covered roughly one long turn.
 */
const MAX_ROWS = 800;
/** A serialized entry above this is skipped: writing it would stall more than it saves. */
const MAX_BYTES = 2_500_000;
/** Entries kept at all; the oldest are pruned whenever a write happens. */
const MAX_ENTRIES = 60;
/** Writes coalesce: a streaming turn replaces the rows many times a second. */
const WRITE_DELAY_MS = 800;

const DB_NAME = "reasonix.cache";
const DB_VERSION = 1;
const STORE = "transcripts";

interface Entry {
  /** Every key this entry is filed under; pruning reads them in one call. */
  ids: string[];
  rows: Row[];
  savedAt: number;
}

/** The keys a conversation can be reached by. Empty strings are dropped. */
export type CacheKeys = readonly (string | undefined)[];

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
 * L2: opened once. A WebView without IndexedDB, or one that refuses the open
 * (private mode, eviction), loses only the cold-start layer.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

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
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }).catch(() => null);
  }
  return dbPromise;
}

/** Remember an entry under all its keys, so either path finds it later. */
function remember(entry: Entry): void {
  for (const id of entry.ids) memory.set(id, entry);
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
  const wanted = usableKeys(keys);
  if (wanted.length === 0) return null;
  for (const id of wanted) {
    const fresh = memory.get(id);
    if (fresh) return fresh.rows;
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      let settled = false;
      const finish = (rows: Row[] | null, entry?: Entry) => {
        if (settled) return;
        settled = true;
        if (rows && entry) remember(entry);
        resolve(rows);
      };
      for (const id of wanted) {
        const request = store.get(id);
        request.onsuccess = () => {
          const entry = request.result as Entry | undefined;
          const rows = entry && Array.isArray(entry.rows) && entry.rows.length > 0 ? entry.rows : null;
          if (rows && entry) finish(rows, entry);
        };
        request.onerror = () => finish(null);
      }
      // Every key missed, or the store answered nothing at all.
      if (!settled) finish(null);
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
  if (JSON.stringify(rows).length > MAX_BYTES) {
    forget(ids);
    await dropCachedRows(ids);
    return;
  }
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const entry: Entry = { ids, rows, savedAt: Date.now() };
    for (const id of ids) store.put(entry, id);
    const all = store.getAll();
    all.onsuccess = () => {
      const entries = (all.result ?? []) as Entry[];
      // An entry reachable by two keys appears twice; prune by identity, not
      // by count, or the second copy would delete the first.
      const unique = new Map<string, Entry>();
      for (const candidate of entries) {
        const key = candidate.ids?.[0] ?? "";
        const prior = unique.get(key);
        if (!prior || prior.savedAt < candidate.savedAt) unique.set(key, candidate);
      }
      const ordered = [...unique.values()].sort((a, b) => a.savedAt - b.savedAt);
      if (ordered.length <= MAX_ENTRIES) return;
      for (const stale of ordered.slice(0, ordered.length - MAX_ENTRIES)) {
        if (stale.ids.includes(primary)) continue;
        for (const id of stale.ids) store.delete(id);
      }
    };
    // A failed or aborted transaction costs this one write, not correctness.
  } catch {
    // Ignore: the history read remains the source of truth.
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
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      for (const id of ids) store.delete(id);
    } catch {
      // Ignore: a leftover entry is stale data the next read corrects.
    }
  })();
}

/** Reset everything. Tests only: module state would otherwise leak between them. */
export function resetTranscriptCache(): void {
  memory.clear();
  pending.clear();
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
}
