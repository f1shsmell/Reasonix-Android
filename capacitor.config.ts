import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android shell.
 *
 * `appId` is the package name: Google Play treats it as permanent once the
 * first build is published, so it is set once here rather than derived from a
 * folder name later.
 *
 * The phone talks to a Reasonix kernel over plain HTTP on a LAN. The Android
 * project opts into cleartext for that reason. The WebView itself is served
 * from the loopback proxy (`http://127.0.0.1:8788`), so the kernel is the
 * same origin and no mixed-content exception is needed.
 */
const config: CapacitorConfig = {
  appId: "com.reasonix.mobile",
  appName: "Reasonix",
  webDir: "dist",
  // The WebView loads the loopback proxy, which serves the bundle from the
  // APK and forwards kernel routes to the configured origin. Same origin is
  // what makes the kernel's cookie session and SSE usable from a WebView.
  server: {
    url: "http://127.0.0.1:8788",
    cleartext: true,
  },
  android: {
    // The WebView itself is http://127.0.0.1:8788 and the kernel is plain
    // HTTP on a LAN, so a request from one to the other is not mixed content.
    // Keeping this off stops an https page inside the WebView from pulling
    // arbitrary http subresources.
    allowMixedContent: false,
  },
};

export default config;
