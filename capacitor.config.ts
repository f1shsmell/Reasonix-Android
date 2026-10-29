import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android shell.
 *
 * `appId` is the package name: Google Play treats it as permanent once the
 * first build is published, so it is set once here rather than derived from a
 * folder name later.
 *
 * The phone talks to a Reasonix kernel over plain HTTP on a LAN. The Android
 * project opts into cleartext for that reason; the WebView is served from
 * `https://localhost`, so a request to `http://<kernel>` is mixed content and
 * has to be allowed explicitly as well.
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
    allowMixedContent: true,
  },
};

export default config;
