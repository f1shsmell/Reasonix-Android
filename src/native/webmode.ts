import { registerPlugin } from "@capacitor/core";

/**
 * The paired computer's own Studio page, in a full-screen app WebView.
 *
 * The kernel serves the whole Studio frontend on its port, and the phone
 * browser is a first-class way to run it — no native bridge required. The
 * activity is therefore deliberately plain: the page owns its connection and
 * its SSE stream, and the app's proxy stays out of the way. Cookies the
 * pairing left in the shared CookieManager are what make the first load land
 * inside Studio instead of its connect screen.
 */
export interface WebModePlugin {
  open(options: { url: string }): Promise<void>;
}

export const WebMode = registerPlugin<WebModePlugin>("WebMode");
