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
  plugins: {
    // The page always declares viewport-fit=cover, and the SystemBars plugin
    // needs one page-load round-trip to discover it — until then it assumes
    // the opposite, which pushes the whole page below the status bar for the
    // first frames of a cold start. The hint skips that jump; the plugin
    // still corrects itself if the meta tag ever changes.
    SystemBars: {
      initialViewportFitValueHint: "cover",
    },
  },
};

export default config;
