import { beforeEach, describe, expect, it } from "vitest";
import { loadDispatchAfter, saveDispatchAfter } from "./dispatchPref";

beforeEach(() => localStorage.clear());

describe("dispatch after", () => {
  it("defaults to the recent view", () => {
    expect(loadDispatchAfter()).toBe("recent");
  });

  it("remembers the chosen destination and falls back on an unknown value", () => {
    saveDispatchAfter("session");
    expect(loadDispatchAfter()).toBe("session");

    localStorage.setItem("reasonix.dispatch-after", "elsewhere");
    expect(loadDispatchAfter()).toBe("recent");
  });

  it("stores only a difference from the default", () => {
    saveDispatchAfter("stay");
    expect(localStorage.getItem("reasonix.dispatch-after")).toBe("stay");

    saveDispatchAfter("recent");
    expect(localStorage.getItem("reasonix.dispatch-after")).toBeNull();
  });
});
