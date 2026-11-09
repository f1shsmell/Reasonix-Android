/**
 * Whether the phone keeps conversation content between launches.
 *
 * On by default: the transcript cache is what lets a reopened conversation
 * paint before `GET /history` lands. Turning it off is a privacy choice, not a
 * space one — the rows include the person's own words, the model's reasoning
 * and tool output, and none of it should stay on the device.
 *
 * The guard lives in the cache module rather than at each call site, so a
 * reader or writer added later inherits it without remembering to ask.
 */
import { readFlag, writeFlag, SETTINGS_KEYS, SETTINGS_DEFAULTS } from "./settings";

export function loadRetainTranscript(): boolean {
  return readFlag(SETTINGS_KEYS.retainTranscript, SETTINGS_DEFAULTS.retainTranscript);
}

export function saveRetainTranscript(on: boolean): void {
  writeFlag(SETTINGS_KEYS.retainTranscript, on, SETTINGS_DEFAULTS.retainTranscript);
}
