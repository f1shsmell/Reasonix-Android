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
import { prefetchGrant, relayState } from "../net/relay";
import { loadAutoHandover } from "./handoverPref";
import { machineRelation } from "../net/sameMachine";
import type { DoorRef } from "../net/sameMachine";
import {
  directDoorForMachine,
  learnConnectionMachine,
  loadConnections,
  latestConnection,
  machineKey,
  normalizeTarget,
  originHost,
  originName,
  rememberConnection,
} from "../net/savedConnections";
import type { SavedConnection } from "../net/savedConnections";
import {
  answeringOrigins,
  readMachineIdentity,
  readProxyConfig,
  refreshProxy,
} from "../net/server";
import type { ProxyConfig } from "../net/server";
import type { NetworkStatus } from "../net/network";

function reachCode(reach: ConnectionSnapshot["reach"]): string {
  return reach.kind === "unauthorized" ? "device.unauthorized" : "client.offline";
}

/** Every LAN address worth trying, the ones this phone can reach directly first. */
export function lanDoorsOf(config: ProxyConfig | null): string[] {
  const saved = config?.ephemeral
    ? []
    : loadConnections()
        .filter((row) => row.kind === "lan")
        .map((row) => row.target);
  // The proxy already ordered what it remembered by "is this a neighbour of
  // my Wi-Fi". Rows the app knows about but the proxy does not keep their
  // place at the end rather than jumping the queue.
  const ordered = [...(config?.preferred ?? []), ...(config?.candidates ?? [])];
  /**
   * One door per host.
   *
   * A kernel that restarted on a new port leaves its old address behind in
   * the proxy's list, and both would be probed — a deadline spent on a door
   * that is gone. Hosts are compared the way `originHost` does, so a spelling
   * difference is not a second computer. Different hosts stay: a Wi-Fi
   * address and a tunnel address are two doors to one machine and both work.
   */
  const doors: string[] = [];
  const hosts = new Set<string>();
  for (const origin of [config?.origin ?? "", ...ordered, ...saved]) {
    if (!origin) continue;
    const host = originHost(origin);
    if (host && hosts.has(host)) continue;
    if (host) hosts.add(host);
    if (!doors.includes(origin)) doors.push(origin);
  }
  return doors;
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
  const add = (kind: "lan" | "cloud", target: string, name?: string, machine?: string) => {
    // The key is the normalised target, because that is what a saved row
    // stores and what an attempt records as tried. Comparing raw strings let
    // "http://host:1/" and "http://host:1" be two doors.
    const key = `${kind}:${normalizeTarget(kind, target) || target}`;
    if (!target || seen.has(key)) return;
    seen.add(key);
    doors.push({
      kind,
      target,
      ...(name ? { name } : {}),
      ...(machine ? { machine } : {}),
    });
  };
  if (!config?.ephemeral) {
    for (const row of saved) add(row.kind, row.target, row.name, row.machine);
  }
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
export type SwitchTarget = Pick<SavedConnection, "kind" | "target" | "name" | "machine">;

export interface Link {
  state: LinkState;
  /** Check now (network change, app resumed): cuts a backoff wait short. */
  kick: () => void;
  /** The person asked: same as a kick, but also retries a failed link. */
  retry: () => void;
  /** Switch to a recorded computer and verify it. */
  switchTo: (entry: SwitchTarget) => Promise<SwitchResult>;
  /**
   * Prefer the LAN door to the computer already reached through the account.
   *
   * Called when Wi-Fi returns and while a cloud link is live. It does nothing
   * unless both doors name the same machine and the proxy says the LAN origin
   * is a neighbour, and a failed upgrade restores the cloud link.
   */
  preferLan: () => void;
  /** The settings screen just connected; record that, then re-read the list. */
  noteConnected: () => Promise<void>;
  /**
   * Verify a live link without ever tearing it down.
   *
   * This is what a foreground or a settings visit should ask for: it reads the
   * route and leaves the state machine alone. A route that has actually
   * stopped answering is handled by `watch`, not by the mere act of a screen
   * appearing.
   */
  check: () => void;
  /**
   * Look after a live link: verify it, and reconnect only when the transport
   * has really stopped answering.
   *
   * Called on a timer while the app is on screen. A single lost request is
   * not enough — that is the difference between "the Wi-Fi hiccuped while you
   * opened settings" and "the computer is gone".
   */
  watch: () => void;
  /**
   * Verify the live route after a foreground, and repair the stream when it
   * still answers.
   *
   * Distinct from `check`: a route that answers is not proof the event stream
   * is alive. A phone frozen in the background comes back with a connection
   * whose peer closed it long ago, and nothing reports that — so a reachable
   * route also wakes the stream. A route that no longer answers goes to a
   * fresh attempt instead of waiting out a backoff.
   */
  reassess: () => void;
  /** The settings screen swapped the upstream and then could not verify it. */
  noteFailed: (error: LinkError) => void;
  /**
   * The platform's view of the default network.
   *
   * A network change is not only a disconnect: Wi-Fi A→B and cellular→Wi-Fi
   * keep `connected` true. `changed` says the route itself may have moved, so
   * a live link is verified once and reconnected immediately if it no longer
   * answers.
   */
  noteNetwork: (status: NetworkStatus, changed?: boolean) => void;
  /**
   * The person disconnected on purpose: stand down until they connect again.
   * A machine that auto-reconnects would fight the choice the screen just
   * carried out.
   */
  noteDisconnected: () => void;
}

/**
 * What one walk may do differently.
 *
 * `skipLan` is set by a stale pairing: the LAN cookie that expired cannot be
 * repaired by retrying it, while the account may still reach the same
 * machine. Passing it per call rather than through a shared flag keeps it
 * from leaking into an unrelated retry that happens to start first.
 */
export interface AttemptOptions {
  skipLan?: boolean;
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
   * Whether the system says a default network exists.
   *
   * This is deliberately not Android's "validated internet": a LAN-only Wi-Fi
   * is connected enough to reach the kernel, and treating it as offline would
   * leave the phone waiting for a validation that may never come. Starts
   * optimistic: a browser session has no network plugin to ask, and a phone
   * that has not reported yet is far more likely to be online than not.
   */
  const online = useRef(true);
  const lastNetwork = useRef<NetworkStatus | null>(null);
  /** A change arrived while an attempt was running; retry when it ends. */
  const networkDirty = useRef(false);
  /** Coalesces capability bursts into one reassessment. */
  const lastNetworkKick = useRef(0);
  /** One short verification after a change; overlapping events share it. */
  const reassessing = useRef(false);
  const attemptRef = useRef<(options?: AttemptOptions) => Promise<void>>(async () => {});

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
    (target: string, name: string, mode: "lan" | "cloud", machine?: string) => {
      backoff.current.reset();
      // Only a verified connection is a place worth returning to.
      if (target) rememberConnection(mode === "lan" ? "lan" : "cloud", target, name, machine);
      // A LAN link that was reached without walking through `openDoor` (the
      // route the proxy already held) still gets a name for the next match.
      if (mode === "lan" && target) {
        void readMachineIdentity(target).then((identity) => {
          if (identity) learnConnectionMachine("lan", target, identity.machine);
        });
      }
      // A stream may be waiting out a backoff from before the route was
      // restored; retry it now with the same cursor.
      networkDirty.current = false;
      connection.wakeStream();
      emit({
        phase: "connected",
        target,
        name,
        mode,
        attempt: 0,
        completed: LINK_STEPS,
      });
    },
    [connection, emit],
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

  const attempt = useCallback(async (options: AttemptOptions = {}) => {
    if (active.current) return;
    active.current = true;
    const mine = ++generation.current;
    const live = () => generation.current === mine;
    clearTimer();
    /**
     * What the app was doing before this attempt.
     *
     * Read before any `emit`: a retry keeps the phase it started under, and
     * the transport it was on is what a handover has to be judged against.
     */
    const from = stateRef.current;
    const skipLan = options.skipLan === true;
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
    /**
     * A walk that started from a working link keeps that link's face.
     *
     * The session is still on screen and the transport is being repaired, not
     * established, so the chip must not blink back to "finding the computer"
     * for the second it takes to try the next door. The budget is short on
     * purpose: a repair that is really an outage has to say so, and a failure
     * is still reported at once by `schedule`.
     */
    const recovering = from.phase === "connected";
    const silentUntil = recovering ? Date.now() + 3_000 : 0;
    const stage = (step: LinkStep): LinkState => {
      if (Date.now() < silentUntil && stateRef.current.phase === "connected") {
        return { ...stateRef.current, step };
      }
      return {
        ...connectingLink(step, stateRef.current),
        // A repair that ran out of budget is "reconnecting", not "connecting":
        // the person never asked for a new link, they lost the one they had.
        ...(retrying || recovering ? { phase: "reconnecting" as const } : {}),
      };
    };
    emit(stage("probe"));
    // A skipped LAN walk still has to say why it ended if no cloud door can
    // be opened: the person's pairing expired, not their network.
    let last: LinkError | null = skipLan ? linkFailure("device.unauthorized") : null;
    try {
      const fresh = await refreshProxy();
      if (!live()) return;
      if (fresh !== null) configRef.current = fresh;
      const config = fresh ?? configRef.current;

      if (config === null) {
        // A browser preview has no proxy to read; the page's own origin is
        // the kernel, so verify that and otherwise leave the chip quiet.
        // The return value is the answer for *this* read: the snapshot may
        // still say "ok" from before while the read itself failed.
        const reached = await connection.refresh();
        if (!live()) return;
        if (reached) {
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
      if (!skipLan && config.mode !== "relay" && config.origin) {
        tried.add(`lan:${normalizeTarget("lan", config.origin)}`);
        const reached = await connection.refresh();
        if (!live()) return;
        if (reached) {
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
      /**
       * What this walk may switch to.
       *
       * A runtime id only means something on the kernel that minted it, so a
       * door the list proves reaches another computer never opens on its own
       * — of any kind. A transport switch needs more: both doors proven to be
       * the same computer, and the person's permission.
       *
       * `from` keeps `target` and `mode` through a retry (`schedule` carries
       * them), and that is exactly the walk this rule exists for. Keying it on
       * the `connected` phase instead let the first refused walk be followed
       * by a retry that took the other computer. Only a first connection,
       * which has no route at all, is free to open any door.
       */
      const autoHandover = loadAutoHandover();
      const fromDoor: DoorRef | null =
        from.target && from.mode ? { kind: from.mode, target: from.target } : null;
      const refused = (door: Door): LinkError | null => {
        if (fromDoor === null) return null;
        const relation = machineRelation(saved, fromDoor, door);
        if (relation === "different")
          return linkFailure("handover.other_machine", `${door.kind} ${door.target}`);
        if (door.kind === fromDoor.kind) return null;
        // A door the list has not named is a refusal here, not a guess.
        if (relation !== "same")
          return linkFailure("handover.unknown", `${door.kind} ${door.target}`);
        if (!autoHandover) return linkFailure("handover.off", `${door.kind} ${door.target}`);
        return null;
      };
      // A cloud handshake begins with a round trip to the account service, and
      // the walk cannot reach that door until this sweep has finished. Ask for
      // the ticket now so the round trip runs beside the probe instead of
      // after it: it touches no proxy upstream and no socket, so it cannot
      // disturb a LAN attempt. The ticket is only spent if the walk reaches
      // the door while it is still fresh.
      if (config.account.signedIn) {
        for (const door of doors) {
          // Deliberately not filtered by `refused`: a ticket touches no proxy
          // upstream and no socket, and keeping the request beside the sweep
          // is what stops a cloud handshake from starting only after the LAN
          // probe has finished. A door that turns out to be refused costs one
          // cached round trip, not a wrong switch.
          if (door.kind === "cloud") prefetchGrant(door.target);
        }
      }
      const reachable = new Set(
        !skipLan && lanTargets.length > 0 ? await answeringOrigins(lanTargets) : [],
      );
      if (!live()) return;

      for (const door of doors) {
        if (!live()) return;
        const name =
          door.name ?? (door.kind === "lan" ? originName(door.target) : "云端电脑");
        if (door.kind === "cloud" && !config.account.signedIn) continue;
        // The credential that just expired belongs to every LAN door, so a
        // stale-pairing walk spends nothing on them.
        if (skipLan && door.kind === "lan") continue;
        // A refusal is not a failure of this route: it is a rule about what
        // may change without the person asking. Keep walking the doors of the
        // transport already in use; only a walk with nothing left to try ends
        // on it.
        const refusal = refused(door);
        if (refusal) {
          last = last ?? refusal;
          continue;
        }
        if (door.kind === "lan" && !reachable.has(door.target)) {
          last = last ?? linkFailure("client.offline", `origin ${door.target}`);
          continue;
        }
        const result = await openDoor(
          {
            kind: door.kind,
            target: door.target,
            name,
            ...(door.machine ? { machine: door.machine } : {}),
          },
          (step) => {
            if (live()) emit({ ...stage(step), target: door.target, name, mode: door.kind });
          },
        );
        if (!live()) return;
        if (result.ok) {
          // Verify the door with the read's own answer, not the snapshot: a
          // tolerated hiccup leaves `reach` at "ok" from an earlier door, and
          // trusting that would call a dead route connected.
          const reached = await connection.refresh();
          if (!live()) return;
          if (reached) {
            if (door.kind === "lan") {
              // Keep the cloud id as the hint for the next time this phone
              // leaves the Wi-Fi.
              const cloud =
                config.relayDevice || loadRelayDevice() || latestConnection("cloud")?.target;
              if (cloud) saveRelayDevice(cloud);
            }
            connected(door.target, name, door.kind, door.machine);
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
      // A door the first sweep missed can come back while the walk spends its
      // budget on a slow one — "the first address answered only after the
      // second was already being tried" is exactly this case. One more sweep
      // before sleeping on a backoff is cheap: the probes run together and
      // each carries its own short deadline, so the whole check costs one
      // probe's wait rather than the sum of a retry cycle.
      //
      // Only on a transport failure, only while the phone thinks it has a
      // network, and only before the first backoff has been handed out: an
      // authorization failure will not improve by re-probing, a phone with no
      // network would only pay one more deadline for nothing, and repeating
      // this on every retry would turn a backoff into a tight loop.
      if (last?.retryable === true && online.current && backoff.current.attempt === 0) {
        const missed = doors
          .filter((door) => door.kind === "lan" && !reachable.has(door.target))
          .map((door) => door.target);
        if (missed.length > 0) {
          const restored = await answeringOrigins(missed);
          if (!live()) return;
          if (restored.length > 0) {
            // The restart is one retry, so it has to spend one. Leaving the
            // count at zero let the next attempt enter this branch again, and
            // a door that keeps flapping across the probe deadline — missed by
            // the sweep, caught by the re-probe, missed again — restarted the
            // loop for ever instead of falling back to a backoff.
            backoff.current.next();
            // Let the attempt finish clearing `active` before starting the
            // next one; calling straight through would be refused as a second
            // attempt running beside the first.
            window.setTimeout(() => void attemptRef.current(), 0);
            return;
          }
        }
      }
      schedule(
        last ?? linkFailure(doors.length > 0 ? "client.offline" : "no.doors"),
      );
    } catch (error) {
      if (live()) schedule(failureFromError(error));
    } finally {
      active.current = false;
      if (networkDirty.current) {
        networkDirty.current = false;
        // A change arrived during the attempt: the route it just tested is the
        // old one, so a failure must not wait out the backoff.
        if (!standDown.current && online.current && stateRef.current.phase !== "connected") {
          window.setTimeout(() => {
            void attemptRef.current();
          }, 0);
        }
      }
    }
  }, [clearTimer, connected, connection, emit, schedule]);

  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  /**
   * Move a link whose door refused onto another door of the same computer.
   *
   * A refusal is decisive, but it is about the door: the LAN cookie that
   * expired cannot be repaired by retrying it, while the account may still
   * reach the same machine. The walk runs with LAN doors skipped, and
   * `refused()` still holds the machine check — so this lands on the cloud
   * route of the same computer, or nowhere at all.
   */
  const recoverStalePairing = useCallback(() => {
    if (standDown.current || active.current) return;
    if (stateRef.current.phase !== "connected") return;
    backoff.current.reset();
    // Only a refusal on the LAN route says the LAN cookie is dead. A refusal
    // carried over the relay may be about the account, and the neighbour may
    // still answer — so that walk keeps every door.
    const skipLan = stateRef.current.mode === "lan";
    void attemptRef.current({ skipLan });
  }, []);

  /**
   * Verify the route a live link is on, without changing a working one.
   *
   * Safe to call as often as a screen mounts: a route that answers decides
   * nothing. Switching a working relay to the LAN is an improvement, not a
   * repair, and doing it here meant a settings visit could silently replace
   * the transport under a conversation — which is the other half of the "it
   * disconnects when I open settings" report. Only a refusal acts, and only
   * by moving to another door of the same computer.
   */
  const check = useCallback(() => {
    void (async () => {
      await connection.refresh();
      // An expired pairing is an answer, not a hiccup: the kernel refused
      // every read it will refuse until the person re-pairs. Leaving the chip
      // on 已连接 with a dead session is the wedge the tolerance was not meant
      // to create — but the computer may still be reachable through the
      // account, so this is a handover, not a failure.
      if (
        connection.current.reach.kind === "unauthorized" &&
        !standDown.current &&
        !active.current &&
        stateRef.current.phase === "connected"
      ) {
        recoverStalePairing();
      }
    })();
  }, [connection, recoverStalePairing]);

  /**
   * Look after a live link on a timer.
   *
   * The difference from `check` is what happens when the transport stops
   * answering: `check` only reads, and this reconnects — but only once the
   * transport has failed twice in a row (`Connection.lost`). A single lost
   * request is a Wi-Fi hiccup, and acting on it is what used to drop a
   * working connection the moment a screen appeared.
   */
  const watch = useCallback(() => {
    if (standDown.current || active.current) return;
    if (stateRef.current.phase !== "connected") return;
    void (async () => {
      await connection.refresh();
      // Same verdict as `check`: a refusal is decisive, a lost transport is
      // not. Both end the "connected" phase; only the lost one retries. The
      // phase is re-checked like the lost branch below, because a refresh can
      // outlive the state it started under — noteFailed or a manual switch
      // may have moved the machine while this read was in flight.
      if (
        connection.current.reach.kind === "unauthorized" &&
        !standDown.current &&
        !active.current &&
        stateRef.current.phase === "connected"
      ) {
        recoverStalePairing();
        return;
      }
      if (!connection.lost) return;
      if (standDown.current || active.current) return;
      if (stateRef.current.phase !== "connected") return;
      backoff.current.reset();
      void attemptRef.current();
    })();
  }, [connection, recoverStalePairing]);

  /**
   * A retrying stream is the earliest sign the whole route is gone.
   *
   * The watch timer is a poll and can be half a minute late; a stream that has
   * retried twice (about a second) is an event, and a kernel restarting one
   * pane rarely costs more than one. A short probe then says whether this is
   * the pane or the computer, and a dead route goes straight to a fresh walk
   * instead of waiting for the next tick.
   *
   * LAN only: a cloud stream is carried by the relay, whose own reconnection
   * is the thing to wait for — probing it here would race `relayAlive` and
   * turn a self-healing link into a handover.
   */
  const streamProbe = useRef(false);
  useEffect(
    () =>
      connection.subscribe((snapshot) => {
        if (streamProbe.current || standDown.current || active.current) return;
        const live = stateRef.current;
        if (live.phase !== "connected" || live.mode !== "lan") return;
        const stream = snapshot.stream;
        if (stream.kind !== "retrying" || stream.attempt < 2) return;
        streamProbe.current = true;
        void (async () => {
          try {
            const reached = await connection.quickCheck(3_000);
            if (reached) return;
            if (standDown.current || active.current) return;
            if (stateRef.current.phase !== "connected") return;
            backoff.current.reset();
            void attemptRef.current();
          } finally {
            streamProbe.current = false;
          }
        })();
      }),
    [connection],
  );

  /** A LAN upgrade just failed; do not retry it on every timer tick. */
  const lastUpgrade = useRef(0);

  /**
   * Switch an active cloud link to the LAN door of the same computer.
   *
   * The cloud route is often the only one that worked away from home; once
   * the phone is back on the Wi-Fi, the neighbour answers directly and is
   * faster. Both doors must name the same machine, and the proxy's `direct`
   * list must call the origin a neighbour — so a phone that is not at home
   * never gets pointed at an address that is not there.
   *
   * The upgrade is non-destructive: the link state stays "connected" while it
   * runs, and a failed switch restores the relay before it is reported.
   */
  const preferLan = useCallback(() => {
    if (standDown.current || active.current) return;
    // The person turned automatic switching off: a live cloud link stays
    // where it is until they pick a door themselves.
    if (!loadAutoHandover()) return;
    const live = stateRef.current;
    if (live.phase !== "connected" || live.mode !== "cloud" || !live.target) return;
    if (Date.now() - lastUpgrade.current < 15_000) return;
    lastUpgrade.current = Date.now();
    const cloudTarget = live.target;
    const cloudName = live.name ?? "云端电脑";
    const startGeneration = generation.current;
    const unchanged = () =>
      generation.current === startGeneration &&
      !active.current &&
      stateRef.current.phase === "connected" &&
      stateRef.current.mode === "cloud" &&
      stateRef.current.target === cloudTarget;
    void (async () => {
      const config = await readProxyConfig();
      if (!config || config.mode !== "relay" || !unchanged()) return;
      const saved = loadConnections();
      const cloudRow = saved.find(
        (row) => row.kind === "cloud" && row.target === cloudTarget,
      );
      // An older cloud row may predate the identity field; its name is the
      // account's device name, which is the same host name the LAN door gives.
      const machine = cloudRow?.machine?.trim() || cloudRow?.name?.trim() || "";
      if (!machine) return;
      const direct = config.direct ?? [];
      let door = directDoorForMachine(saved, machine, direct);
      if (door) {
        // The saved name is a hint; the computer itself has the final word.
        const identity = await readMachineIdentity(door.target);
        if (!identity || machineKey(identity.machine) !== machineKey(machine)) return;
      } else {
        // The LAN door may predate the identity field. Ask the direct doors
        // once, in parallel, instead of making the person open settings.
        const reachable = new Set(
          direct.map((target) => normalizeTarget("lan", target)).filter(Boolean),
        );
        const unknown = saved.filter(
          (row) => row.kind === "lan" && reachable.has(row.target) && !row.machine?.trim(),
        );
        const answers = await Promise.all(
          unknown.map(async (row) => ({
            row,
            identity: await readMachineIdentity(row.target),
          })),
        );
        const hit = answers.find(
          (answer) =>
            answer.identity &&
            machineKey(answer.identity.machine) === machineKey(machine),
        );
        if (!hit?.identity) return;
        learnConnectionMachine("lan", hit.row.target, hit.identity.machine);
        door = { ...hit.row, machine: hit.identity.machine };
      }
      if (!unchanged()) return;

      active.current = true;
      const mine = ++generation.current;
      const stillLive = () => generation.current === mine;
      try {
        const opened = await openDoor(
          { kind: "lan", target: door.target, name: door.name, machine },
          () => {},
        );
        if (!stillLive()) return;
        if (opened.ok && (await connection.refresh()) && stillLive()) {
          // Keep the cloud id as the hint for the next time the phone leaves.
          saveRelayDevice(cloudTarget);
          connected(door.target, door.name, "lan", machine);
          return;
        }
        // The LAN door did not answer after the switch: put the relay back
        // before showing anything, so a failed upgrade is not an outage.
        const restored = await openDoor(
          { kind: "cloud", target: cloudTarget, name: cloudName, machine },
          () => {},
        );
        if (!stillLive()) return;
        if (restored.ok && (await connection.refresh()) && stillLive()) {
          connected(cloudTarget, cloudName, "cloud", machine);
          return;
        }
        if (stillLive()) {
          failed(
            restored.ok
              ? linkFailure(reachCode(connection.current.reach), "cloud restore")
              : restored.error,
            stateRef.current,
          );
        }
      } finally {
        active.current = false;
      }
    })();
  }, [connected, connection, failed]);

  /**
   * One short verification after the network changed.
   *
   * A working route stays connected — no flicker, no teardown — while a route
   * that no longer answers goes straight to a fresh attempt instead of waiting
   * for the watch timer and its second tolerated failure.
   */
  const reassess = useCallback(() => {
    if (standDown.current || active.current || reassessing.current) return;
    if (stateRef.current.phase !== "connected") return;
    // A reconnecting relay is already healing. Its requests stay pending
    // until the socket is back, so a probe here would time out against a link
    // that is about to return — and then start a walk that tears it down.
    if (relayState() === "reconnecting") return;
    reassessing.current = true;
    void (async () => {
      try {
        const reached = await connection.quickCheck(5_000);
        if (standDown.current || active.current) return;
        if (stateRef.current.phase !== "connected") return;
        if (reached) {
          connection.wakeStream();
          preferLan();
          return;
        }
        backoff.current.reset();
        await attemptRef.current();
      } finally {
        reassessing.current = false;
      }
    })();
  }, [connection, preferLan]);

  const kick = useCallback(() => {
    if (active.current) return;
    if (standDown.current) return;
    const phase = stateRef.current.phase;
    if (phase === "connecting") return;
    if (phase === "connected") {
      check();
      return;
    }
    clearTimer();
    backoff.current.reset();
    void attemptRef.current();
  }, [check, clearTimer]);

  /**
   * Try now, whether or not the system still believes it is offline.
   *
   * The `online` flag caches the platform's last network answer, and a phone
   * that regained Wi-Fi while the app was paused can miss the event entirely.
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
   * The platform's answer about this phone's network.
   *
   * No network cancels the retry timer: an attempt fired while offline can
   * only fail. A default network returning starts one attempt over the saved
   * doors. A change while the phone stays connected — Wi-Fi A→B, cellular→
   * Wi-Fi — is just as important: the route may have moved, so a live link is
   * verified once and reconnected immediately if it no longer answers.
   */
  const noteNetwork = useCallback(
    (status: NetworkStatus, changed = false) => {
      const was = online.current;
      const previous = lastNetwork.current;
      lastNetwork.current = status;
      online.current = status.connected;
      const phase = stateRef.current.phase;

      if (!status.connected) {
        clearTimer();
        // Only a link waiting on a retry has anything to stop. A live link
        // may still answer over another interface, and a failure the person
        // can read ("配对失效") should not be replaced by "no network".
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
      if (standDown.current) return;

      // The boolean can stay true across a handover, so the network's
      // identity and transport are part of the signal too.
      const routeChanged =
        changed ||
        !was ||
        (previous !== null &&
          (previous.networkKey !== status.networkKey ||
            previous.connectionType !== status.connectionType));
      if (!routeChanged) return;

      const now = Date.now();
      if (changed && was && now - lastNetworkKick.current < 1_000) return;
      lastNetworkKick.current = now;
      connection.resetFailures();
      backoff.current.reset();
      clearTimer();

      if (active.current) {
        networkDirty.current = true;
        return;
      }
      if (phase === "connected") {
        reassess();
        return;
      }
      // A waiting or failed link starts a fresh walk over the saved doors.
      kick();
      // Wi-Fi returning is also the moment a cloud link can become a LAN one.
      preferLan();
    },
    [clearTimer, connection, emit, kick, preferLan, reassess],
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
      // The person is pointing this phone somewhere else; failures counted
      // against the old route say nothing about the new one.
      connection.resetFailures();
      const room = (): LinkState => ({
        ...connectingLink("switch"),
        target: entry.target,
        name: entry.name,
        mode,
      });
      emit(room());
      try {
        const result = await openDoor(
          {
            kind: entry.kind,
            target: entry.target,
            name: entry.name,
            ...(entry.machine ? { machine: entry.machine } : {}),
          },
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
        const reached = await connection.refresh();
        if (!live()) return { ok: false };
        if (!reached) {
          failed(linkFailure(reachCode(connection.current.reach)), room());
          return { ok: false };
        }
        if (mode === "lan") {
          const cloud = latestConnection("cloud")?.target || loadRelayDevice();
          if (cloud) saveRelayDevice(cloud);
        }
        connected(entry.target, entry.name, mode, entry.machine);
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
    // A connection made from the settings screen is a new route, so failures
    // counted against the previous one must not carry over.
    connection.resetFailures();
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
    networkDirty.current = false;
    connection.wakeStream();
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
    check,
    watch,
    retry,
    switchTo,
    preferLan,
    reassess,
    noteConnected,
    noteFailed,
    noteNetwork,
    noteDisconnected,
  };
}
