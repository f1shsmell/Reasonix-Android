import { describe, expect, it } from "vitest";
import { cachePercent, cacheRate } from "./cacheRate";

/**
 * The number the meter shows is a claim about what the endpoint did, so its
 * denominator is pinned here: prompt the endpoint never split is not a miss.
 */

describe("cacheRate", () => {
  it("is the split hit share", () => {
    expect(cacheRate(750, 250)).toBe(0.75);
  });

  it("keeps unsplit prompt out of the denominator", () => {
    // The kernel bills unsplit prompt as uncached, so it sits in `miss`; a
    // rate that counted it would read lower than what was measured.
    expect(cacheRate(500, 500, 400)).toBe(500 / 600);
  });

  it("says nothing when nothing was split", () => {
    expect(cacheRate(0, 100, 100)).toBeNull();
    expect(cacheRate(0, 0)).toBeNull();
  });

  it("never exceeds one", () => {
    expect(cacheRate(120, 0, 20)).toBe(1);
  });
});

describe("cachePercent", () => {
  it("rounds down to whole percent", () => {
    expect(cachePercent(799, 201)).toBe(79);
  });

  it("stays null with no measurement", () => {
    expect(cachePercent(0, 0)).toBeNull();
  });
});
