/**
 * The controller side of the kernel's mux push lane.
 *
 * A stream is opened inside the sealed relay channel with a cursor and a byte
 * budget; the kernel pushes numbered frames as they happen and waits for
 * credit before sending more. The link owns this client so a reconnect can
 * reopen every stream from the cursor its source has actually seen, while a
 * half-received frame is dropped rather than merged into the next one.
 */

/** The initial grant and the refill size; the kernel caps held credit at 1MiB. */
const CREDIT_GRANT = 512 * 1024;
const REPLENISH_AT = CREDIT_GRANT / 2;
const OPEN_TIMEOUT_MS = 30_000;

export interface MuxFrameHandlers {
  onFrame: (frame: Record<string, unknown>) => void;
  onClosed: (reason: string) => void;
}

export interface MuxStreamHandle {
  close(): void;
}

export interface MuxHost {
  send: (command: Record<string, unknown>) => Promise<void>;
}

interface Stream {
  id: string;
  runtime: string;
  cursor: () => number | null;
  handlers: MuxFrameHandlers;
  chunks: Map<number, string>;
  spent: number;
  open: boolean;
}

interface Opening {
  resolve: (handle: MuxStreamHandle) => void;
  reject: (reason: unknown) => void;
  timer: number;
}

const utf8 = new TextEncoder();

export class MuxClient {
  private readonly streams = new Map<string, Stream>();
  private readonly openings = new Map<string, Opening>();

  constructor(private readonly host: MuxHost) {}

  open(runtime: string, cursor: () => number | null, handlers: MuxFrameHandlers): Promise<MuxStreamHandle> {
    const id = crypto.randomUUID();
    const stream: Stream = { id, runtime, cursor, handlers, chunks: new Map(), spent: 0, open: false };
    this.streams.set(id, stream);
    return new Promise<MuxStreamHandle>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.drop(id);
        reject(new Error("远程 Studio 没有及时打开事件流。"));
      }, OPEN_TIMEOUT_MS);
      this.openings.set(id, { resolve, reject, timer });
      void this.host.send(this.openCommand(stream));
    });
  }

  private openCommand(stream: Stream): Record<string, unknown> {
    const after = stream.cursor();
    return {
      v: 1,
      type: "mux.open",
      id: stream.id,
      runtime: stream.runtime,
      ...(after === null ? { attach: true } : { after, attach: false }),
      credit: CREDIT_GRANT,
    };
  }

  /** Consume a mux message; false leaves it for the request path. */
  receive(message: Record<string, unknown>): boolean {
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "error") {
      const id = typeof message.id === "string" ? message.id : "";
      const opening = this.openings.get(id);
      if (!opening) return false;
      this.drop(id);
      opening.reject(new Error(typeof message.error === "string" ? message.error : "远程 Studio 拒绝了事件流。"));
      return true;
    }
    if (!type.startsWith("mux.")) return false;
    const id = typeof message.id === "string" ? message.id : "";
    switch (type) {
      case "mux.opened": {
        const opening = this.openings.get(id);
        const stream = this.streams.get(id);
        if (opening && stream) {
          this.openings.delete(id);
          clearTimeout(opening.timer);
          stream.open = true;
          opening.resolve({ close: () => this.closeStream(id) });
        }
        return true;
      }
      case "mux.closed": {
        // With an id it is the ack of our own close; without one the kernel
        // ended the stream (starved credit, gone runtime) on its own.
        if (id) return true;
        const stream = typeof message.stream === "string" ? this.streams.get(message.stream) : undefined;
        if (stream) {
          this.streams.delete(stream.id);
          stream.handlers.onClosed(typeof message.reason === "string" ? message.reason : "closed");
        }
        return true;
      }
      case "mux.frame": {
        const stream = typeof message.stream === "string" ? this.streams.get(message.stream) : undefined;
        if (stream && stream.open) this.frame(stream, message);
        return true;
      }
      default:
        // mux.credit acks the refill; the budget is tracked locally.
        return true;
    }
  }

  private frame(stream: Stream, message: Record<string, unknown>): void {
    const data = typeof message.data === "string" ? message.data : "";
    // Bytes, not UTF-16 units: a Chinese answer spends three bytes a character
    // and would starve the stream if the budget counted units.
    stream.spent += utf8.encode(data).length;
    if (stream.spent >= REPLENISH_AT) {
      stream.spent = 0;
      void this.host.send({ v: 1, type: "mux.credit", id: stream.id, credit: CREDIT_GRANT });
    }
    const index = typeof message.index === "number" ? message.index : 0;
    stream.chunks.set(index, data);
    if (message.done !== true) return;
    const whole = [...stream.chunks.entries()].sort(([a], [b]) => a - b).map(([, part]) => part).join("");
    stream.chunks.clear();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(whole) as Record<string, unknown>;
    } catch {
      return;
    }
    stream.handlers.onFrame(frame);
  }

  private closeStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    void this.host.send({ v: 1, type: "mux.close", id });
  }

  private drop(id: string): void {
    const opening = this.openings.get(id);
    if (opening) {
      this.openings.delete(id);
      clearTimeout(opening.timer);
    }
    this.streams.delete(id);
  }

  /** The socket dropped: an open in flight fails, held streams keep their place. */
  lost(): void {
    for (const [id, opening] of this.openings) {
      this.openings.delete(id);
      clearTimeout(opening.timer);
      this.streams.delete(id);
      opening.reject(new Error("连接中断，事件流没有打开。"));
    }
    for (const stream of this.streams.values()) {
      stream.chunks.clear();
      stream.spent = 0;
      stream.open = false;
    }
  }

  /** The socket is back: reopen every held stream from its source's cursor. */
  reconnected(): void {
    for (const stream of this.streams.values()) {
      if (stream.open) continue;
      const opening = new Promise<MuxStreamHandle>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.drop(stream.id);
          stream.handlers.onClosed("远程 Studio 没有及时重开事件流。");
          reject(new Error("reopen timed out"));
        }, OPEN_TIMEOUT_MS);
        this.openings.set(stream.id, { resolve, reject, timer });
      });
      opening.catch(() => {});
      void this.host.send(this.openCommand(stream));
    }
  }

  /** The link ended: every source hears about it and retries by its own rules. */
  ended(reason: string): void {
    for (const [id, opening] of this.openings) {
      this.openings.delete(id);
      clearTimeout(opening.timer);
      opening.reject(new Error(reason));
    }
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.handlers.onClosed(reason);
  }
}