/**
 * Phone-local settings: one storage boundary, one version marker.
 *
 * Each setting still owns its defaults and domain rules; this module owns the
 * key, the localStorage try/catch, and the "store only a difference" rule.
 * A version marker gives a later build a place to migrate from without
 * guessing which keys an older install wrote.
 */

const VERSION_KEY = "reasonix.settings.version";
const VERSION = 1;

export type ThemeChoice = "auto" | "light" | "dark";
export type UiStyle = "paper" | "studio";
export type DispatchAfter = "stay" | "recent" | "session";
export type EnterPref = "send" | "newline";
export type NetPolicy = "auto" | "bypass" | "system";
export type ChatFont = "sm" | "standard" | "lg" | "xl";
export type FoldMode = "compact" | "standard" | "full";
export type HapticSurface = "drag" | "stream";

export interface NotificationPrefs {
  ongoing: boolean;
  ask: boolean;
  done: boolean;
  headsUp: boolean;
}

export const SETTINGS_DEFAULTS = {
  theme: "auto",
  uiStyle: "paper",
  dispatchAfter: "recent",
  enter: "newline",
  netPolicy: "auto",
  chatFont: "standard",
  folding: "standard",
  notificationOptions: false,
  cloudWatch: false,
  notify: { ongoing: false, ask: true, done: true, headsUp: true },
  haptics: { master: true, drag: true, stream: false },
} as const;

export const SETTINGS_KEYS = {
  theme: "reasonix.theme",
  uiStyle: "reasonix.ui-style",
  dispatchAfter: "reasonix.dispatch-after",
  enter: "reasonix.enter",
  netPolicy: "reasonix.net-policy",
  chatFont: "reasonix.chat-font.v1",
  folding: "reasonix.folding.v1",
  notificationOptions: "reasonix.notificationOptions.v1",
  cloudWatch: "reasonix.cloudWatch.v1",
  notify: {
    ongoing: "reasonix.notify.ongoing",
    ask: "reasonix.notify.ask",
    done: "reasonix.notify.done",
    headsUp: "reasonix.notify.headsUp",
  },
  haptics: {
    master: "reasonix.haptics",
    drag: "reasonix.haptics.drag",
    stream: "reasonix.haptics.stream",
  },
} as const;

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A closed store keeps the previous choice; the screen still works.
  }
}

export function readChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readRaw(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function writeChoice<T extends string>(
  key: string,
  value: T,
  fallback: T,
): void {
  // Only the difference is stored, so a later default change reaches anyone
  // who never touched the switch.
  writeRaw(key, value === fallback ? null : value);
}

export function readFlag(key: string, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  return raw === "on";
}

export function writeFlag(key: string, on: boolean, fallback: boolean): void {
  writeRaw(key, on === fallback ? null : on ? "on" : "off");
}

/**
 * Record that this build has seen the current key layout.
 *
 * No key moved in v1; the marker is what lets a later migration know which
 * layout it is upgrading rather than treating every absent key as fresh.
 */
export function migrateSettings(): void {
  if (readRaw(VERSION_KEY) === String(VERSION)) return;
  writeRaw(VERSION_KEY, String(VERSION));
}