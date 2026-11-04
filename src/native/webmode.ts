import { registerPlugin } from "@capacitor/core";

/**
 * The paired computer's own Studio page, in a full-screen app WebView.
 *
 * The kernel serves the whole Studio frontend on its port, but a LAN door
 * loads it through the app's loopback proxy: the proxy is what pins the
 * connection to Wi-Fi when a VPN owns the default route, adds the pairing
 * cookie and speaks the kernel's own CSRF Origin. A bare WebView on the kernel
 * address loses all three and times out. The activity is still plain — the
 * page owns its connection and its SSE stream — it is the *origin* that moves.
 * Cloud doors have no loopback proxy and keep their remote URL.
 */
export interface WebModePlugin {
  open(options: {
    url: string;
    /** The URL belongs to the loopback proxy, not the kernel itself. */
    viaProxy?: boolean;
    /** The real kernel origin, so absolute self-links can be rewritten. */
    origin?: string;
  }): Promise<void>;
}

export const WebMode = registerPlugin<WebModePlugin>("WebMode");
