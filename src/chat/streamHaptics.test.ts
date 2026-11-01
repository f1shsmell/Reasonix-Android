import { describe, expect, it } from "vitest";
import {
  latestStreamingAssistant,
  shouldTickStreamHaptic,
  STREAM_HAPTIC_THROTTLE_MS,
  type StreamMark,
} from "./streamHaptics";
import type { AssistantRow, Row } from "./transcript";

function assistant(id: string, text: string, streaming = true): AssistantRow {
  return { kind: "assistant", id, text, reasoning: "", streaming };
}

function rowsOf(...rows: (AssistantRow | { kind: "user"; id: string })[]): Row[] {
  return rows as Row[];
}

const mark = (id: string, textLength: number): StreamMark => ({ id, textLength });

describe("latestStreamingAssistant", () => {
  it("finds the streaming answer at the end", () => {
    expect(latestStreamingAssistant(rowsOf(assistant("a1", "前半"), assistant("a2", "后半")))).toEqual(
      mark("a2", 2),
    );
  });

  it("finds a streaming answer below finished rows after it", () => {
    const rows = rowsOf(assistant("a1", "还在生成"), assistant("a2", "已完成", false));
    expect(latestStreamingAssistant(rows)).toEqual(mark("a1", 4));
  });

  it("returns null when nothing streams", () => {
    expect(latestStreamingAssistant(rowsOf(assistant("a1", "完成", false)))).toBeNull();
    expect(latestStreamingAssistant([])).toBeNull();
  });
});

describe("shouldTickStreamHaptic", () => {
  it("ticks when a new stream starts", () => {
    expect(
      shouldTickStreamHaptic({
        previous: null,
        latest: mark("a1", 0),
        lastTickAt: 0,
        now: 1000,
      }),
    ).toBe(true);
  });

  it("ticks when a different stream replaces the old one", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a1", 100),
        latest: mark("a2", 0),
        lastTickAt: 1000,
        now: 1100,
      }),
    ).toBe(true);
  });

  it("does not tick before the text grows", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a1", 100),
        latest: mark("a1", 100),
        lastTickAt: 0,
        now: 5000,
      }),
    ).toBe(false);
  });

  it("does not tick when the stream disappeared", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a1", 100),
        latest: null,
        lastTickAt: 0,
        now: 5000,
      }),
    ).toBe(false);
  });

  it("does not tick when the text shrank", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a1", 100),
        latest: mark("a1", 50),
        lastTickAt: 0,
        now: 5000,
      }),
    ).toBe(false);
  });

  it("rate-limits growth to one tick per window", () => {
    const grew = {
      previous: mark("a1", 100),
      latest: mark("a1", 120),
    };
    expect(
      shouldTickStreamHaptic({ ...grew, lastTickAt: 1000, now: 1000 + STREAM_HAPTIC_THROTTLE_MS - 1 }),
    ).toBe(false);
    expect(
      shouldTickStreamHaptic({ ...grew, lastTickAt: 1000, now: 1000 + STREAM_HAPTIC_THROTTLE_MS }),
    ).toBe(true);
  });
});
