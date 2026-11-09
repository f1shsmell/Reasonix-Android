/**
 * Whether the app may move itself between a computer's LAN and cloud doors.
 *
 * Default on: a handover is what keeps a conversation alive when the phone
 * leaves the Wi-Fi, and it never changes which computer is on screen — see
 * `sameMachine` in `net/sameMachine`. Turning it off makes the link stay on
 * the door it is on: a dead route is retried and eventually reported, but the
 * transport is never swapped behind the person's back.
 *
 * It is a person's switch, not a policy: the settings screen writes it, and
 * every automatic attempt reads it fresh, so flipping it takes effect on the
 * next kick rather than on the next cold start.
 */
import { readFlag, writeFlag, SETTINGS_KEYS, SETTINGS_DEFAULTS } from "./settings";

export function loadAutoHandover(): boolean {
  return readFlag(SETTINGS_KEYS.autoHandover, SETTINGS_DEFAULTS.autoHandover);
}

export function saveAutoHandover(on: boolean): void {
  writeFlag(SETTINGS_KEYS.autoHandover, on, SETTINGS_DEFAULTS.autoHandover);
}
