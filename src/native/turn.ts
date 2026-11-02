/**
 * The native foreground-service bridge.
 *
 * Browser builds and tests have no service; both helpers become no-ops there.
 * Failures are swallowed by design: a missing notification must never fail a
 * turn that the kernel is already running.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

export interface TurnLink {
  title?: string;
  /** The runtime's request prefix, e.g. `/rt/ab12`. */
  base?: string;
  /** The project root, carried so the notification can open the chat. */
  root?: string;
  runtimeId?: string;
  /** How the kernel is reached, named in the ongoing notification. */
  mode?: "lan" | "cloud";
}

export interface BackgroundStatus {
  /** The system allows this app to run outside its battery optimizations. */
  exempt: boolean;
  /** The system will show this app's notifications. */
  notifications: boolean;
}

export interface NativeDiagnostics {
  version?: string;
  build?: number;
  android?: string;
  sdk?: number;
  model?: string;
  manufacturer?: string;
  exempt?: boolean;
  notifications?: boolean;
}

interface TurnNotificationsPlugin {
  start(options: TurnLink): Promise<void>;
  stop(options: { completed?: boolean }): Promise<void>;
  startCloudWatch(): Promise<void>;
  stopCloudWatch(): Promise<void>;
  backgroundStatus(): Promise<BackgroundStatus>;
  diagnostics(): Promise<NativeDiagnostics>;
  openBatterySettings(): Promise<void>;
  openNotificationSettings(): Promise<void>;
}

const TurnNotifications = registerPlugin<TurnNotificationsPlugin>("TurnNotifications");

export function startTurnNotification(link: TurnLink = {}): void {
  if (!Capacitor.isNativePlatform()) return;
  const options: TurnLink = {};
  if (link.title) options.title = link.title;
  if (link.base) options.base = link.base;
  if (link.root) options.root = link.root;
  if (link.runtimeId) options.runtimeId = link.runtimeId;
  if (link.mode) options.mode = link.mode;
  void TurnNotifications.start(options).catch(() => {
    // The notification is a convenience; the turn is not.
  });
}

export function stopTurnNotification(completed = false): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.stop({ completed }).catch(() => {
    // Nothing to do; the service stops with the process anyway.
  });
}

/** Start the persistent cloud watcher; the caller must be in the foreground. */
export function startCloudWatch(): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.startCloudWatch().catch(() => {
    // The switch stays on; the next foreground change retries.
  });
}

export function stopCloudWatch(): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.stopCloudWatch().catch(() => {
    // Nothing to do; the service stops with the process anyway.
  });
}

/**
 * Whether notifications and battery settings let this app work in the
 * background. `null` in a browser, or when the native side cannot answer —
 * the screen then hides the rows rather than claiming a state it does not
 * know.
 */
export async function loadBackgroundStatus(): Promise<BackgroundStatus | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await TurnNotifications.backgroundStatus();
  } catch {
    return null;
  }
}

export function openBatterySettings(): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.openBatterySettings().catch(() => {
    // No settings page on this device; the hint stays as a sentence.
  });
}

/** Native facts for the copy-diagnostics row; null in a browser. */
export async function readNativeDiagnostics(): Promise<NativeDiagnostics | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await TurnNotifications.diagnostics();
  } catch {
    return null;
  }
}

export function openNotificationSettings(): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.openNotificationSettings().catch(() => {
    // Same as above.
  });
}
