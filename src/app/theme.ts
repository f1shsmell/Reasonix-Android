/**
 * The app's appearance setting: follow the system, or pin light or dark.
 *
 * It is applied as a `data-theme` attribute on the document root rather than
 * by rewriting the stylesheet, so `tokens.css` can keep one set of variable
 * names and the media query stays the default. A pinned choice is remembered
 * because a phone that forgets it flips appearance on every cold start.
 *
 * This is the one setting that needs no kernel: it is about this phone's
 * screen, and a value stored on the desktop would be a different answer.
 */

import { applyStatusBar } from "../native/themeBar";

export type ThemeChoice = "auto" | "light" | "dark";

const STORAGE_KEY = "reasonix.theme";

/** The three choices, in the order the segmented control draws them. */
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function isTheme(value: unknown): value is ThemeChoice {
  return value === "auto" || value === "light" || value === "dark";
}

export function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : "auto";
  } catch {
    // A blocked storage API costs the setting, not the screen.
    return "auto";
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Nothing to do: the choice applies for this session either way.
  }
}

/**
 * Apply a choice to the document.
 *
 * `auto` removes the attribute instead of writing `data-theme="auto"`, so the
 * `prefers-color-scheme` block is what decides. Writing the word would leave
 * the attribute set to a value no rule matches, which is a third state that
 * looks like a bug.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  applyStatusBar(resolveAppearance(choice));
  watchSystemAppearance();
}

/**
 * Keep the bar in step while the app sits in `auto` and the system flips.
 *
 * The stylesheet follows `prefers-color-scheme` on its own; the status bar is
 * native chrome and needs to be told. Registered once, and only acts while the
 * page has no pinned attribute — a pinned choice owns its own colour.
 */
let watching = false;
function watchSystemAppearance(): void {
  if (watching) return;
  watching = true;
  try {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    query.addEventListener("change", () => {
      if (document.documentElement.hasAttribute("data-theme")) return;
      applyStatusBar(query.matches ? "light" : "dark");
    });
  } catch {
    // No media query support: `auto` stays wherever it started.
  }
}

/**
 * The appearance the page is actually showing.
 *
 * `auto` is resolved here rather than in CSS because the status bar is native
 * chrome: it needs a concrete colour, not a media query. Below WebView 140 the
 * bar sits above a WebView that Capacitor pads down, so it is drawn by the
 * window and the stylesheet cannot reach it.
 */
export function resolveAppearance(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "auto") return choice;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    // No media query support: the stylesheet's own default is dark.
    return "dark";
  }
}
