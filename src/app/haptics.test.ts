import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Haptics } from "@capacitor/haptics";
import { hapticTick, loadHaptics, saveHaptics, vibrate } from "./haptics";

vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: vi.fn(async () => undefined) },
  ImpactStyle: { Light: "LIGHT" },
}));

const buzz = vi.fn();

beforeEach(() => {
  localStorage.clear();
  buzz.mockClear();
  vi.mocked(Haptics.impact).mockClear();
  Object.defineProperty(navigator, "vibrate", {
    value: buzz,
    configurable: true,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("haptics preference", () => {
  it("is on until the person turns it off", () => {
    expect(loadHaptics()).toBe(true);
    saveHaptics(false);
    expect(loadHaptics()).toBe(false);
    // Turning it back on writes the default, not a second stored value.
    saveHaptics(true);
    expect(loadHaptics()).toBe(true);
    expect(localStorage.getItem("reasonix.haptics")).toBeNull();
  });

  it("treats an unreadable stored value as on", () => {
    localStorage.setItem("reasonix.haptics", "something else");
    expect(loadHaptics()).toBe(true);
  });
});

describe("haptics actions", () => {
  it("buzzes and ticks while the preference is on", async () => {
    vibrate(12);
    expect(buzz).toHaveBeenCalledWith(12);
    await hapticTick();
    expect(Haptics.impact).toHaveBeenCalledWith({ style: "LIGHT" });
  });

  it("stays silent for every surface once it is off", async () => {
    saveHaptics(false);
    vibrate(12);
    await hapticTick();
    expect(buzz).not.toHaveBeenCalled();
    expect(Haptics.impact).not.toHaveBeenCalled();
  });
});
