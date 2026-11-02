/**
 * Whether this phone buzzes.
 *
 * Three surfaces use it — a held row, a picked-up project and a streaming
 * answer — and they must agree: turning the switch off in settings cannot
 * leave one of them still ticking. The choice lives on this phone, like the
 * theme, and is read at the moment of the buzz so a change applies without a
 * remount.
 */

import { Haptics, ImpactStyle } from "@capacitor/haptics";

const STORAGE_KEY = "reasonix.haptics";

/** Absent means on: vibration was the behaviour before the switch existed. */
export function loadHaptics(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    // A blocked storage API costs the setting, not the feedback.
    return true;
  }
}

export function saveHaptics(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, "off");
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
}

/** A short system buzz, when the preference allows it. */
export function vibrate(ms: number): void {
  if (!loadHaptics()) return;
  if (typeof navigator.vibrate === "function") navigator.vibrate(ms);
}

/** One light Capacitor tick, when the preference allows it. */
export async function hapticTick(): Promise<void> {
  if (!loadHaptics()) return;
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}
