/**
 * The Internet relay channel.
 *
 * The kernel's Studio dials `wss://remote.reasonix.io` as a device; this
 * client dials the same relay as a controller. The account service issues a
 * one-time ticket and names the device's X25519 public key; after that every
 * request and answer is sealed with AES-GCM under a key both sides derive.
 *
 * The protocol is the desktop page's (`frontend-next/src/port/cloud_remote.ts`
 * and `cloud_link.ts`), reduced to what a phone needs: fetch and a polled
 * event stream. Keeping the same shape means the kernel does not need a second
 * remote contract for Android.
 */

import { Capacitor } from "@capacitor/core";
import { NativeWebSocket } from "../native/socket";
import { fetchWithTimeout } from "./http";

const ACCOUNT_GRANT = "/__reasonix/account/grant";
const HOSTED_RELAY = "wss://remote.reasonix.io";
const INFO_PREFIX = "reasonix-remote-v1|";
const HANDSHAKE_TIMEOUT_MS = 30_000;

export type RelayKind = "reauth" | "ended" | "transient";

export class RelayError extends Error {
  constructor(
    readonly kind: RelayKind,
    message: string,
  ) {
    super(message);
  }
}

interface RelayDevice {
  id: string;
  publicKey: string;
  capabilities: string[];
  revokedAt?: string | null;
}

interface RelayGrant {
  ticket: string;
  device: RelayDevice;
  relay: string;
}

interface Channel {
  bind(session: string): void;
  seal(value: unknown): Promise<string>;
  open(payload: string): Promise<Record<string, unknown>>;
}

export interface SocketEvent {
  data?: string;
  code?: number;
  reason?: string;
  message?: string;
  status?: number;
}

/** The WebSocket surface the relay uses, whether native or browser-backed. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}

function createSocket(url: string, protocols: string[]): SocketLike {
  if (Capacitor.isNativePlatform()) return new NativeWebSocket(url, protocols);
  return new WebSocket(url, protocols) as unknown as SocketLike;
}

interface Connection {
  socket: SocketLike;
  channel: Channel;
  features: string[];
  instance: string;
}

interface Pending {
  id: string;
  method: string;
  path: string;
  body: string;
  sentTo: Connection | null;
  status?: number;
  contentType?: string;
  etag?: string;
  chunks: Map<number, string>;
  /** Fires when the relay never answers, so a request cannot hang forever. */
  timer?: number;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

// ---- codec -----------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatChunks(chunks: Map<number, string>): Uint8Array<ArrayBuffer> {
  const parts = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => base64ToBytes(value));
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

// ---- account grant ---------------------------------------------------

async function requestGrant(deviceId: string): Promise<RelayGrant> {
  const response = await fetchWithTimeout(ACCOUNT_GRANT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  }, 20_000);
  const body = (await response.json().catch(() => null)) as
    | {
        grant?: { ticket?: unknown };
        device?: RelayDevice;
        relay?: unknown;
        code?: string;
        error?: { code?: string };
      }
    | null;
  if (!response.ok) {
    const code = body?.error?.code ?? body?.code;
    if (response.status === 401 || code === "account.signed_out" || code === "remote_reauth_required") {
      throw new RelayError("reauth", "登录已过期，请重新登录 Reasonix 账号。");
    }
    if (response.status === 404 || code === "device_not_found") {
      throw new RelayError("ended", "这台电脑已从账号中移除，或不属于这个账号。");
    }
    throw new RelayError("transient", `云端授权失败：${code ?? response.status}`);
  }
  if (!body || typeof body.grant?.ticket !== "string" || !body.device) {
    throw new RelayError("ended", "账号服务没有返回可用的连接凭证。");
  }
  return {
    ticket: body.grant.ticket,
    device: body.device,
    relay: typeof body.relay === "string" ? body.relay : HOSTED_RELAY,
  };
}

