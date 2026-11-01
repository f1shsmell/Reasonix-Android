import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNetPolicy, loadNetPolicy, saveNetPolicy } from "./netpref";

/**
 * The policy follows the theme's storage pattern, and the same trap applies:
 * "auto" is the native default, so it must be the absent key — a phone that
 * never opened settings keeps the proxy's own behaviour.
 */

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("isNetPolicy", () => {
  it("accepts the three choices and nothing else", () => {
    expect(isNetPolicy("auto")).toBe(true);
    expect(isNetPolicy("bypass")).toBe(true);
    expect(isNetPolicy("system")).toBe(true);
    expect(isNetPolicy("direct")).toBe(false);
    expect(isNetPolicy(null)).toBe(false);
    expect(isNetPolicy(1)).toBe(false);
  });
});

describe("loadNetPolicy", () => {
  it("defaults to the proxy's own behaviour", () => {
    expect(loadNetPolicy()).toBe("auto");
  });

  it("reads a remembered choice", () => {
    localStorage.setItem("reasonix.net-policy", "bypass");
    expect(loadNetPolicy()).toBe("bypass");
  });

  it("ignores a value it does not know", () => {
    localStorage.setItem("reasonix.net-policy", "off");
    expect(loadNetPolicy()).toBe("auto");
  });
});

describe("saveNetPolicy", () => {
  it("remembers a non-default choice", () => {
    saveNetPolicy("system");
    expect(localStorage.getItem("reasonix.net-policy")).toBe("system");
  });

  it("forgets the choice when back to auto", () => {
    saveNetPolicy("bypass");
    saveNetPolicy("auto");
    expect(localStorage.getItem("reasonix.net-policy")).toBeNull();
  });
});
