/**
 * Opening one remembered door: a LAN origin or an account device.
 *
 * A door is not open when the proxy has been told where to send requests. It
 * is open when the kernel on the other side answers for itself, so every path
 * here ends with `probeUpstream` — the difference between saving an address
 * and connecting to a computer. The steps are reported as they happen so the
 * Home chip and the settings screen can say which one is running.
 */

import { linkFailure } from "./link";
import type { LinkError, LinkStep } from "./link";
import { ensureRelay, clearRelayRouting, RelayError } from "./relay";
import { syncFleetPeer } from "./fleet";
import { learnConnectionMachine, rememberConnection } from "./savedConnections";
import {
  configureProxy,
  markRelay,
  probeDoor,
  probeUpstream,
  readMachineIdentity,
  readProxyConfig,
  ProxyError,
} from "./server";
import type { ProxyConfig } from "./server";

export interface Door {
  kind: "lan" | "cloud";
  /** A LAN origin, or an account device id. */
  target: string;
  /** What to call it in the UI. */
  name?: string;
  /** The computer's own name, when a saved row or the account already knew it. */
  machine?: string;
}

export type DoorResult = { ok: true } | { ok: false; error: LinkError };

/**
 * Put the route back the way it was before a switch.
 *
 * A door cannot be verified until the proxy has been pointed at it: the LAN
 * branch has to name the candidate upstream, and the cloud branch has to
 * replace the relay before `/runtimes` can be read through it. When that
 * verification fails the old route is already gone, and a person who asked
 * for a switch would be left on a dead address with the relay disconnected —
 * the app would look connected to nothing until the next walk.
 *
 * Restoring is best-effort and never replaces the caller's error: the switch
 * failed, and saying so is the honest answer. The relay is tried first
 * because it is the route a cloud link was on, and a LAN origin is the
 * fallback for a shell that cannot reopen it.
 */
/**
 * How long a failed switch may spend putting the previous route back.
 *
 * The relay's grant and socket handshake carry 20 s and 30 s timeouts of
 * their own; awaiting both after a door already failed made the switch look
 * like a hang. Six seconds covers a healthy wake and still reports the
 * original error in bounded time.
 */
const RESTORE_BUDGET_MS = 6_000;

async function restoreRoute(previous: ProxyConfig | null): Promise<void> {
  if (previous === null) return;
  if (previous.mode === "relay" && previous.relayDevice) {
    const outcome = await restoreRelay(previous.relayDevice, RESTORE_BUDGET_MS);
    if (outcome === "restored") return;
    // A reopen that was abandoned is still running in the background;
    // `clearRelayRouting` bumps the relay's connect sequence, so the late
    // handshake can no longer install itself as the active route.
    clearRelayRouting();
    // A timeout already spent the budget; the origin fallback is another
    // network write, so it is not started. A refusal is the old fast path.
    if (outcome === "timeout") return;
  }
  if (!previous.origin) return;
  try {
    await configureProxy(previous.origin);
  } catch {
    // Nothing left to restore to. The original failure is still reported.
  }
}

/** Reopen the relay, or give up after [budgetMs] without cancelling it. */
async function restoreRelay(
  deviceId: string,
  budgetMs: number,
): Promise<"restored" | "failed" | "timeout"> {
  const reopen = (async () => {
    await ensureRelay(deviceId);
    await markRelay(deviceId);
  })();
  // The race below observes it; this keeps a late rejection from surfacing
  // as an unhandled one once the timeout has already won.
  reopen.catch(() => {});
  let timer: number | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = window.setTimeout(() => resolve("timeout"), budgetMs);
  });
  try {
    return await Promise.race([
      reopen.then<"restored", "failed">(
        () => "restored",
        () => "failed",
      ),
      timeout,
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export async function openDoor(
  door: Door,
  onStep: (step: LinkStep) => void,
): Promise<DoorResult> {
  try {
    if (door.kind === "lan") {
      onStep("switch");
      // Verify before tearing anything down. The switch itself is a local
      // write, so a door that cannot answer leaves the current route intact —
      // that is the difference between a handover and an outage.
      const pre = await probeDoor(door.target);
      if (!pre.ok) {
        return { ok: false, error: linkFailure(pre.code, `origin ${door.target}`) };
      }
      // What the proxy pointed at before this switch, so a door that answers
      // its probe but not `/runtimes` can put it back.
      const before = await readProxyConfig();
      await configureProxy(door.target);
      clearRelayRouting();
      onStep("verify");
      const reach = await probeUpstream();
      if (!reach.ok) {
        await restoreRoute(before);
        return { ok: false, error: linkFailure(reach.code, `origin ${door.target}`) };
      }
      rememberConnection("lan", door.target, door.name, door.machine);
      // The probe already named the computer; only a build that could not
      // answer it needs the late read.
      if (pre.machine) learnConnectionMachine("lan", door.target, pre.machine);
      else {
        void readMachineIdentity(door.target).then((identity) => {
          if (identity) learnConnectionMachine("lan", door.target, identity.machine);
        });
      }
      void syncFleetPeer("lan", door.target, door.name ?? door.target).catch(() => {});
      return { ok: true };
    }

    onStep("switch");
    let linked = false;
    let before: ProxyConfig | null = null;
    try {
      // Reuse a live link to the same computer; a different one replaces it
      // only after its handshake succeeds.
      before = await readProxyConfig();
      await ensureRelay(door.target);
      linked = true;
      await markRelay(door.target);
      onStep("verify");
      const reach = await probeUpstream();
      if (!reach.ok) {
        clearRelayRouting();
        await restoreRoute(before);
        return { ok: false, error: linkFailure(reach.code, `device ${door.target}`) };
      }
      rememberConnection("cloud", door.target, door.name, door.machine);
      void syncFleetPeer("cloud", door.target, door.name ?? door.target).catch(() => {});
      return { ok: true };
    } catch (error) {
      // The relay replaced the old route before the rest failed; do not leave
      // a half-open link behind, and do not leave the old route unreachable.
      if (linked) {
        clearRelayRouting();
        await restoreRoute(before);
      }
      throw error;
    }
  } catch (error) {
    return { ok: false, error: failureFromError(error) };
  }
}

export function failureFromError(error: unknown): LinkError {
  if (error instanceof RelayError) {
    switch (error.kind) {
      case "reauth":
        return linkFailure("account.signed_out", error.message);
      case "ended":
        return linkFailure("device_not_found", error.message);
      case "trust_required":
        return linkFailure("device.trust_required", error.message);
      case "trust_changed":
        return linkFailure("device.trust_changed", error.message);
      case "trust_unreadable":
        return linkFailure("device.trust_unreadable", error.message);
      case "trust_cancelled":
        return linkFailure("device.trust_cancelled", error.message);
      case "trust_unwritable":
        return linkFailure("device.trust_unwritable", error.message);
      default:
        return linkFailure("client.offline", error.message);
    }
  }
  if (error instanceof ProxyError) return linkFailure(error.code, error.message);
  return linkFailure("client.offline", error instanceof Error ? error.message : String(error));
}
