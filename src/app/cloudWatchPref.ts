/**
 * Whether the phone watches cloud sessions in the background.
 *
 * Default off: the watcher costs battery, and it only works while the app
 * process is alive.
 */
const KEY = "reasonix.cloudWatch.v1";

export function loadCloudWatch(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function saveCloudWatch(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // A full or closed store keeps the previous choice.
  }
}
