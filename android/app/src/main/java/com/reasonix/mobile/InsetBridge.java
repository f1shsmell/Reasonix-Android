package com.reasonix.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.webkit.WebView;

import androidx.core.view.ViewCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

/**
 * Hands the page the one inset number it cannot work out for itself: how much
 * of the status bar the window has *not* already cleared.
 *
 * Measured on the reported device, the page drew a second status bar's worth
 * of empty space beneath the real one. The CSS asked for
 * `var(--safe-area-inset-top, env(safe-area-inset-top, 0px))` and both sources
 * were wrong for the job:
 *
 * - Capacitor's injected variable never reached the page. It is written with
 *   `document.documentElement.style`, so it belongs to one document — the
 *   write happens when insets are dispatched, which is before the page exists,
 *   and `onPageCommitVisible` only asks for another inset pass (distributing
 *   an unchanged value fires no listener). The CSS fallback then hid the
 *   failure silently.
 * - `env()` reports the bar's real height whichever way the window arranged
 *   itself, because it describes the viewport's safe area rather than who
 *   moved the view. With the WebView already sitting below the bar, reading it
 *   padded the page down again.
 *
 * So this measures the signal that cannot be wrong: where the WebView actually
 * starts on screen. Whatever the window already cleared, the page does not
 * need to add. On the reported device that is 96px of a 96px bar — the page
 * adds nothing — while a window that lays the page under the bar reads 0 and
 * the page adds the whole bar.
 *
 * That covers both of Capacitor's arrangements without knowing which one ran,
 * which is what makes it survive a WebView upgrade: the two arrangements are
 * the entire difference between 96 and 158.
 */
final class InsetBridge {
    private InsetBridge() {}

    /** Read by the pages ahead of Capacitor's variable and `env()`. */
    private static final String PROPERTY = "--rx-inset-top";

    /** The last value sent, so an unchanged pass costs no bridge traffic. */
    private static int lastCssPx = Integer.MIN_VALUE;

    /**
     * Keep the page in step from here on.
     *
     * Two triggers, because the page outlives any single layout pass: a new
     * document has no custom property, and an inset pass can precede this
     * view's own layout. Neither alone is enough.
     */
    static void install(final Activity activity, final WebView webView, Bridge bridge) {
        if (activity == null || webView == null) return;
        reset();

        // Every navigation starts a document that never saw the property.
        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView view) {
                    reset();
                    view.post(() -> sync(activity, webView));
                }

                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    view.post(() -> sync(activity, webView));
                }
            });
        }

        // A rotation, a keyboard or a bar change moves the view without a
        // navigation. Capacitor listens on the decor view, so this one on the
        // WebView sees what that arrangement already left behind.
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            view.post(() -> sync(activity, webView));
            return insets;
        });
        webView.post(() -> sync(activity, webView));
    }

    /** Re-measure and, if the answer moved, tell the page. */
    static void sync(Activity activity, WebView webView) {
        if (activity == null || webView == null || !webView.isAttachedToWindow()) return;

        int barPx = statusBarHeight(activity);
        // A ROM that exposes no such dimension must not be handed a made-up
        // zero: leaving the property unset keeps the CSS on its own fallback,
        // which is how this behaved before the bridge existed.
        if (barPx <= 0) return;

        int[] location = new int[2];
        webView.getLocationOnScreen(location);
        int css = cssInset(barPx, location[1], density(activity));
        if (css == lastCssPx) return;
        lastCssPx = css;

        webView.evaluateJavascript(script(css), null);
    }

    /** The one-line write, kept separate so a test can pin its shape. */
    static String script(int cssPx) {
        return "try{document.documentElement.style.setProperty('"
                + PROPERTY
                + "','"
                + cssPx
                + "px')}catch(e){}";
    }

    /** Forget the cached value, so the next sync reports even if unchanged. */
    static void reset() {
        lastCssPx = Integer.MIN_VALUE;
    }

    /**
     * The height the page must add, in CSS pixels.
     *
     * Pure, so the arithmetic is testable on the JVM: a page already clear of
     * the bar needs nothing, a page laid under it is owed the bar in full, and
     * a view pushed past the bar is owed nothing rather than a negative value.
     */
    static int cssInset(int barPx, int webTopPx, float density) {
        int need = Math.max(0, barPx - Math.max(0, webTopPx));
        if (density <= 0f) return 0;
        return Math.round(need / density);
    }

    /** Falls back to 0 when the ROM exposes no such dimension. */
    @SuppressLint({"InternalInsetResource", "DiscouragedApi"})
    private static int statusBarHeight(Activity activity) {
        int id = activity.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? activity.getResources().getDimensionPixelSize(id) : 0;
    }

    private static float density(Activity activity) {
        return activity.getResources().getDisplayMetrics().density;
    }
}
