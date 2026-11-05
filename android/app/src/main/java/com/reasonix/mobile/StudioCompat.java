package com.reasonix.mobile;

/**
 * Repaints the Studio page for a WebView that predates its colour syntax.
 *
 * The kernel's Studio front end defines its whole palette with `oklch()`
 * (148 declarations) and mixes with `color-mix()` (310), both of which need
 * Chrome 111. The app's own WebView is whatever the phone ships: Chrome 96 on
 * the Android 12 device this was reported on, where every one of those values
 * is invalid. A custom property left invalid makes each `background`,
 * `color` and `border` that reads it invalid too, so the page keeps its
 * layout skeleton and loses its surfaces and ink — pale text on a washed
 * background, which reads as "laggy and broken" rather than "wrong colours".
 *
 * This sheet redefines those variables with the sRGB equivalents. Rules that
 * call `color-mix()` inline (soft shadows, hover washes) still drop out; the
 * structure, surfaces and readable text come back, which is what a person
 * needs to use the page. Injecting it is cheaper and far less invasive than
 * asking the kernel to ship a second palette.
 *
 * Values were computed from the kernel's own `oklch()` literals, not eyeballed.
 */
final class StudioCompat {
    private StudioCompat() {}

    /** Chrome 111 is the first release with oklch() and color-mix(). */
    static final int COLOUR_MIN_CHROME = 111;

    /** The main document's user agent carries "Chrome/<major>". */
    static int chromeMajor(String userAgent) {
        if (userAgent == null) return 0;
        int at = userAgent.indexOf("Chrome/");
        if (at < 0) return 0;
        int start = at + "Chrome/".length();
        int end = start;
        while (end < userAgent.length() && Character.isDigit(userAgent.charAt(end))) end++;
        if (end == start) return 0;
        try {
            return Integer.parseInt(userAgent.substring(start, end));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** True when the page needs this sheet: it is known to be older. */
    static boolean needsCompat(int chromeMajor) {
        return chromeMajor > 0 && chromeMajor < COLOUR_MIN_CHROME;
    }

    /**
     * The sheet itself, as plain CSS (the caller wraps and injects it).
     * `!important` because the page also has higher-specificity theme blocks
     * (`[data-theme=dark][data-contrast=soft]`) whose declarations would
     * otherwise win over a plain `:root` override.
     */
    static String css() {
        String dark = "--page:#060a10 !important;--surface:#0e1218 !important;"
                + "--raised:#161c23 !important;--overlay:#20262f !important;"
                + "--border:#2d353e !important;--hair:#1b2027 !important;"
                + "--net:#7199e3 !important;--net-wash:#111825 !important;"
                + "--deleg:#32aabc !important;--deleg-wash:#0a1b1e !important;"
                + "--ok:#5bb67f !important;--err:#e16a60 !important;--warn:#f2925e !important;"
                + "--syn-key:#caa2f8 !important;--syn-str:#85cb94 !important;"
                + "--syn-num:#f1ad79 !important;--syn-fn:#81b4f6 !important;"
                + "--err-ink:#f1786d !important;--face-sunk:#060a0f !important;"
                + "--face-code:#0a0e15 !important;--float:#1d232c !important;"
                + "--float-hi:#2a313a !important;--text:#ebe7e0 !important;"
                + "--muted:#a0a5ac !important;--faint:#81878d !important;"
                + "--ghost:#646970 !important;";
        return ":root{"
                + "--page:#f4f1ea !important;--surface:#fdfbf8 !important;--raised:#ffffff !important;"
                + "--overlay:#ece8de !important;--border:#dcd6c9 !important;--hair:#e7e3da !important;"
                + "--float:#ffffff !important;--float-hi:#efebe3 !important;--face-sunk:#f1eee8 !important;"
                + "--face-code:#f9f7f3 !important;--accent:#e6ac45 !important;--accent-fg:#3b2302 !important;"
                + "--net:#395bc6 !important;--net-wash:#e5eeff !important;--deleg:#007282 !important;"
                + "--deleg-wash:#dff2f5 !important;--ok:#2b7a4b !important;--err:#bc3d34 !important;"
                + "--warn:#b16039 !important;--syn-key:#703d9f !important;--syn-str:#1e6534 !important;"
                + "--syn-num:#964d00 !important;--syn-fn:#1657a1 !important;--warn-ink:#9c4c23 !important;"
                + "--net-ink:#2b46a1 !important;--muted:#504a3e !important;--faint:#625c4f !important;"
                + "--ghost:#625c4f !important;--text:#342e22 !important;"
                + "}"
                + ":root[data-theme=dark]{" + dark + "}"
                // An explicit light choice must win over the system preference.
                + "@media (prefers-color-scheme:dark){"
                + ":root:not([data-theme=light]){" + dark + "}"
                + "}"
                + ":root{color-scheme:light;}"
                + ":root[data-theme=dark]{color-scheme:dark;}";
    }
}
