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
 */

import type { Row } from "./transcript";

/** Rows kept per conversation: enough to repaint, little enough to write fast. */
const MAX_ROWS = 400;
/** A serialized entry above this is skipped: writing it would stall more than it saves. */
const MAX_BYTES = 1_500_000;
/** Entries kept at all; the oldest are pruned whenever a write happens. */
const MAX_ENTRIES = 40;
/** Writes coalesce: a streaming turn replaces the rows many times a second. */
const WRITE_DELAY_MS = 800;

const DB_NAME = "reasonix.cache";
const DB_VERSION = 1;
const STORE = "transcripts";

interface Entry {
  /** Duplicated inside the value so pruning can read keys and ages in one call. */
  id: string;
  rows: Row[];
  savedAt: number;
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

/**
 * The rows last drawn for this conversation, or null.
 *
 * Memory answers first; IndexedDB covers the cold start and then feeds memory,
 * so one read per conversation ever reaches disk.
 */
export async function loadCachedRows(runtimeId: string): Promise<Row[] | null> {
  const fresh = memory.get(runtimeId);
  if (fresh) return fresh.rows;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(runtimeId);
      request.onsuccess = () => {
        const entry = request.result as Entry | undefined;
        const rows = entry && Array.isArray(entry.rows) && entry.rows.length > 0 ? entry.rows : null;
        if (rows && entry) memory.set(runtimeId, { id: runtimeId, rows, savedAt: entry.savedAt });
        resolve(rows);
      };
      request.onerror = () => resolve(null);
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
export function scheduleSaveRows(runtimeId: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const kept = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  pending.set(runtimeId, kept);
  memory.set(runtimeId, { id: runtimeId, rows: kept, savedAt: Date.now() });
  if (timers.has(runtimeId)) return;
  timers.set(
    runtimeId,
    window.setTimeout(() => {
      timers.delete(runtimeId);
      void flushRows(runtimeId);
    }, WRITE_DELAY_MS),
  );
}

async function flushRows(runtimeId: string): Promise<void> {
  const rows = pending.get(runtimeId);
  pending.delete(runtimeId);
  if (!rows || rows.length === 0) return;
  if (JSON.stringify(rows).length > MAX_BYTES) {
    memory.delete(runtimeId);
    await dropCachedRows(runtimeId);
    return;
  }
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    store.put({ id: runtimeId, rows, savedAt: Date.now() }, runtimeId);
    const all = store.getAll();
    all.onsuccess = () => {
      const entries = (all.result ?? []) as Entry[];
      if (entries.length <= MAX_ENTRIES) return;
      const stale = entries
        .sort((a, b) => a.savedAt - b.savedAt)
        .slice(0, entries.length - MAX_ENTRIES);
      for (const entry of stale) {
        if (entry.id && entry.id !== runtimeId) store.delete(entry.id);
      }
    };
    // A failed or aborted transaction costs this one write, not correctness.
  } catch {
    // Ignore: the history read remains the source of truth.
  }
}

/** Forget this conversation's copy — the caller has reason to distrust it. */
export function dropCachedRows(runtimeId: string): void {
  memory.delete(runtimeId);
  pending.delete(runtimeId);
  const timer = timers.get(runtimeId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(runtimeId);
  }
  void (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(runtimeId);
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
