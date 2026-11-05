/**
 * Which notifications this phone posts, and whether they interrupt.
 *
 * Four choices, each a difference from a default rather than a stored
 * `true`/`false`: a later change to a default then reaches everyone who never
 * touched the switch, which matters most for the one that ships off.
 *
 * These are read by the native service, not by a screen, so the phone keeps
 * working with the WebView gone. The store is localStorage because the
 * service starts from the same process; a cold start reads them again.
 *
 * Android draws two of these differently from how they look here:
 *
 * - The ongoing notification **cannot** be removed while the service runs
 *   (the platform requires one for a foreground service). Off means the
 *   channel drops to IMPORTANCE_MIN, so it is still there but no longer takes
 *   a slot in the status bar or makes a sound.
 * - Whether a notification *heads up* is a property of the channel, fixed when
 *   the channel is created. Switching it means posting on a different channel,
 *   which is why there are two ask channels rather than a boolean on one.
 */

import {
  readFlag,
  writeFlag,
  SETTINGS_KEYS,
  SETTINGS_DEFAULTS,
  type NotificationPrefs,
} from "./settings";

export type { NotificationPrefs };

/**
 * Defaults.
 *
 * `ask` and `headsUp` stay on: a blocked turn is the one thing this app must
 * interrupt for, and both were the behaviour before these switches existed.
 * `done` stays on for the same reason — it is the result the person asked for.
 * `ongoing` ships off: it is the notification that is always there, so it is
 * the one place where "silent but present" is the better default than a
 * permanent status-bar icon nobody can dismiss.
 */
const DEFAULTS: NotificationPrefs = { ...SETTINGS_DEFAULTS.notify };

const KEYS: Record<keyof NotificationPrefs, string> = SETTINGS_KEYS.notify;

function read(name: keyof NotificationPrefs): boolean {
  return readFlag(KEYS[name], DEFAULTS[name]);
}

function write(name: keyof NotificationPrefs, on: boolean): void {
  // Only the difference is stored, so an untouched switch follows its default
  // if that default ever changes.
  writeFlag(KEYS[name], on, DEFAULTS[name]);
}

export function loadNotificationPrefs(): NotificationPrefs {
  return {
    ongoing: read("ongoing"),
    ask: read("ask"),
    done: read("done"),
    headsUp: read("headsUp"),
  };
}

export function loadNotificationPref(name: keyof NotificationPrefs): boolean {
  return read(name);
}

export function saveNotificationPref(name: keyof NotificationPrefs, on: boolean): void {
  write(name, on);
}

export function notificationDefaults(): NotificationPrefs {
  return { ...DEFAULTS };
}
