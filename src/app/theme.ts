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
}
