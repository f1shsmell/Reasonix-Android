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
  lastEvent?: EventPayload;
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

export class Connection {
  private listeners = new Set<Listener>();
  private snapshot: ConnectionSnapshot = {
    reach: { kind: "unknown" },
    runtimes: [],
    stream: { kind: "idle" },
  };
  private stream: RuntimeStream | null = null;
  private activeRuntime: string | null = null;
  private activeBase: string | null = null;
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
   * `lastEvent` belongs to the pane that was attached when it arrived. A new
   * attach must not fold the previous pane's last frame into this transcript.
   */
  private clearLastEvent(): void {
    if (this.snapshot.lastEvent === undefined) return;
    const { lastEvent: _previous, ...rest } = this.snapshot;
    this.snapshot = rest;
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
   * Verify the current route with a deadline short enough for a handover.
   *
   * Unlike `refresh`, a failure here is not a verdict: it does not increment
   * the tolerated-failure count or republish `reach`. The caller (a network
   * change) acts on it by starting a fresh attempt.
   */
  async quickCheck(timeoutMs = 5_000): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        "/runtimes",
        { credentials: "same-origin" },
        timeoutMs,
      );
      if (response.status === 401 || response.status === 403) {
        this.failures = 0;
        this.publish({ reach: { kind: "unauthorized" }, runtimes: [] });
        return false;
      }
      if (!response.ok) return false;
      const body: unknown = await response.json();
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

  /** A stream waiting out its backoff should retry now that the network is back. */
  wakeStream(): void {
    if (this.snapshot.stream.kind !== "retrying") return;
    this.stream?.retryNow();
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
    if (this.activeBase !== runtime.base) this.attach(active);
  }

  /**
   * Attach to one pane's event stream, replacing whatever was attached.
   *
   * The cursor is loaded per runtime and persisted on every numbered frame, so
   * a cold start resumes rather than replays from zero.
   */
  attach(runtimeId: string): void {
    this.stream?.stop();
    this.stream = null;
    this.clearLastEvent();
    this.activeRuntime = runtimeId;
    const runtime = this.snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      this.publish({ stream: { kind: "closed", reason: "no such runtime" } });
      return;
    }
    this.activeBase = runtime.base;
    const stream = new RuntimeStream(absolute(streamUrl(runtime.base)), {
      onEvent: (event) => this.publish({ lastEvent: event }),
      onState: (state) => this.publish({ stream: state }),
      onCursor: (seq) => saveCursor(runtimeId, seq),
    }, loadCursor(runtimeId));
    this.stream = stream;
    stream.start();
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