function relayUrl(named: string): string {
  if (named === HOSTED_RELAY) return named;
  const url = new URL(named);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RelayError("ended", "这台电脑使用的中继地址无法识别。");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new RelayError("ended", "这台电脑使用的中继地址无法识别。");
  }
  return `wss://${url.host}`;
}

// ---- cryptography ----------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

async function agreement(devicePublicBytes: Bytes): Promise<{ secret: Bytes; publicKey: Bytes }> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const deviceKey = await crypto.subtle.importKey("raw", devicePublicBytes, { name: "X25519" }, false, []);
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: deviceKey }, pair.privateKey, 256),
    ) as Bytes;
    return { secret, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) as Bytes };
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotSupportedError")) throw error;
    // Android WebViews older than Chromium 133 have no X25519 in WebCrypto;
    // the audited software curve is the fallback the desktop page uses too.
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const keys = x25519.keygen();
    return {
      secret: new Uint8Array(x25519.getSharedSecret(keys.secretKey, devicePublicBytes)) as Bytes,
      publicKey: new Uint8Array(keys.publicKey) as Bytes,
    };
  }
}

async function encryptedChannel(device: RelayDevice, socket: SocketLike): Promise<Channel> {
  const { secret, publicKey } = await agreement(base64ToBytes(device.publicKey) as Bytes);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode(`${INFO_PREFIX}${device.id}`);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  socket.send(
    JSON.stringify({ v: 1, type: "hello", publicKey: bytesToBase64(publicKey), salt: bytesToBase64(salt) }),
  );
  let bound: string | null = null;
  let seq = 0;
  return {
    bind(session: string) {
      bound = session;
    },
    async seal(value: unknown) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const stamped =
        bound && value && typeof value === "object"
          ? { ...(value as Record<string, unknown>), session: bound, seq: ++seq }
          : value;
      const plain = new TextEncoder().encode(JSON.stringify(stamped));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: info }, key, plain);
      return JSON.stringify({
        v: 1,
        nonce: bytesToBase64(nonce),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      });
    },
    async open(payload: string) {
      const envelope = JSON.parse(payload) as { v: number; nonce: string; ciphertext: string };
      if (envelope.v !== 1) throw new Error("unsupported relay encryption version");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.nonce), additionalData: info },
        key,
        base64ToBytes(envelope.ciphertext),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    },
  };
}

// ---- socket handshake ------------------------------------------------

function waitForOpen(socket: SocketLike, timeout = HANDSHAKE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = (event?: SocketEvent) => {
      cleanup();
      const detail = event?.status ? `HTTP ${event.status}` : event?.message;
      reject(
        new RelayError(
          "transient",
          detail ? `连接不到远程中继：${detail}` : "连接不到远程中继，请检查网络后重试。",
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {
        // A socket that never opened may refuse close.
      }
      reject(new RelayError("transient", "连接远程 Studio 超时，请确认电脑在线。"));
    }, timeout);
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
  });
}

function nextMessage(socket: SocketLike, timeout = HANDSHAKE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      socket.removeEventListener("close", closed);
    };
    const receive = (event: SocketEvent) => {
      cleanup();
      resolve(String(event.data ?? ""));
    };
    const closed = () => {
      cleanup();
      reject(new RelayError("transient", "远程连接在握手中断开。"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new RelayError("transient", "远程 Studio 没有回应握手。"));
    }, timeout);
    socket.addEventListener("message", receive);
    socket.addEventListener("close", closed);
  });
}

