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
  /**
   * When the last frame arrived, and when this connection opened.
   *
   * A stream can be dead while its `readyState` still says OPEN: the peer went
   * away and nothing reached the browser to say so. All that is left is
   * silence, so silence is what this records.
   */
  private lastFrameAt = 0;
  private openedAt = 0;

  constructor(url: string, handlers: StreamHandlers, initialCursor = 0) {
    this.url = url;
    this.handlers = handlers;
    this.lastEventId = initialCursor;
  }

  /** The id to resume from on the next cold start. */
  get cursor(): number {
    return this.lastEventId;
  }

  /**
   * How long this connection has been silent, in ms, or 0 when it is not open.
   *
   * Measured from the last frame, or from when the connection opened if nothing
   * has arrived yet — a connection that opened and then said nothing is exactly
   * as suspect as one that went quiet.
   */
  idleFor(now: number): number {
    if (this.source === null || this.openedAt === 0) return 0;
    return now - Math.max(this.lastFrameAt, this.openedAt);
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

  /**
   * Retry now instead of waiting out the backoff.
   *
   * The platform reported the network is back, so the delay was measured
   * against a route that no longer exists. The cursor is kept.
   */
  retryNow(): void {
    if (this.stopped || this.source !== null || this.timer === null) return;
    this.clearTimer();
    this.attempt = 0;
    this.connect();
  }

  /**
   * Replace a connection that may no longer be delivering.
   *
   * A stream frozen in the background comes back holding an `EventSource`
   * whose `readyState` still says OPEN: the peer closed the TCP connection
   * while the app was not running, and nothing reached us to say so. No error
   * fires, so `retryNow` (which waits for a backoff timer) can never help;
   * the only recovery is to build a new connection. That is why this does not
   * reuse `stop()` — a stop publishes `closed`, and a healthy pane would blink
   * for a teardown that is really a repair.
   *
   * The cursor lives in this instance, so a reopen resumes from the last frame
   * actually seen rather than from the throttled value written to storage.
   * `announce` is false: the pane keeps showing its last state until the new
   * connection either opens or fails on its own.
   */
  reopen(): void {
    if (this.stopped) return;
    this.clearTimer();
    const previous = this.source;
    this.source = null;
    previous?.close();
    this.attempt = 0;
    this.connect(false);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Open a connection.
   *
   * `announce` publishes `connecting`; a reopen skips it so a repair does not
   * flash the pane's status dot to "not connected" on every foreground.
   */
  private connect(announce = true): void {
    if (announce) this.handlers.onState({ kind: "connecting" });
    // EventSource sends Last-Event-ID itself only for its own internal
    // reconnects. A connection we create fresh needs it on the query, which
    // the kernel reads through lastEventID.
    const url = this.lastEventId > 0 ? `${this.url}?lastEventId=${this.lastEventId}` : this.url;
    let source: EventSource;
    try {
      source = new EventSource(url, { withCredentials: true });
    } catch {
      // During a relay -> LAN switch the relay wrapper can be gone before the
      // stream has reconnected. Retry through the transport installed by then
      // instead of letting the constructor throw out of the timer.
      this.scheduleRetry();
      return;
    }
    this.source = source;
    // A new source has not opened yet, so there is nothing to measure: the
    // clock restarts at `onopen`. Leaving the previous timestamps would make a
    // just-reconnected stream look silent since the last connection, and the
    // idle check would tear it down the moment it was rebuilt.
    this.openedAt = 0;
    this.lastFrameAt = 0;

    // Every handler checks it still owns this stream. A `close()` does not
    // cancel an error or a message already queued on the old source, and a
    // reopen replaces the connection immediately: without the check, a late
    // frame from the discarded connection would update this instance — most
    // damagingly `onerror`, which would null the *new* source and leak it.
    source.onopen = () => {
      if (this.source !== source) return;
      this.attempt = 0;
      this.openedAt = Date.now();
      this.lastFrameAt = 0;
      this.handlers.onState({ kind: "open" });
    };

    source.onmessage = (message: MessageEvent<string>) => {
      if (this.source !== source) return;
      this.lastFrameAt = Date.now();
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
      if (this.source !== source) return;
      source.close();
      this.source = null;
      if (this.stopped) return;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const index = Math.min(this.attempt, BACKOFF_MS.length - 1);
    // Half the slot plus a random half, the same full-jitter rule `Backoff`
    // uses for the link machine: when the kernel restarts, every phone
    // reconnecting in lockstep turns one recovery into a thundering herd.
    const slot = BACKOFF_MS[index] ?? 15000;
    const afterMs = Math.max(1, Math.round(slot / 2 + Math.random() * (slot / 2)));
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

const pendingCursors = new Map<string, number>();
let cursorTimer: number | null = null;

function flushCursors(): void {
  if (cursorTimer !== null) {
    window.clearTimeout(cursorTimer);
    cursorTimer = null;
  }
  for (const [runtimeId, seq] of pendingCursors) {
    try {
      localStorage.setItem(CURSOR_KEY + runtimeId, String(seq));
    } catch {
      // Losing the cursor costs a replay, not correctness.
    }
  }
  pendingCursors.clear();
}

/**
 * Remember a frame cursor, at most twice a second.
 *
 * Every SSE frame carried one synchronous localStorage write; a streaming
 * answer could block the main thread on storage it rereads once at launch.
 */
export function saveCursor(runtimeId: string, seq: number): void {
  pendingCursors.set(runtimeId, seq);
  if (cursorTimer !== null) return;
  cursorTimer = window.setTimeout(flushCursors, 500);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushCursors);
}
