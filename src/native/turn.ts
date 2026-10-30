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
}

interface TurnNotificationsPlugin {
  start(options: TurnLink): Promise<void>;
  stop(options: { completed?: boolean }): Promise<void>;
}

const TurnNotifications = registerPlugin<TurnNotificationsPlugin>("TurnNotifications");

export function startTurnNotification(link: TurnLink = {}): void {
  if (!Capacitor.isNativePlatform()) return;
  const options: TurnLink = {};
  if (link.title) options.title = link.title;
  if (link.base) options.base = link.base;
  if (link.root) options.root = link.root;
  if (link.runtimeId) options.runtimeId = link.runtimeId;
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
