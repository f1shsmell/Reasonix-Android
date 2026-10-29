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
  connect(options: { url: string; protocols: string[]; origin?: string }): Promise<void>;
  send(options: { data: string }): Promise<void>;
  close(): Promise<void>;
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
}

type Listener = (event: SocketEvent) => void;

export class NativeWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private handles: PluginListenerHandle[] = [];
  private closed = false;

  constructor(url: string, protocols: string[]) {
    void this.start(url, protocols);
  }

  private async listen(event: string, handler: Listener): Promise<void> {
    const handle = await plugin.addListener(event, (data) => handler(data as SocketEvent));
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
      this.readyState = 3;
      this.emit("close", {
        code: Number(event.code ?? 1006),
        reason: String(event.reason ?? ""),
      });
    });
    await this.listen("error", (event) => {
      if (this.closed) return;
      this.readyState = 3;
      this.emit("error", {
        message: String(event.message ?? "relay socket failed"),
        status: Number(event.status ?? 0),
      });
    });
    try {
      await plugin.connect({ url, protocols, origin: "https://reasonix.io" });
    } catch (error) {
      this.readyState = 3;
      this.emit("error", {
        message: error instanceof Error ? error.message : "relay socket failed",
      });
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
    void plugin.send({ data }).catch(() => {
      this.emit("error", { message: "relay send failed" });
    });
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
    void plugin.close();
    for (const handle of this.handles) void handle.remove();
    this.handles = [];
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
