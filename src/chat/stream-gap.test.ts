import { describe, expect, it } from "vitest";
import { emptyTranscript, reduce } from "./transcript";

describe("stream_gap", () => {
  it("marks the transcript for a history reload instead of dropping the frame", () => {
    const result = reduce(emptyTranscript, { kind: "stream_gap", seq: 7 });
    expect(result).not.toBe(emptyTranscript);
    expect(result.gap).toBe(true);
  });
});
