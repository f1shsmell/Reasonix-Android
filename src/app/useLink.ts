/**
 * The connection machine: one attempt at a time, LAN first, account second.
 *
 * The stream and the proxy can both be alive while nothing at the other end
 * answers, so an attempt only counts once `/runtimes` does. Failures are
 * classified (network vs authorization), a retryable one is scheduled with
 * backoff, and every outside signal — network change, foreground, retry button
 * — is a kick that cuts the wait short instead of starting a second machine.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import { failureFromError, openDoor } from "../net/door";
import type { Door } from "../net/door";
import {
  Backoff,
  LINK_STEPS,
  afterFailure,
  connectingLink,
  idleLink,
  linkFailure,
} from "../net/link";
import type { LinkError, LinkState, LinkStep } from "../net/link";
import { loadRelayDevice, saveRelayDevice, loadStandDown, saveStandDown, clearStandDown } from "../net/relayStore";
import {
  loadConnections,
  latestConnection,
  normalizeTarget,
  originName,
  rememberConnection,
} from "../net/savedConnections";
import type { SavedConnection } from "../net/savedConnections";
import { answeringOrigins, firstAnswering, readProxyConfig, refreshProxy } from "../net/server";
import type { ProxyConfig } from "../net/server";

function reachCode(reach: ConnectionSnapshot["reach"]): string {
  return reach.kind === "unauthorized" ? "device.unauthorized" : "client.offline";
}

/** Every LAN address worth trying, the ones this phone can reach directly first. */
export function lanDoorsOf(config: ProxyConfig | null): string[] {
  const saved = loadConnections()
    .filter((row) => row.kind === "lan")
    .map((row) => row.target);
  // The proxy already ordered what it remembered by "is this a neighbour of
  // my Wi-Fi". Rows the app knows about but the proxy does not keep their
  // place at the end rather than jumping the queue.
  const ordered = [...(config?.preferred ?? []), ...(config?.candidates ?? [])];
  return [
    ...new Set(
      [config?.origin ?? "", ...ordered, ...saved].filter(Boolean),
    ),
  ];
}

/**
 * Every door this phone would try, in the person's order.
 *
 * The saved list *is* the order: it holds LAN addresses and cloud devices in
 * one sequence, so "try home, then the office, then the account" is a thing
 * someone can arrange rather than a rule the app invents. Addresses the proxy
 * knows about but the app never recorded follow at the end — an install that
 * predates the saved list still gains its doors on first boot, without
 * jumping ahead of a list somebody arranged on purpose.
 *
 * `skip` holds targets this attempt already tried, so re-probing the origin
 * the phone is already on does not cost a second attempt.
 */
export function orderedDoors(
  config: ProxyConfig | null,
  saved: SavedConnection[],
  skip: Iterable<string> = [],
): Door[] {
  const doors: Door[] = [];
  const seen = new Set<string>(skip);
  const add = (kind: "lan" | "cloud", target: string, name?: string) => {
    // The key is the normalised target, because that is what a saved row
    // stores and what an attempt records as tried. Comparing raw strings let
    // "http://host:1/" and "http://host:1" be two doors.
    const key = `${kind}:${normalizeTarget(kind, target) || target}`;
    if (!target || seen.has(key)) return;
    seen.add(key);
    doors.push({ kind, target, ...(name ? { name } : {}) });
  };
  for (const row of saved) add(row.kind, row.target, row.name);
  // What the proxy remembers but the app does not, in the proxy's own order:
  // it is the side that can see which addresses are neighbours of this Wi-Fi.
  for (const origin of lanDoorsOf(config)) add("lan", origin, originName(origin));
  const device = config?.relayDevice || loadRelayDevice() || latestConnection("cloud")?.target;
  if (device) {
    add("cloud", device, saved.find((row) => row.kind === "cloud" && row.target === device)?.name);
  }
  return doors;
}

/** How a manual switch ended: the fleet row needs to know whether to open. */
export type SwitchResult = { ok: boolean };

