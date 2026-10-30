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
import {
  Backoff,
  LINK_STEPS,
  connectingLink,
  idleLink,
  linkFailure,
} from "../net/link";
import type { LinkError, LinkState, LinkStep } from "../net/link";
import { loadRelayDevice, saveRelayDevice } from "../net/relayStore";
import {
  loadConnections,
  latestConnection,
  originName,
  rememberConnection,
} from "../net/savedConnections";
import type { SavedConnection } from "../net/savedConnections";
import { firstAnswering, readProxyConfig, refreshProxy } from "../net/server";
import type { ProxyConfig } from "../net/server";

function reachCode(reach: ConnectionSnapshot["reach"]): string {
  return reach.kind === "unauthorized" ? "device.unauthorized" : "client.offline";
}

/** Every LAN address worth trying: the proxy's own first, duplicates removed. */
function lanDoorsOf(config: ProxyConfig | null): string[] {
  const saved = loadConnections()
    .filter((row) => row.kind === "lan")
    .map((row) => row.target);
  return [
    ...new Set(
      [config?.origin ?? "", ...(config?.candidates ?? []), ...saved].filter(Boolean),
    ),
  ];
}

export interface Link {
  state: LinkState;
  /** Check now (network change, app resumed): cuts a backoff wait short. */
  kick: () => void;
  /** The person asked: same as a kick, but also retries a failed link. */
  retry: () => void;
  /** Switch to a recorded computer and verify it. */
  switchTo: (entry: SavedConnection) => Promise<void>;
  /** The settings screen just connected; record that, then re-read the list. */
  noteConnected: () => Promise<void>;
  /** The settings screen swapped the upstream and then could not verify it. */
  noteFailed: (error: LinkError) => void;
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
      if (!error.retryable || backoff.current.exhausted) {
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

      // Already on a LAN that answers: re-probing its candidates is the whole
      // job. Anything else is a switch, and the account is the fallback.
      if (config.mode !== "relay" && config.origin) {
        await connection.refresh();
        if (!live()) return;
        if (connection.current.reach.kind === "ok") {
          connected(config.origin, originName(config.origin), "lan");
          return;
        }
        last = linkFailure(reachCode(connection.current.reach), "current origin");
      }

      const saved = loadConnections();
      const doors = lanDoorsOf(config);
      const hit = doors.length > 0 ? await firstAnswering(doors) : null;
      if (!live()) return;
      const device =
        config.relayDevice || loadRelayDevice() || latestConnection("cloud")?.target || "";
      const deviceName = saved.find(
        (row) => row.kind === "cloud" && row.target === device,
      )?.name;

      // Prefer the LAN even while the relay still works: back on the
      // computer's Wi-Fi it is the faster path and costs no account traffic.
      if (hit !== null) {
        const name = originName(hit);
        const result = await openDoor({ kind: "lan", target: hit, name }, (step) => {
          if (live()) emit({ ...stage(step), target: hit, name, mode: "lan" });
        });
        if (!live()) return;
        if (result.ok) {
          await connection.refresh();
          if (!live()) return;
          if (connection.current.reach.kind === "ok") {
            // Keep the cloud id as the hint for the next time this phone
            // leaves the Wi-Fi.
            if (device) saveRelayDevice(device);
            connected(hit, name, "lan");
            return;
          }
          last = linkFailure(reachCode(connection.current.reach), `origin ${hit}`);
        } else {
          last = result.error;
        }
      }

      if (config.account.signedIn && device) {
        const result = await openDoor(
          { kind: "cloud", target: device, ...(deviceName ? { name: deviceName } : {}) },
          (step) => {
            if (live()) {
              emit({
                ...stage(step),
                target: device,
                ...(deviceName ? { name: deviceName } : {}),
                mode: "cloud",
              });
            }
          },
        );
        if (!live()) return;
        if (result.ok) {
          await connection.refresh();
          if (!live()) return;
          if (connection.current.reach.kind === "ok") {
            connected(device, deviceName ?? "云端电脑", "cloud");
            return;
          }
          last = linkFailure(reachCode(connection.current.reach), `device ${device}`);
        } else {
          last = result.error;
        }
      }

      if (!live()) return;
      schedule(
        last ?? linkFailure(doors.length > 0 || device ? "client.offline" : "no.doors"),
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

  const retry = useCallback(() => {
    backoff.current.reset();
    kick();
  }, [kick]);

  const switchTo = useCallback(
    async (entry: SavedConnection) => {
      if (active.current) return;
      active.current = true;
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
        if (!live()) return;
        if (!result.ok) {
          failed(result.error, room());
          return;
        }
        await connection.refresh();
        if (!live()) return;
        if (connection.current.reach.kind !== "ok") {
          failed(linkFailure(reachCode(connection.current.reach)), room());
          return;
        }
        if (mode === "lan") {
          const cloud = latestConnection("cloud")?.target || loadRelayDevice();
          if (cloud) saveRelayDevice(cloud);
        }
        connected(entry.target, entry.name, mode);
      } catch (error) {
        if (live()) failed(failureFromError(error), room());
      } finally {
        active.current = false;
      }
    },
    [clearTimer, connected, connection, emit, failed],
  );

  const noteConnected = useCallback(async () => {
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

  useEffect(
    () => () => {
      generation.current += 1;
      clearTimer();
    },
    [clearTimer],
  );

  return { state, kick, retry, switchTo, noteConnected, noteFailed };
}