async function openConnection(deviceId: string): Promise<Connection> {
  const grant = await requestGrant(deviceId);
  if (grant.device.id !== deviceId || grant.device.revokedAt || !grant.device.capabilities.includes("desktop")) {
    throw new RelayError("ended", "这台电脑没有开启远程桌面，或已被移除。");
  }
  const socket = createSocket(`${relayUrl(grant.relay)}/v1/sessions/connect`, [
    "reasonix.remote.v1",
    `reasonix.auth.${grant.ticket}`,
  ]);
  try {
    await waitForOpen(socket);
    const readyWire = nextMessage(socket);
    const channel = await encryptedChannel(grant.device, socket);
    const ready = await channel.open(await readyWire);
    if (ready.type !== "ready" || ready.deviceId !== deviceId) {
      throw new RelayError("ended", "远程 Studio 身份校验失败。");
    }
    if (typeof ready.session === "string" && ready.session) channel.bind(ready.session);
    const features = Array.isArray(ready.features)
      ? ready.features.filter((item): item is string => typeof item === "string")
      : [];
    return {
      socket,
      channel,
      features,
      instance: typeof ready.instance === "string" ? ready.instance : "",
    };
  } catch (error) {
    try {
      socket.close(1000, "Handshake failed");
    } catch {
      // never opened
    }
    throw error;
  }
}

// ---- request transport -----------------------------------------------

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/** A relay request is a kernel round trip; beyond this the link is presumed dead. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Carries same-origin kernel requests over the relay.
 *
 * A request that never left is resent after a reconnect. A state-changing one
 * that was already sent is failed instead: the phone cannot know whether the
 * kernel ran it, and running a submit twice is worse than asking the person to
 * try again.
 */
export class RelayLink {
  private current: Connection | null;
  private readonly pending = new Map<string, Pending>();
  private sending: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private ended = false;

  constructor(private readonly deviceId: string, first: Connection) {
    this.current = first;
    this.attach(first);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Which device this link is for; a recovery must not reuse a link to another. */
  get device(): string {
    return this.deviceId;
  }

  /** Stop this link: close its socket and fail every request still waiting. */
  close(reason = "closed by caller"): void {
    const connection = this.current;
    this.finish(reason);
    try {
      connection?.socket.close(1000, "Closed");
    } catch {
      // already closed
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (this.ended) throw new RelayError("ended", "远程连接已断开，请重新连接。");
    const id = crypto.randomUUID();
    const body = new Uint8Array(await request.arrayBuffer());
    const target = new URL(request.url, location.origin);
    const path = `${target.pathname}${target.search}`;
    const encoded = bytesToBase64(body);
    const command = {
      v: 1,
      type: "desktop.request",
      id,
      method: request.method,
      path,
      body: encoded,
    };
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = {
        id,
        method: request.method.toUpperCase(),
        path,
        body: encoded,
        sentTo: null,
        chunks: new Map(),
        resolve,
        reject,
      };
      entry.timer = window.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RelayError("transient", "远程 Studio 没有及时回应，请稍后重试。"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, entry);
      void this.send(id, command);
    });
  }

  private attach(connection: Connection): void {
    this.current = connection;
    connection.socket.addEventListener("message", (event) => {
      if (this.current !== connection) return;
      void this.receive(connection, String(event.data ?? ""));
    });
    connection.socket.addEventListener("close", (event) => {
      if (this.current === connection) {
        this.lost(Number(event.code ?? 1006), String(event.reason ?? ""));
      }
    });
  }

  private send(id: string, command: Record<string, unknown>): Promise<void> {
    this.sending = this.sending.then(
      () => this.sendNow(id, command),
      () => this.sendNow(id, command),
    );
    return this.sending;
  }

  private async sendNow(id: string, command: Record<string, unknown>): Promise<void> {
    const connection = this.current;
    if (!connection || connection.socket.readyState !== 1 || !this.pending.has(id)) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    const wire = await connection.channel.seal(command);
    if (this.current !== connection || connection.socket.readyState !== 1 || !this.pending.has(id)) {
      return;
    }
    entry.sentTo = connection;
    connection.socket.send(wire);
  }