/**
 * What a switch needs to know about a door.
 *
 * Narrower than `SavedConnection` on purpose: a switch names a computer, and
 * the stored rank and timestamp of a saved row are not part of that. Callers
 * that have a row pass it; callers that only know a target do not have to
 * invent the rest.
 */
export type SwitchTarget = Pick<SavedConnection, "kind" | "target" | "name">;

export interface Link {
  state: LinkState;
  /** Check now (network change, app resumed): cuts a backoff wait short. */
  kick: () => void;
  /** The person asked: same as a kick, but also retries a failed link. */
  retry: () => void;
  /** Switch to a recorded computer and verify it. */
  switchTo: (entry: SwitchTarget) => Promise<SwitchResult>;
  /** The settings screen just connected; record that, then re-read the list. */
  noteConnected: () => Promise<void>;
  /** The settings screen swapped the upstream and then could not verify it. */
  noteFailed: (error: LinkError) => void;
  /**
   * The system reported whether this phone has a network.
   *
   * Losing it stops the retry timer instead of letting it spin against a
   * network that is not there; getting it back is the signal that starts the
   * walk over the saved doors again, in their order.
   */
  noteNetwork: (connected: boolean) => void;
  /**
   * The person disconnected on purpose: stand down until they connect again.
   * A machine that auto-reconnects would fight the choice the screen just
   * carried out.
   */
  noteDisconnected: () => void;
}

