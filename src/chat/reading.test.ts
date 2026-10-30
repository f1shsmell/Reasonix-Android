import { beforeEach, describe, expect, it } from "vitest";
import { clearReading, loadReading, readingKey, saveReading } from "./reading";

beforeEach(() => localStorage.clear());

describe("readingKey", () => {
  it("uses the stored session path so reopening a transcript finds the place", () => {
    expect(readingKey("C:\\Dev\\app\\a.jsonl", "r9")).toBe("C:\\Dev\\app\\a.jsonl");
  });

  it("falls back to the pane id for a conversation that has no path yet", () => {
    expect(readingKey(undefined, "r1")).toBe("r1");
    expect(readingKey("   ", " r2 ")).toBe("r2");
  });
});

describe("reading position", () => {
  it("round-trips the offset and whether the person followed the newest row", () => {
    saveReading("C:\\a.jsonl", { top: 420.6, atBottom: false });
    expect(loadReading("C:\\a.jsonl")).toEqual({ top: 421, atBottom: false });
  });

  it("answers nothing for a conversation that was never opened", () => {
    expect(loadReading("missing")).toBeNull();
  });

  it("ignores a stored row this build cannot read", () => {
    localStorage.setItem("reasonix.reading.bad", "{\"top\":-1,\"atBottom\":false}");
    localStorage.setItem("reasonix.reading.bad2", "{\"top\":10}");
    localStorage.setItem("reasonix.reading.bad3", "not json");
    expect(loadReading("bad")).toBeNull();
    expect(loadReading("bad2")).toBeNull();
    expect(loadReading("bad3")).toBeNull();
  });

  it("clamps a negative offset instead of trusting it", () => {
    saveReading("neg", { top: -30, atBottom: true });
    expect(loadReading("neg")).toEqual({ top: 0, atBottom: true });
  });

  it("does nothing for an empty key", () => {
    saveReading("", { top: 10, atBottom: true });
    expect(loadReading("")).toBeNull();
    clearReading("");
  });

  it("forgets a position on request", () => {
    saveReading("k", { top: 10, atBottom: false });
    clearReading("k");
    expect(loadReading("k")).toBeNull();
  });
});
