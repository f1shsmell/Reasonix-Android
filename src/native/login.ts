import { registerPlugin } from "@capacitor/core";

/**
 * The in-app sign-in page. It must be the app's own WebView, not the system
 * browser: the account cookie it stores is what the loopback proxy sends to
 * `/me/remote-grants`.
 */
export interface LoginPlugin {
  open(options: { url: string }): Promise<void>;
}

export const NativeLogin = registerPlugin<LoginPlugin>("Login");
