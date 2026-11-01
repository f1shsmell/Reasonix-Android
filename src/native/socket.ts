import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/**
 * The relay socket, carried by native code.
 *
 * A WebView cannot choose its WebSocket Origin, and the relay rejects the
 * app's loopback origin. This adapter exposes the small WebSocket surface the
 * relay link uses, backed by OkHttp with the allowed Origin header.
 */
interface RelaySocketPlugin {
  connect(options: { url: string; protocols: string[]; origin?: string; tag?: number }): Promise<void>;
  send(options: { data: string; tag?: number }): Promise<void>;
  close(options: { tag?: number }): Promise<void>;
  addListener(
    event: string,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<RelaySocketPlugin>("RelaySocket");

interface SocketEvent {
  data?: string;
  code?: number;
  reason?: string;
  message?: string;
  status?: number;
  /** Which connection an event belongs to; absent means no filtering. */
  tag?: number;
}

type Listener = (event: SocketEvent) => void;

/**
 * Identifies each dial, so the plugin's events can be told apart: Capacitor
 * broadcasts an event to every listener ever registered, and the Java side
 * closes the previous socket when a new one dials, so a slow close from the
 * old connection would otherwise arrive at the new one and read as its own
 * failure — disarming its bridge or ending it before it opened.
 */
// Seeded from the clock so tags never repeat across a page reload: a socket
// of the previous page can still be alive in the plugin, and a reused tag
// would let its "replaced" close read as the new page's own.
let nextTag = Date.now() % 0x3fffffff;

export class NativeWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private handles: PluginListenerHandle[] = [];
  private closed = false;
  /** Set once a close has reached the page, whichever path carried it. */
  private finished = false;
  private readonly tag = ++nextTag;

  constructor(url: string, protocols: string[]) {
    void this.start(url, protocols);
  }

  private async listen(event: string, handler: Listener): Promise<void> {
    const tag = this.tag;
    const handle = await plugin.addListener(event, (data) => {
      // Events from other connections the plugin has opened are not ours;
      // a plugin that does not tag (tests, older builds) sends none.
      if (typeof data?.tag === "number" && data.tag !== tag) return;
      handler(data as SocketEvent);
    });
    this.handles.push(handle);
  }

  private async start(url: string, protocols: string[]): Promise<void> {
    await this.listen("open", () => {
      this.readyState = 1;
      this.emit("open", {});
    });
    await this.listen("message", (event) =>
      this.emit("message", { data: String(event.data ?? "") }),
    );
    await this.listen("close", (event) => {
      // Plugin events are broadcast to every socket this plugin ever opened,
      // and the Java side closes the previous socket when a new one dials. A
      // close seen before this socket has opened belongs to that previous
      // one; taking it as ours would pin `finished` and disarm the failure
      // bridge before the connection ever came up.
      if (this.readyState === 0 || this.finished) return;
      this.finished = true;
      this.readyState = 3;
      this.emit("close", {
        code: Number(event.code ?? 1006),
        reason: String(event.reason ?? ""),
      });
    });
    await this.listen("error", (event) => {
      this.fail(String(event.message ?? "relay socket failed"), Number(event.status ?? 0));
    });
    try {
      await plugin.connect({ url, protocols, origin: "https://reasonix.io", tag: this.tag });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "relay socket failed");
    }
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    void plugin.send({ data, tag: this.tag }).catch(() => {
      this.fail("relay send failed");
    });
  }

  /**
   * Report a failed socket the way a browser would: an error, then a close.
   *
   * OkHttp reports every transport failure — dial refused, send refused, a
   * ping that drew no Pong — through one onFailure callback that carries no
   * close of its own. The page speaks browser WebSocket semantics and only
   * reconnects on close, so the close is emitted here; the guards keep a
   * socket the plugin did close, or the page closed itself, from seeing a
   * second one.
   */
  private fail(message: string, status = 0): void {
    if (this.closed || this.finished) return;
    this.finished = true;
    this.readyState = 3;
    this.emit("error", { message, status });
    this.emit("close", { code: 1006, reason: "abnormal" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    void plugin.close({ tag: this.tag });
    for (const handle of this.handles) void handle.remove();
    this.handles = [];
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
