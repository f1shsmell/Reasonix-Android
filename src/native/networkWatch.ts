import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type { NetworkStatus } from "../net/network";

interface NetworkWatchEvent extends NetworkStatus {
  /** True for a callback; false for a status read. */
  changed: boolean;
}

interface NetworkWatchPlugin {
  getStatus(): Promise<NetworkWatchEvent>;
  addListener(
    eventName: "changed",
    listener: (event: NetworkWatchEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const NetworkWatch = registerPlugin<NetworkWatchPlugin>("NetworkWatch");

export async function readNetworkStatus(): Promise<NetworkStatus | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await NetworkWatch.getStatus();
  } catch {
    return null;
  }
}

/** Every default-network change, including a Wi-Fi handover with no dropout. */
export async function onNetworkChange(
  listener: (status: NetworkStatus) => void,
): Promise<PluginListenerHandle | null> {
  if (!Capacitor.isNativePlatform()) return null;
  return NetworkWatch.addListener("changed", (status) => listener(status));
}
