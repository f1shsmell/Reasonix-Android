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

/** What a notification surface does when nothing is stored. */
export interface NotificationPrefs {
  /** The ongoing "turn running" notification. Off keeps it, but silent. */
  ongoing: boolean;
  /** `ask` notifications: a turn is blocked on a decision. */
  ask: boolean;
  /** `done` notifications: a turn finished. */
  done: boolean;
  /** Ask notifications may heads-up instead of waiting in the shade. */
  headsUp: boolean;
}

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
const DEFAULTS: NotificationPrefs = {
  ongoing: false,
  ask: true,
  done: true,
  headsUp: true,
};

const KEYS: Record<keyof NotificationPrefs, string> = {
  ongoing: "reasonix.notify.ongoing",
  ask: "reasonix.notify.ask",
  done: "reasonix.notify.done",
  headsUp: "reasonix.notify.headsUp",
};

function read(name: keyof NotificationPrefs): boolean {
  const fallback = DEFAULTS[name];
  try {
    const stored = localStorage.getItem(KEYS[name]);
    if (stored === null) return fallback;
    return stored === "on";
  } catch {
    return fallback;
  }
}

function write(name: keyof NotificationPrefs, on: boolean): void {
  try {
    // Only the difference is stored, so an untouched switch follows its
    // default if that default ever changes.
    if (on === DEFAULTS[name]) {
      localStorage.removeItem(KEYS[name]);
      return;
    }
    localStorage.setItem(KEYS[name], on ? "on" : "off");
  } catch {
    // A closed store keeps the previous choice.
  }
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
