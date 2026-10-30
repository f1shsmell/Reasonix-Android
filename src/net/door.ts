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
import { rememberConnection } from "./savedConnections";
import { configureProxy, markRelay, probeUpstream, ProxyError } from "./server";

export interface Door {
  kind: "lan" | "cloud";
  /** A LAN origin, or an account device id. */
  target: string;
  /** What to call it in the UI. */
  name?: string;
}

export type DoorResult = { ok: true } | { ok: false; error: LinkError };

export async function openDoor(
  door: Door,
  onStep: (step: LinkStep) => void,
): Promise<DoorResult> {
  try {
    if (door.kind === "lan") {
      onStep("switch");
      await configureProxy(door.target);
      clearRelayRouting();
      onStep("verify");
      const reach = await probeUpstream();
      if (!reach.ok) {
        return { ok: false, error: linkFailure(reach.code, `origin ${door.target}`) };
      }
      rememberConnection("lan", door.target, door.name);
      void syncFleetPeer("lan", door.target, door.name ?? door.target).catch(() => {});
      return { ok: true };
    }

    onStep("switch");
    let linked = false;
    try {
      // Reuse a live link to the same computer; a different one replaces it
      // only after its handshake succeeds.
      await ensureRelay(door.target);
      linked = true;
      await markRelay(door.target);
      onStep("verify");
      const reach = await probeUpstream();
      if (!reach.ok) {
        clearRelayRouting();
        return { ok: false, error: linkFailure(reach.code, `device ${door.target}`) };
      }
      rememberConnection("cloud", door.target, door.name);
      void syncFleetPeer("cloud", door.target, door.name ?? door.target).catch(() => {});
      return { ok: true };
    } catch (error) {
      // The relay replaced the old route before the rest failed; do not leave
      // a half-open link behind.
      if (linked) clearRelayRouting();
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
      default:
        return linkFailure("client.offline", error.message);
    }
  }
  if (error instanceof ProxyError) return linkFailure(error.code, error.message);
  return linkFailure("client.offline", error instanceof Error ? error.message : String(error));
}
