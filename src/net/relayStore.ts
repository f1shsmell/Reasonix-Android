/**
 * The last cloud device this phone connected to.
 *
 * The proxy forgets `relayDevice` when a LAN connection takes over, because
 * only one upstream can be active. Keeping the id here is what lets a later
 * LAN failure fall back to the relay without asking the person to pick the
 * computer again. It is only a hint: the grant is still requested fresh.
 */

const KEY = "reasonix.relay.device";

export function loadRelayDevice(): string | null {
  try {
    const value = localStorage.getItem(KEY);
    return value ? value : null;
  } catch {
    return null;
  }
}

export function saveRelayDevice(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(KEY, deviceId);
  } catch {
    // A lost hint costs a reconnect, not correctness.
  }
}

export function clearRelayDevice(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
