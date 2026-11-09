/**
 * Open the paired computer's own Studio page.
 *
 * One implementation for every entry: the chat header and the settings rows
 * must agree on which URL the native WebView loads and when it goes through
 * the loopback proxy. A call reads the proxy config fresh; the answer is a
 * result rather than a throw, because "no address" and "both doors failed"
 * need different words on screen.
 */

import { Browser } from "@capacitor/browser";
import { WebMode } from "../native/webmode";
import { relayAlive } from "../net/relay";
import { loadRelayDevice } from "../net/relayStore";
import { readProxyConfig, studioAppUrl, studioRemoteUrl, studioWebUrl } from "../net/server";

export type StudioOpenResult =
  | { kind: "native" }
  | { kind: "browser" }
  | { kind: "none" }
  | { kind: "failed"; error: unknown };

let opening: Promise<StudioOpenResult> | null = null;

export interface StudioOpenOptions {
  /**
   * The caller's live route says it is not a working LAN link (a cloud link,
   * or a transport that is still switching). A configured LAN origin is not
   * evidence that it answers — a phone that just left Wi-Fi still has one.
   */
  preferRelay?: boolean;
}

/** Single-flight: a second tap joins the first instead of opening twice. */
export function openStudio(options: StudioOpenOptions = {}): Promise<StudioOpenResult> {
  const preferRelay = options.preferRelay === true;
  opening ??= run(preferRelay).finally(() => {
    opening = null;
  });
  return opening;
}

async function run(preferRelay: boolean): Promise<StudioOpenResult> {
  const config = await readProxyConfig();
  if (config === null) return { kind: "none" };

  const device = config.relayDevice?.trim() || loadRelayDevice();
  const remote = studioRemoteUrl(device);
  // A live relay is the route even if the proxy has not written "relay" yet;
  // and a caller that reports the link is not a working LAN (still switching,
  // or on the cloud) outranks a configured origin the phone has already left.
  const onRelay = remote !== "" && (preferRelay || config.mode === "relay" || relayAlive());
  const url = onRelay ? remote : config.mode === "relay" ? "" : studioAppUrl(config, device);
  if (!url) return { kind: "none" };

  // A LAN page must load through the loopback proxy: it carries the pairing
  // cookie, the CSRF Origin and the VPN detour. Cloud doors have no proxy.
  const viaProxy = !onRelay && Boolean(config.studioUrl?.trim());
  // The cloud page hands itself to the Studio host and, for an account that
  // needs approving, to the identity host. Both are the same visit; keeping
  // them here is what stops the WebView from starting the page and then
  // throwing the person into Chrome.
  const allowHosts = onRelay ? ["studio.reasonix.io", "id.reasonix.io"] : [];
  try {
    await WebMode.open({
      url,
      viaProxy,
      origin: config.origin ?? "",
      ...(allowHosts.length > 0 ? { allowHosts } : {}),
    });
    return { kind: "native" };
  } catch {
    try {
      // The browser cannot reach the loopback address, so it gets the real
      // one. On a relay (marked or merely live) that real address is the
      // remote page, not the LAN origin the proxy still remembers.
      const browserUrl = onRelay ? remote : studioWebUrl(config, device);
      await Browser.open({ url: browserUrl || url });
      return { kind: "browser" };
    } catch (error) {
      return { kind: "failed", error };
    }
  }
}
