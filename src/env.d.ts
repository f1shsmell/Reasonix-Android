/**
 * Values the build injects.
 *
 * `__APP_VERSION__` comes from `package.json` through `define` in
 * `vite.config.ts`; declaring it here keeps the About row from needing a cast
 * or a runtime guard for a value that is always present in a built bundle.
 */
declare const __APP_VERSION__: string;
