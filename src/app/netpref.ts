/**
 * How the loopback proxy reaches a LAN computer while a VPN is active.
 *
 * The native proxy already re-routes private addresses over the non-VPN
 * Wi-Fi and bypasses system HTTP proxies for them; "auto" is that behaviour.
 * The other two answers exist for the phones where the automatic guess is
 * wrong: "bypass" forces the private-route path even when the active network
 * does not look like a VPN, "system" leaves every connection on the default
 * route for people whose proxy must see LAN traffic too.
 *
 * The choice lives on this phone, like the theme: the proxy reads its own
 * preference store, and the value here keeps the segmented control honest
 * across cold starts. When the proxy has not adopted the choice yet (a fresh
 * install, an old native build), the stored value is still what the screen
 * shows — the native side is the authority, this is the last answer given.
 */

export type NetPolicy = "auto" | "bypass" | "system";

const STORAGE_KEY = "reasonix.net-policy";
const DEFAULT: NetPolicy = "auto";

export const NET_POLICY_CHOICES: ReadonlyArray<{ value: NetPolicy; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "bypass", label: "绕过代理" },
  { value: "system", label: "跟随系统" },
];

export const NET_POLICY_NOTE =
  "自动：连局域网电脑时优先绕开 VPN；绕过代理：始终直连；跟随系统：按系统路由走。";

export function isNetPolicy(value: unknown): value is NetPolicy {
  return value === "auto" || value === "bypass" || value === "system";
}

export function loadNetPolicy(): NetPolicy {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isNetPolicy(stored) ? stored : DEFAULT;
  } catch {
    // A blocked storage API costs the setting, not the screen.
    return DEFAULT;
  }
}

export function saveNetPolicy(policy: NetPolicy): void {
  try {
    if (policy === DEFAULT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, policy);
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
}
