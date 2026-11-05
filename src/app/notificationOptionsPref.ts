/**
 * Whether ask notifications inline their options.
 *
 * Off by default: the action row is narrow, and a long option is ellipsized by
 * the system. Off means every ask notification carries one action, 去回答,
 * which opens that conversation instead of guessing at a truncated label.
 */
import { readFlag, writeFlag, SETTINGS_KEYS, SETTINGS_DEFAULTS } from "./settings";

export function loadNotificationOptions(): boolean {
  return readFlag(SETTINGS_KEYS.notificationOptions, SETTINGS_DEFAULTS.notificationOptions);
}

export function saveNotificationOptions(on: boolean): void {
  writeFlag(SETTINGS_KEYS.notificationOptions, on, SETTINGS_DEFAULTS.notificationOptions);
}
