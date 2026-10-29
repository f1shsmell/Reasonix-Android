/**
 * The app's one connection: which kernel it is talking to, whether that kernel
 * is reachable, and the runtimes it currently has open.
 *
 * Reachability is a separate fact from stream health. A stream can be retrying
 * while the kernel is fine, and a kernel can be gone while the last stream
 * frame is still on screen; showing one number for both would lie about which.
 */

import type { RuntimeView } from "../wire/runtime";
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
    try {
      const response = await fetch("/runtimes", { credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) {
        this.publish({ reach: { kind: "unauthorized" }, runtimes: [] });
        return;
      }
      if (!response.ok) {
        this.publish({ reach: { kind: "unreachable", detail: `HTTP ${response.status}` } });
        return;
      }
      const runtimes = (await response.json()) as RuntimeView[];
      this.publish({ reach: { kind: "ok" }, runtimes });
    } catch (error) {
      this.publish({
        reach: {
          kind: "unreachable",
          detail: error instanceof Error ? error.message : "network error",
        },
      });
    }
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
    this.activeRuntime = runtimeId;
    const runtime = this.snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) {
      this.publish({ stream: { kind: "closed", reason: "no such runtime" } });
      return;
    }
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
    this.activeRuntime = null;
  }

  get attachedRuntime(): string | null {
    return this.activeRuntime;
  }
}
