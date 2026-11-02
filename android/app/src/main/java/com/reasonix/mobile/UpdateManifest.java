package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The update manifest a release publishes. Its rules decide whether a version
 * is offered and what may be downloaded, so it stays free of Android types and
 * runs as a JVM test.
 */
final class UpdateManifest {
    private static final Pattern TAG = Pattern.compile("v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?");
    private static final Pattern APK = Pattern.compile("[A-Za-z0-9._-]+\\.apk");

    private final String tag;
    private final String version;
    private final int versionCode;
    private final String apk;
    private final String notes;
    private final List<String> mirrors;

    private UpdateManifest(
            String tag, String version, int versionCode, String apk, String notes, List<String> mirrors) {
        this.tag = tag;
        this.version = version;
        this.versionCode = versionCode;
        this.apk = apk;
        this.notes = notes;
        this.mirrors = Collections.unmodifiableList(mirrors);
    }

    static UpdateManifest parse(String json) throws IllegalArgumentException {
        JSONObject object;
        try {
            object = new JSONObject(json);
        } catch (JSONException e) {
            throw new IllegalArgumentException("bad-json");
        }
        String tag = object.optString("tag", "").trim();
        String version = object.optString("version", "").trim();
        int versionCode = object.optInt("versionCode", 0);
        String apk = object.optString("apk", "").trim();
        if (!TAG.matcher(tag).matches()) throw new IllegalArgumentException("bad-tag");
        if (!version.equals(tag.substring(1))) throw new IllegalArgumentException("tag-version-mismatch");
        if (versionCode <= 0) throw new IllegalArgumentException("bad-version-code");
        if (!APK.matcher(apk).matches()) throw new IllegalArgumentException("bad-apk");

        List<String> mirrors = new ArrayList<>();
        JSONArray array = object.optJSONArray("mirrors");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                String mirror = array.optString(i, "").trim();
                if (mirror.startsWith("https://")) mirrors.add(mirror);
            }
        }
        return new UpdateManifest(
                tag, version, versionCode, apk, object.optString("notes", ""), mirrors);
    }

    String tag() {
        return tag;
    }

    String version() {
        return version;
    }

    int versionCode() {
        return versionCode;
    }

    String apk() {
        return apk;
    }

    String notes() {
        return notes;
    }

    List<String> mirrors() {
        return mirrors;
    }

    boolean isNewerThan(long installedVersionCode) {
        return versionCode > installedVersionCode;
    }

    String apkUrl(String repo) {
        return "https://github.com/" + repo + "/releases/download/" + tag + "/" + apk;
    }
}