  private async receive(connection: Connection, wire: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = await connection.channel.open(wire);
    } catch {
      return;
    }
    if (this.current !== connection) return;
    const id = typeof message.id === "string" ? message.id : "";
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.type === "error") {
      this.pending.delete(id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(
        new RelayError("transient", typeof message.error === "string" ? message.error : "远程 Studio 拒绝了这次请求。"),
      );
      return;
    }
    if (message.type !== "desktop.response" || typeof message.index !== "number" || typeof message.body !== "string") {
      return;
    }
    if (typeof message.status === "number") pending.status = message.status;
    if (typeof message.contentType === "string") pending.contentType = message.contentType;
    if (typeof message.etag === "string") pending.etag = message.etag;
    pending.chunks.set(message.index, message.body);
    if (message.done !== true) return;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const headers = new Headers();
    if (pending.contentType) headers.set("content-type", pending.contentType);
    if (pending.etag) headers.set("etag", pending.etag);
    const status = pending.status ?? 500;
    const bytes = concatChunks(pending.chunks);
    pending.resolve(new Response(status === 204 || status === 304 ? null : bytes, { status, headers }));
  }

  private lost(code: number, reason: string): void {
    if (this.ended) return;
    this.current = null;
    // Only reads survive a reconnect: a write may have run already.
    for (const [id, entry] of this.pending) {
      if (entry.method !== "GET" && entry.method !== "HEAD") {
        this.pending.delete(id);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.reject(new RelayError("transient", "连接中断，这次操作可能没有完成，请刷新后确认。"));
      }
    }
    if (code === 4401) {
      this.finish("登录已过期，请重新登录。");
      return;
    }
    if (code === 4403 || code === 4004) {
      this.finish("这台电脑已断开远程连接。");
      return;
    }
    if (!this.reconnecting) void this.reconnect(reason);
  }

  private async reconnect(reason: string): Promise<void> {
    this.reconnecting = true;
    try {
      let last: unknown = reason;
      for (const delay of RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.ended) return;
        try {
          const connection = await openConnection(this.deviceId);
          this.attach(connection);
          for (const [id, entry] of this.pending) {
            await this.send(id, {
              v: 1,
              type: "desktop.request",
              id,
              method: entry.method,
              path: entry.path,
              body: entry.body,
            });
          }
          return;
        } catch (error) {
          last = error;
          if (error instanceof RelayError && error.kind !== "transient") {
            this.finish(error.message);
            return;
          }
        }
      }
      this.finish(last instanceof Error ? last.message : "远程 Studio 暂无响应。");
    } finally {
      this.reconnecting = false;
    }
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new RelayError("ended", reason));
    }
    this.pending.clear();
  }
}

// ---- polled event stream ---------------------------------------------

interface ReplayAnswer {
  frames?: Array<Record<string, unknown>> | null;
  complete?: boolean;
  watermark?: number;
}

/**
 * A stand-in for EventSource over the relay.
 *
 * The relay carries requests, not a long-lived byte stream, so the kernel's
 * replay endpoint is polled. A cursor is what a reconnecting stream resumes
 * from; frames the kernel writes itself (watermark, gap) are replayed too, so
 * the connection state on screen still means something.
 */
