package com.reasonix.mobile;

import java.io.IOException;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The upstream cookie jar, plus the WebView jar the account flow reads. Neither
 * jar is reliably a superset of the other: a code scanned into the pairing
 * WebView leaves the credential in the CookieManager, while a code handed to
 * the proxy itself leaves it in memory. A request that picked one jar and
 * ignored the other could reach the kernel carrying no credential at all, so
 * every request folds both by name, the WebView's copy winning a name both
 * jars hold.
 */
final class ProxyCookies {
    private final CookieManager jar = new CookieManager(null, CookiePolicy.ACCEPT_ALL);

    /** One Cookie header for a request to origin: both jars folded by name. */
    String forOrigin(String origin) {
        if (origin == null || origin.trim().isEmpty()) return "";
        List<String> sources = new ArrayList<>();
        sources.add(webCookie(cookieUrl(origin)));
        try {
            Map<String, List<String>> request = jar.get(URI.create(cookieUrl(origin)), new HashMap<>());
            for (List<String> values : request.values()) sources.addAll(values);
        } catch (Exception ignored) {
            // An empty memory jar is a request the kernel will refuse, not a crash.
        }
        return merge(sources);
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

    /** The CookieManager cookie for any origin a WebView paired with. */
    static String webCookie(String url) {
        try {
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            return cookie == null ? "" : cookie;
        } catch (RuntimeException e) {
            return "";
        }
    }

    /**
     * One spelling of a door, so a read and the write that stores a credential
     * cannot drift into asking two questions of the same jar. The proxy may
     * normalize an origin to {@code https://host:443} while a page loads as
     * {@code https://host/}; cookies match by host, so the port decides
     * nothing, but two spellings are two questions.
     */
    static String cookieUrl(String origin) {
        String clean = origin == null ? "" : origin.trim();
        if (clean.isEmpty()) return "";
        while (clean.endsWith("/")) clean = clean.substring(0, clean.length() - 1);
        if (clean.startsWith("https://") && clean.endsWith(":443")) {
            clean = clean.substring(0, clean.length() - 4);
        } else if (clean.startsWith("http://") && clean.endsWith(":80")) {
            clean = clean.substring(0, clean.length() - 3);
        }
        return clean + "/";
    }

    /**
     * Fold cookie headers by name, the first source holding a name winning it.
     * Duplicate names in one header are the same as duplicates across headers —
     * the first stands. Pure, so the folding is tested without a jar.
     */
    static String merge(List<String> sources) {
        LinkedHashMap<String, String> folded = new LinkedHashMap<>();
        if (sources == null) return "";
        for (String source : sources) {
            if (source == null || source.isEmpty()) continue;
            for (String piece : source.split(";")) {
                String pair = piece.trim();
                int eq = pair.indexOf('=');
                if (eq <= 0) continue; // no '=' or no name: not a pairing
                // The name is what two jars match on, so it loses its spaces
                // entirely; a value keeps everything after the '='.
                String name = pair.substring(0, eq).trim();
                if (name.isEmpty()) continue;
                folded.putIfAbsent(name, pair.substring(eq + 1).trim());
            }
        }
        if (folded.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> entry : folded.entrySet()) {
            if (out.length() > 0) out.append("; ");
            out.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return out.toString();
    }
}
