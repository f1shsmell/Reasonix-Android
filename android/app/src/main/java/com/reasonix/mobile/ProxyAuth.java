package com.reasonix.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;

/**
 * The door on the loopback port.
 *
 * A per-install secret is installed as an HttpOnly cookie in this app's own
 * WebView jar; every request must carry it, and a foreign Origin is refused
 * even when the cookie is present. The foreground service sends the same
 * cookie directly, without going through the page.
 */
final class ProxyAuth {
    private ProxyAuth() {}

    private static final String TAG = "ReasonixProxy";
    static final String PREFS = "reasonix_proxy";
    private static final String KEY_SECRET = "proxy_secret";
    static final String PROXY_COOKIE = "reasonix_loopback";

    /** Put the per-install secret into the app's WebView cookie jar. */
    static void installWebViewCookie(Context context, String loopbackOrigin) {
        try {
            android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setCookie(loopbackOrigin + "/",
                    PROXY_COOKIE + "=" + secret(context) + "; Path=/; HttpOnly");
            cookies.flush();
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot install the loopback cookie", e);
        }
    }

    /** The cookie a native component sends when it speaks to the proxy itself. */
    static String cookie(Context context) {
        return PROXY_COOKIE + "=" + secret(context);
    }

    static String secret(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = prefs.getString(KEY_SECRET, "");
        if (!existing.isEmpty()) return existing;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        String value = out.toString();
        prefs.edit().putString(KEY_SECRET, value).apply();
        return value;
    }

    /**
     * Only the app's own WebView has this HttpOnly cookie. A local socket
     * without it is refused before any path is routed, so another app cannot
     * read the kernel's conversation or repoint the upstream.
     */
    static boolean authorized(Map<String, String> headers, String loopbackOrigin, String secret) {
        String origin = headers.get("origin");
        if (origin != null && !origin.isEmpty() && !loopbackOrigin.equals(origin)) return false;
        String header = headers.get("cookie");
        if (header == null) return false;
        for (String part : header.split(";")) {
            int equals = part.indexOf('=');
            if (equals <= 0) continue;
            if (!PROXY_COOKIE.equals(part.substring(0, equals).trim())) continue;
            byte[] sent = part.substring(equals + 1).trim().getBytes(StandardCharsets.UTF_8);
            if (MessageDigest.isEqual(sent, secret.getBytes(StandardCharsets.UTF_8))) return true;
        }
        return false;
    }
}
