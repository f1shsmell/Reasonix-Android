import { describe, expect, it } from "vitest";
import { latestStreamingAssistant, streamEdge, type StreamMark } from "./streamHaptics";
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

describe("streamEdge", () => {
  it("ticks the start of an answer", () => {
    expect(streamEdge({ previous: null, latest: mark("a1", 0) })).toBe("start");
  });

  it("ticks the start of a second answer", () => {
    expect(streamEdge({ previous: mark("a1", 100), latest: mark("a2", 0) })).toBe("start");
  });

  it("ticks the end of an answer", () => {
    expect(streamEdge({ previous: mark("a1", 100), latest: null })).toBe("end");
  });

  it("stays silent while the answer grows", () => {
    // The bug this replaces: ticking on growth made a long reply buzz the
    // whole way through, which reads as broken rather than responsive.
    expect(streamEdge({ previous: mark("a1", 100), latest: mark("a1", 120) })).toBeNull();
    expect(streamEdge({ previous: mark("a1", 100), latest: mark("a1", 5000) })).toBeNull();
  });

  it("stays silent when nothing streams on either side", () => {
    expect(streamEdge({ previous: null, latest: null })).toBeNull();
  });

  it("stays silent when the same stream merely shrinks", () => {
    // A rebuilt or re-merged transcript can shed text without an answer ending.
    expect(streamEdge({ previous: mark("a1", 100), latest: mark("a1", 50) })).toBeNull();
  });
});
