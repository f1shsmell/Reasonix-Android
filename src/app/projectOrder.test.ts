import { describe, expect, it } from "vitest";
import { dropBefore, insertAt } from "./projectOrder";
import type { OrderRow } from "./projectOrder";

function rows(...names: string[]): OrderRow[] {
  return names.map((root) => ({ root, remembered: true }));
}

describe("insertAt", () => {
  const bounds = [
    { top: 0, bottom: 60 },
    { top: 60, bottom: 120 },
    { top: 120, bottom: 180 },
  ];

  it("puts a finger above the first middle at the top", () => {
    expect(insertAt(bounds, 10)).toBe(0);
    expect(insertAt(bounds, -20)).toBe(0);
  });

  it("uses the row it is already past", () => {
    expect(insertAt(bounds, 40)).toBe(1);
    expect(insertAt(bounds, 100)).toBe(2);
  });

  it("puts a finger below every middle at the end", () => {
    expect(insertAt(bounds, 170)).toBe(3);
    expect(insertAt(bounds, 999)).toBe(3);
  });

  it("answers the end of an empty list", () => {
    expect(insertAt([], 50)).toBe(0);
  });
});

describe("dropBefore", () => {
  const order = rows("a", "b", "c");

  it("names the next project when a row moves between two others", () => {
    expect(dropBefore(order, "a", 2)).toBe("c");
    expect(dropBefore(order, "c", 0)).toBe("a");
  });

  it("answers the end when the drop is below everything", () => {
    expect(dropBefore(order, "a", 3)).toBe("");
  });

  it("says nothing when the row is already there", () => {
    // Above itself, just below itself, and at the end it already occupies.
    expect(dropBefore(order, "a", 0)).toBeNull();
    expect(dropBefore(order, "a", 1)).toBeNull();
    expect(dropBefore(order, "b", 2)).toBeNull();
    expect(dropBefore(order, "c", 3)).toBeNull();
  });

  it("refuses a folder the kernel does not remember", () => {
    const mixed = [{ root: "a", remembered: true }, { root: "b", remembered: false }];
    expect(dropBefore(mixed, "b", 0)).toBeNull();
  });

  it("keeps its judgement within the remembered list", () => {
    const mixed = [
      { root: "a", remembered: true },
      { root: "b", remembered: false },
      { root: "c", remembered: true },
    ];
    // Dropping between a and the unremembered b still names c.
    expect(dropBefore(mixed, "a", 1)).toBeNull();
    expect(dropBefore(mixed, "c", 0)).toBe("a");
  });

  it("has nothing to write when only one project is movable", () => {
    expect(dropBefore([{ root: "a", remembered: true }], "a", 1)).toBeNull();
  });
});
