import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Paint the status bar to match the page.
 *
 * The bar is not part of the WebView: below WebView 140 Capacitor pads the
 * WebView down by the inset instead of laying it under the bar, so the strip
 * above the content is drawn by the window and no stylesheet can reach it.
 * The theme's own colour follows the *system* dark setting, which is right for
 * the default and wrong the moment someone pins the appearance in the app
 * (`src/app/theme.ts`): a pinned dark page under a system-light bar is a hard
 * seam, and the reverse is worse.
 *
 * So the page reports the background it actually drew. Both values travel
 * together because they are one decision — a dark bar needs light icons.
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

/**
 * Match the bar to the page.
 *
 * `appearance` is what the page is actually showing, which is the pinned
 * choice when there is one and the system's answer otherwise. Fire and forget:
 * a bar that is one frame late is invisible, and a screen must not wait on a
 * decoration.
 */
export function applyStatusBar(appearance: "light" | "dark"): void {
  if (!Capacitor.isNativePlatform()) return;
  try {
    void themeBar().setAppearance({
      color: BACKGROUND[appearance],
      darkIcons: appearance === "light",
    }).catch(() => {
      // Older builds have no such plugin; the theme's own colour still applies.
    });
  } catch {
    // A bridge without `registerPlugin` (a plain browser, a partial mock) must
    // not take the screen down over a decoration.
  }
}
