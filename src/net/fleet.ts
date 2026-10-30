/**
 * The other computers this phone watches while one is active.
 *
 * The active connection stays what it was: the proxy's single upstream and the
 * link machine's one target. What the fleet adds is a read-only answer to
 * "what is happening on the computers I am not looking at" — the running and
 * blocked conversations the home screen would otherwise hide behind a switch.
 *
 * A LAN peer is read through the proxy's per-peer route with that computer's
 * own pairing cookie. One sweep is one `/runtimes` call plus a `/status` call
 * per open pane — the pane list carries the projects, so `/tree` is never
 * pulled for a computer nobody is looking at. The sweep runs only while the
 * app is visible, and never in the background: this feature is about seeing,
 * and a notification remains the active connection's job alone.
 *
 * A cloud peer is listed but not watchable. The relay carries one link, and
 * dialling a second one just to draw a dot is a handshake per poll; until
 * links can live side by side, an inactive cloud computer shows what the
 * account knows about it instead of pretending to read it.
 */

import { fleetRead, loadFleet, saveFleet } from "./server";
import type { FleetEntry } from "./server";
import { isRuntimeView } from "./connection";
import { parseRuntimeStatus } from "./status";
import type { Decision } from "./status";
import type { RuntimeView } from "../wire/runtime";

export type { FleetEntry };

/** The proxy refuses a longer list; the app repeats the bound it enforces. */
const MAX_PEERS = 4;
/** A visible sweep is cheap; a hidden phone is a dark screen. */
const VISIBLE_SWEEP_MS = 20_000;
/** A pane status is one round trip to a computer over a LAN. */
const STATUS_TIMEOUT_MS = 6_000;

export interface FleetPendingItem {
  peer: number;
  peerName: string;
  runtimeId: string;
  projectName: string;
  projectRoot: string;
  /** The conversation's stored path; opening it binds, it does not mint. */
  sessionPath: string;
  title: string;
  decision: Decision;
}

export interface FleetRunningItem {
  peer: number;
  peerName: string;
  runtimeId: string;
  projectName: string;
  projectRoot: string;
  sessionPath: string;
  title: string;
}

export interface PeerState {
  index: number;
  kind: "lan" | "cloud";
  target: string;
  name: string;
  /** `unknown` until the first sweep reaches it. */
  state: "unknown" | "online" | "offline" | "unauthorized" | "unwatchable";
  /** Unix milliseconds of the last answer of any kind. */
  seenAt: number;
}

export interface FleetSnapshot {
  /** The watched peer the active connection is, or -1 when it is not watched. */
  active: number;
  peers: PeerState[];
  pending: FleetPendingItem[];
  running: FleetRunningItem[];
}

export const emptyFleet: FleetSnapshot = { active: -1, peers: [], pending: [], running: [] };

type Listener = (snapshot: FleetSnapshot) => void;

interface PeerRead {
  ok: boolean;
  code: string;
  pending: FleetPendingItem[];
  running: FleetRunningItem[];
}

/** A pane's title when the runtime row itself is all the phone knows. */
function paneTitle(runtime: RuntimeView): string {
  if (runtime.sessionPath) {
    const base = runtime.sessionPath.split(/[\\/]/).pop() ?? "";
    if (base) return base;
  }
  return runtime.name;
}

/**
 * One peer's read: the pane list, then the status of every open pane.
 *
 * `unauthorized` travels separately from `offline`: an expired pairing is
 * fixable by reconnecting, while a computer that is simply not there is not.
 */
