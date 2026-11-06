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

/** Substitute the tokens the page would have resolved from `tokens.css`. */
let palette: Record<string, string> = {};
function paint(tokens: Record<string, string>): void {
  palette = tokens;
}

beforeEach(() => {
  mocks.setAppearance.mockReset();
  mocks.setAppearance.mockResolvedValue(undefined);
  mocks.native = true;
  palette = {};
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => palette[name] ?? "",
      }) as unknown as CSSStyleDeclaration,
  );
  vi.useFakeTimers();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-style");
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("applyStatusBar", () => {
  it("reports the page's own background and the matching icon shade", () => {
    paint({ "--bg": "#f7f3ea" });
    applyStatusBar("light");
    expect(sent()).toEqual([{ color: "#f7f3ea", darkIcons: true }]);
    paint({ "--bg": "#16130e" });
    applyStatusBar("dark");
    expect(sent()[1]).toEqual({ color: "#16130e", darkIcons: false });
  });

  it("accepts rgb() and falls back to the channel triplet", () => {
    paint({ "--bg": "rgb(247, 243, 234)" });
    applyStatusBar("light");
    paint({ "--bg-rgb": "31, 27, 20" });
    applyStatusBar("light");
    expect(sent()).toEqual([
      { color: "#f7f3ea", darkIcons: true },
      { color: "#1f1b14", darkIcons: true },
    ]);
  });

  it("repaints when a root attribute switches the palette", async () => {
    paint({ "--bg": "#f4f6fa" });
    applyStatusBar("light");
    expect(sent()).toHaveLength(1);

    paint({ "--bg": "#f7f3ea" });
    document.documentElement.setAttribute("data-style", "paper");
    await Promise.resolve();
    await Promise.resolve();

    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual({ color: "#f7f3ea", darkIcons: true });

    // Another attribute with the same palette is not a repaint.
    document.documentElement.setAttribute("data-mode", "same");
    await Promise.resolve();
    await Promise.resolve();
    expect(sent()).toHaveLength(2);
  });

  it("retries a bridge that was not ready yet, then stops once it answers", async () => {
    paint({ "--bg": "#f4f6fa" });
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

  it("retries when the stylesheet has not resolved yet", async () => {
    applyStatusBar("light");
    expect(mocks.setAppearance).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    paint({ "--bg": "#f7f3ea" });
    await vi.advanceTimersByTimeAsync(400);

    expect(sent()).toEqual([{ color: "#f7f3ea", darkIcons: true }]);
  });

  it("drops a stale retry chain when the appearance changed", async () => {
    paint({ "--bg": "#f4f6fa" });
    mocks.setAppearance.mockRejectedValueOnce(new Error("bridge not ready"));
    applyStatusBar("light");
    await vi.advanceTimersByTimeAsync(0);

    paint({ "--bg": "#0b0e14" });
    applyStatusBar("dark");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent()).toEqual([
      { color: "#f4f6fa", darkIcons: true },
      { color: "#0b0e14", darkIcons: false },
    ]);
  });

  it("does nothing at all outside a native platform", async () => {
    mocks.native = false;
    paint({ "--bg": "#f4f6fa" });
    applyStatusBar("light");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.setAppearance).not.toHaveBeenCalled();
  });

  it("re-sends the current palette when the page becomes visible again", async () => {
    const state = { visibility: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state.visibility,
    });
    try {
      paint({ "--bg": "#0b0e14" });
      applyStatusBar("dark");
      state.visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(mocks.setAppearance).toHaveBeenCalledTimes(1);

      // The system palette moved while the page was hidden.
      paint({ "--bg": "#16130e" });
      state.visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(mocks.setAppearance).toHaveBeenCalledTimes(2);
      expect(sent()[1]).toEqual({ color: "#16130e", darkIcons: false });
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    await vi.advanceTimersByTimeAsync(0);
  });
});
