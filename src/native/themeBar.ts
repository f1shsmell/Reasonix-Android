import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Paint the status bar to match the page.
 *
 * The bar is not part of the WebView: below WebView 140 Capacitor pads the
 * WebView down by the inset instead of laying it under the bar, so the strip
 * above the content is drawn by the window. Capacitor's SystemBars plugin
 * repaints that strip from the *system* theme whenever the bridge starts, and
 * the app can pin its appearance independently (`src/app/theme.ts`).
 *
 * The colour is read from the page's own `--bg` token rather than copied into
 * a table here: a palette added to `tokens.css` is painted without touching
 * this file, and any root attribute that changes the palette repaints the bar.
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

type Appearance = "light" | "dark";

/** The most recent request wins; a late failure must not repaint an old one. */
let generation = 0;
let last: Appearance | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let watching = false;
let watchingRoot = false;
/** What the native side was last told, so attribute churn can be ignored. */
let reportedColor = "";
let reportedIcons: boolean | null = null;
/** The bridge is usually up immediately; these cover a slow cold start. */
const RETRY_DELAYS_MS = [120, 400, 1000, 2000];

/** The page's painted background, in a form `Color.parseColor` accepts. */
function pageBackground(): string {
  if (typeof document === "undefined") return "";
  const styles = getComputedStyle(document.documentElement);
  const direct = normalizeColor(styles.getPropertyValue("--bg"));
  if (direct) return direct;
  const triplet = styles.getPropertyValue("--bg-rgb").trim();
  if (!triplet) return "";
  return normalizeColor(`rgb(${triplet})`);
}

/**
 * CSS colours to `#rrggbb`.
 *
 * `--bg` is written as hex today, but a theme may compute it or use a colour
 * function; Android's parser accepts neither `rgb()` nor CSS's trailing-alpha
 * form. The bar is opaque, so alpha is dropped rather than reinterpreted.
 */
function normalizeColor(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("#")) {
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw
        .slice(1)
        .split("")
        .map((part) => part + part)
        .join("")}`.toLowerCase();
    }
    if (/^#[0-9a-f]{8}$/i.test(raw)) return raw.slice(0, 7).toLowerCase();
    return "";
  }
  const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(raw);
  if (!match) return "";
  const channels = [match[1], match[2], match[3]].map((part) => Math.round(Number(part)));
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return "";
  }
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function send(appearance: Appearance, gen: number, attempt: number): void {
  const color = pageBackground();
  if (!color) {
    // The stylesheet has not applied yet; the same retry chain covers it.
    scheduleRetry(appearance, gen, attempt);
    return;
  }
  const darkIcons = appearance === "light";
  reportedColor = color;
  reportedIcons = darkIcons;
  let request: Promise<void>;
  try {
    request = themeBar().setAppearance({ color, darkIcons });
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
 * Repaint when the root attributes choose another palette.
 *
 * A theme change and a surface change are two axes (`data-theme`,
 * `data-style`), and either can move `--bg`. Observing the attributes rather
 * than making each setter remember to call here means a third axis added
 * later inherits the behaviour. Unchanged colours are not re-sent.
 */
function watchRoot(): void {
  if (watchingRoot || typeof MutationObserver === "undefined") return;
  watchingRoot = true;
  new MutationObserver(() => {
    if (last === null) return;
    const color = pageBackground();
    const darkIcons = last === "light";
    if (!color || (color === reportedColor && darkIcons === reportedIcons)) return;
    generation += 1;
    send(last, generation, 0);
  }).observe(document.documentElement, { attributes: true });
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
  watchRoot();
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  send(appearance, generation, 0);
  watchVisibility();
}
