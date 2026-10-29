/**
 * One SSE connection to a runtime, with resume.
 *
 * The kernel writes `id:` only on frames it considers replayable, and reads
 * `Last-Event-ID` on reconnect to replay from there. A frame with no id is a
 * delta a reconnect must not ask for again, so the id we send back is the last
 * one we actually saw, not a count of frames received.
 */

import type { EventPayload } from "../wire/events";

export type StreamState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "retrying"; attempt: number; afterMs: number }
  | { kind: "closed"; reason: string };

export interface StreamHandlers {
  onEvent: (event: EventPayload) => void;
  onState: (state: StreamState) => void;
  /** Called with the last event id seen so the caller can persist it. */
  onCursor?: (lastEventId: number) => void;
}

/** Backoff: 0.5s, 1s, 2s, 4s, 8s, then a 15s ceiling. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const CURSOR_KEY = "reasonix.cursor.";

export class RuntimeStream {
  private url: string;
  private handlers: StreamHandlers;
  private source: EventSource | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private lastEventId: number;

  constructor(url: string, handlers: StreamHandlers, initialCursor = 0) {
    this.url = url;
    this.handlers = handlers;
    this.lastEventId = initialCursor;
  }

  /** The id to resume from on the next cold start. */
  get cursor(): number {
    return this.lastEventId;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.source?.close();
    this.source = null;
    this.handlers.onState({ kind: "closed", reason: "stopped by caller" });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private connect(): void {
    this.handlers.onState({ kind: "connecting" });
    // EventSource sends Last-Event-ID itself only for its own internal
    // reconnects. A connection we create fresh needs it on the query, which
    // the kernel reads through lastEventID.
    const url = this.lastEventId > 0 ? `${this.url}?lastEventId=${this.lastEventId}` : this.url;
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      this.handlers.onState({ kind: "open" });
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const id = message.lastEventId;
      if (id) {
        const parsed = Number(id);
        if (Number.isFinite(parsed)) {
          this.lastEventId = parsed;
          this.handlers.onCursor?.(parsed);
        }
      }
      let payload: EventPayload;
      try {
        payload = JSON.parse(message.data) as EventPayload;
      } catch {
        // A frame we cannot parse is not a reason to drop the stream.
        return;
      }
      if (typeof payload?.kind !== "string") return;
      this.handlers.onEvent(payload);
    };

    source.onerror = () => {
      source.close();
      this.source = null;
      if (this.stopped) return;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const index = Math.min(this.attempt, BACKOFF_MS.length - 1);
    const afterMs = BACKOFF_MS[index] ?? 15000;
    this.attempt += 1;
    this.handlers.onState({ kind: "retrying", attempt: this.attempt, afterMs });
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, afterMs);
  }
}

/** Where a runtime's stream lives, and where its cursor is remembered. */
export function streamUrl(base: string): string {
  return `${base}/events`;
}

export function loadCursor(runtimeId: string): number {
  try {
    const raw = localStorage.getItem(CURSOR_KEY + runtimeId);
    const parsed = raw === null ? 0 : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveCursor(runtimeId: string, seq: number): void {
  try {
    localStorage.setItem(CURSOR_KEY + runtimeId, String(seq));
  } catch {
    // Losing the cursor costs a replay, not correctness.
  }
}
