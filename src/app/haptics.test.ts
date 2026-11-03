import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Haptics } from "@capacitor/haptics";
import {
  hapticSample,
  hapticTick,
  loadHapticSurface,
  loadSurfaceChoice,
  loadHaptics,
  saveHapticSurface,
  saveHaptics,
  vibrate,
} from "./haptics";

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

describe("haptics surfaces", () => {
  it("keeps gesture feedback on and stream feedback off by default", () => {
    // A gesture acknowledges something the person did; a reply being written
    // is not an event worth interrupting for, so only the former is on.
    expect(loadHapticSurface("drag")).toBe(true);
    expect(loadHapticSurface("stream")).toBe(false);
  });

  it("stores only the difference from the default", () => {
    saveHapticSurface("drag", true);
    expect(localStorage.getItem("reasonix.haptics.drag")).toBeNull();
    saveHapticSurface("drag", false);
    expect(localStorage.getItem("reasonix.haptics.drag")).toBe("off");

    saveHapticSurface("stream", false);
    expect(localStorage.getItem("reasonix.haptics.stream")).toBeNull();
    saveHapticSurface("stream", true);
    expect(localStorage.getItem("reasonix.haptics.stream")).toBe("on");
  });

  it("silences every surface under the master switch", () => {
    // The master is read first, so turning it off cannot leave one surface
    // still buzzing — which is what a per-surface switch alone would do.
    saveHapticSurface("drag", true);
    saveHapticSurface("stream", true);
    saveHaptics(false);

    expect(loadHapticSurface("drag")).toBe(false);
    expect(loadHapticSurface("stream")).toBe(false);
  });

  it("keeps a stored surface choice visible while the master is off", () => {
    // The settings screen reads the surface alone. Reading the combined value
    // would draw the sub-switch as off because vibration happened to be off
    // when the screen mounted, and the person's earlier choice would look
    // like it had never been made.
    saveHapticSurface("stream", true);
    saveHaptics(false);

    expect(loadSurfaceChoice("stream")).toBe(true);
    expect(loadHapticSurface("stream")).toBe(false);

    // Turning the master back on restores the choice instead of losing it.
    saveHaptics(true);
    expect(loadHapticSurface("stream")).toBe(true);
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

  it("stays silent on the stream surface even while the master is on", async () => {
    await hapticTick("stream");
    expect(Haptics.impact).not.toHaveBeenCalled();

    saveHapticSurface("stream", true);
    await hapticTick("stream");
    expect(Haptics.impact).toHaveBeenCalledTimes(1);
  });

  it("keeps gesture feedback controlled by its own switch", () => {
    saveHapticSurface("drag", false);
    vibrate(8);
    expect(buzz).not.toHaveBeenCalled();

    saveHapticSurface("drag", true);
    vibrate(8);
    expect(buzz).toHaveBeenCalledWith(8);
  });

  it("still gives a sample when the master is switched on", async () => {
    // The sample proves the hardware works; silencing it because a sub-switch
    // is off would make turning the master on look broken.
    saveHapticSurface("drag", false);
    saveHapticSurface("stream", false);
    await hapticSample();
    expect(Haptics.impact).toHaveBeenCalledTimes(1);

    saveHaptics(false);
    vi.mocked(Haptics.impact).mockClear();
    await hapticSample();
    expect(Haptics.impact).not.toHaveBeenCalled();
  });
});
