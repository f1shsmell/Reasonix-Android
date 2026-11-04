import { afterEach, describe, expect, it } from "vitest";
import { isEnterPref, loadEnterPref, saveEnterPref } from "./enterPref";

afterEach(() => {
  localStorage.clear();
});

describe("enterPref", () => {
  it("defaults to a line break", () => {
    expect(loadEnterPref()).toBe("newline");
  });

  it("round-trips the send choice", () => {
    saveEnterPref("send");
    expect(loadEnterPref()).toBe("send");
  });

  it("returns to the default once the choice is cleared", () => {
    saveEnterPref("send");
    saveEnterPref("newline");
    expect(localStorage.getItem("reasonix.enter")).toBeNull();
    expect(loadEnterPref()).toBe("newline");
  });

  it("rejects values that are not a preference", () => {
    expect(isEnterPref("send")).toBe(true);
    expect(isEnterPref("newline")).toBe(true);
    expect(isEnterPref("both")).toBe(false);
    expect(isEnterPref(null)).toBe(false);
  });
});
