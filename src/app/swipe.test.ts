import { describe, expect, it } from "vitest";
import { SWIPE_MIN_PX, insideHorizontalScroller, swipeTo } from "./swipe";

/**
 * The swipe rule is a pure function because the failure mode is subtle: a
 * gesture that fires too eagerly steals the vertical scroll and the sideways
 * card strip, and that is not something a screenshot would show.
 */

function drag(from: "recent" | "projects", dx: number, dy = 0) {
  return swipeTo({ startX: 200, startY: 400, endX: 200 + dx, endY: 400 + dy, tab: from });
}

describe("swipeTo", () => {
  it("moves to the next view when dragging left", () => {
    expect(drag("recent", -120)).toBe("projects");
  });

  it("moves back when dragging right", () => {
    expect(drag("projects", 120)).toBe("recent");
  });

  it("does not wrap past either end", () => {
    expect(drag("projects", -120)).toBeNull();
    expect(drag("recent", 120)).toBeNull();
  });

  it("ignores a short drag", () => {
    // A tap that wobbles must never change the view.
    expect(drag("recent", -(SWIPE_MIN_PX - 1))).toBeNull();
  });

  it("ignores a diagonal drag, which is a scroll that drifted", () => {
    expect(drag("recent", -120, 100)).toBeNull();
    expect(drag("recent", -120, -100)).toBeNull();
  });

  it("accepts a drag that is clearly horizontal", () => {
    expect(drag("recent", -120, 40)).toBe("projects");
  });

  it("requires the distance in either direction equally", () => {
    expect(drag("projects", SWIPE_MIN_PX)).toBe("recent");
  });
});

describe("insideHorizontalScroller", () => {
  it("recognises a touch inside the sideways card strip", () => {
    const strip = document.createElement("ul");
    strip.className = "cards";
    const card = document.createElement("li");
    strip.appendChild(card);
    expect(insideHorizontalScroller(card)).toBe(true);
  });

  it("leaves a touch on an ordinary row to the page", () => {
    const item = document.createElement("li");
    const row = document.createElement("button");
    item.appendChild(row);
    document.body.appendChild(item);
    expect(insideHorizontalScroller(row)).toBe(false);
    item.remove();
  });

  it("tolerates a target with no element behind it", () => {
    expect(insideHorizontalScroller(null)).toBe(false);
  });
});
