/**
 * The native foreground-service bridge.
 *
 * Browser builds and tests have no service; both helpers become no-ops there.
 * Failures are swallowed by design: a missing notification must never fail a
 * turn that the kernel is already running.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface TurnNotificationsPlugin {
  start(options: { title?: string }): Promise<void>;
  stop(options: { completed?: boolean }): Promise<void>;
}

const TurnNotifications = registerPlugin<TurnNotificationsPlugin>("TurnNotifications");

export function startTurnNotification(title?: string): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.start(title ? { title } : {}).catch(() => {
    // The notification is a convenience; the turn is not.
  });
}

export function stopTurnNotification(completed = false): void {
  if (!Capacitor.isNativePlatform()) return;
  void TurnNotifications.stop({ completed }).catch(() => {
    // Nothing to do; the service stops with the process anyway.
  });
}
