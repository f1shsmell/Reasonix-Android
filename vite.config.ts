import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The kernel a dev session talks to. Override with REASONIX_SERVE, e.g.
 * `REASONIX_SERVE=http://127.0.0.1:8791 vite`. Without it the dev server
 * starts but every kernel call 404s, which reads as a broken app rather than
 * a missing backend.
 */
const serve = process.env.REASONIX_SERVE ?? "";

/** Paths the kernel owns. Everything else is the app's own assets. */
const KERNEL_PATHS = [
  "/runtimes",
  "/rt",
  "/auth",
  "/pair",
  "/device",
  "/events",
  "/status",
  "/models",
];

export default defineConfig({
  plugins: [react()],
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
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // React 19's `act` refuses to work unless the environment says it is a
    // test build. Without this every component test warns, and the batching
    // that makes them deterministic quietly stops applying.
    setupFiles: ["./src/test-setup.ts"],
  },
});
