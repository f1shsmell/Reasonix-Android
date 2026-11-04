import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Paint the status bar to match the page.
 *
 * The bar is not part of the WebView: below WebView 140 Capacitor pads the
 * WebView down by the inset instead of laying it under the bar, so the strip
 * above the content is drawn by the window. Capacitor's SystemBars plugin
 * repaints that strip from the *system* theme whenever the bridge starts, and
 * the app can pin its appearance independently (`src/app/theme.ts`) — a pinned
 * dark page under a system-light bar is a hard seam, and the reverse is worse.
 *
 * So the page reports the background it actually drew. Both values travel
 * together because they are one decision — a dark bar needs light icons.
 * The native side keeps the last report and reasserts it after SystemBars,
 * but the first report can still race a bridge that is not up yet; a short
 * retry chain and a re-send on return to the foreground close that window.
 */
interface ThemeBarPlugin {
  setAppearance(options: { color: string; darkIcons: boolean }): Promise<void>;
}

/**
 * Registered on first use, not at import time.
 *
 * Importing this module must not require a native bridge: `theme.ts` is used
 * by screens that render in a plain browser, and by tests that mock
 * `@capacitor/core` down to the one member they need.
 */
let plugin: ThemeBarPlugin | null = null;
function themeBar(): ThemeBarPlugin {
  if (plugin === null) plugin = registerPlugin<ThemeBarPlugin>("ThemeBar");
  return plugin;
}

/** The `--bg` token, per appearance. Kept here because this is native chrome. */
const BACKGROUND: Record<"light" | "dark", string> = {
  light: "#f4f6fa",
  dark: "#0b0e14",
};

type Appearance = "light" | "dark";

/** The most recent request wins; a late failure must not repaint an old one. */
let generation = 0;
let last: Appearance | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let watching = false;
/** The bridge is usually up immediately; these cover a slow cold start. */
const RETRY_DELAYS_MS = [120, 400, 1000, 2000];

function send(appearance: Appearance, gen: number, attempt: number): void {
  let request: Promise<void>;
  try {
    request = themeBar().setAppearance({
      color: BACKGROUND[appearance],
      darkIcons: appearance === "light",
    });
  } catch {
    // `registerPlugin` itself threw: this bridge has no such member (a plain
    // browser, a partial mock). Retrying cannot make it appear, and a queued
    // timer would outlive the screen for nothing.
    return;
  }
  // A rejection means the bridge was not ready yet; that one is worth retrying.
  void request.catch(() => scheduleRetry(appearance, gen, attempt));
}

function scheduleRetry(appearance: Appearance, gen: number, attempt: number): void {
  // A newer theme choice, or a page that has given up waiting, owns the bar.
  if (gen !== generation || attempt >= RETRY_DELAYS_MS.length) return;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (gen === generation) send(appearance, gen, attempt + 1);
  }, RETRY_DELAYS_MS[attempt]);
}

/**
 * Keep the bar in step when the app comes back. The activity also reasserts
 * the last report natively; this covers a WebView that was only hidden, where
 * onResume never ran but SystemBars may have repainted the strip.
 */
function watchVisibility(): void {
  if (watching) return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && last !== null) {
      send(last, generation, 0);
    }
  });
}

/**
 * Match the bar to the page.
 *
 * `appearance` is what the page is actually showing, which is the pinned
 * choice when there is one and the system's answer otherwise. Fire and forget:
 * a bar that is one frame late is invisible, and a screen must not wait on a
 * decoration.
 */
export function applyStatusBar(appearance: Appearance): void {
  last = appearance;
  generation += 1;
  if (!Capacitor.isNativePlatform()) return;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  send(appearance, generation, 0);
  watchVisibility();
}
