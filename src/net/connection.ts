/**
 * The app's one connection: which kernel it is talking to, whether that kernel
 * is reachable, and the runtimes it currently has open.
 *
 * Reachability is a separate fact from stream health. A stream can be retrying
 * while the kernel is fine, and a kernel can be gone while the last stream
 * frame is still on screen; showing one number for both would lie about which.
 */

import type { RuntimeView } from "../wire/runtime";
import { fetchWithTimeout } from "./http";
import { relayState } from "./relay";
import { RuntimeStream, loadCursor, saveCursor, streamUrl } from "./stream";
import type { StreamState } from "./stream";
import type { EventPayload } from "../wire/events";

export type Reach =
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "unauthorized" }
  | { kind: "unreachable"; detail: string };

export interface ConnectionSnapshot {
  reach: Reach;
  runtimes: RuntimeView[];
  stream: StreamState;
  /**
   * The newest frame, kept for consumers that only care about the latest
   * notification (a todo revision, say). A consumer that folds every frame
   * must use `events` instead — see below.
   */
  lastEvent?: EventPayload;
  /**
   * Frames that arrived since the queue was last drained, oldest first.
   *
   * A single `lastEvent` slot is not enough. Frames are delivered in bursts:
   * the relay answers one poll with every frame it has (`relay.ts` says each
   * one synchronously), so a dozen `text` deltas land inside one task and
   * React commits them as a single render. An effect keyed on `lastEvent`
   * then runs once, with only the last delta, and the rest are gone — and
   * `text` is droppable in the kernel, so they are never replayed.
   *
   * Bounded, because a consumer that stops reading must not grow this
   * without end. The oldest frames are dropped when it overflows, which is
   * the same loss the kernel already makes for deltas.
   */
  events: QueuedEvent[];
  /**
   * The seq of the newest frame ever queued. Never reset, so a consumer can
   * tell "nothing new" from "everything I have is stale" across a re-attach.
   */
  eventSeq: number;
}

/** A frame in the queue, with the number a consumer uses to know it is new. */
export interface QueuedEvent {
  seq: number;
  event: EventPayload;
}

type Listener = (snapshot: ConnectionSnapshot) => void;

/** A runtime row this client can draw; a newer field is simply ignored. */
export function isRuntimeView(value: unknown): value is RuntimeView {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.base === "string" &&
    typeof row.root === "string" &&
    typeof row.name === "string"
  );
}

/** A runtime base may be absolute when the pane lives on another machine. */
function absolute(base: string): string {
  return new URL(base, window.location.origin).toString();
}

/**
 * What a read said about the route, as opposed to about the read.
 *
 * `refresh` answers "did this request succeed", which is not the same
 * question and was read as if it were: a caller that had just switched doors
 * treated its `false` as "the new door is dead" and rolled back, when the
 * failure was the first one in a row on a route that was still up. A phone
 * changing networks drops exactly that packet, so the two meanings have to be
 * separated at the source rather than at each call site.
 */
export type RouteVerdict = "up" | "hiccup" | "down";

export class Connection {
  private listeners = new Set<Listener>();
  private snapshot: ConnectionSnapshot = {
    reach: { kind: "unknown" },
    runtimes: [],
    stream: { kind: "idle" },
    events: [],
    eventSeq: 0,
  };
  private stream: RuntimeStream | null = null;
  private activeRuntime: string | null = null;
  private activeBase: string | null = null;
  /**
   * How many undrained frames are kept.
   *
   * Deep enough for a burst (one relay poll answers with a whole backlog) and
   * shallow enough that a screen which stops reading cannot grow it forever.
   * A frame that overflows is dropped from the old end, which is the loss the
   * kernel already makes for deltas.
   */
  private static readonly MAX_QUEUED_EVENTS = 512;
  /** A slow refresh must not overwrite the answer of a newer one. */
  private refreshSeq = 0;
  /**
   * Failures in a row since the last successful read.
   *
   * A phone's worst network is not "offline": it is a Wi-Fi that drops one
   * packet, a router that pauses for a second while a screen mounts, a
   * `fetch` that times out at exactly 12 s. Treating the first of those as a
   * lost connection is what made a working link flip to "reconnecting" when
   * the person opened settings, so a transient failure is retried once
   * before the snapshot is allowed to say the kernel is gone.
   *
   * Only a transport failure counts here. A refusal from the kernel — 401,
   * 403, a 5xx, or a body that is not a runtime list — is an answer: it is
   * published at once and clears the count, because the route is fine and the
   * problem is something a retry of the *transport* will not fix.
   */
  private failures = 0;
  /** How many failures in a row still count as noise rather than a loss. */
  private static readonly TOLERATED_FAILURES = 2;

