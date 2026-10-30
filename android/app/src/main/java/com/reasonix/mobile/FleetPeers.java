package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The watchable computers in `GET /__reasonix/fleet`.
 *
 * The array position is the index the fleet read routes address, so it is
 * carried beside the target rather than recomputed later. Cloud rows are
 * listed by older shells but cannot be read through the LAN proxy, so they
 * are not peers a watcher can poll.
 */
final class FleetPeers {
    private FleetPeers() {}

    static final class Peer {
        final int index;
        final String target;
        final String name;

        Peer(int index, String target, String name) {
            this.index = index;
            this.target = target;
            this.name = name;
        }
    }

    /** Null means the body was not a list; empty means no watchable peers. */
    static List<Peer> parse(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONArray peers = new JSONObject(json).optJSONArray("peers");
            if (peers == null) return null;
            List<Peer> out = new ArrayList<>();
            for (int index = 0; index < peers.length(); index++) {
                JSONObject row = peers.optJSONObject(index);
                if (row == null) continue;
                if (!"lan".equals(row.optString("kind", "lan"))) continue;
                if (!row.optBoolean("watchable", false)) continue;
                String target = row.optString("target", "").trim();
                if (target.isEmpty()) continue;
                String name = row.optString("name", "").trim();
                out.add(new Peer(index, target, name.isEmpty() ? target : name));
            }
            return out;
        } catch (Exception ignored) {
            return null;
        }
    }
}
