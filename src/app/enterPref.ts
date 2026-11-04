/**
 * What Enter does in the composer.
 *
 * A phone keyboard's Enter is the send key people expect, which is why this
 * used to be the default. It is not the default any more: a half-written
 * thought sent by a stray key is the worse failure, and the send button is
 * always one tap away. A hardware keyboard gets the same rule — Enter breaks
 * the line, Ctrl/⌘+Enter sends — so the two never disagree.
 *
 * The choice lives on this phone, like the theme and the fold: it is about
 * this device's keyboard, not about the kernel.
 */

export type EnterPref = "send" | "newline";

const STORAGE_KEY = "reasonix.enter";
const DEFAULT: EnterPref = "newline";

export const ENTER_CHOICES: ReadonlyArray<{ value: EnterPref; label: string }> = [
  { value: "newline", label: "换行" },
  { value: "send", label: "发送" },
];

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
