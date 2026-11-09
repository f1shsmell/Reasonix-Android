package com.reasonix.mobile;

import java.net.URI;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;

/**
 * What a navigation inside the Studio WebView should become.
 *
 * The page may move within its own origin; anything else is the browser's
 * job, and a subframe is never the app's to decide. Kept away from the
 * activity so the rule is a plain JUnit table rather than something only a
 * device can exercise.
 */
final class WebModeLinks {
    private WebModeLinks() {}

    enum Verdict {
        /** The WebView loads it. */
        LOAD,
        /** Hand it to whichever app handles it (mailto:, intent:, deep links). */
        HAND_OFF,
        /** Hand a web URL on another host to the system browser. */
        EXTERNAL,
    }

    static Verdict decide(String target, boolean forMainFrame, String pageHost) {
        return decide(target, forMainFrame, pageHost, Collections.emptySet());
    }

    static Verdict decide(
            String target, boolean forMainFrame, String pageHost, Set<String> allowedHosts) {
        // A subframe belongs to the page: it cannot hand the person to
        // another app, and intercepting it is what made a cross-origin
        // iframe (a challenge, an embed) open the browser.
        if (!forMainFrame) return Verdict.LOAD;
        if (target == null || target.isEmpty()) return Verdict.HAND_OFF;
        String scheme;
        String host;
        try {
            URI uri = new URI(target.trim());
            scheme = uri.getScheme();
            host = uri.getHost();
        } catch (Exception e) {
            return Verdict.HAND_OFF;
        }
        boolean web = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
        if (!web) return Verdict.HAND_OFF;
        if (host == null || host.isEmpty() || pageHost == null || pageHost.isEmpty()) {
            return Verdict.EXTERNAL;
        }
        String folded = host.toLowerCase(Locale.ROOT);
        if (folded.equals(pageHost.toLowerCase(Locale.ROOT))) return Verdict.LOAD;
        // A declared host is the page moving within itself (a subdomain of the
        // same visit). Only https qualifies, so the exception cannot downgrade.
        if ("https".equalsIgnoreCase(scheme)
                && allowedHosts != null
                && allowedHosts.contains(folded)) {
            return Verdict.LOAD;
        }
        return Verdict.EXTERNAL;
    }
}
