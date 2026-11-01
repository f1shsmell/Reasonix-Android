/**
 * The last cloud device this phone connected to.
 *
 * The proxy forgets `relayDevice` when a LAN connection takes over, because
 * only one upstream can be active. Keeping the id here is what lets a later
 * LAN failure fall back to the relay without asking the person to pick the
 * computer again. It is only a hint: the grant is still requested fresh.
 */

const KEY = "reasonix.relay.device";
/**
 * The person disconnected on purpose and it should survive a restart: the
 * boot path reads this and leaves the phone offline instead of quietly
 * re-establishing the last connection. Only a person's own connect clears it.
 */
const STAND_DOWN_KEY = "reasonix.link.stand-down";

export function loadStandDown(): boolean {
  try {
    return localStorage.getItem(STAND_DOWN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveStandDown(): void {
  try {
    localStorage.setItem(STAND_DOWN_KEY, "1");
  } catch {
    // A lost mark costs one automatic reconnect, not a broken promise.
  }
}

export function clearStandDown(): void {
  try {
    localStorage.removeItem(STAND_DOWN_KEY);
  } catch {
    // ignore
  }
}

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
