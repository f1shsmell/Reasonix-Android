/**
 * The loopback proxy's control plane.
 *
 * On Android the WebView loads `http://127.0.0.1:8788`; that same origin
 * answers `/__reasonix/*`, so the app can change its upstream, pair with a
 * scanned code and drive the account device flow without a browser origin in
 * the way. In a browser dev session those routes do not exist: every read
 * reports `null` and every write throws a `ProxyError`, which is what the
 * Connect screen shows.
 */

import { fetchWithTimeout } from "./http";

export interface ProxyUser {
  handle?: string;
  email?: string;
  label?: string;
}

export interface ProxyAccount {
  signedIn: boolean;
  user?: ProxyUser;
}

export interface ProxyConfig {
  origin: string;
  candidates: string[];
  paired: boolean;
  /** `relay` means kernel requests go through the account relay, not a LAN origin. */
  mode?: "lan" | "relay";
  relayDevice?: string;
  account: ProxyAccount;
}

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface PollResult {
  status: "pending" | "complete" | "slow_down" | "ended" | "error";
  user?: ProxyUser;
  code?: string;
}

export class ProxyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const response = await fetchWithTimeout(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  }, timeoutMs);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code =
      body !== null && typeof body === "object" && "code" in body
        ? String((body as { code: unknown }).code)
        : `http.${response.status}`;
    throw new ProxyError(response.status, code);
  }
  return body as T;
}

/** `null` in a browser, where the proxy does not exist. */
export async function readProxyConfig(): Promise<ProxyConfig | null> {
  try {
    return await request<ProxyConfig>("/__reasonix/config");
  } catch {
    return null;
  }
}

export async function configureProxy(origin: string, pairCode?: string): Promise<ProxyConfig> {
  return request<ProxyConfig>("/__reasonix/config", {
    method: "POST",
    body: JSON.stringify({ origin, ...(pairCode ? { pairCode } : {}) }),
  });
}

export async function refreshProxy(): Promise<ProxyConfig | null> {
  try {
    return await request<ProxyConfig>("/__reasonix/refresh", { method: "POST" });
  } catch {
    return null;
  }
}

export async function startAccount(): Promise<DeviceGrant> {
  return request<DeviceGrant>("/__reasonix/account/start", { method: "POST" });
}

export async function pollAccount(deviceCode: string): Promise<PollResult> {
  return request<PollResult>("/__reasonix/account/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode }),
  });
}

export async function signOutAccount(): Promise<ProxyAccount> {
  return request<ProxyAccount>("/__reasonix/account/logout", { method: "POST" });
}

export interface RemoteDevice {
  id: string;
  name?: string;
  platform?: string;
  capabilities?: string[];
  lastSeenAt?: string | null;
  revokedAt?: string | null;
}

export async function listRemoteDevices(): Promise<RemoteDevice[]> {
  const body = await request<{ devices?: RemoteDevice[] }>("/__reasonix/account/devices");
  return Array.isArray(body.devices) ? body.devices.filter((device) => !device.revokedAt) : [];
}

export interface RelayGrantResponse {
  grant: { ticket: string };
  device: { id: string; publicKey: string; capabilities: string[]; revokedAt?: string | null };
  relay?: string | null;
}

export async function grantRelay(deviceId: string): Promise<RelayGrantResponse> {
  return request<RelayGrantResponse>("/__reasonix/account/grant", {
    method: "POST",
    body: JSON.stringify({ deviceId }),
  });
}

export async function markRelay(deviceId: string): Promise<ProxyConfig> {
  return request<ProxyConfig>("/__reasonix/relay", {
    method: "POST",
    body: JSON.stringify({ deviceId }),
  });
}

export async function clearRelay(): Promise<ProxyConfig> {
  return request<ProxyConfig>("/__reasonix/relay/clear", { method: "POST" });
}

/**
 * Whether a remembered LAN origin answers at all.
 *
 * A `no-cors` GET cannot read the reply, and that is the point: the question
 * is about the network — is that computer still there? — not about the
 * kernel's answer, which the proxy checks once the upstream is switched. The
 * short deadline is what keeps an address left behind on another Wi-Fi from
 * holding up the fallback to the account relay.
 */
export async function originAnswers(origin: string, timeoutMs = 2_500): Promise<boolean> {
  const target = origin.trim().replace(/\/+$/, "");
  if (!target) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${target}/`, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type ServerLink =
  | { kind: "lan"; origin: string; pairCode?: string }
  | { kind: "cloud"; device: string };

/**
 * Read what a Studio QR code carries.
 *
 * The LAN code is `http://<ip>:<port>/#pair=<one-time code>`. The Internet
 * code is `https://reasonix.io/remote/?device=<id>`: a web page, not a kernel
 * origin, so it is reported as a cloud link rather than used as an upstream.
 */
export function parseServerLink(raw: string): ServerLink | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "reasonix:") {
      // reasonix://connect?origin=http%3A%2F%2Fhost%3Aport&pair=code
      // or reasonix://open?url=<an http(s) share link>.
      const nested = url.searchParams.get("url");
      if (nested) return parseServerLink(nested);
      const rawOrigin = url.searchParams.get("origin") ?? url.searchParams.get("server");
      if (!rawOrigin) return null;
      const target = new URL(rawOrigin);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      const pairCode = url.searchParams.get("pair") ?? url.searchParams.get("code");
      return {
        kind: "lan",
        origin: `${target.protocol}//${target.host}`,
        ...(pairCode ? { pairCode } : {}),
      };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const device = url.searchParams.get("device") ?? fragment.get("device");
    if (device) return { kind: "cloud", device };
    const pairCode = fragment.get("pair") ?? url.searchParams.get("pair");
    return {
      kind: "lan",
      origin: `${url.protocol}//${url.host}`,
      ...(pairCode ? { pairCode } : {}),
    };
  } catch {
    return null;
  }
}
