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

  private publish(patch: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /** Refresh the runtime list. This is the reachability probe as well. */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const stale = () => seq !== this.refreshSeq;
    try {
      const response = await fetchWithTimeout("/runtimes", { credentials: "same-origin" }, 12_000);
      if (stale()) return;
      if (response.status === 401 || response.status === 403) {
        this.publish({ reach: { kind: "unauthorized" }, runtimes: [] });
        return;
      }
      if (!response.ok) {
        this.publish({ reach: { kind: "unreachable", detail: `HTTP ${response.status}` } });
        return;
      }
      const body: unknown = await response.json();
      if (stale()) return;
      if (!Array.isArray(body)) {
        this.publish({ reach: { kind: "unreachable", detail: "invalid /runtimes response" } });
        return;
      }
      const runtimes = body.filter(isRuntimeView);
      if (body.length > 0 && runtimes.length === 0) {
        this.publish({ reach: { kind: "unreachable", detail: "invalid /runtimes response" } });
        return;
      }
      this.publish({ reach: { kind: "ok" }, runtimes });
      this.reattachIfBaseMoved();
    } catch (error) {
      if (stale()) return;
      this.publish({
        reach: {
          kind: "unreachable",
          detail: error instanceof Error ? error.message : "network error",
        },
      });
    }
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
