/**
 * One attachment crossing the relay's bulk lane.
 *
 * The file is sent as binary sealed parts — a 4-byte index plus raw bytes —
 * so only the envelope's base64 inflates it. The kernel answers `bulk.open`
 * with the part count it already holds, which is what lets a dropped link
 * resume instead of retransmitting: the upload waits for the reconnect, opens
 * again under the same id, and sends only what is missing.
 */

const PART_BYTES = 24 * 1024;
const BUFFER_HIGH = 512 * 1024;
const OPEN_TIMEOUT_MS = 30_000;
const PROGRESS_TIMEOUT_MS = 60_000;

export interface BulkHost {
  send: (command: Record<string, unknown>) => Promise<void>;
  sendBinary: (part: Uint8Array<ArrayBuffer>) => Promise<void>;
  buffered: () => number;
}

export class BulkUpload {
  private aborted = false;
  private lostNow = false;
  private gate: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;
  private waiting: ((next: number) => void) | null = null;
  private openReject: ((error: unknown) => void) | null = null;
  private watchdog: number | null = null;
  private readonly total: number;

  constructor(
    private readonly id: string,
    private readonly path: string,
    private readonly name: string,
    private readonly mime: string,
    private readonly bytes: Uint8Array,
    private readonly host: BulkHost,
    private readonly fail: (error: unknown) => void,
  ) {
    this.total = Math.ceil(bytes.length / PART_BYTES);
  }

  async run(): Promise<void> {
    this.armWatchdog();
    while (!this.aborted) {
      if (this.lostNow) await this.gate;
      if (this.aborted) break;
      try {
        const next = await this.open();
        this.armWatchdog();
        if (await this.pump(next)) break;
      } catch (error) {
        if (this.aborted) break;
        if (this.lostNow) continue;
        this.stop(error);
        break;
      }
    }
    this.clearWatchdog();
  }

  /** The kernel's answer to bulk.open: the number of parts it already holds. */
  ready(message: Record<string, unknown>): void {
    const next = typeof message.next === "number" ? message.next : 0;
    this.waiting?.(next);
  }

  /** The answer settled (delivered or refused); nothing more should be sent. */
  abort(): void {
    this.aborted = true;
    this.release?.();
    this.openReject?.(new Error("upload settled"));
  }

  lost(): void {
    this.lostNow = true;
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.openReject?.(new Error("connection lost"));
  }

  reconnected(): void {
    this.lostNow = false;
    this.release?.();
    this.release = null;
  }

  private open(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting = null;
        this.openReject = null;
        reject(new Error("远程 Studio 没有及时接收附件，请稍后重试。"));
      }, OPEN_TIMEOUT_MS);
      this.waiting = (next) => {
        window.clearTimeout(timer);
        this.waiting = null;
        this.openReject = null;
        resolve(next);
      };
      this.openReject = (error) => {
        window.clearTimeout(timer);
        this.waiting = null;
        this.openReject = null;
        reject(error);
      };
      void this.host.send({
        v: 1,
        type: "bulk.open",
        id: this.id,
        path: this.path,
        name: this.name,
        mime: this.mime,
        total: this.total,
      });
    });
  }

  /** Send parts from `next`; false means a loss interrupted the run. */
  private async pump(next: number): Promise<boolean> {
    for (let index = next; index < this.total; index += 1) {
      if (this.aborted || this.lostNow) return false;
      while (this.host.buffered() > BUFFER_HIGH) {
        if (this.aborted || this.lostNow) return false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      this.armWatchdog();
      const start = index * PART_BYTES;
      const chunk = this.bytes.subarray(start, Math.min(start + PART_BYTES, this.bytes.length));
      const framed = new Uint8Array(4 + chunk.length);
      new DataView(framed.buffer).setUint32(0, index);
      framed.set(chunk, 4);
      await this.host.sendBinary(framed);
    }
    return true;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = window.setTimeout(() => {
      this.stop(new Error("附件上传没有进展，请稍后重试。"));
    }, PROGRESS_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private stop(error: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.clearWatchdog();
    this.release?.();
    this.openReject?.(error);
    this.fail(error);
  }
}