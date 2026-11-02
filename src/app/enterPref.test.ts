import { afterEach, describe, expect, it } from "vitest";
import { isEnterPref, loadEnterPref, saveEnterPref } from "./enterPref";

afterEach(() => {
  localStorage.clear();
});

describe("enterPref", () => {
  it("defaults to send", () => {
    expect(loadEnterPref()).toBe("send");
  });

  it("round-trips the newline choice", () => {
    saveEnterPref("newline");
    expect(loadEnterPref()).toBe("newline");
  });

  it("returns to the default once the choice is cleared", () => {
    saveEnterPref("newline");
    saveEnterPref("send");
    expect(localStorage.getItem("reasonix.enter")).toBeNull();
    expect(loadEnterPref()).toBe("send");
  });

  it("rejects values that are not a preference", () => {
    expect(isEnterPref("send")).toBe(true);
    expect(isEnterPref("newline")).toBe(true);
    expect(isEnterPref("both")).toBe(false);
    expect(isEnterPref(null)).toBe(false);
  });
});
