import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

/**
 * The kernel a dev session talks to. Override with REASONIX_SERVE, e.g.
 * `REASONIX_SERVE=http://127.0.0.1:8791 vite`. Without it the dev server
 * starts but every kernel call 404s, which reads as a broken app rather than
 * a missing backend.
 */
const serve = process.env.REASONIX_SERVE ?? "";

/**
 * The version the About row shows.
 *
 * Read from package.json rather than typed into a component: a hand-written
 * string drifts the first time someone bumps the version, and the row that
 * exists to answer "which build is this?" would then be wrong.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

/**
 * Paths the kernel owns. Everything else is the app's own assets.
 *
 * This list mirrors KERNEL_PATHS in src/net/relay.ts and the two must move
 * together: a route the relay carries but the dev proxy does not makes every
 * dev-session call to it 404 against Vite instead of reaching the kernel.
 * Vite's proxy matches by prefix, so the two slash-suffixed relay entries are
 * spelled bare here (`/rt` already covers `/rt/...`, `/auth` covers
 * `/auth/...`).
 */
const KERNEL_PATHS = [
  "/runtimes",
  "/rt",
  // The sidebar tree: projects and their conversations. The phone's whole
  // first two screens are this one read, so a relay that did not carry it
  // would leave the app with nothing to draw.
  "/tree",
  "/auth",
  "/pair",
  "/device",
  "/events",
  "/status",
  "/models",
  "/share",
  "/provider-setup",
  "/context",
  "/inbox",
  "/adjudications",
  "/checkpoints",
  "/trajectory",
  "/changes",
  "/sessions",
  "/balance",
  "/usage",
  "/permissions",
  "/sandbox",
  "/studio",
  "/new",
  "/submit",
  "/cancel",
  "/approve",
  "/plan",
  "/effort",
  "/compact",
  "/rewind",
  "/branch",
  "/git",
  "/commit",
  "/summarize",
  "/goal",
  "/tools",
  "/plugins",
  "/hooks",
  "/workspace",
  "/config",
  "/host",
];

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    port: 5274,
    proxy: serve
      ? Object.fromEntries(
          KERNEL_PATHS.map((path) => [
            path,
            {
              target: serve,
              changeOrigin: true,
              // The kernel's CSRF guard rejects a foreign Origin. Rewriting it
              // makes the dev hop look same-origin, which is what production
              // is: the app really is served from the kernel.
              configure: (proxy: {
                on: (
                  event: string,
                  handler: (req: { headers?: Record<string, string> }) => void,
                ) => void;
              }) => {
                proxy.on("proxyReq", (req) => {
                  if (req.headers) req.headers["origin"] = serve;
                });
              },
            },
          ]),
        )
      : undefined,
  },
  build: {
    target: "es2022",
    // A source map for an app the phone downloads is 5 MB in the APK for a
    // stack trace nobody reads on the device; CI keeps the sources.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    // A fresh jsdom per file cost 125 s of the suite's runtime (84 contexts).
    // vmThreads keeps per-file isolation but reuses one environment per
    // worker; test-setup fills its missing webcrypto so the crypto-backed
    // suites stay honest under it.
    pool: "vmThreads",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // React 19's `act` refuses to work unless the environment says it is a
    // test build. Without this every component test warns, and the batching
    // that makes them deterministic quietly stops applying.
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/env.d.ts"],
      reporter: ["text-summary"],
      thresholds: {
        statements: 78,
        branches: 71,
        functions: 78,
        lines: 81,
      },
    },
  },
});
