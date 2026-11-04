import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setAppearance: vi.fn(),
  native: true,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
  registerPlugin: () => ({ setAppearance: mocks.setAppearance }),
}));

import { applyStatusBar } from "./themeBar";

/** What the page asked the window to paint, in call order. */
const sent = () => mocks.setAppearance.mock.calls.map(([options]) => options);

beforeEach(() => {
  mocks.setAppearance.mockReset();
  mocks.setAppearance.mockResolvedValue(undefined);
  mocks.native = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("applyStatusBar", () => {
  it("reports the page's own background and the matching icon shade", () => {
    applyStatusBar("light");
    expect(sent()).toEqual([{ color: "#f4f6fa", darkIcons: true }]);
    applyStatusBar("dark");
    expect(sent()[1]).toEqual({ color: "#0b0e14", darkIcons: false });
  });

  it("retries a bridge that was not ready yet, then stops once it answers", async () => {
    mocks.setAppearance.mockRejectedValueOnce(new Error("bridge not ready"));
    applyStatusBar("light");
    // Let the rejection reach scheduleRetry before advancing the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.setAppearance).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(mocks.setAppearance).toHaveBeenCalledTimes(2);
    // The second call resolved, so the chain is done.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.setAppearance).toHaveBeenCalledTimes(2);
  });

  it("drops a stale retry chain when the appearance changed", async () => {
    mocks.setAppearance.mockRejectedValueOnce(new Error("bridge not ready"));
    applyStatusBar("light");
    await vi.advanceTimersByTimeAsync(0);

    applyStatusBar("dark");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent()).toEqual([
      { color: "#f4f6fa", darkIcons: true },
      { color: "#0b0e14", darkIcons: false },
    ]);
  });

  it("does nothing at all outside a native platform", async () => {
    mocks.native = false;
    applyStatusBar("light");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.setAppearance).not.toHaveBeenCalled();
  });

  it("re-sends the last appearance when the page becomes visible again", async () => {
    const state = { visibility: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state.visibility,
    });
    try {
      applyStatusBar("dark");
      state.visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(mocks.setAppearance).toHaveBeenCalledTimes(1);

      state.visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(mocks.setAppearance).toHaveBeenCalledTimes(2);
      expect(sent()[1]).toEqual({ color: "#0b0e14", darkIcons: false });
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    await vi.advanceTimersByTimeAsync(0);
  });
});