export function useLink(connection: Connection): Link {
  const [state, setState] = useState<LinkState>(idleLink);
  const stateRef = useRef<LinkState>(idleLink);
  const configRef = useRef<ProxyConfig | null>(null);
  const backoff = useRef(new Backoff());
  const timer = useRef<number | null>(null);
  const active = useRef(false);
  /** Bumped by a manual switch and by unmount, so a stale attempt stands down. */
  const generation = useRef(0);
  /**
   * Set while the person's own disconnect stands: automatic kicks (a network
   * change, coming back to the foreground) honour it, and only a person's
   * retry or switch clears it. Without it the machine would fight the choice
   * the settings screen just carried out. Mirrored to storage so a restart
   * keeps the phone offline too.
   */
  const standDown = useRef(loadStandDown());
  /**
   * Whether the system says this phone has a network at all.
   *
   * Starts optimistic: a browser session has no network plugin to ask, and a
   * phone that has not reported yet is far more likely to be online than not.
   * A false value is what turns a retry into a wait, so guessing "offline"
   * would leave a working phone stuck until the first network event.
   */
  const online = useRef(true);
  const attemptRef = useRef<() => Promise<void>>(async () => {});

  const emit = useCallback((next: LinkState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const connected = useCallback(
    (target: string, name: string, mode: "lan" | "cloud") => {
      backoff.current.reset();
      // Only a verified connection is a place worth returning to.
      if (target) rememberConnection(mode === "lan" ? "lan" : "cloud", target, name);
      emit({
        phase: "connected",
        target,
        name,
        mode,
        attempt: 0,
        completed: LINK_STEPS,
      });
    },
    [emit],
  );

  const failed = useCallback(
    (error: LinkError, previous: LinkState) => {
      emit({
        phase: "failed",
        error,
        completed: [],
        attempt: backoff.current.attempt,
        ...(previous.target ? { target: previous.target } : {}),
        ...(previous.name ? { name: previous.name } : {}),
        ...(previous.mode ? { mode: previous.mode } : {}),
      });
    },
    [emit],
  );

  const schedule = useCallback(
    (error: LinkError) => {
      const previous = stateRef.current;
      const next = afterFailure(error, {
        online: online.current,
        exhausted: backoff.current.exhausted,
      });
      if (next === "wait-for-network") {
        clearTimer();
        emit({
          phase: "offline",
          error,
          completed: [],
          attempt: backoff.current.attempt,
          ...(previous.target ? { target: previous.target } : {}),
          ...(previous.name ? { name: previous.name } : {}),
          ...(previous.mode ? { mode: previous.mode } : {}),
        });
        return;
      }
      if (next === "fail") {
        failed(error, previous);
        return;
      }
      const delay = backoff.current.next();
      emit({
        phase: "reconnecting",
        error,
        attempt: backoff.current.attempt,
        nextRetryAt: Date.now() + delay,
        completed: [],
        ...(previous.target ? { target: previous.target } : {}),
        ...(previous.name ? { name: previous.name } : {}),
        ...(previous.mode ? { mode: previous.mode } : {}),
      });
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void attemptRef.current();
      }, delay);
    },
    [emit, failed],
  );

  const attempt = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    const mine = ++generation.current;
    const live = () => generation.current === mine;
    clearTimer();
    // The system says there is no network: every door would fail on a socket
    // that cannot open. Wait for the network instead of spending the retry
    // budget on a phone that is offline.
    if (!online.current) {
      active.current = false;
      emit({
        phase: "offline",
        completed: [],
        attempt: backoff.current.attempt,
        ...(stateRef.current.target ? { target: stateRef.current.target } : {}),
        ...(stateRef.current.name ? { name: stateRef.current.name } : {}),
        ...(stateRef.current.mode ? { mode: stateRef.current.mode } : {}),
        ...(stateRef.current.error ? { error: stateRef.current.error } : {}),
      });
      return;
    }
    // An automatic retry stays "reconnecting" while it runs; only a person
    // starting from idle sees "connecting".
    const retrying = stateRef.current.phase === "reconnecting";
    const stage = (step: LinkStep): LinkState => ({
      ...connectingLink(step, stateRef.current),
      ...(retrying ? { phase: "reconnecting" as const } : {}),
    });
    emit(stage("probe"));
    let last: LinkError | null = null;
    try {
      const fresh = await refreshProxy();
      if (!live()) return;
      if (fresh !== null) configRef.current = fresh;
      const config = fresh ?? configRef.current;

      if (config === null) {
        // A browser preview has no proxy to read; the page's own origin is
        // the kernel, so verify that and otherwise leave the chip quiet.
        await connection.refresh();
        if (!live()) return;
        if (connection.current.reach.kind === "ok") {
          connected("", "本机服务", "lan");
          return;
        }
        schedule(linkFailure(reachCode(connection.current.reach)));
        return;
      }

      const saved = loadConnections();
      /** Doors this attempt has already spent a try on. */
      const tried = new Set<string>();

      // The route the proxy already points at costs one request to verify,
      // where re-opening it costs a switch plus a probe. Verify it first, and
      // remember it so the ordered walk below does not repeat it. The key is
      // the normalised target, which is what `orderedDoors` compares against:
      // an origin with a trailing slash is the same door.
      if (config.mode !== "relay" && config.origin) {
        tried.add(`lan:${normalizeTarget("lan", config.origin)}`);
        await connection.refresh();
        if (!live()) return;
        if (connection.current.reach.kind === "ok") {
          connected(config.origin, originName(config.origin), "lan");
          return;
        }
        last = linkFailure(reachCode(connection.current.reach), "current origin");
      }

      // Everything else, in the order the person arranged. A door that does
      // not answer at all is skipped rather than given a probe deadline: the
      // sweep is what keeps a long list from costing a timeout per address,
      // and the walk keeps the list's order for the ones that do answer.
      const doors = orderedDoors(config, saved, tried);
      const lanTargets = doors.filter((door) => door.kind === "lan").map((door) => door.target);
      const reachable = new Set(
        lanTargets.length > 0 ? await answeringOrigins(lanTargets) : [],
      );
      if (!live()) return;

      for (const door of doors) {
        if (!live()) return;
        const name =
          door.name ?? (door.kind === "lan" ? originName(door.target) : "云端电脑");
        if (door.kind === "cloud" && !config.account.signedIn) continue;
        if (door.kind === "lan" && !reachable.has(door.target)) {
          last = last ?? linkFailure("client.offline", `origin ${door.target}`);
          continue;
        }
        const result = await openDoor(
          { kind: door.kind, target: door.target, name },
          (step) => {
            if (live()) emit({ ...stage(step), target: door.target, name, mode: door.kind });
          },
        );
        if (!live()) return;
        if (result.ok) {
          await connection.refresh();
          if (!live()) return;
          if (connection.current.reach.kind === "ok") {
            if (door.kind === "lan") {
              // Keep the cloud id as the hint for the next time this phone
              // leaves the Wi-Fi.
              const cloud =
                config.relayDevice || loadRelayDevice() || latestConnection("cloud")?.target;
              if (cloud) saveRelayDevice(cloud);
            }
            connected(door.target, name, door.kind);
            return;
          }
          last = linkFailure(
            reachCode(connection.current.reach),
            `${door.kind} ${door.target}`,
          );
          continue;
        }
        // A refusal from one door is not the end of the walk: the next
        // computer may still answer, and that is the whole point of a list.
        last = result.error;
      }

      if (!live()) return;
      schedule(
        last ?? linkFailure(doors.length > 0 ? "client.offline" : "no.doors"),
      );
    } catch (error) {
      if (live()) schedule(failureFromError(error));
    } finally {
      active.current = false;
    }
  }, [clearTimer, connected, connection, emit, schedule]);

  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  const kick = useCallback(() => {
    if (active.current) return;
    if (standDown.current) return;
    const phase = stateRef.current.phase;
    if (phase === "connecting") return;
    if (phase === "connected") {
      // A network change under a live link: ask whether a LAN door answers
      // now (the relay may still work but be the slower path), and verify the
      // current route quietly. Only a dead route starts a reconnect, so the
      // chip does not flash on every foreground.
      void (async () => {
        const config = await readProxyConfig();
        if (config?.mode === "relay") {
          const hit = await firstAnswering(lanDoorsOf(config));
          if (hit !== null) {
            if (active.current) return;
            backoff.current.reset();
            void attemptRef.current();
            return;
          }
        }
        await connection.refresh();
        if (connection.current.reach.kind === "ok") return;
        if (active.current) return;
        backoff.current.reset();
        void attemptRef.current();
      })();
      return;
    }
    clearTimer();
    backoff.current.reset();
    void attemptRef.current();
  }, [clearTimer, connection]);

  /**
   * Try now, whether or not the system still believes it is offline.
   *
   * The `online` flag is a cache of one `networkStatusChange` event, and a
   * phone that regained Wi-Fi while the app was paused can miss it entirely.
   * A person tapping 重试 is a stronger signal than that cache, so their own
   * action clears it; the attempt then either succeeds or sets it again from
   * its own failure.
   */
  const retry = useCallback(() => {
    standDown.current = false;
    clearStandDown();
    online.current = true;
    backoff.current.reset();
    kick();
  }, [kick]);

  /**
   * The system's answer about this phone's network.
   *
   * Losing it cancels the retry timer: an attempt fired while offline can only
   * fail, and a chain of those is exactly the "still retrying after the Wi-Fi
   * died" this state exists to prevent. Regaining it resets the backoff — the
   * person was not waiting on this computer, they were waiting on the network
   * — and starts one attempt that walks the saved doors in order.
   */
  const noteNetwork = useCallback(
    (reachable: boolean) => {
      const was = online.current;
      online.current = reachable;
      if (!reachable) {
        clearTimer();
        // Only a link that was waiting on a retry has anything to stop. A
        // live link may still answer over another interface, a first attempt
        // is already running, and a failure the person can read ("配对失效")
        // should not be replaced by "no network".
        const phase = stateRef.current.phase;
        if (phase !== "reconnecting" && phase !== "offline") return;
        emit({
          phase: "offline",
          completed: [],
          attempt: backoff.current.attempt,
          ...(stateRef.current.target ? { target: stateRef.current.target } : {}),
          ...(stateRef.current.name ? { name: stateRef.current.name } : {}),
          ...(stateRef.current.mode ? { mode: stateRef.current.mode } : {}),
          ...(stateRef.current.error ? { error: stateRef.current.error } : {}),
        });
        return;
      }
      if (was) return;
      if (standDown.current) return;
      if (active.current) return;
      backoff.current.reset();
      clearTimer();
      // `kick` already knows what each phase deserves: a live link is only
      // verified quietly, and a waiting one starts a fresh walk over the
      // saved doors.
      kick();
    },
    [clearTimer, emit, kick],
  );

  const switchTo = useCallback(
    async (entry: SwitchTarget) => {
      if (active.current) return { ok: false };
      active.current = true;
      standDown.current = false;
      clearStandDown();
      clearTimer();
      backoff.current.reset();
      const mine = ++generation.current;
      const live = () => generation.current === mine;
      const mode = entry.kind === "lan" ? "lan" : "cloud";
      const room = (): LinkState => ({
        ...connectingLink("switch"),
        target: entry.target,
        name: entry.name,
        mode,
      });
      emit(room());
      try {
        const result = await openDoor(
          { kind: entry.kind, target: entry.target, name: entry.name },
          (step) => {
            if (live()) {
              emit({
                ...connectingLink(step, stateRef.current),
                target: entry.target,
                name: entry.name,
                mode,
              });
            }
          },
        );
        if (!live()) return { ok: false };
        if (!result.ok) {
          failed(result.error, room());
          return { ok: false };
        }
        await connection.refresh();
        if (!live()) return { ok: false };
        if (connection.current.reach.kind !== "ok") {
          failed(linkFailure(reachCode(connection.current.reach)), room());
          return { ok: false };
        }
        if (mode === "lan") {
          const cloud = latestConnection("cloud")?.target || loadRelayDevice();
          if (cloud) saveRelayDevice(cloud);
        }
        connected(entry.target, entry.name, mode);
        return { ok: true };
      } catch (error) {
        if (live()) {
          failed(failureFromError(error), room());
        }
        return { ok: false };
      } finally {
        active.current = false;
      }
    },
    [clearTimer, connected, connection, emit, failed],
  );

  const noteConnected = useCallback(async () => {
    standDown.current = false;
    clearStandDown();
    clearTimer();
    backoff.current.reset();
    const mine = ++generation.current;
    const config = await readProxyConfig();
    if (generation.current !== mine) return;
    const mode: "lan" | "cloud" = config?.mode === "relay" ? "cloud" : "lan";
    const target = mode === "cloud" ? (config?.relayDevice ?? "") : (config?.origin ?? "");
    const entry = loadConnections().find(
      (row) => row.kind === (mode === "cloud" ? "cloud" : "lan") && row.target === target,
    );
    const name =
      entry?.name ?? (mode === "cloud" ? "云端电脑" : target ? originName(target) : undefined);
    emit({
      phase: "connected",
      mode,
      attempt: 0,
      completed: LINK_STEPS,
      ...(target ? { target } : {}),
      ...(name ? { name } : {}),
    });
    await connection.refresh();
  }, [clearTimer, connection, emit]);

  const noteFailed = useCallback(
    (error: LinkError) => {
      generation.current += 1;
      clearTimer();
      backoff.current.reset();
      failed(error, stateRef.current);
    },
    [clearTimer, failed],
  );

  const noteDisconnected = useCallback(() => {
    generation.current += 1;
    clearTimer();
    backoff.current.reset();
    standDown.current = true;
    saveStandDown();
    emit({ phase: "idle", completed: [], attempt: 0 });
  }, [clearTimer, emit]);

  useEffect(
    () => () => {
      generation.current += 1;
      clearTimer();
    },
    [clearTimer],
  );

  return {
    state,
    kick,
    retry,
    switchTo,
    noteConnected,
    noteFailed,
    noteNetwork,
    noteDisconnected,
  };
}
