import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropCachedRows,
  loadCachedRows,
  resetTranscriptCache,
  scheduleSaveRows,
} from "./transcriptCache";
import type { Row } from "./transcript";

/**
 * jsdom has no IndexedDB, so these run against the memory layer with every
 * disk path silently degraded — which is also the shape the cache takes in a
 * WebView that refuses the database. The disk layer adds persistence, not
 * different answers: the same rows go in and come back out.
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
