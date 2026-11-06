package com.reasonix.mobile;

import org.json.JSONArray;

import java.net.InetAddress;

/** How a private target is reached when a VPN owns the default route. */
final class LanRoute {
    private LanRoute() {}

    /**
     * The route a kernel connection takes: "system", "direct" or "no-proxy".
     *
     * "auto" only avoids the system HTTP proxy when the target is a private
     * address a VPN might otherwise swallow. "bypass" forces that path for
     * phones where the automatic guess is wrong. "system" leaves both alone.
     *
     * `onLink` comes from the proxy's LAN network lookup, which only answers
     * while a VPN owns the default route; without one the default route
     * already reaches the LAN. `vpn` keeps a mesh-VPN address on the tunnel:
     * it is private by the same rule as a home router's address, but no local
     * link can reach it.
     */
    static String routeFor(String policy, boolean onLink, boolean vpn) {
        if ("system".equals(policy)) return "system";
        if (onLink) return "direct";
        if (!vpn) return "no-proxy";
        return "system";
    }

    /** The IP a LAN share uses, or null for an internet host. */
    static InetAddress lanTarget(String host) {
        if (host == null || host.isEmpty()) return null;
        String value = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1) : host;
        // A literal address parses without touching DNS; only a hostname pays
        // the resolver, and then briefly: classification ran per request, and
        // a dead resolver tied up a worker thread for the system timeout each
        // time. Half a minute of memory changes no decision a resolver would.
        if (value.contains(":") || value.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            try {
                return classify(InetAddress.getByName(value));
            } catch (Exception ignored) {
                return null;
            }
        }
        Cached cached = RESOLVED.get(value);
        long now = System.currentTimeMillis();
        if (cached != null && now - cached.at < RESOLVE_TTL_MS) {
            return cached.address == null ? null : classify(cached.address);
        }
        // A miss is cached like a hit: the motivation for caching at all is a
        // dead resolver tying up a worker per request, and an unresolvable
        // name is exactly the case that pays the full timeout each time.
        InetAddress address;
        try {
            address = InetAddress.getByName(value);
        } catch (Exception ignored) {
            address = null;
        }
        if (RESOLVED.size() > 16) RESOLVED.clear();
        RESOLVED.put(value, new Cached(address, now));
        return address == null ? null : classify(address);
    }

    /** The address when it names a private neighbour, else null. */
    private static InetAddress classify(InetAddress address) {
        if (address.isSiteLocalAddress() || address.isLinkLocalAddress() || address.isLoopbackAddress()) {
            return address;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc) return address;
        return null;
    }

    private static final java.util.concurrent.ConcurrentHashMap<String, Cached> RESOLVED =
            new java.util.concurrent.ConcurrentHashMap<>();
    private static final long RESOLVE_TTL_MS = 30_000L;

    /** A resolved name; a null address remembers that the name does not resolve. */
    private static final class Cached {
        final InetAddress address;
        final long at;

        Cached(InetAddress address, long at) {
            this.address = address;
            this.at = at;
        }
    }

    /**
     * Whether [target] falls inside [local]/[prefix].
     *
     * An interface's own prefix is the only statement that a neighbour is
     * directly reachable: a mesh VPN's 172.16.x address is private by the same
     * rule as a home router's 192.168.x one, but only the latter is a
     * neighbour of the Wi-Fi link.
     */
    static boolean inSubnet(InetAddress target, InetAddress local, int prefix) {
        if (target == null || local == null || prefix < 0) return false;
        byte[] a = target.getAddress();
        byte[] b = local.getAddress();
        if (a.length != b.length) return false;
        int bits = Math.min(prefix, a.length * 8);
        int whole = bits / 8;
        for (int i = 0; i < whole; i++) {
            if (a[i] != b[i]) return false;
        }
        int rest = bits % 8;
        if (rest == 0) return true;
        int mask = (0xff << (8 - rest)) & 0xff;
        return (a[whole] & mask) == (b[whole] & mask);
    }

    /**
     * The remembered origins, the directly reachable ones first.
     *
     * Stable within each group: two neighbours keep the order they were
     * recorded in, so the newest direct door still wins.
     */
    static JSONArray preferredFirst(JSONArray list, java.util.function.Predicate<String> direct) {
        JSONArray near = new JSONArray();
        JSONArray far = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            String origin = list.optString(i, "");
            if (origin.isEmpty()) continue;
            (direct.test(origin) ? near : far).put(origin);
        }
        for (int i = 0; i < far.length(); i++) near.put(far.optString(i, ""));
        return near;
    }
}
