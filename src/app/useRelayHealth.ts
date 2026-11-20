import { useEffect, useState } from "react";
import { kernelTransport } from "../net/transport";
import { watchRelayState } from "../net/relay";

export type RelayHealth = "open" | "reconnecting" | "ended" | "none";

/**
 * The relay link's condition, as the screens should show it.
 *
 * A relay that is quietly rebuilding its socket is exactly when the UI must
 * not keep claiming everything is fine: the link self-heals within ~30 s, but
 * during that window requests stall and streams hold their last frame.
 *
 * The dev transport may script the answer (`?cloud=1&lag=1` holds the link in
 * its reconnecting state) so the recovery indicators can be rendered without a
 * real dead link. `none` means no relay is routing — a LAN connection.
 */
export function useRelayHealth(): RelayHealth {
  const [health, setHealth] = useState<RelayHealth>(
    () => kernelTransport().relayState?.() ?? "none",
  );
  useEffect(() => {
    const scripted = kernelTransport().relayState;
    if (scripted) {
      setHealth(scripted() ?? "none");
      return;
    }
    return watchRelayState(setHealth);
  }, []);
  return health;
}

/** The short word a status badge shows when the frames ride the relay. */
export function channelLabel(channel: string | undefined): string {
  if (channel === "mux") return "推送";
  if (channel === "poll") return "轮询";
  return "";
}