  /**
   * Frames belong to the pane that was attached when they arrived. A new
   * attach must not fold the previous pane's frames into this transcript.
   *
   * `eventSeq` is deliberately not reset: consumers compare against it to
   * decide what is new, and rewinding it would make old frames look fresh.
   */
  private clearLastEvent(): void {
    if (this.snapshot.lastEvent === undefined && this.snapshot.events.length === 0) return;
    const { lastEvent: _previous, ...rest } = this.snapshot;
    this.snapshot = { ...rest, events: [] };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  get current(): ConnectionSnapshot {
    return this.snapshot;
  }

  /**
   * Whether the last reads failed often enough to mean the route is gone.
   *
   * The link machine uses this instead of a single probe: a live link is only
   * torn down when the transport has actually stopped answering twice in a
   * row, which is what keeps a screen mounting from disconnecting a phone.
   */
  get lost(): boolean {
    return this.failures >= Connection.TOLERATED_FAILURES;
  }

  /**
   * Forget earlier failures because the route they were measured on is gone.
   *
   * The counter answers "has *this* route stopped answering", so a deliberate
   * upstream change — a switch to another computer, a fresh pairing — starts
   * from zero. Without this, one hiccup before the switch plus one hiccup on
   * the new route would add up to a verdict about neither.
   */
  resetFailures(): void {
    this.failures = 0;
  }

  private publish(patch: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Queue one stream frame.
   *
   * Frames arrive in bursts — one relay poll answers with every frame it
   * holds, and `relay.ts` hands each one over synchronously — so React
   * commits the whole burst as a single render. Appending instead of
   * replacing is what lets a consumer fold all of them: the last-wins slot
   * lost every delta but the final one, and the kernel never replays a
   * droppable `text` frame, so those deltas were gone for good.
   */
  private publishEvent(event: EventPayload): void {
    const seq = this.snapshot.eventSeq + 1;
    const queued = this.snapshot.events;
    const room = Connection.MAX_QUEUED_EVENTS;
    const next =
      queued.length >= room
        ? [...queued.slice(queued.length - room + 1), { seq, event }]
        : [...queued, { seq, event }];
    this.snapshot = { ...this.snapshot, lastEvent: event, events: next, eventSeq: seq };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Drop every frame up to and including `throughSeq`.
   *
   * A consumer calls this once it has folded those frames, so the queue holds
   * only what is still unread. Silently ignores a seq older than the queue,
   * which happens when a burst overflowed.
   */
  drainEvents(throughSeq: number): void {
    const events = this.snapshot.events;
    if (events.length === 0) return;
    const firstUnread = events.findIndex((entry) => entry.seq > throughSeq);
    const kept = firstUnread === -1 ? [] : events.slice(firstUnread);
    if (kept.length === events.length) return;
    this.snapshot = { ...this.snapshot, events: kept };
    // No notification: the only listener that drains is the one doing the
    // draining, and telling it about its own write would loop.
  }

  /**
   * Refresh the runtime list, and answer whether *this* read reached the
   * kernel.
   *
   * The return value is the fact; the snapshot is the display. They diverge on
   * purpose: a tolerated hiccup keeps the last good `reach` so the chip does
   * not flicker, but a caller that is *verifying* a door — "did the address I
   * just switched to actually answer?" — must not read that kept value as
   * evidence. `true` means this read answered `/runtimes`; `false` means it did
   * not, whatever the snapshot still says.
   */
  async refresh(): Promise<boolean> {
    const seq = ++this.refreshSeq;
    const stale = () => seq !== this.refreshSeq;
    /**
     * A reconnecting relay is healing itself.
     *
     * Its requests stay pending until the socket is back, so a read that times
     * out in that window says nothing about the computer. Counting it would
     * make the link machine reconnect a route that is about to return on its
     * own — the opposite of what the tolerance above is for.
     */
    const relayHealing = relayState() === "reconnecting";
    try {
      const response = await fetchWithTimeout("/runtimes", { credentials: "same-origin" }, 12_000);
      if (stale()) return false;
      if (response.status === 401 || response.status === 403) {
        // The kernel answered. That is a connection, just an unauthorized one.
        this.failures = 0;
        this.publish({ reach: { kind: "unauthorized" }, runtimes: [] });
        return false;
      }
      if (!response.ok) {
        // The kernel answered with a refusal. That is not a lost route, so it
        // does not count toward `lost`, but it is not a usable read either.
        this.failures = 0;
        this.publish({ reach: { kind: "unreachable", detail: `HTTP ${response.status}` } });
        return false;
      }
      const body: unknown = await response.json();
      if (stale()) return false;
      if (!Array.isArray(body)) {
        this.failures = 0;
        this.publish({ reach: { kind: "unreachable", detail: "invalid /runtimes response" } });
        return false;
      }
      const runtimes = body.filter(isRuntimeView);
      if (body.length > 0 && runtimes.length === 0) {
        this.failures = 0;
        this.publish({ reach: { kind: "unreachable", detail: "invalid /runtimes response" } });
        return false;
      }
      this.failures = 0;
      this.publish({ reach: { kind: "ok" }, runtimes });
      this.reattachIfBaseMoved();
      return true;
    } catch (error) {
      if (stale()) return false;
      if (relayHealing) return false;
      this.failures += 1;
      // One lost request is not a lost computer. Keep the last good answer on
      // screen and let the next probe decide; only a second failure in a row
      // is allowed to say the kernel is unreachable. A link that was already
      // unreachable is republished so a screen waiting on the change still
      // hears about it.
      const tolerated = this.failures < Connection.TOLERATED_FAILURES;
      if (tolerated && this.snapshot.reach.kind === "ok") return false;
      this.publish({
        reach: {
          kind: "unreachable",
          detail: error instanceof Error ? error.message : "network error",
        },
      });
      return false;
    }
  }

  /**
   * Refresh, and answer what the route is — not what this read was.
   *
   * Three outcomes, because the two-question boolean was misused:
   *
   * - `up`     the read answered; the route serves requests.
   * - `hiccup` the read did not answer, but nothing published a verdict: this
   *            is the first transport failure in a row, a read superseded by
   *            a newer one, or a relay that is healing itself. The route may
   *            well be fine.
   * - `down`   the route answered with a refusal (401/403), with something
   *            that is not a runtime list, or it failed twice in a row.
   *
   * A caller deciding whether a door it has just opened is usable must accept
   * `up` and `hiccup`; only `down` is a reason to move on. A caller deciding
   * whether to leave a route it is already on should treat `hiccup` as "no
   * evidence yet" and let the watch timer decide.
   */
  async probeRoute(): Promise<RouteVerdict> {
    const reached = await this.refresh();
    if (reached) return "up";
    return this.snapshot.reach.kind === "ok" ? "hiccup" : "down";
  }

  /**
   * Verify the current route with a deadline short enough for a handover.
   *
   * Unlike `refresh`, a failure here is not a verdict: it does not increment
   * the tolerated-failure count or republish `reach`. The caller (a network
   * change) acts on it by starting a fresh attempt.
   *
   * It does share the refresh ordering token: a quickCheck races the watch's
   * refresh for the same snapshot, and a probe that started before a newer
   * read must not resolve after it and overwrite the newer answer with older
   * data. Superseded is not failed, though: the boolean answers "is the route
   * up", so a stale probe reports the reach already on screen and lets the
   * newer read — the one that made this one stale — deliver the verdict.
   * Reporting a bare `false` here would send the caller off to reconnect a
   * link that a newer, still-landing read may well prove healthy.
   */
  async quickCheck(timeoutMs = 5_000): Promise<boolean> {
    const seq = ++this.refreshSeq;
    const stale = () => seq !== this.refreshSeq;
    const superseded = (): boolean => this.snapshot.reach.kind === "ok";
    try {
      const response = await fetchWithTimeout(
        "/runtimes",
        { credentials: "same-origin" },
        timeoutMs,
      );
      if (stale()) return superseded();
      if (response.status === 401 || response.status === 403) {
        // The kernel answered. That is a connection, just an unauthorized one.
        this.failures = 0;
        this.publish({ reach: { kind: "unauthorized" }, runtimes: [] });
        return false;
      }
      if (!response.ok) return false;
      const body: unknown = await response.json();
      if (stale()) return superseded();
      if (!Array.isArray(body)) return false;
      const runtimes = body.filter(isRuntimeView);
      if (body.length > 0 && runtimes.length === 0) return false;
      this.failures = 0;
      this.publish({ reach: { kind: "ok" }, runtimes });
      this.reattachIfBaseMoved();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the stream back after something said the route is usable again.
   *
   * Two states need different repairs. A retrying stream is only waiting out a
   * backoff, so it retries at once. An open one may be a connection whose peer
   * went away while the app was frozen: no error ever fired, `readyState` still
   * says OPEN, and this call is the only notice it will get — hence `reopen`
   * rather than a no-op, which is what let a backgrounded phone come back to a
   * conversation that never updated again.
   */
  wakeStream(): void {
    const kind = this.snapshot.stream.kind;
    if (kind === "retrying") {
      this.stream?.retryNow();
      return;
    }
    if (kind === "open") this.stream?.reopen();
  }

  /**
   * A pane can move when the kernel is reached through another origin or the
   * relay; keeping a stream on its old URL would silently stop delivering
   * events while the list above it refreshed.
   */
  private reattachIfBaseMoved(): void {
    const active = this.activeRuntime;
    if (active === null) return;
    const runtime = this.snapshot.runtimes.find((candidate) => candidate.id === active);
    if (!runtime) {
      this.stream?.stop();
      this.stream = null;
      this.activeBase = null;
      this.publish({ stream: { kind: "closed", reason: "runtime went away" } });
      return;
    }
    if (this.activeBase !== runtime.base) this.attach(active, { silent: true });
  }

  /**
   * Attach to one pane's event stream, replacing whatever was attached.
   *
   * The cursor is loaded per runtime and persisted on every numbered frame, so
   * a cold start resumes rather than replays from zero.
   *
   * `silent` is for a repair: the same pane is now read from another base (a
   * handover moved the kernel from the relay to its LAN origin), and the
   * conversation did not change. A silent attach therefore keeps the pane's
   * status and its undrained frames — publishing `closed` there made a working
   * chat blink every time the transport moved. A different runtime is a new
   * pane, and must not inherit the previous one's queue even when silent.
   */
  attach(runtimeId: string, options: { silent?: boolean } = {}): void {
    const sameRuntime = this.activeRuntime === runtimeId;
    if (options.silent) this.stream?.close();
    else this.stream?.stop();
    this.stream = null;
    if (!options.silent || !sameRuntime) this.clearLastEvent();
    this.activeRuntime = runtimeId;
    const runtime = this.snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      this.publish({ stream: { kind: "closed", reason: "no such runtime" } });
      return;
    }
    this.activeBase = runtime.base;
    const stream = new RuntimeStream(absolute(streamUrl(runtime.base)), {
      onEvent: (event) => this.publishEvent(event),
      onState: (state) => this.publish({ stream: state }),
      onCursor: (seq) => saveCursor(runtimeId, seq),
    }, loadCursor(runtimeId));
    this.stream = stream;
    // A repair skips `connecting` too: the new base is either open or it is
    // not, and the first state a person sees should be the true one.
    stream.start(!options.silent);
  }

  detach(): void {
    this.stream?.stop();
    this.stream = null;
    this.clearLastEvent();
    this.activeRuntime = null;
    this.activeBase = null;
  }

  get attachedRuntime(): string | null {
    return this.activeRuntime;
  }
}
