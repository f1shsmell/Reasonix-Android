import { describe, expect, it } from "vitest";
import { diffLines } from "./diffLines";

const sample = [
  "diff --git a/x.ts b/x.ts",
  "index aaa..bbb 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -3,4 +3,5 @@",
  " keep",
  "-gone",
  "+here",
  "+added",
  " context",
  "\\ No newline at end of file",
].join("\n");

describe("diffLines", () => {
  it("skips the file headers and numbers the hunk's lines", () => {
    const rows = diffLines(sample);
    // The hunk header itself is a row; the 4 file headers and git's
    // `\ No newline` note never reach the rows.
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ mark: "@", text: "@@ -3,4 +3,5 @@" });
    expect(rows[1]).toMatchObject({ old: 3, now: 3, mark: " ", text: "keep" });
    expect(rows[2]).toMatchObject({ old: 4, mark: "-", text: "gone" });
    expect(rows[3]).toMatchObject({ now: 4, mark: "+", text: "here" });
    expect(rows[4]).toMatchObject({ now: 5, mark: "+", text: "added" });
  });

  it("keeps the line counters honest across hunks", () => {
    const rows = diffLines(`${sample}\n@@ -40,2 +41,2 @@\n ctx2\n-add2`);
    const second = rows.find((row) => row.text.startsWith("ctx2"));
    expect(second).toMatchObject({ old: 40, now: 41, mark: " " });
    const removal = rows.find((row) => row.text === "add2");
    expect(removal).toMatchObject({ old: 41, mark: "-" });
  });

  it("renders an empty answer for a diff with no hunk", () => {
    expect(diffLines("diff --git a/x.ts b/x.ts\nindex aaa..bbb 100644")).toEqual([]);
  });

  it("does not treat a removed line that begins with a dash as a header", () => {
    const rows = diffLines("@@ -1,2 +1,2 @@\n--- inside");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ old: 1, mark: "-", text: "-- inside" });
  });
});
