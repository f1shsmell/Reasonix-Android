/**
 * Whether the phone watches cloud sessions in the background.
 *
 * Default off: the watcher costs battery, and it only works while the app
 * process is alive.
 */
import { readFlag, writeFlag, SETTINGS_KEYS } from "./settings";

export function loadCloudWatch(): boolean {
  return readFlag(SETTINGS_KEYS.cloudWatch, false);
}

export function saveCloudWatch(on: boolean): void {
  writeFlag(SETTINGS_KEYS.cloudWatch, on, false);
}
