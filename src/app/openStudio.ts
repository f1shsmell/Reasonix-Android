/**
 * Open the paired computer's own Studio page.
 *
 * One implementation for every entry: the chat header and the settings rows
 * must agree on which URL the native WebView loads and when it goes through
 * the loopback proxy. A call reads the proxy config fresh; the answer is a
 * result rather than a throw, because "no address" and "both doors failed"
 * need different words on screen.
 *
 * A relay door is deliberately not a case here. A self-hosted relay forwards
 * sealed frames; it hosts no page, so there is no full Studio UI to open over
 * the cloud. The route the link machine has still decides *which* door the
 * page would come from — a phone that left Wi-Fi must not open the LAN
 * address it remembers — so a relay route answers `none`, and the callers
 * hide the entry instead of offering a dead one.
 */

import { Browser } from "@capacitor/browser";
import { WebMode } from "../native/webmode";
import { relayAlive } from "../net/relay";
import { loadRelayDevice } from "../net/relayStore";
import { readProxyConfig, studioAppUrl, studioWebUrl } from "../net/server";

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

  // A live relay is the route even if the proxy has not written "relay" yet;
  // and a caller that reports the link is not a working LAN (still switching,
  // or on the cloud) outranks a configured origin the phone has already left.
  const onRelay =
    Boolean(config.relayDevice?.trim() || loadRelayDevice()) &&
    (preferRelay || config.mode === "relay" || relayAlive());
  if (onRelay) return { kind: "none" };

  const url = studioAppUrl(config);
  if (!url) return { kind: "none" };

  // A LAN page must load through the loopback proxy: it carries the pairing
  // cookie, the CSRF Origin and the VPN detour.
  const viaProxy = Boolean(config.studioUrl?.trim());
  try {
    await WebMode.open({
      url,
      viaProxy,
      origin: config.origin ?? "",
    });
    return { kind: "native" };
  } catch {
    try {
      // The browser cannot reach the loopback address, so it gets the real
      // one: the kernel origin this proxy forwards to.
      await Browser.open({ url: studioWebUrl(config) || url });
      return { kind: "browser" };
    } catch (error) {
      return { kind: "failed", error };
    }
  }
}
