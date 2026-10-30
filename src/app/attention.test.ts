import { beforeEach, describe, expect, it } from "vitest";
import { Attention, decisionKey, runningKey } from "./attention";

beforeEach(() => localStorage.clear());

describe("Attention", () => {
  it("keeps a decision's first sighting across instances", () => {
    const key = decisionKey("r2", "d1");

    expect(new Attention(1_000).decision(key, 1_000)).toEqual({
      firstSeenAt: 1_000,
      isNew: true,
    });
    const reopened = new Attention(2_000).decision(key, 2_000);
    expect(reopened.firstSeenAt).toBe(1_000);
    expect(reopened.isNew).toBe(true);
  });

  it("drops the new badge for good once the card is opened", () => {
    const key = decisionKey("r2", "d1");
    const attention = new Attention(1_000);
    attention.decision(key, 1_000);
    attention.markSeen(key, 1_500);

    expect(attention.decision(key, 2_000).isNew).toBe(false);
    expect(new Attention(3_000).decision(key, 3_000).isNew).toBe(false);
  });

  it("ages a running turn from its first sighting", () => {
    const key = runningKey("r2");

    expect(new Attention(1_000).running(key, 1_000)).toBe(1_000);
    expect(new Attention(5_000).running(key, 5_000)).toBe(1_000);
  });

  it("starts clean when the stored shape is unusable", () => {
    localStorage.setItem("reasonix.attention.v1", "{not json");

    expect(new Attention(1_000).decision("d:r2:d1", 1_000)).toEqual({
      firstSeenAt: 1_000,
      isNew: true,
    });
  });

  it("forgets entries older than a week", () => {
    const now = Date.now();
    localStorage.setItem(
      "reasonix.attention.v1",
      JSON.stringify({ firstSeen: { old: 1 }, seen: { old: 1 } }),
    );

    expect(new Attention(now).decision("old", now).firstSeenAt).toBe(now);
  });
});
