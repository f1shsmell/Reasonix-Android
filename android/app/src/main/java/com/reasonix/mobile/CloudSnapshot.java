package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The one JSON answer the WebView gives the background cloud watcher:
 * `/runtimes` plus each pane's raw `/status`. Pure so the service's parsing can
 * be tested without a WebView.
 */
final class CloudSnapshot {
    final boolean ok;
    final String code;
    final List<RuntimeList.Row> runtimes;
    final Map<String, String> statuses;

    private CloudSnapshot(
            boolean ok, String code, List<RuntimeList.Row> runtimes, Map<String, String> statuses) {
        this.ok = ok;
        this.code = code;
        this.runtimes = runtimes;
        this.statuses = statuses;
    }

    static CloudSnapshot parse(String json) {
        if (json == null || json.isEmpty()) return failed("watch.empty");
        try {
            JSONObject body = new JSONObject(json);
            if (!body.optBoolean("ok", false)) {
                return failed(body.optString("code", "watch.failed"));
            }
            if (!body.has("runtimes") || body.isNull("runtimes")) {
                return failed("runtime.shape");
            }
            JSONArray rows = body.optJSONArray("runtimes");
            if (rows == null) return failed("runtime.shape");
            List<RuntimeList.Row> runtimes = RuntimeList.parse(rows.toString());
            if (runtimes == null) return failed("runtime.shape");

            Map<String, String> statuses = new LinkedHashMap<>();
            JSONObject raw = null;
            if (body.has("statuses") && !body.isNull("statuses")) {
                raw = body.optJSONObject("statuses");
                if (raw == null) return failed("status.shape");
            }
            if (raw != null) {
                Iterator<String> keys = raw.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    JSONObject status = raw.optJSONObject(key);
                    if (status != null) statuses.put(key, status.toString());
                }
            }
            return new CloudSnapshot(true, "", runtimes, statuses);
        } catch (Exception e) {
            return failed("watch.failed");
        }
    }

    private static CloudSnapshot failed(String code) {
        return new CloudSnapshot(
                false,
                code == null || code.isEmpty() ? "watch.failed" : code,
                Collections.emptyList(),
                Collections.emptyMap());
    }
}
