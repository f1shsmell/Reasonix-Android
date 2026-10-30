package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The open panes a watcher discovers from `GET /runtimes`.
 *
 * A pane row is what `/status` must be addressed to and what a notification
 * needs to deep-link back: the runtime id, its request prefix, the workspace
 * root and a readable title. Pure so the foreground service can be tested by
 * feeding it a kernel's answer without an Android runtime.
 */
final class RuntimeList {
    private RuntimeList() {}

    static final class Row {
        final String id;
        final String base;
        final String root;
        final String title;
        /** Another process holds the write lease; the phone cannot answer it. */
        final boolean readOnly;

        Row(String id, String base, String root, String title, boolean readOnly) {
            this.id = id;
            this.base = base;
            this.root = root;
            this.title = title;
            this.readOnly = readOnly;
        }
    }

    /** Null means the body was not a list; empty means the computer has no panes. */
    static List<Row> parse(String json) {
        List<Row> rows = new ArrayList<>();
        if (json == null || json.isEmpty()) return null;
        try {
            JSONArray array = new JSONArray(json);
            for (int index = 0; index < array.length(); index++) {
                JSONObject row = array.optJSONObject(index);
                if (row == null) continue;
                String id = row.optString("id", "").trim();
                String base = row.optString("base", "").trim();
                if (id.isEmpty() || base.isEmpty()) continue;
                rows.add(new Row(
                        id,
                        base,
                        row.optString("root", ""),
                        titleOf(row.optString("sessionPath", ""), row.optString("name", "")),
                        row.optBoolean("readOnly", false)));
            }
        } catch (Exception ignored) {
            // A body this build cannot read is not a list of panes.
            return null;
        }
        return rows;
    }

    /** The transcript's file name, or the project name before a path exists. */
    static String titleOf(String sessionPath, String name) {
        String path = sessionPath == null ? "" : sessionPath.trim();
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (slash >= 0) path = path.substring(slash + 1).trim();
        if (!path.isEmpty()) return path;
        return name == null ? "" : name.trim();
    }
}
