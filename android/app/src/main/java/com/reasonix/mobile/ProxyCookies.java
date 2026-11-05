package com.reasonix.mobile;

import java.io.IOException;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The upstream cookie jar, plus the WebView jar the account flow reads. */
final class ProxyCookies {
    private final CookieManager jar = new CookieManager(null, CookiePolicy.ACCEPT_ALL);

    void apply(HttpURLConnection conn, URI uri) {
        try {
            Map<String, List<String>> request = jar.get(uri, new HashMap<>());
            for (List<String> values : request.values()) {
                for (String value : values) conn.addRequestProperty("Cookie", value);
            }
        } catch (IOException ignored) {
            // No cookie is a request the kernel will refuse, not a crash.
        }
    }

    void store(URI uri, HttpURLConnection conn) throws IOException {
        Map<String, List<String>> response = new HashMap<>();
        for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
            if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey())) {
                response.put("Set-Cookie", entry.getValue());
            }
        }
        if (!response.isEmpty()) jar.put(uri, response);
    }

    boolean has(String origin) {
        try {
            return !jar.getCookieStore().get(URI.create(origin + "/")).isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /** The account cookie the in-app sign-in WebView holds. */
    static String webCookie() {
        return webCookie("https://id.reasonix.io");
    }

    /** The CookieManager cookie for any origin a WebView paired with. */
    static String webCookie(String url) {
        try {
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            return cookie == null ? "" : cookie;
        } catch (RuntimeException e) {
            return "";
        }
    }
}
