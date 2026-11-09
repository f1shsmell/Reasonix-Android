import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "./transcript";

/**
 * jsdom has no IndexedDB, so most of these run against the memory layer with
 * every disk path silently degraded — which is also the shape the cache takes
 * in a WebView that refuses the database. The disk layer adds persistence,
 * not different answers: the same rows go in and come back out. The last
 * suites stand a minimal IndexedDB up so the disk path itself is exercised
 * too, including the `meta` store that statistics and eviction read.
 */

const retain = vi.hoisted(() => ({ on: true }));
vi.mock("../app/retainPref", () => ({
  loadRetainTranscript: () => retain.on,
  saveRetainTranscript: (on: boolean) => {
    retain.on = on;
  },
}));

const user = (id: string, text: string): Row => ({ kind: "user", id, text });

describe("transcriptCache", () => {
  let cache: typeof import("./transcriptCache");

  beforeAll(async () => {
    cache = await import("./transcriptCache");
  });

  beforeEach(() => {
    retain.on = true;
    cache.resetTranscriptCache();
  });
  afterEach(() => cache.resetTranscriptCache());

  it("serves the saved rows back within the same process", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "第一句")]);
    await expect(cache.loadCachedRows(["r1"])).resolves.toEqual([user("u1", "第一句")]);
  });

  it("keeps conversations apart", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "一")]);
    cache.scheduleSaveRows(["r2"], [user("u2", "二")]);
    await expect(cache.loadCachedRows(["r1"])).resolves.toEqual([user("u1", "一")]);
    await expect(cache.loadCachedRows(["r2"])).resolves.toEqual([user("u2", "二")]);
  });

  it("answers nothing for a conversation it never saved", async () => {
    await expect(cache.loadCachedRows(["nope"])).resolves.toBeNull();
  });

  it("forgets a conversation it is told to distrust, pending writes included", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "一")]);
    cache.dropCachedRows(["r1"]);
    await expect(cache.loadCachedRows(["r1"])).resolves.toBeNull();
  });

  it("keeps only the tail of a conversation longer than the cap", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => user(`u${index}`, `m${index}`));
    cache.scheduleSaveRows(["r1"], rows);
    const saved = await cache.loadCachedRows(["r1"]);
    expect(saved).toHaveLength(800);
    const first = saved?.[0];
    const last = saved?.at(-1);
    expect(first?.kind === "user" && first.text).toBe("m200");
    expect(last?.kind === "user" && last.text).toBe("m999");
  });

  it("saves nothing for an empty transcript", async () => {
    cache.scheduleSaveRows(["r1"], []);
    await expect(cache.loadCachedRows(["r1"])).resolves.toBeNull();
  });

  it("reads nothing and writes nothing while retention is off", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "关掉之前")]);
    retain.on = false;
    await expect(cache.loadCachedRows(["r1"])).resolves.toBeNull();
    cache.scheduleSaveRows(["r2"], [user("u2", "关掉之后")]);
    await expect(cache.loadCachedRows(["r2"])).resolves.toBeNull();
  });
});

describe("transcriptCache with two keys", () => {
  let cache: typeof import("./transcriptCache");

  beforeAll(async () => {
    cache = await import("./transcriptCache");
  });

  beforeEach(() => {
    retain.on = true;
    cache.resetTranscriptCache();
  });
  afterEach(() => cache.resetTranscriptCache());

  it("finds an entry saved under the pane id when asked for the session path", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "上次看到的")]);
    await expect(cache.loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toBeNull();
  });

  it("finds an entry saved under both keys when asked for either", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "两句都认")]);
    await expect(cache.loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toEqual([user("u1", "两句都认")]);
    await expect(cache.loadCachedRows(["r1"])).resolves.toEqual([user("u1", "两句都认")]);
  });

  it("prefers the first key that answers", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl"], [user("u1", "按路径存的")]);
    cache.scheduleSaveRows(["r9"], [user("u9", "按 id 存的")]);
    await expect(cache.loadCachedRows(["C:\\w\\a.jsonl", "r9"])).resolves.toEqual([
      user("u1", "按路径存的"),
    ]);
  });

  it("ignores blank keys instead of treating them as an identity", async () => {
    cache.scheduleSaveRows(["", "  ", undefined], [user("u1", "不该存进去")]);
    await expect(cache.loadCachedRows(["", "  "])).resolves.toBeNull();
  });

  it("drops every key an entry carries when it is distrusted", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "要丢掉的")]);
    cache.dropCachedRows(["C:\\w\\a.jsonl", "r1"]);
    await expect(cache.loadCachedRows(["C:\\w\\a.jsonl"])).resolves.toBeNull();
    await expect(cache.loadCachedRows(["r1"])).resolves.toBeNull();
  });
});

class FakeRequest {
  result: unknown;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  constructor(result: unknown) {
    this.result = result;
    setTimeout(() => this.onsuccess?.(), 0);
  }
}

