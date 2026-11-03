/**
 * Whether this phone buzzes, and where.
 *
 * One master switch, with per-surface preferences under it: a person who
 * wants a tick when a long press arms may not want the phone to buzz while an
 * answer is being written. The master is read first and off means off, so
 * turning vibration off in settings cannot leave one surface still buzzing.
 *
 * The choice lives on this phone, like the theme, and is read at the moment of
 * the buzz so a change applies without a remount.
 */

import { Haptics, ImpactStyle } from "@capacitor/haptics";

const MASTER_KEY = "reasonix.haptics";

/**
 * One surface under the master switch.
 *
 * `drag` covers the long press and the row drag; `stream` covers the start and
 * end of a written answer. They are separate because they answer different
 * things: `drag` acknowledges an action the person took, `stream` reports
 * progress the person did not ask to be notified about.
 */
export type HapticSurface = "drag" | "stream";

const SURFACE_KEYS: Record<HapticSurface, string> = {
  drag: "reasonix.haptics.drag",
  stream: "reasonix.haptics.stream",
};

/**
 * What each surface does when nothing is stored.
 *
 * `drag` stays on because it acknowledges the person's own gesture, and that
 * was the behaviour before this switch existed. `stream` defaults off: an
 * answer being written is not an event worth interrupting for, and a phone
 * that buzzes through a long reply reads as broken rather than responsive.
 */
const SURFACE_DEFAULTS: Record<HapticSurface, boolean> = {
  drag: true,
  stream: false,
};

/** Absent means on: vibration was the behaviour before the switch existed. */
export function loadHaptics(): boolean {
  try {
    return localStorage.getItem(MASTER_KEY) !== "off";
  } catch {
    // A blocked storage API costs the setting, not the feedback.
    return true;
  }
}

export function saveHaptics(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(MASTER_KEY);
    else localStorage.setItem(MASTER_KEY, "off");
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
}

/** Whether one surface may buzz, master switch included. */
export function loadHapticSurface(surface: HapticSurface): boolean {
  return loadHaptics() && loadSurfaceChoice(surface);
}

/**
 * The surface's own choice, ignoring the master switch.
 *
 * The settings screen needs this: a switch has to show what the person stored
 * for that surface, not what the master currently allows. Reading the combined
 * value there would draw a sub-switch as off — and on the next master toggle
 * silently lose a choice the person had already made — just because vibration
 * happened to be off when the screen mounted.
 */
export function loadSurfaceChoice(surface: HapticSurface): boolean {
  const fallback = SURFACE_DEFAULTS[surface];
  try {
    const stored = localStorage.getItem(SURFACE_KEYS[surface]);
    if (stored === null) return fallback;
    return stored === "on";
  } catch {
    return fallback;
  }
}

export function saveHapticSurface(surface: HapticSurface, enabled: boolean): void {
  try {
    // The stored value is the difference from the default, so a future change
    // to a default reaches everyone who never touched this switch.
    if (enabled === SURFACE_DEFAULTS[surface]) {
      localStorage.removeItem(SURFACE_KEYS[surface]);
      return;
    }
    localStorage.setItem(SURFACE_KEYS[surface], enabled ? "on" : "off");
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
}

/** A short system buzz for a gesture the person made, when both switches allow. */
export function vibrate(ms: number): void {
  if (!loadHapticSurface("drag")) return;
  if (typeof navigator.vibrate === "function") navigator.vibrate(ms);
}

/** One light Capacitor tick for a surface that opted in, master switch first. */
export async function hapticTick(surface: HapticSurface = "drag"): Promise<void> {
  if (!loadHapticSurface(surface)) return;
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

/**
 * A sample buzz that proves the hardware works.
 *
 * Deliberately outside the surface switches: this runs the moment someone
 * turns vibration on, and a sample that stayed silent because a sub-switch is
 * off would read as "the switch does nothing".
 */
export async function hapticSample(): Promise<void> {
  if (!loadHaptics()) return;
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

