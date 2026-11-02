import { readNetworkStatus } from "../native/networkWatch";
import { readNativeDiagnostics } from "../native/turn";
import type { ConnectionSnapshot } from "../net/connection";
import type { LinkState } from "../net/link";

/**
 * The text the About page copies.
 *
 * It answers "which build, on what phone, over which route, with which last
 * error" without carrying chat content, cookies, pairing codes or tokens.
 */
export interface DiagnosticInput {
  link: LinkState;
  snapshot: ConnectionSnapshot;
  cloudWatch: boolean;
}

function reachText(snapshot: ConnectionSnapshot): string {
  const reach = snapshot.reach;
  return reach.kind === "unreachable" ? `${reach.kind} · ${reach.detail}` : reach.kind;
}

export async function buildDiagnostics(input: DiagnosticInput): Promise<string> {
  const [native, network] = await Promise.all([
    readNativeDiagnostics(),
    readNetworkStatus(),
  ]);
  const { link, snapshot, cloudWatch } = input;
  const error = link.error;
  const route = [link.phase, link.mode, link.target, link.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" · ");

  const lines = [
    `Reasonix For Android ${__APP_VERSION__}`,
    native
      ? `Android ${native.android ?? "?"} (API ${native.sdk ?? "?"}) · ${native.manufacturer ?? ""} ${native.model ?? ""}`.trim()
      : "Android: unavailable",
    native
      ? `Build ${native.build ?? "?"} · notifications=${native.notifications ? "on" : "off"} · battery-exempt=${native.exempt ? "yes" : "no"}`
      : "Build: unavailable",
    `WebView: ${navigator.userAgent}`,
    `Link: ${route || "none"}`,
    `Link error: ${error ? `${error.code}${error.detail ? ` · ${error.detail}` : ""}` : "none"}`,
    `Reach: ${reachText(snapshot)}`,
    `Stream: ${snapshot.stream.kind}`,
    `Runtimes: ${snapshot.runtimes.length}`,
    `Network: ${
      network
        ? `${network.connected ? "connected" : "none"} · ${network.connectionType} · validated=${network.validated} · key=${network.networkKey || "-"}`
        : "unavailable"
    }`,
    `Cloud background reminders: ${cloudWatch ? "on" : "off"}`,
    `At: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}
