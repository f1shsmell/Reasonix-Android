import { beforeEach, describe, expect, it } from "vitest";
import { FOLD_CHOICES, loadFoldMode, saveFoldMode } from "./folding";

const KEY = "reasonix.folding.v1";

beforeEach(() => localStorage.clear());

describe("fold preference", () => {
  it("starts at standard", () => {
    expect(loadFoldMode()).toBe("standard");
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
