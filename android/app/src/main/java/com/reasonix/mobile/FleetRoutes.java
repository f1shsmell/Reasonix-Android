package com.reasonix.mobile;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** The read-only watch list and its per-peer GET forwarding. */
final class FleetRoutes {
    private static final String KEY_FLEET = "fleet";
    /** Watching every remembered computer would make a sweep a port scan. */
    private static final int MAX_FLEET = 4;

    interface Forwarder {
        void forward(Socket socket, String origin, String method, String target,
                     Map<String, String> headers, byte[] body) throws IOException;
    }

    private final SharedPreferences prefs;
    private final Forwarder forwarder;

    FleetRoutes(SharedPreferences prefs, Forwarder forwarder) {
        this.prefs = prefs;
        this.forwarder = forwarder;
    }

    /**
     * The watch list behind `/__reasonix/fleet/<index>/<kernel path>`.
     *
     * The app replaces the whole list: per-entry writes would need the app and
     * the proxy to agree on identity during a reorder, and a stale mirror
     * would then read one computer's cookies from another's row. LAN rows
     * carry the origin the reads go to; a cloud row is recorded so the app can
     * name it, but the relay carries one link, so it is `watchable: false`.
     */
    void handle(Socket socket, String method, byte[] body) throws IOException, JSONException {
        if ("GET".equals(method)) {
            ProxyWire.writeJson(socket, 200, list().toString());
            return;
        }
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        JSONArray raw = request.optJSONArray("peers");
        JSONArray kept = new JSONArray();
        Set<String> keys = new HashSet<>();
        if (raw != null) {
            for (int i = 0; i < raw.length() && kept.length() < MAX_FLEET; i++) {
                JSONObject entry = raw.optJSONObject(i);
                if (entry == null) continue;
                String kind = entry.optString("kind", "lan");
                String target = entry.optString("target", "").trim();
                JSONObject keptEntry = new JSONObject();
                if ("lan".equals(kind)) {
                    String origin = ProxyPaths.normalizeOrigin(target);
                    if (origin.isEmpty()) continue;
                    keptEntry.put("kind", "lan").put("target", origin);
                } else {
                    if (target.isEmpty()) continue;
                    keptEntry.put("kind", "cloud").put("target", target);
                }
                // One spelling per computer, however the app spelled the host:
                // a duplicate row would make two indexes read the same kernel.
                String key = kind + " " + keptEntry.optString("target", "").toLowerCase(Locale.ROOT);
                if (!keys.add(key)) continue;
                String name = entry.optString("name", "").trim();
                keptEntry.put("name", name.isEmpty() ? target : name);
                kept.put(keptEntry);
            }
        }
        prefs.edit().putString(KEY_FLEET, kept.toString()).apply();
        ProxyWire.writeJson(socket, 200, list().toString());
    }

    private JSONObject list() throws JSONException {
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_FLEET, "[]"));
        } catch (JSONException e) {
            list = new JSONArray();
        }
        JSONArray peers = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject entry = list.optJSONObject(i);
            if (entry == null) continue;
            boolean lan = "lan".equals(entry.optString("kind", "lan"));
            JSONObject out = new JSONObject();
            out.put("kind", entry.optString("kind", "lan"));
            out.put("target", entry.optString("target", ""));
            out.put("name", entry.optString("name", ""));
            out.put("watchable", lan);
            peers.put(out);
        }
        JSONObject body = new JSONObject();
        body.put("peers", peers);
        return body;
    }

    /**
     * One kernel read through a watched computer, named by list index.
     *
     * GET only: the phone may watch another computer, but a turn, an approval
     * and every other write stay with the connection the person is on. The
     * index names the peer; the path behind it is what that kernel answers.
     */
    void forward(Socket socket, String method, String target,
                 Map<String, String> headers) throws IOException {
        if (!"GET".equals(method)) {
            ProxyWire.methodNotAllowed(socket);
            return;
        }
        String kernelPath = ProxyPaths.fleetKernelPath(target);
        if (kernelPath.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"fleet.bad_path\"}");
            return;
        }
        int index = ProxyPaths.fleetPeerIndex(target);
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_FLEET, "[]"));
        } catch (JSONException e) {
            list = new JSONArray();
        }
        if (index < 0 || index >= list.length()) {
            ProxyWire.writeJson(socket, 404, "{\"code\":\"fleet.no_peer\"}");
            return;
        }
        JSONObject entry = list.optJSONObject(index);
        String origin = entry != null && "lan".equals(entry.optString("kind", "lan"))
                ? entry.optString("target", "")
                : "";
        if (origin.isEmpty()) {
            ProxyWire.writeJson(socket, 503, "{\"code\":\"fleet.unwatchable\"}");
            return;
        }
        forwarder.forward(socket, origin, method, kernelPath, headers, new byte[0]);
    }
}