async function sweepPeer(index: number): Promise<PeerRead> {
  const none: PeerRead = { ok: false, code: "", pending: [], running: [] };
  const list = await fleetRead(`/__reasonix/fleet/${index}/runtimes`);
  if (!list.ok) return { ...none, code: list.code };
  if (!Array.isArray(list.body)) return { ...none, code: "runtime.shape" };
  const runtimes = list.body.filter(isRuntimeView);
  const statuses = await Promise.all(
    runtimes.map((runtime) =>
      fleetRead(
        `/__reasonix/fleet/${index}/rt/${encodeURIComponent(runtime.id)}/status`,
        STATUS_TIMEOUT_MS,
      ).then((read) => ({ runtime, read })),
    ),
  );
  const pending: FleetPendingItem[] = [];
  const running: FleetRunningItem[] = [];
  for (const { runtime, read } of statuses) {
    if (!read.ok) continue;
    const parsed = parseRuntimeStatus(read.body);
    if (!parsed) continue;
    const who = {
      peer: index,
      runtimeId: runtime.id,
      projectName: runtime.name,
      projectRoot: runtime.root,
      sessionPath: runtime.sessionPath ?? "",
      title: paneTitle(runtime),
    };
    for (const decision of parsed.decisions) {
      pending.push({ ...who, peerName: "", decision });
    }
    if (parsed.running) running.push({ ...who, peerName: "" });
  }
  return { ok: true, code: "", pending, running };
}

/**
 * The fleet watcher. One instance for the app; `App` owns its lifecycle.
 *
 * `activePeer` is the index of the connection the app is already using, so its
 * conversations are not double-reported by the fleet block.
 */
export class Fleet {
  private listeners = new Set<Listener>();
  private snapshot: FleetSnapshot = emptyFleet;
  private names = new Map<number, string>();
  private watchable = new Map<number, boolean>();
  private kinds = new Map<number, "lan" | "cloud">();
  private targets = new Map<number, string>();
  /** The last sweep's verdict per peer; the snapshot is composed from it. */
  private verdicts = new Map<number, { state: PeerState["state"]; at: number }>();
  private timer: number | null = null;
  private tick: (() => void) | null = null;
  private sweeping = false;
  /**
   * Bumped whenever the mirrored list is rebuilt. A sweep that started
   * against an older list must not write its verdicts into the new one: the
   * indexes would name computers the sweep never read.
   */
  private generation = 0;
  private activePeer = -1;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  get current(): FleetSnapshot {
    return this.snapshot;
  }

  /** The watched peer that is the active connection, or -1. */
  get active(): number {
    return this.activePeer;
  }

