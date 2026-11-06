import { beforeEach, describe, expect, it } from "vitest";
import { applyUiStyle, loadUiStyle, saveUiStyle } from "./uiStyle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-style");
});

describe("ui style", () => {
  it("defaults to warm paper", () => {
    expect(loadUiStyle()).toBe("paper");
  });

  it("remembers studio and falls back for an unknown value", () => {
    saveUiStyle("studio");
    expect(loadUiStyle()).toBe("studio");

    localStorage.setItem("reasonix.ui-style", "neon");
    expect(loadUiStyle()).toBe("paper");
  });

  it("stores only a difference from the default", () => {
    saveUiStyle("studio");
    expect(localStorage.getItem("reasonix.ui-style")).toBe("studio");

    saveUiStyle("paper");
    expect(localStorage.getItem("reasonix.ui-style")).toBeNull();
  });

  it("puts the choice on the document for the stylesheet", () => {
    applyUiStyle("studio");
    expect(document.documentElement.getAttribute("data-style")).toBe("studio");

    applyUiStyle("paper");
    expect(document.documentElement.getAttribute("data-style")).toBe("paper");
  });
});
