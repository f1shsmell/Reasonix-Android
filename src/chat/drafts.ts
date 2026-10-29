/**
 * Unsent text, kept per session.
 *
 * A phone is interrupted constantly: a call, the home gesture, a dead Wi-Fi.
 * A draft is the person's own text, not a request the kernel has seen, so it
 * belongs on the device and it must not leak into another session. The screen
 * is keyed by runtime id in `App`, so one mount reads exactly one key.
 */

const PREFIX = "reasonix.draft.";

export function loadDraft(runtimeId: string): string {
  if (!runtimeId) return "";
  try {
    return localStorage.getItem(PREFIX + runtimeId) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(runtimeId: string, text: string): void {
  if (!runtimeId) return;
  try {
    if (text.length === 0) localStorage.removeItem(PREFIX + runtimeId);
    else localStorage.setItem(PREFIX + runtimeId, text);
  } catch {
    // Private mode or a full quota costs the draft, not the screen.
  }
}

/** Called once the kernel accepted the text; the draft must not come back. */
export function clearDraft(runtimeId: string): void {
  saveDraft(runtimeId, "");
}