  private publish(): void {
    const peers = [...this.names.keys()].sort((a, b) => a - b).map((index) => {
      const verdict = this.verdicts.get(index);
      const unwatchable = this.watchable.get(index) === false;
      return {
        index,
        kind: this.kinds.get(index) ?? "lan",
        target: this.targets.get(index) ?? "",
        name: this.names.get(index) ?? "",
        state: unwatchable ? ("unwatchable" as const) : (verdict?.state ?? "unknown"),
        seenAt: verdict?.at ?? 0,
      };
    });
    this.snapshot = {
      active: this.activePeer,
      peers,
      pending: this.snapshot.pending.map((item) => ({ ...item, peerName: this.names.get(item.peer) ?? "" })),
      running: this.snapshot.running.map((item) => ({ ...item, peerName: this.names.get(item.peer) ?? "" })),
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Name the peer the active connection is. Its rows are the home screen's
   * own blocks already; the fleet hides them instead of doubling them.
   */
  setActiveTarget(kind: "lan" | "cloud", target: string): void {
    const key = originKey(kind, target);
    let index = -1;
    for (const [candidate, entryKind] of this.kinds) {
      if (entryKind === kind && originKey(kind, this.targets.get(candidate) ?? "") === key) {
        index = candidate;
      }
    }
    if (index === this.activePeer) return;
    this.activePeer = index;
    this.publish();
  }

  /**
   * Sync the watch list and read every peer once.
   *
   * The list lives in the proxy; the app mirrors it here so an index is the
   * same computer on both sides until the next sync.
   */
  async refresh(): Promise<void> {
    const mine = ++this.generation;
    const peers = await loadFleet();
    if (mine !== this.generation) return;
    if (peers === null) {
      // No proxy (a browser dev session) or an old shell: the fleet does not
      // exist there, and the app keeps its single-connection behaviour.
      this.stop();
      if (this.names.size > 0) this.reset();
      return;
    }
    this.names.clear();
    this.kinds.clear();
    this.targets.clear();
    this.watchable.clear();
    for (const [index, peer] of peers.entries()) {
      this.names.set(index, peer.name);
      this.kinds.set(index, peer.kind);
      this.targets.set(index, peer.target);
      this.watchable.set(index, peer.watchable);
    }
    for (const index of [...this.verdicts.keys()]) {
      if (index >= peers.length) this.verdicts.delete(index);
    }
    if (this.activePeer >= peers.length) this.activePeer = -1;
    await this.sweep();
  }

  private reset(): void {
    this.names.clear();
    this.watchable.clear();
    this.kinds.clear();
    this.targets.clear();
    this.verdicts.clear();
    this.activePeer = -1;
    this.snapshot = emptyFleet;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    const mine = this.generation;
    try {
      const watchable = [...this.names.keys()].filter((index) => this.watchable.get(index) !== false);
      const results = await Promise.all(
        watchable.map(async (index) => ({ index, read: await sweepPeer(index) })),
      );
      // The list was rebuilt while this sweep was in flight; its indexes are
      // someone else's now, so it writes nothing.
      if (mine !== this.generation) return;
      const pending: FleetPendingItem[] = [];
      const running: FleetRunningItem[] = [];
      for (const { index, read } of results) {
        const state = read.ok
          ? "online"
          : read.code === "device.unauthorized"
            ? "unauthorized"
            : "offline";
        this.verdicts.set(index, { state, at: Date.now() });
        if (read.ok) {
          pending.push(...read.pending);
          running.push(...read.running);
        }
      }
      this.snapshot = { active: this.activePeer, peers: this.snapshot.peers, pending, running };
      this.publish();
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Visible-and-reading cadence.
   *
   * Later sweeps only run while the document is visible, because a phone in a
   * pocket gains nothing from a list it cannot show. The active peer is
   * filtered at draw time, not here: a sweep that raced a switch still carries
   * every computer's truth.
   */
  start(): void {
    if (this.timer !== null) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void this.sweep();
    };
    this.tick = tick;
    this.timer = window.setInterval(tick, VISIBLE_SWEEP_MS);
    document.addEventListener("visibilitychange", tick);
  }

  stop(): void {
    if (this.tick !== null) {
      document.removeEventListener("visibilitychange", this.tick);
      this.tick = null;
    }
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** The dot tone a peer's state draws, matching the app's other status dots. */
export function peerTone(state: PeerState["state"]): "ok" | "warn" | "bad" | "idle" {
  switch (state) {
    case "online":
      return "ok";
    case "unauthorized":
      return "warn";
    case "offline":
      return "bad";
    default:
      return "idle";
  }
}

/**
 * One spelling per computer, matching the proxy's own normalization: host
 * case and an explicit default port do not make a second computer.
 */
export function originKey(kind: "lan" | "cloud", target: string): string {
  const trimmed = target.trim();
  if (kind === "cloud" || !trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return trimmed;
  }
}

/**
 * Add a computer to the watch list after a verified connection.
 *
 * The proxy holds the list and keeps it across restarts; this write mirrors
 * what `openDoor` just verified, so the next boot already knows which
 * computers to listen to. The list is never reordered: `/__reasonix/fleet/<n>`
 * addresses a computer by index, so moving a row would make every reader that
 * cached the list read another computer's cookies. A computer already on the
 * list is updated in place (however its host was spelled), a new one is
 * appended, and a full list stays as it is — the cap wins over recency.
 */
export async function syncFleetPeer(
  kind: "lan" | "cloud",
  target: string,
  name: string,
): Promise<void> {
  const current = await loadFleet();
  if (current === null) return;
  const row: FleetEntry = { kind, target, name, watchable: kind === "lan" };
  const key = originKey(kind, target);
  const at = current.findIndex(
    (entry) => entry.kind === kind && originKey(entry.kind, entry.target) === key,
  );
  if (at >= 0) {
    const existing = current[at];
    // A reconnect to a watched computer is the common case; only a changed
    // name is worth another write to the proxy.
    if (existing && existing.name === name) return;
    const next = [...current];
    next[at] = { ...row, target: existing?.target ?? target };
    await saveFleet(next);
    return;
  }
  if (current.length >= MAX_PEERS) return;
  await saveFleet([...current, row]);
}
