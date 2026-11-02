/**
 * What Enter does in the composer.
 *
 * The phone keyboard's Enter is the send key people expect, so that is the
 * default and there was no choice before. But a phone is also the device a
 * hardware keyboard gets attached to — a foldable, a tablet with a cover —
 * and on those, Enter-as-newline with a modifier to send is the convention
 * every other editor on the device follows.
 *
 * The choice lives on this phone, like the theme and the fold: it is about
 * this device's keyboard, not about the kernel.
 */

export type EnterPref = "send" | "newline";

const STORAGE_KEY = "reasonix.enter";
const DEFAULT: EnterPref = "send";

export const ENTER_CHOICES: ReadonlyArray<{ value: EnterPref; label: string }> = [
  { value: "send", label: "发送" },
  { value: "newline", label: "换行" },
];

export const ENTER_NOTE =
  "换行：Enter 换行，Ctrl/⌘+Enter 发送，适合外接键盘；发送：Enter 直接发送（默认）。";

export function isEnterPref(value: unknown): value is EnterPref {
  return value === "send" || value === "newline";
}

export function loadEnterPref(): EnterPref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isEnterPref(stored) ? stored : DEFAULT;
  } catch {
    // A blocked storage API costs the setting, not the screen.
    return DEFAULT;
  }
}

export function saveEnterPref(pref: EnterPref): void {
  try {
    if (pref === DEFAULT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
}
