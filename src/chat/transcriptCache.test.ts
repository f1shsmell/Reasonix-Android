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
 */

const user = (id: string, text: string): Row => ({ kind: "user", id, text });

describe("transcriptCache", () => {
  beforeEach(() => resetTranscriptCache());
  afterEach(() => resetTranscriptCache());

  it("serves the saved rows back within the same process", async () => {
    scheduleSaveRows("r1", [user("u1", "第一句")]);
    await expect(loadCachedRows("r1")).resolves.toEqual([user("u1", "第一句")]);
  });

  it("keeps conversations apart", async () => {
    scheduleSaveRows("r1", [user("u1", "一")]);
    scheduleSaveRows("r2", [user("u2", "二")]);
    await expect(loadCachedRows("r1")).resolves.toEqual([user("u1", "一")]);
    await expect(loadCachedRows("r2")).resolves.toEqual([user("u2", "二")]);
  });

  it("answers nothing for a conversation it never saved", async () => {
    await expect(loadCachedRows("nope")).resolves.toBeNull();
  });

  it("forgets a conversation it is told to distrust, pending writes included", async () => {
    scheduleSaveRows("r1", [user("u1", "一")]);
    dropCachedRows("r1");
    await expect(loadCachedRows("r1")).resolves.toBeNull();
  });

  it("keeps only the tail of a conversation longer than the cap", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => user(`u${index}`, `m${index}`));
    scheduleSaveRows("r1", rows);
    const saved = await loadCachedRows("r1");
    expect(saved).toHaveLength(400);
    const first = saved?.[0];
    const last = saved?.at(-1);
    expect(first?.kind === "user" && first.text).toBe("m200");
    expect(last?.kind === "user" && last.text).toBe("m599");
  });

  it("saves nothing for an empty transcript", async () => {
    scheduleSaveRows("r1", []);
    await expect(loadCachedRows("r1")).resolves.toBeNull();
  });
});
