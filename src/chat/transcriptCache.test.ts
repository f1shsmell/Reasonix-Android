import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropCachedRows,
  loadCachedRows,
  resetTranscriptCache,
  scheduleSaveRows,
} from "./transcriptCache";
import type { Row } from "./transcript";

/**
 * jsdom has no IndexedDB, so most of these run against the memory layer with
 * every disk path silently degraded — which is also the shape the cache takes
 * in a WebView that refuses the database. The disk layer adds persistence,
 * not different answers: the same rows go in and come back out. The last
 * suite stands a minimal fake IndexedDB up so the disk path itself is
 * exercised too.
 *
 * The two-key rule is what these cover. A pane id changes on every reopen, so
 * an entry saved under one must be reachable by the other; that is the whole
 * reason a cold start can repaint at all.
 */

const user = (id: string, text: string): Row => ({ kind: "user", id, text });

describe("transcriptCache", () => {
  beforeEach(() => resetTranscriptCache());
  afterEach(() => resetTranscriptCache());

  it("serves the saved rows back within the same process", async () => {
    scheduleSaveRows(["r1"], [user("u1", "第一句")]);
    await expect(loadCachedRows(["r1"])).resolves.toEqual([user("u1", "第一句")]);
  });

  it("keeps conversations apart", async () => {
    scheduleSaveRows(["r1"], [user("u1", "一")]);
    scheduleSaveRows(["r2"], [user("u2", "二")]);
    await expect(loadCachedRows(["r1"])).resolves.toEqual([user("u1", "一")]);
    await expect(loadCachedRows(["r2"])).resolves.toEqual([user("u2", "二")]);
  });

  it("answers nothing for a conversation it never saved", async () => {
    await expect(loadCachedRows(["nope"])).resolves.toBeNull();
  });

  it("forgets a conversation it is told to distrust, pending writes included", async () => {
    scheduleSaveRows(["r1"], [user("u1", "一")]);
    dropCachedRows(["r1"]);
    await expect(loadCachedRows(["r1"])).resolves.toBeNull();
  });

  it("keeps only the tail of a conversation longer than the cap", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => user(`u${index}`, `m${index}`));
    scheduleSaveRows(["r1"], rows);
    const saved = await loadCachedRows(["r1"]);
    expect(saved).toHaveLength(800);
    const first = saved?.[0];
    const last = saved?.at(-1);
    expect(first?.kind === "user" && first.text).toBe("m200");
    expect(last?.kind === "user" && last.text).toBe("m999");
  });

  it("saves nothing for an empty transcript", async () => {
    scheduleSaveRows(["r1"], []);
    await expect(loadCachedRows(["r1"])).resolves.toBeNull();
  });
});

describe("transcriptCache with two keys", () => {
  beforeEach(() => resetTranscriptCache());
  afterEach(() => resetTranscriptCache());

  it("finds an entry saved under the pane id when asked for the session path", async () => {
    // The cold-start case: the pane that saved it is gone, so its id is
    // useless, but the transcript it belonged to is the same file.
    scheduleSaveRows(["r1"], [user("u1", "上次看到的")]);
    await expect(loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toBeNull();
  });

  it("finds an entry saved under both keys when asked for either", async () => {
    scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "两句都认")]);
    await expect(loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toEqual([user("u1", "两句都认")]);
    await expect(loadCachedRows(["r1"])).resolves.toEqual([user("u1", "两句都认")]);
  });

  it("prefers the first key that answers", async () => {
    scheduleSaveRows(["C:\\w\\a.jsonl"], [user("u1", "按路径存的")]);
    scheduleSaveRows(["r9"], [user("u9", "按 id 存的")]);
    // The caller passes the session path first, so that copy wins.
    await expect(loadCachedRows(["C:\\w\\a.jsonl", "r9"])).resolves.toEqual([
      user("u1", "按路径存的"),
    ]);
  });

  it("ignores blank keys instead of treating them as an identity", async () => {
    scheduleSaveRows(["", "  ", undefined], [user("u1", "不该存进去")]);
    await expect(loadCachedRows(["", "  "])).resolves.toBeNull();
  });

  it("drops every key an entry carries when it is distrusted", async () => {
    scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "要丢掉的")]);
    dropCachedRows(["C:\\w\\a.jsonl", "r1"]);
    await expect(loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toBeNull();
    await expect(loadCachedRows(["r1"])).resolves.toBeNull();
  });
});

/**
 * A minimal IndexedDB: one store over a Map, and every callback handed to the
 * event loop the way a real database answers — asynchronously. It exists
 * because jsdom has none, and the disk layer was therefore invisible to every
 * test above: loadCachedRows resolved null before a single request callback
 * could speak, and no test could see a disk hit.
 */
class FakeRequest {
  result: unknown;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(result: unknown) {
    this.result = result;
    setTimeout(() => this.onsuccess?.(), 0);
  }
}

function installIndexedDBShim(): void {
  const data = new Map<string, unknown>();
  const store = {
    get: (key: IDBValidKey) => new FakeRequest(data.get(String(key))),
    put: (value: unknown, key: IDBValidKey) => {
      data.set(String(key), value);
      return new FakeRequest(undefined);
    },
    getAll: () => new FakeRequest([...data.values()]),
    delete: (key: IDBValidKey) => {
      data.delete(String(key));
      return new FakeRequest(undefined);
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        request.result = db;
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

describe("transcriptCache on disk", () => {
  // A fresh module instance: the suites above already ran without IndexedDB,
  // and openDb() caches its null answer — this block needs an instance whose
  // first open sees the shim.
  let cache: typeof import("./transcriptCache");

  beforeAll(async () => {
    vi.resetModules();
    installIndexedDBShim();
    cache = await import("./transcriptCache");
    // The write coalesces behind WRITE_DELAY_MS and the shim's callbacks ride
    // setTimeout(0), so the timer wheel is advanced by hand below.
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    // Other suites must not see the shim.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  beforeEach(() => cache.resetTranscriptCache());
  afterEach(() => cache.resetTranscriptCache());

  it("returns the rows a flush wrote to disk after the memory layer is cleared", async () => {
    // The cold start: this process remembers nothing, and the entry only
    // exists because a previous one flushed it.
    const rows = [user("u1", "冷启动前的最后一屏")];
    cache.scheduleSaveRows(["r1"], rows);
    await vi.runAllTimersAsync();

    cache.resetTranscriptCache();
    const read = cache.loadCachedRows(["r1"]);
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual(rows);
  });

  it("resolves null when every key misses instead of hanging", async () => {
    const read = cache.loadCachedRows(["nope", "also-gone"]);
    await vi.runAllTimersAsync();
    await expect(read).resolves.toBeNull();
  });
});
