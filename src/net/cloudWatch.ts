/**
 * The cloud status a background watcher asks for.
 *
 * Native code cannot speak the relay protocol: `relay.ts` seals requests in
 * the WebView. This module is the one bridge the foreground service uses — it
 * performs the same `/runtimes` + `/status` reads the app does, and returns
 * them as one JSON snapshot through the `__reasonixCloudWatchResult` bridge.
 *
 * It only runs while the app process and its WebView are alive; a task swiped
 * away is out of reach without a native relay client or push.
 */
import { isRuntimeView } from "./connection";
import { fetchWithTimeout } from "./http";
import { ensureRelay, relayAlive, relayDevice } from "./relay";

export interface CloudWatchSnapshot {
  ok: boolean;
  code?: string;
  /** The raw `/runtimes` rows, so native code can reuse `RuntimeList`. */
  runtimes: Array<Record<string, unknown>>;
  /** Runtime id → the raw `/status` body. */
  statuses: Record<string, unknown>;
}

function failed(code: string): CloudWatchSnapshot {
  return { ok: false, code, runtimes: [], statuses: {} };
}

export async function sweepCloud(): Promise<CloudWatchSnapshot> {
  try {
    if (!relayAlive()) {
      const device = relayDevice();
      if (!device) return failed("relay.offline");
      // The WebView timers may be paused in the background; a request from the
      // service is a good moment to rebuild the link.
      await ensureRelay(device);
    }
    const response = await fetchWithTimeout(
      "/runtimes",
      { credentials: "same-origin" },
      8_000,
    );
    if (!response.ok) return failed(`http.${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return failed("runtime.shape");

    const runtimes = body.filter(isRuntimeView) as unknown as Array<Record<string, unknown>>;
    const statuses: Record<string, unknown> = {};
    await Promise.all(
      runtimes.map(async (row) => {
        const base = typeof row.base === "string" ? row.base : "";
        const id = typeof row.id === "string" ? row.id : "";
        if (!base || !id) return;
        try {
          const statusResponse = await fetchWithTimeout(
            `${base}/status`,
            { credentials: "same-origin" },
            8_000,
          );
          if (!statusResponse.ok) return;
          const status: unknown = await statusResponse.json();
          if (status !== null && typeof status === "object") statuses[id] = status;
        } catch {
          // One pane that cannot answer must not fail the whole sweep.
        }
      }),
    );
    return { ok: true, runtimes, statuses };
  } catch {
    return failed("relay.offline");
  }
}

declare global {
  interface Window {
    __reasonixCloudWatch?: () => void;
    __reasonixCloudWatchResult?: (json: string) => void;
  }
}

/** Install the native `evaluateJavascript` entry point. */
export function installCloudWatchBridge(): void {
  if (typeof window === "undefined") return;
  window.__reasonixCloudWatch = () => {
    void sweepCloud().then((snapshot) => {
      try {
        window.__reasonixCloudWatchResult?.(JSON.stringify(snapshot));
      } catch {
        // The page may be gone under the service.
      }
    });
  };
}
