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
import { kernelTransport } from "./transport";

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
  /**
   * The loopback proxy's own origin, for the in-app full Studio WebView.
   * Empty (or absent) on a cloud door and in a browser dev session.
   */
  studioUrl?: string;
  /** A VPN/HTTP proxy is active on this phone. */
  vpn?: boolean;
  /** A non-VPN Wi-Fi or Ethernet interface is available for a LAN share. */
  lan?: boolean;
  /**
   * How the proxy reaches a LAN computer while a VPN is active. Absent on an
   * old native build or in a browser, where the proxy itself does not exist.
   */
  netPolicy?: "auto" | "bypass" | "system";
  /**
   * A dev-only kernel owns this browser profile; saved doors are from another
   * session and must not win over the configured origin.
   */
  ephemeral?: boolean;
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

/**
 * Tell the proxy how to reach a LAN computer while a VPN is active.
 *
 * The write is fire-and-forget on purpose: the proxy adopts what it receives
 * and answers with the full config, but a phone that leaves this screen the
 * moment it taps should not wait on the round trip. A refusal here is not
 * shown — an old native build simply ignores the field, and the segmented
 * control already says what it sent.
 */
export async function setNetworkPolicy(policy: "auto" | "bypass" | "system"): Promise<void> {
  await request("/__reasonix/net-policy", {
    method: "POST",
    body: JSON.stringify({ policy }),
  });
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

/**
 * Drop the active upstream: no origin, no relay device.
 *
 * Saved connections and pairing cookies survive, so reconnecting is one tap
 * on a remembered row or one scan. This is the "断开连接" the settings screen
 * offers; a phone that only clears the app side would leave the proxy still
 * forwarding to a computer the person asked it to leave.
 */
export async function disconnectProxy(): Promise<ProxyConfig> {
  return request<ProxyConfig>("/__reasonix/disconnect", { method: "POST" });
}

// ---- machine identity ----------------------------------------------------

export interface MachineIdentity {
  /** The computer's own name, as its paired-device route reports it. */
  machine: string;
}

/**
 * Ask a remembered LAN origin which computer it is.
 *
 * A paired device's `GET /device` names the machine it reaches, and that name
 * is the same one the account lists for this computer's cloud device. The read
 * goes through the proxy rather than straight to the origin: the page is on
 * `127.0.0.1`, the origin is another host, and a VPN that owns the default
 * route must still leave a neighbour reachable. `null` when the origin cannot
 * answer or has no identity to give — the identity is a hint, not a gate.
 *
 * The deadline is longer than the proxy's own connect budget would suggest
 * because the proxy allows itself 4 s to connect and 4 s to read; a shorter
 * client deadline would turn a slow-but-live door into "no identity", and a
 * handover that reads no identity declines to move at all.
 */
export async function readMachineIdentity(
  origin: string,
  timeoutMs = 10_000,
): Promise<MachineIdentity | null> {
  try {
    const body = await request<{ machine?: unknown }>(
      "/__reasonix/device",
      { method: "POST", body: JSON.stringify({ origin }) },
      timeoutMs,
    );
    const machine = typeof body.machine === "string" ? body.machine.trim() : "";
    return machine ? { machine } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a LAN origin can serve this phone right now.
 *
 * The same read as `readMachineIdentity`, but the failure keeps its code.
 * A door that is merely unreachable and a door whose pairing expired are both
 * "cannot switch", and the person's next step differs — retry later versus
 * re-pair — so folding them into `null` is not enough for a gate.
 *
 * `ok` means the origin answered and authorized this phone. A kernel that
 * names no machine still qualifies: it is an older build, not a broken door.
 *
 * The client deadline must outlast the proxy's own budget — it allows 4 s to
 * connect and 4 s to read — or a slow door is reported as `client.timeout`
 * before the proxy has finished deciding, and a switch that would have
 * succeeded is refused.
 */
export type DoorProbe = { ok: true; machine: string } | { ok: false; code: string };

export async function probeDoor(origin: string, timeoutMs = 10_000): Promise<DoorProbe> {
  try {
    const body = await request<{ machine?: unknown } | null>(
      "/__reasonix/device",
      { method: "POST", body: JSON.stringify({ origin }) },
      timeoutMs,
    );
    // A page served where no proxy exists answers 200 with HTML, which parses
    // to no body at all. That is not a door: it is the absence of one.
    if (body === null || typeof body !== "object") {
      return { ok: false, code: "proxy.bad_response" };
    }
    const machine = typeof body.machine === "string" ? body.machine.trim() : "";
    return { ok: true, machine };
  } catch (error) {
    if (error instanceof ProxyError) {
      // An older shell has no `/__reasonix/device` at all. Refusing every LAN
      // door there would turn an app upgrade into a broken connection, so the
      // caller is told to fall back to switch-then-verify.
      if (error.code === "proxy.unknown_path") return { ok: true, machine: "" };
      return { ok: false, code: error.code };
    }
    return {
      ok: false,
      code: error instanceof RequestTimeout ? "client.timeout" : "client.offline",
    };
  }
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
 *
 * It is a direct read from the page, so it inherits the phone's default route.
 * With a VPN owning that route the private address is probed through the
 * tunnel — the very path the loopback proxy exists to avoid — which is why a
 * LAN door can look dead here and answer fine through the proxy. That is why
 * `answeringOrigins` asks the proxy first and only falls back to this.
 */
export async function originAnswers(origin: string, timeoutMs = 2_500): Promise<boolean> {
  const target = origin.trim().replace(/\/+$/, "");
  if (!target) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await kernelTransport().fetch(`${target}/`, {
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
/**
 * The doors among `origins` that answer, asked through the proxy.
 *
 * The proxy probes each one natively, so the request is bound to the Wi-Fi a
 * switch would itself use; a page-level fetch follows the default route and
 * lets a VPN carry a LAN address into the tunnel, where a neighbour answers
 * as dead. One round trip carries the whole batch, which is what keeps a long
 * list from costing a timeout each.
 *
 * A shell without the route — or a browser, where there is no proxy — falls
 * back to the page sweep. That reader is the only one left there, and being
 * less honest beats having no answer at all.
 */
export interface ReachRow {
  origin: string;
  /** The kernel status the proxy saw; -1 when the door did not answer. */
  status: number;
  /** How long the probe took; -1 when the reader could not time it. */
  ms: number;
}

/** The most recent batch any reader answered, for the diagnostics text. */
let lastReach: ReachRow[] = [];

export function reachReport(): readonly ReachRow[] {
  return lastReach;
}

export async function answeringOrigins(
  origins: string[],
  timeoutMs = 8_000,
): Promise<string[]> {
  const asked = origins.map((origin) => origin.trim()).filter(Boolean);
  if (asked.length === 0) return [];
  try {
    const body = await request<{
      origins?: Array<{ origin?: unknown; ok?: unknown; status?: unknown; ms?: unknown }>;
    }>(
      "/__reasonix/reach",
      { method: "POST", body: JSON.stringify({ origins: asked }) },
      timeoutMs,
    );
    const rows = Array.isArray(body?.origins) ? body.origins : [];
    if (!Array.isArray(body?.origins)) {
      // A 200 with no rows is not "nothing answered": it is a shell that does
      // not know this route, and trusting it would filter out every door.
      throw new ProxyError(200, "proxy.bad_response");
    }
    lastReach = rows.flatMap((row) => {
      if (row === null || typeof row !== "object" || typeof row.origin !== "string") return [];
      const status =
        typeof row.status === "number" && Number.isFinite(row.status)
          ? row.status
          : row.ok === true
            ? 1
            : -1;
      const ms = typeof row.ms === "number" && Number.isFinite(row.ms) ? Math.max(0, row.ms) : -1;
      return [{ origin: row.origin, status, ms }];
    });
    const answered = new Set(
      rows
        .filter(
          (row) =>
            row !== null &&
            typeof row === "object" &&
            row.ok === true &&
            typeof row.origin === "string",
        )
        .map((row) => row.origin as string),
    );
    return asked.filter((origin) => answered.has(origin));
  } catch {
    const answered = await pageAnswers(asked, Math.min(timeoutMs, 2_500));
    // The page reader has no timing of its own; keep the row so a diagnosis
    // can still say which doors the fallback found.
    lastReach = asked.map((origin) => ({
      origin,
      status: answered.includes(origin) ? 1 : -1,
      ms: -1,
    }));
    return answered;
  }
}

/** The old reader: one `no-cors` GET per address, from the page. */
async function pageAnswers(origins: string[], timeoutMs: number): Promise<string[]> {
  const answers = await Promise.all(
    origins.map(async (origin) => ({ origin, ok: await originAnswers(origin, timeoutMs) })),
  );
  return answers.filter((entry) => entry.ok).map((entry) => entry.origin);
}

/**
 * The first remembered LAN address that answers, in preference order.
 *
 * The same reader as `answeringOrigins`, kept under its own name because a
 * boot check wants one address rather than a list.
 */
export async function firstAnswering(
  origins: string[],
  timeoutMs = 8_000,
): Promise<string | null> {
  const answered = await answeringOrigins(origins, timeoutMs);
  return answered[0] ?? null;
}

export type ServerLink =
  | { kind: "lan"; origin: string; pairCode?: string }
  | { kind: "cloud"; device: string };

/**
 * The Studio page this connection opens in a web view of the whole UI.
 *
 * A LAN door is the kernel origin itself; a cloud door is the remote page that
 * carries the device id. Empty when there is nothing to open — the caller
 * hides the entry instead of shipping a dead link.
 */
export function studioRemoteUrl(device: string | null | undefined): string {
  const id = device?.trim();
  return id ? `https://reasonix.io/remote/?device=${encodeURIComponent(id)}` : "";
}

export function studioWebUrl(
  config: Pick<ProxyConfig, "mode" | "origin" | "relayDevice"> | null,
  fallbackDevice?: string | null,
): string {
  if (config?.mode === "relay") {
    return studioRemoteUrl(config.relayDevice?.trim() || fallbackDevice);
  }
  return config?.origin?.trim() || "";
}

/**
 * The URL for the **in-app** full Studio WebView.
 *
 * A LAN door has to go through the loopback proxy, not straight at the kernel:
 * the proxy is what binds the request to the Wi-Fi network when a VPN owns the
 * default route, adds the pairing cookie, and speaks the kernel's CSRF Origin.
 * A bare WebView on the kernel address has none of that and fails whenever a
 * tunnel is active — the "打不开完整界面" case. The proxy publishes its own
 * address in `studioUrl`; cloud doors and browser dev sessions keep the real
 * address (they have no loopback proxy to talk to).
 *
 * The system browser is different again: it has no proxy cookie, so it must
 * keep using `studioWebUrl()` even on a LAN door.
 */
export function studioAppUrl(
  config: Pick<ProxyConfig, "mode" | "origin" | "relayDevice" | "studioUrl"> | null,
  fallbackDevice?: string | null,
): string {
  if (config?.mode === "relay") return studioWebUrl(config, fallbackDevice);
  return config?.studioUrl?.trim() || config?.origin?.trim() || "";
}

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
