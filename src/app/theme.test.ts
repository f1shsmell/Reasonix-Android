import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, isTheme, loadTheme, saveTheme } from "./theme";

/**
 * The theme setting is small but has one trap worth a test: `auto` must be the
 * absent attribute, not a literal value, or the system preference stops
 * applying and the screen looks broken in one appearance only.
 */

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("isTheme", () => {
  it("accepts the three choices and nothing else", () => {
    expect(isTheme("auto")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(1)).toBe(false);
  });
});

describe("loadTheme", () => {
  it("defaults to following the system", () => {
    expect(loadTheme()).toBe("auto");
  });

  it("reads a remembered choice", () => {
    localStorage.setItem("reasonix.theme", "dark");
    expect(loadTheme()).toBe("dark");
  });

  it("ignores a value it does not know", () => {
    localStorage.setItem("reasonix.theme", "sepia");
    expect(loadTheme()).toBe("auto");
  });
});

describe("saveTheme", () => {
  it("remembers a pinned choice", () => {
    saveTheme("light");
    expect(localStorage.getItem("reasonix.theme")).toBe("light");
  });

  it("forgets the choice when following the system again", () => {
    saveTheme("dark");
    saveTheme("auto");
    expect(localStorage.getItem("reasonix.theme")).toBeNull();
  });
});

describe("applyTheme", () => {
  it("pins the attribute for a fixed choice", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("removes the attribute so the media query decides again", () => {
    applyTheme("dark");
    applyTheme("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
