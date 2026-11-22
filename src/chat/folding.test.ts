import { beforeEach, describe, expect, it } from "vitest";
import { FOLD_CHOICES, loadFoldMode, saveFoldMode } from "./folding";

const KEY = "reasonix.folding.v1";

beforeEach(() => localStorage.clear());

describe("fold preference", () => {
  it("starts at standard", () => {
    expect(loadFoldMode()).toBe("standard");
  });

  it("a ?fold= override pins the mode in a dev build", () => {
    window.history.replaceState(null, "", "/?fold=compact");
    expect(loadFoldMode()).toBe("compact");
    window.history.replaceState(null, "", "/");
  });

  it("an unknown ?fold= value falls back to the stored choice", () => {
    localStorage.setItem(KEY, "full");
    window.history.replaceState(null, "", "/?fold=nope");
    expect(loadFoldMode()).toBe("full");
    window.history.replaceState(null, "", "/");
  });

  it("remembers each of the three modes", () => {
    for (const { value } of FOLD_CHOICES) {
      saveFoldMode(value);
      expect(loadFoldMode()).toBe(value);
    }
  });

  it("falls back to standard for a value it does not know", () => {
    localStorage.setItem(KEY, "verbose");
    expect(loadFoldMode()).toBe("standard");
  });

  it("falls back to standard when storage cannot be read", () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(loadFoldMode()).toBe("standard");
    } finally {
      Storage.prototype.getItem = get;
    }
  });
});
