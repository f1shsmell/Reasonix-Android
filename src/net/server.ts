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

import { fetchWithTimeout, RequestTimeout } from "./http";

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
  /**
   * The same addresses in the order the proxy would try them: the ones on a
   * Wi-Fi/Ethernet interface this phone is attached to come first.
   *
   * Kept beside `candidates` rather than replacing it, because a phone that
   * left that network still has to see every door it remembers. A browser dev
   * session has no proxy and therefore no order.
   */
  preferred?: string[];
  /**
   * The subset of `candidates` reachable without a tunnel.
   *
   * Separate from `preferred` on purpose: that one is a full ordering, so
   * every address is in it. Only this says which doors are neighbours of the
   * phone's own Wi-Fi.
   */
  direct?: string[];
  paired: boolean;
  /** `relay` means kernel requests go through the account relay, not a LAN origin. */
  mode?: "lan" | "relay";
  relayDevice?: string;
  /** A VPN/HTTP proxy is active on this phone. */
  vpn?: boolean;
  /** A non-VPN Wi-Fi or Ethernet interface is available for a LAN share. */
  lan?: boolean;
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
  // The proxy may spend 25 s reaching a share listener before it can name the
  // refusal; a shorter client deadline would replace that code with a timeout.
  return request<ProxyConfig>(
    "/__reasonix/config",
    {
      method: "POST",
      body: JSON.stringify({ origin, ...(pairCode ? { pairCode } : {}) }),
    },
    pairCode ? 35_000 : undefined,
  );
}

export async function refreshProxy(): Promise<ProxyConfig | null> {
  try {
    return await request<ProxyConfig>("/__reasonix/refresh", { method: "POST" });
  } catch {
    return null;
  }
}

export async function startAccount(): Promise<DeviceGrant> {
  // The proxy's own connect deadline is 15 s. Giving the request a longer
  // deadline lets a stalled IPv6 route fall through to IPv4, and lets the
  // proxy's refusal arrive with a code instead of a bare client timeout.
  return request<DeviceGrant>("/__reasonix/account/start", { method: "POST" }, 25_000);
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

/**
 * Sign in with the account's own email and password.
 *
 * This is the fast path: the proxy talks to the identity service directly and
 * keeps the session cookie, so the account can be approved without loading the
 * sign-in page. The page remains the way to register, verify and reset.
 */
export async function signInAccount(email: string, password: string): Promise<ProxyAccount> {
  return request<ProxyAccount>(
    "/__reasonix/account/signin",
    { method: "POST", body: JSON.stringify({ email, password }) },
    25_000,
  );
}

/** Approve the pending device code with the account session the proxy holds. */
export async function approveDevice(userCode: string): Promise<void> {
  await request(
    "/__reasonix/account/approve",
    { method: "POST", body: JSON.stringify({ userCode }) },
    25_000,
  );
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

// ---- fleet: the other computers this phone listens to -------------------

/**
 * A computer the fleet watches. The proxy holds the list; the app only
 * mirrors it, so both sides agree on what an index names.
 */
export interface FleetEntry {
  kind: "lan" | "cloud";
  /** A LAN origin, or a cloud device id when one is stored. */
  target: string;
  name: string;
  /** Cloud peers are listed but have no read route until they are active. */
  watchable: boolean;
}

/** `null` in a browser, where the proxy does not exist. */
export async function loadFleet(): Promise<FleetEntry[] | null> {
  try {
    const body = await request<{ peers?: FleetEntry[] }>("/__reasonix/fleet");
    return Array.isArray(body.peers) ? body.peers : [];
  } catch {
    return null;
  }
}

/** Replace the whole watch list. The proxy rejects more than four. */
export async function saveFleet(peers: FleetEntry[]): Promise<void> {
  await request("/__reasonix/fleet", {
    method: "POST",
    body: JSON.stringify({ peers: peers.slice(0, 4) }),
  });
}

/**
 * One kernel read through a watched peer's route.
 *
 * The full path is the caller's (`/__reasonix/fleet/<index>/...`), because the
 * fleet reads several shapes and the proxy owns what the index means. A
 * refusal is classified, not swallowed: 401/403 is that computer's pairing
 * having expired, which reads differently from a computer that is not there.
 */
export type FleetRead =
  | { ok: true; body: unknown }
  | { ok: false; code: string };

export async function fleetRead(path: string, timeoutMs = 8_000): Promise<FleetRead> {
  try {
    const response = await fetchWithTimeout(path, { credentials: "same-origin" }, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "device.unauthorized" };
    }
    if (!response.ok) return { ok: false, code: `http.${response.status}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RequestTimeout ? "client.timeout" : "client.offline",
    };
  }
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

/**
 * Whether the active upstream can actually answer for a kernel.
 *
 * Writing an origin or a relay into the proxy only says where requests will
 * go; it does not say anything is there. This read is the difference between
 * "connected" and "the settings page saved a dead address", and it is the
 * last step of every connect and every recovery.
 */
export type UpstreamReach = { ok: true } | { ok: false; code: string };

export async function probeUpstream(timeoutMs = 12_000): Promise<UpstreamReach> {
  try {
    const response = await fetchWithTimeout("/runtimes", { credentials: "same-origin" }, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "device.unauthorized" };
    }
    if (!response.ok) return { ok: false, code: `http.${response.status}` };
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return { ok: false, code: "runtime.shape" };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RequestTimeout ? "client.timeout" : "client.offline",
    };
  }
}

/**
 * The first remembered LAN address that answers at all, in preference order.
 *
 * The probes run together: a phone away from home should not spend a second
 * per remembered computer before letting the account relay have its turn.
 */
export async function firstAnswering(origins: string[], timeoutMs = 2_500): Promise<string | null> {
  const answers = await Promise.all(
    origins.map(async (origin) => ({ origin, ok: await originAnswers(origin, timeoutMs) })),
  );
  return answers.find((entry) => entry.ok)?.origin ?? null;
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