interface Shim {
  reset(): void;
  seed(store: string, entries: Record<string, unknown>): void;
  dump(store: string): Record<string, unknown>;
  setVersion(version: number): void;
  /** How many times the content store was read whole — pruning must not. */
  contentReads(): number;
}

/**
 * A minimal IndexedDB: stores over Maps, callbacks handed to the event loop
 * the way a real database answers, a cursor that walks keys one at a time, and
 * a version bump that runs `onupgradeneeded` before `onsuccess`. The previous
 * shim had one store and `contains()` always true, which made every `meta`
 * assertion pass by reading the transcripts store.
 */
function installIndexedDBShim(): Shim {
  const stores = new Map<string, Map<string, unknown>>();
  let version = 0;
  let reads = 0;

  const storeFor = (name: string): Map<string, unknown> => {
    let data = stores.get(name);
    if (!data) {
      data = new Map();
      stores.set(name, data);
    }
    return data;
  };

  const makeCursor = (data: Map<string, unknown>) => {
    const keys = [...data.keys()];
    const request = {
      result: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    const step = (index: number) => {
      if (index >= keys.length) {
        request.result = null;
        setTimeout(() => request.onsuccess?.(), 0);
        return;
      }
      const key = keys[index] as string;
      request.result = {
        key,
        value: data.get(key),
        continue: () => step(index + 1),
        delete: () => {
          data.delete(key);
          step(index + 1);
        },
      };
      setTimeout(() => request.onsuccess?.(), 0);
    };
    step(0);
    return request;
  };

  const makeDb = () => ({
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      storeFor(name);
      return {};
    },
    transaction: (names: string | string[]) => {
      const list = Array.isArray(names) ? names : [names];
      void list;
      const objectStore = (name: string) => {
        if (!stores.has(name)) throw new Error(`store ${name} is missing`);
        const data = stores.get(name) as Map<string, unknown>;
        return {
          get: (key: IDBValidKey) => new FakeRequest(data.get(String(key))),
          put: (value: unknown, key: IDBValidKey) => {
            data.set(String(key), value);
            return new FakeRequest(undefined);
          },
          delete: (key: IDBValidKey) => {
            data.delete(String(key));
            return new FakeRequest(undefined);
          },
          getAll: () => {
            if (name === "transcripts") reads += 1;
            return new FakeRequest([...data.values()]);
          },
          getAllKeys: () => new FakeRequest([...data.keys()]),
          clear: () => {
            data.clear();
            return new FakeRequest(undefined);
          },
          openCursor: () => makeCursor(data),
        };
      };
      return { objectStore };
    },
  });

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: (_name: string, next: number) => {
      const request: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        request.result = makeDb();
        if (next > version) {
          version = next;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };

  return {
    reset() {
      for (const data of stores.values()) data.clear();
    },
    seed(name, entries) {
      const data = storeFor(name);
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
    dump(name) {
      return Object.fromEntries(storeFor(name));
    },
    setVersion(next) {
      version = next;
    },
    contentReads() {
      return reads;
    },
  };
}

describe("transcriptCache on disk", () => {
  // A fresh module instance: the suites above already ran without IndexedDB,
  // and openDb() caches its null answer — this block needs an instance whose
  // first open sees the shim.
  let cache: typeof import("./transcriptCache");
  let shim: Shim;

  beforeAll(async () => {
    vi.resetModules();
    shim = installIndexedDBShim();
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

  beforeEach(() => {
    retain.on = true;
    shim.reset();
    cache.resetTranscriptCache();
  });
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

  it("writes a meta record beside the rows", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "一句")]);
    await vi.runAllTimersAsync();

    const meta = shim.dump("meta") as Record<string, { ids: string[]; rows: number; bytes: number }>;
    const record = meta["C:\\w\\a.jsonl"];
    expect(record).toMatchObject({ ids: ["C:\\w\\a.jsonl", "r1"], rows: 1 });
    expect(record?.bytes).toBeGreaterThan(0);
    // Filed under both keys, so either path can reach it.
    expect(meta.r1).toMatchObject({ ids: ["C:\\w\\a.jsonl", "r1"] });
  });

  it("counts a two-key conversation once", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "一句")]);
    await vi.runAllTimersAsync();

    const stats = cache.cacheStats();
    await vi.runAllTimersAsync();
    await expect(stats).resolves.toMatchObject({ entries: 1, rows: 1 });
  });

  it("answers null for statistics when the database is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    vi.resetModules();
    const isolated = await import("./transcriptCache");
    await expect(isolated.cacheStats()).resolves.toBeNull();
    // Restore for the suites that follow.
    shim = installIndexedDBShim();
    vi.resetModules();
    cache = await import("./transcriptCache");
  });

  it("drops both stores when a conversation is distrusted", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "要丢的")]);
    await vi.runAllTimersAsync();

    cache.dropCachedRows(["C:\\w\\a.jsonl", "r1"]);
    await vi.runAllTimersAsync();

    expect(Object.keys(shim.dump("transcripts"))).toHaveLength(0);
    // The migration marker stays: without it the next launch would rescan an
    // empty database to learn nothing.
    const meta = Object.keys(shim.dump("meta")).filter((key) => key !== "__reasonix.cache.meta.v2");
    expect(meta).toHaveLength(0);
  });

  it("clears everything, including a write that was already in flight", async () => {
    cache.scheduleSaveRows(["r1"], [user("u1", "清理前")]);
    // The timer has not fired yet: the flush is pending, not written.
    const cleared = cache.clearAllCachedRows();
    await vi.runAllTimersAsync();
    await expect(cleared).resolves.toEqual({ entries: 0 });

    expect(Object.keys(shim.dump("transcripts"))).toHaveLength(0);
    expect(Object.keys(shim.dump("meta"))).toHaveLength(0);
    cache.resetTranscriptCache();
    const read = cache.loadCachedRows(["r1"]);
    await vi.runAllTimersAsync();
    await expect(read).resolves.toBeNull();
  });

  it("reports how many conversations a clear removed", async () => {
    cache.scheduleSaveRows(["C:\\w\\a.jsonl", "r1"], [user("u1", "一")]);
    cache.scheduleSaveRows(["C:\\w\\b.jsonl", "r2"], [user("u2", "二")]);
    await vi.runAllTimersAsync();

    const cleared = cache.clearAllCachedRows();
    await vi.runAllTimersAsync();
    await expect(cleared).resolves.toEqual({ entries: 2 });
  });

  it("keeps at most the entry cap and never reads the content store to prune", async () => {
    for (let index = 0; index < 61; index += 1) {
      cache.scheduleSaveRows([`k${index}`], [user(`u${index}`, `m${index}`)]);
    }
    await vi.runAllTimersAsync();

    const stats = cache.cacheStats();
    await vi.runAllTimersAsync();
    await expect(stats).resolves.toMatchObject({ entries: 60 });
    // Pruning reads `meta` only: getAll() on transcripts would deserialize
    // every row of every conversation to decide what to throw away.
    expect(shim.contentReads()).toBe(0);
  });

  it("migrates an older database once and leaves a marker", async () => {
    shim.reset();
    shim.setVersion(1);
    shim.seed("transcripts", {
      "C:\\w\\a.jsonl": { ids: ["C:\\w\\a.jsonl", "r1"], rows: [user("u1", "旧")], savedAt: 10 },
      r1: { ids: ["C:\\w\\a.jsonl", "r1"], rows: [user("u1", "旧")], savedAt: 10 },
    });
    vi.resetModules();
    const migrated = await import("./transcriptCache");
    // The database opens lazily; a read is what starts the migration.
    const read = migrated.loadCachedRows(["nothing"]);
    await vi.runAllTimersAsync();
    await read;

    const meta = shim.dump("meta") as Record<string, { ids: string[]; rows: number }>;
    expect(meta["C:\\w\\a.jsonl"]).toMatchObject({ ids: ["C:\\w\\a.jsonl", "r1"], rows: 1 });
    expect(meta["__reasonix.cache.meta.v2"]).toBeTruthy();

    // A second launch sees the marker and does not scan again.
    vi.resetModules();
    const again = await import("./transcriptCache");
    const second = again.loadCachedRows(["nothing"]);
    await vi.runAllTimersAsync();
    await second;
    expect(Object.keys(shim.dump("meta"))).toHaveLength(3);
  });

  it("removes the pane id an older entry left behind", async () => {
    // The old pane's runtimeId is not in the new entry's ids, and nothing will
    // ask for it again — but the shared session path must survive.
    shim.reset();
    shim.setVersion(1);
    shim.seed("transcripts", {
      "C:\\w\\a.jsonl": {
        ids: ["C:\\w\\a.jsonl", "r-new"],
        rows: [user("u1", "新")],
        savedAt: 20,
      },
      "r-new": { ids: ["C:\\w\\a.jsonl", "r-new"], rows: [user("u1", "新")], savedAt: 20 },
      // The older entry of the same conversation: same session path, an
      // earlier pane id.
      "r-old": { ids: ["C:\\w\\a.jsonl", "r-old"], rows: [user("u1", "旧")], savedAt: 10 },
    });
    vi.resetModules();
    const migrated = await import("./transcriptCache");
    const read = migrated.loadCachedRows(["nothing"]);
    await vi.runAllTimersAsync();
    await read;

    const transcripts = shim.dump("transcripts");
    expect(transcripts["r-old"]).toBeUndefined();
    expect(transcripts["C:\\w\\a.jsonl"]).toBeTruthy();
    expect(transcripts["r-new"]).toBeTruthy();
  });
});
