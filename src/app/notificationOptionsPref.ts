/**
 * Whether ask notifications inline their options.
 *
 * Off by default: the action row is narrow, and a long option is ellipsized by
 * the system. Off means every ask notification carries one action, 去回答,
 * which opens that conversation instead of guessing at a truncated label.
 */
const KEY = "reasonix.notificationOptions.v1";

export function loadNotificationOptions(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function saveNotificationOptions(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // A closed store keeps the previous choice.
  }
}