export class RelayEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private closed = false;
  private after: number | null;
  private readonly replay: string;

  constructor(url: string | URL, private readonly link: RelayLink) {
    const target = new URL(String(url), location.origin);
    const cursor = Number(target.searchParams.get("lastEventId") ?? "");
    this.after =
      target.searchParams.has("lastEventId") && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
    this.replay = `${target.pathname}/replay`;
    queueMicrotask(() => void this.poll());
  }

  close(): void {
    this.closed = true;
  }

  private say(frame: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(frame),
        lastEventId: typeof frame.seq === "number" ? String(frame.seq) : "",
      }),
    );
  }

  private async poll(): Promise<void> {
    let opened = false;
    while (!this.closed) {
      let active = false;
      try {
        const query = this.after !== null ? `?lastEventId=${this.after}` : "";
        const response = await this.link.fetch(
          new Request(new URL(this.replay + query, location.origin), { credentials: "same-origin" }),
        );
        if (!response.ok) {
          if (!this.closed) {
            this.closed = true;
            this.onerror?.();
          }
          return;
        }
        if (!this.closed) {
          if (!opened) {
            opened = true;
            this.onopen?.();
          }
          const body = (await response.json()) as ReplayAnswer;
          const watermark = typeof body.watermark === "number" ? body.watermark : null;
          const frames = body.frames ?? [];
          active = frames.length > 0;
          if (this.after === null) this.after = watermark ?? 0;
          else if (body.complete === false) {
            const from = typeof frames[0]?.seq === "number" ? (frames[0].seq as number) : watermark ?? this.after;
            this.say({ kind: "stream_gap", seq: from });
          }
          for (const frame of frames) {
            const seq = typeof frame.seq === "number" ? frame.seq : 0;
            if (seq > this.after) this.after = seq;
            this.say(frame);
          }
          if (!active && watermark !== null) this.say({ kind: "stream_watermark", seq: watermark });
        }
      } catch {
        // A relay link that has ended must not be polled forever. Let the
        // EventSource contract surface the error; RuntimeStream will retry
        // through whichever transport is installed by then.
        if (!this.closed) {
          this.closed = true;
          this.onerror?.();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, active ? 200 : 1500));
    }
  }
}

// ---- installation ----------------------------------------------------

const KERNEL_PATHS = [
  "/runtimes",
  "/rt/",
  "/auth/",
  "/pair",
  "/device",
  "/events",
  "/status",
  "/models",
  "/share",
  "/provider-setup",
  "/context",
  "/inbox",
  "/adjudications",
  "/checkpoints",
  "/trajectory",
  "/changes",
  "/sessions",
  "/balance",
  "/new",
  "/submit",
  "/cancel",
  "/approve",
  "/plan",
  "/effort",
  "/compact",
  "/rewind",
  "/branch",
  "/summarize",
  "/goal",
  "/tools",
  "/plugins",
  "/hooks",
  "/workspace",
  "/config",
  "/host",
];

function isKernelPath(pathname: string): boolean {
  return KERNEL_PATHS.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

let wrapped = false;
let activeLink: RelayLink | null = null;
let nativeEventSource: typeof EventSource | null = null;

function install(): void {
  if (nativeEventSource === null) nativeEventSource = globalThis.EventSource;
  if (!wrapped) {
    wrapped = true;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url, location.origin).pathname;
      if (activeLink !== null && isKernelPath(pathname)) return activeLink.fetch(request);
      return nativeFetch(request);
    }) as typeof fetch;
  }
  // The LAN proxy still needs the real EventSource; clearRelayRouting puts it
  // back when a LAN connection takes over.
  globalThis.EventSource = class extends RelayEventSource {
    constructor(url: string | URL) {
      const link = activeLink;
      if (link === null) throw new Error("relay is not connected");
      super(url, link);
    }
  } as unknown as typeof EventSource;
}

/** Open the relay and route kernel requests through it. */
export async function connectRelay(deviceId: string): Promise<RelayLink> {
  const first = await openConnection(deviceId);
  const link = new RelayLink(deviceId, first);
  const previous = activeLink;
  install();
  activeLink = link;
  // The old socket must not stay alive beside the new one; it would keep
  // reconnecting and could route a request after the switch.
  previous?.close("replaced by a new relay connection");
  return link;
}

/** Reuse a live link to the same device, or replace it. */
export async function ensureRelay(deviceId: string): Promise<RelayLink> {
  const current = activeLink;
  if (current !== null && !current.isEnded && current.device === deviceId) return current;
  return connectRelay(deviceId);
}

export function relayAlive(): boolean {
  return activeLink !== null && !activeLink.isEnded;
}

/** Stop routing kernel requests through the relay (a LAN connection took over). */
export function clearRelayRouting(): void {
  const link = activeLink;
  activeLink = null;
  link?.close("relay routing cleared");
  if (nativeEventSource !== null) globalThis.EventSource = nativeEventSource;
}
