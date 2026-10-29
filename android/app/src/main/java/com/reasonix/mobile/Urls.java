package com.reasonix.mobile;

import java.net.URI;

/** URL checks shared by the two WebView activities. */
final class Urls {
    private Urls() {
    }

    /** Only http(s) may be loaded into an app-owned WebView. */
    static boolean isWebUrl(String url) {
        if (url == null) return false;
        try {
            URI uri = URI.create(url.trim());
            String scheme = uri.getScheme();
            return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
        } catch (RuntimeException e) {
            return false;
        }
    }
}
