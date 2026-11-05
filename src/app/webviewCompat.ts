/**
 * How new the phone's own WebView has to be for the in-app Studio page.
 *
 * The app is a Capacitor shell, so its rendering engine is the system's
 * Android System WebView — a component the phone updates (or doesn't) on its
 * own schedule. The kernel's Studio front end uses `oklch()` and `color-mix()`
 * for every colour and `:has()` / `@container` for the main pane's layout:
 * the first two need Chrome 111, the layout needs 105. On an older engine the
 * page keeps its skeleton, loses its surfaces, and collapses its grid.
 *
 * The app cannot fix that by itself — a structural selector cannot be papered
 * over from the outside — and shipping a private engine would mean carrying
 * ~200 MB and following Chromium's four-week security cadence. So the honest
 * move is to say so where the feature lives, instead of letting the page open
 * looking broken.
 */

/** oklch() and color-mix(), which the Studio palette is written in. */
export const STUDIO_MIN_CHROME = 111;

/**
 * The Chrome major in a user agent, or 0 when it names none.
 *
 * A WebView agent reads `… Chrome/96.0.4664.104 Mobile Safari/537.36`; the
 * app's own UA strings start with `reasonix-android/` and carry no Chrome token,
 * which is exactly why 0 has to mean "unknown" rather than "ancient".
 */
export function chromeMajor(userAgent: string | null | undefined): number {
  if (!userAgent) return 0;
  const match = /Chrome\/(\d+)/.exec(userAgent);
  if (!match || !match[1]) return 0;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : 0;
}

/**
 * True only when the engine is known to be older than the page needs.
 *
 * Unknown is not old: a browser dev session (Firefox, Safari, an unparsable
 * agent) should never be told to update a WebView it is not using. And an
 * engine newer than the floor is left alone.
 */
export function needsStudioUpgrade(major: number): boolean {
  return major > 0 && major < STUDIO_MIN_CHROME;
}
