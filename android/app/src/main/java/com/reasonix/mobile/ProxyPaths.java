package com.reasonix.mobile;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Route parsing and URL rewriting for the loopback proxy.
 *
 * These rules decide what may be forwarded and which redirects stay on the
 * loopback origin, so they live where a unit test can reach them rather than
 * inside the request handler.
 */
final class ProxyPaths {
    private ProxyPaths() {}

    /** The full Studio WebView names itself; the app bundle does not. */
    static final String STUDIO_UA_MARKER = "reasonix-studio/1";

    static boolean controlMethodAllowed(String path, String method) {
        switch (path) {
            case "/__reasonix/config":
                return "GET".equals(method) || "POST".equals(method);
            case "/__reasonix/fleet":
                return "GET".equals(method) || "POST".equals(method);
            case "/__reasonix/account":
            case "/__reasonix/account/devices":
                return "GET".equals(method);
            case "/__reasonix/refresh":
            case "/__reasonix/account/grant":
            case "/__reasonix/account/start":
            case "/__reasonix/account/poll":
            case "/__reasonix/account/signin":
            case "/__reasonix/account/approve":
            case "/__reasonix/account/logout":
            case "/__reasonix/relay":
            case "/__reasonix/net-policy":
            case "/__reasonix/device":
            case "/__reasonix/disconnect":
            case "/__reasonix/relay/clear":
                return "POST".equals(method);
            default:
                // The control switch answers 404 for unknown control paths.
                return true;
        }
    }

    /**
     * The kernel path a fleet route carries, or "" when it must not forward.
     *
     * `/__reasonix/fleet/<index>/<kernel path>?<query>` keeps the query: the
     * kernel reads it (a tree window, a replay cursor). Control paths,
     * traversal and relative shapes are an app bug, and "" is a refusal
     * rather than a forward.
     */
    static String fleetKernelPath(String target) {
        String path = target.split("\\?", 2)[0];
        String query = target.contains("?") ? target.substring(target.indexOf('?')) : "";
        String rest = path.substring("/__reasonix/fleet/".length());
        int slash = rest.indexOf('/');
        // `/__reasonix/fleet/<index>` names a computer but no kernel path;
        // forwarding "/" would read that computer's front page, which no
        // sweep asks for and a stranger should not either.
        if (slash < 0) return "";
        String kernelPath = rest.substring(slash) + query;
        // The kernel may decode percent escapes before routing, so a
        // traversal or a control path hiding behind %2e%2e is judged on the
        // decoded form too. The forward itself stays byte-for-byte.
        String decoded;
        try {
            // The Charset overload is API 33; phones below Android 13 die with
            // NoSuchMethodError on this proxy thread, which takes the app with
            // it. The String overload has been there since API 1.
            decoded = URLDecoder.decode(kernelPath, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException | UnsupportedEncodingException e) {
            return "";
        }
        if (!kernelPath.startsWith("/") || kernelPath.contains("..")
                || kernelPath.toLowerCase(Locale.ROOT).startsWith("/__reasonix/")
                || decoded.contains("..")
                || decoded.toLowerCase(Locale.ROOT).startsWith("/__reasonix/")) {
            return "";
        }
        return kernelPath;
    }

    /** The peer index in a fleet route, or -1 when the shape is unusable. */
    static int fleetPeerIndex(String target) {
        String path = target.split("\\?", 2)[0];
        String rest = path.substring("/__reasonix/fleet/".length());
        int slash = rest.indexOf('/');
        try {
            return Integer.parseInt(slash >= 0 ? rest.substring(0, slash) : rest);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** Whether a request came from the full Studio WebView, not the app. */
    static boolean isStudio(Map<String, String> headers) {
        String agent = headers.get("user-agent");
        return agent != null && agent.contains(STUDIO_UA_MARKER);
    }

    /** Pure half of copyLocation, so the rewrite can be tested without a socket. */
    static String studioLocation(String location, String origin) {
        if (location == null || origin == null || origin.isEmpty()) return location;
        String base = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
        String path = loopbackPath(base, location);
        // A relative Location, or one naming another host, is already safe.
        return path == null ? location : path;
    }

    /**
     * The path part of an absolute kernel URL, or null when the URL does not
     * name this kernel at all.
     *
     * Shared by the redirect rewrite and the Studio WebView's link guard. The
     * boundary after the authority matters: `?query` and `#fragment` have no
     * slash, and a host such as `192.168.5.3:55716.evil.com` merely starts
     * with the same text — treating either as a same-origin path would send
     * the page back to the LAN address or let a foreign host through the guard.
     */
    static String loopbackPath(String base, String target) {
        if (target == null || base == null || base.isEmpty()) return null;
        if (target.equals(base)) return "/";
        if (!target.startsWith(base)) return null;
        String rest = target.substring(base.length());
        if (rest.isEmpty()) return "/";
        char next = rest.charAt(0);
        if (next == '/') return rest;
        if (next == '?' || next == '#') return "/" + rest;
        return null;
    }

    /** The host of an origin like `http://192.168.5.3:57074`, or "". */
    static String hostOf(String origin) {
        if (origin == null || origin.isEmpty()) return "";
        try {
            String host = URI.create(origin).getHost();
            return host == null ? "" : host;
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    /**
     * The remembered origins to keep when {@code origin} becomes the newest.
     *
     * A kernel picks a fresh port on restart unless the person pinned one, so
     * the same computer keeps arriving under a new origin. Keeping every one
     * of them makes `/__reasonix/refresh` probe a queue of doors that no
     * longer answer — three seconds each, on a phone that has left the
     * network. One origin per host is the same rule the app's saved list
     * already uses.
     *
     * The newest origin goes first: callers rely on that order to try the door
     * that was just paired before the ones that merely were remembered.
     *
     * Two origins are the same computer when their hosts match, ignoring case
     * — host names are case-insensitive. An origin this class cannot parse
     * keeps its place: refusing to guess is safer than treating every
     * unreadable address as one machine.
     *
     * The old list is deduplicated against itself too, not only against
     * {@code origin}: a phone that upgraded from an older build already has
     * several ports of one machine in here, and a walk that switches to
     * another address type would otherwise carry all of them forward.
     */
    static List<String> onePerHost(List<String> existing, String origin) {
        List<String> next = new ArrayList<>();
        if (origin == null || origin.isEmpty()) {
            if (existing != null) next.addAll(existing);
            return next;
        }
        Set<String> hosts = new HashSet<>();
        next.add(origin);
        String host = hostOf(origin);
        if (!host.isEmpty()) hosts.add(host.toLowerCase(Locale.ROOT));
        if (existing == null) return next;
        for (String value : existing) {
            if (value == null || value.isEmpty() || value.equals(origin)) continue;
            String other = hostOf(value);
            if (!other.isEmpty()) {
                String key = other.toLowerCase(Locale.ROOT);
                if (hosts.contains(key)) continue;
                hosts.add(key);
            }
            next.add(value);
        }
        return next;
    }

    static String normalizeOrigin(String raw) {
        try {
            URI uri = URI.create(raw.trim());
            String scheme = uri.getScheme();
            if (!"http".equals(scheme) && !"https".equals(scheme)) return "";
            if (uri.getHost() == null) return "";
            int port = uri.getPort();
            if (port <= 0) port = "https".equals(scheme) ? 443 : 80;
            return scheme + "://" + uri.getHost() + ":" + port;
        } catch (Exception e) {
            return "";
        }
    }
}
