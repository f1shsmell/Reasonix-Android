package com.reasonix.mobile;

import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/**
 * The account device flow, isolated from the loopback server.
 *
 * The service this talks to is no longer the vendor's: the upstream account
 * host is gone, so the origin comes from this phone's own settings. An
 * unconfigured phone says so instead of dialling a domain that no longer
 * resolves — the caller checks {@link #configured()} before routing here.
 *
 * The only credential kept is the session token the poll returns, sealed under
 * the phone's keystore. The admin token that approves a code is a person's
 * secret, used once and never stored.
 */
final class AccountFlow {
    private static final String TAG = "ReasonixProxy";
    /** The self-hosted account service's origin; empty until someone sets it. */
    private static final String KEY_IDENTITY = "identity";
    private static final String KEY_ACCOUNT_TOKEN = "account_token";
    private static final String KEY_ACCOUNT_USER = "account_user";

    private final SharedPreferences prefs;
    private final String userAgent;

    AccountFlow(SharedPreferences prefs, String userAgent) {
        this.prefs = prefs;
        this.userAgent = userAgent;
    }

    /**
     * The configured service origin, or "" when nobody set one.
     *
     * Today's answers are all local: the stored value is normalised on read so
     * an origin typed with a trailing slash, a default port or uppercase host
     * still produces the same URL the service was named by.
     */
    String identity() {
        return ProxyPaths.urlOrigin(prefs.getString(KEY_IDENTITY, ""));
    }

    boolean configured() {
        return !identity().isEmpty();
    }

    /**
     * Remember the account service's address, or forget it.
     *
     * An empty value is a state, not an error: a phone that only ever connects
     * over the LAN has no account service, and the account pane should say so
     * rather than keep a dead host it will call on every visit.
     */
    void setIdentity(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String raw = request.optString("origin", "").trim();
        if (raw.isEmpty()) {
            prefs.edit().remove(KEY_IDENTITY).apply();
            ProxyWire.writeJson(socket, 200, status().toString());
            return;
        }
        String origin = ProxyPaths.urlOrigin(raw);
        if (origin.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_origin\"}");
            return;
        }
        prefs.edit().putString(KEY_IDENTITY, origin).apply();
        ProxyWire.writeJson(socket, 200, status().toString());
    }

    /**
     * The stored session token, unsealed. It sits in prefs encrypted under the
     * phone's keystore (an older build's plaintext value reads as-is), because
     * this one string is the whole account credential.
     */
    private String token() {
        return SecretStore.unprotect(prefs.getString(KEY_ACCOUNT_TOKEN, ""));
    }

    void grant(Socket socket, byte[] body) throws IOException, JSONException {
        String token = token();
        if (token.isEmpty()) {
            ProxyWire.writeJson(socket, 401, "{\"code\":\"account.signed_out\"}");
            return;
        }
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String deviceId = request.optString("deviceId", "").trim();
        if (deviceId.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_device\"}");
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(identity() + "/me/remote-grants").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("User-Agent", userAgent);
        conn.setRequestProperty("Accept", "application/json");
        byte[] payload = new JSONObject()
                .put("targetDeviceId", deviceId)
                .put("scopes", new JSONArray().put("desktop"))
                .toString()
                .getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        int status = conn.getResponseCode();
        String text = ProxyWire.readText(conn);
        conn.disconnect();
        if (status < 200 || status >= 300) {
            ProxyWire.writeJson(socket, status, text.isEmpty() ? "{\"code\":\"account.grant_failed\"}" : text);
            return;
        }
        ProxyWire.writeJson(socket, 200, text);
    }

    void devices(Socket socket) throws IOException {
        String token = token();
        if (token.isEmpty()) {
            ProxyWire.writeJson(socket, 401, "{\"code\":\"account.signed_out\"}");
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(identity() + "/me/devices").toURL().openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("User-Agent", userAgent);
        int status = conn.getResponseCode();
        String text = ProxyWire.readText(conn);
        conn.disconnect();
        ProxyWire.writeJson(socket, status, text.isEmpty() ? "{\"devices\":[]}" : text);
    }

    JSONObject status() throws JSONException {
        JSONObject out = new JSONObject();
        String token = token();
        out.put("signedIn", !token.isEmpty());
        String identity = identity();
        // A client that has never been told where the service is can say so
        // instead of leaving the sign-in button to fail on a dead host.
        out.put("identity", identity);
        String user = prefs.getString(KEY_ACCOUNT_USER, "");
        if (!user.isEmpty()) {
            try {
                out.put("user", new JSONObject(user));
            } catch (JSONException ignored) {
                // A stored shape from a newer build is not worth failing over.
            }
        }
        return out;
    }

    JSONObject start() throws IOException, JSONException {
        HttpURLConnection conn = (HttpURLConnection) URI.create(identity() + "/device/start").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", userAgent);
        byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = ProxyWire.readText(conn);
        int status = conn.getResponseCode();
        conn.disconnect();
        if (status < 200 || status >= 300) {
            throw new IOException("account start answered " + status);
        }
        return new JSONObject(text);
    }

    JSONObject poll(byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String deviceCode = request.optString("deviceCode", "");
        if (deviceCode.isEmpty()) {
            return new JSONObject().put("status", "error").put("code", "account.missing_device_code");
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(identity() + "/device/poll").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", userAgent);
        byte[] payload = new JSONObject().put("deviceCode", deviceCode).toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = ProxyWire.readText(conn);
        int status = conn.getResponseCode();
        conn.disconnect();
        if (status == 400 || status == 403 || status == 410) {
            return pollFailure(text);
        }
        if (status < 200 || status >= 300) {
            throw new IOException("account poll answered " + status);
        }
        JSONObject out = new JSONObject(text);
        if ("complete".equals(out.optString("status"))) {
            String token = out.optString("sessionToken", "");
            JSONObject user = out.optJSONObject("user");
            SharedPreferences.Editor edit = prefs.edit().remove(KEY_ACCOUNT_USER);
            if (!token.isEmpty()) edit.putString(KEY_ACCOUNT_TOKEN, SecretStore.protect(token));
            if (user != null) edit.putString(KEY_ACCOUNT_USER, user.toString());
            edit.apply();
            out.remove("sessionToken");
            if (user != null) out.put("user", user);
        }
        return out;
    }

    /**
     * Approve the pending device code with the service's admin token.
     *
     * A self-hosted service has exactly one human credential: the owner's
     * admin token. There is no web session to carry it (no sign-in page, no
     * cookie), so the person types it here and the proxy sends it once, in the
     * body — never in a URL a screenshot or a history could keep.
     *
     * The token is deliberately not stored: approving is a decision made at
     * the moment, and a phone that kept the answer would make it silently for
     * every later code.
     */
    void approve(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String userCode = request.optString("userCode", "").trim();
        if (userCode.isEmpty()) {
            ProxyWire.writeJson(socket, 400, new JSONObject().put("code", "account.missing_user_code").toString());
            return;
        }
        String adminToken = request.optString("token", "").trim();
        if (adminToken.isEmpty()) {
            ProxyWire.writeJson(socket, 400, new JSONObject().put("code", "account.missing_admin_token").toString());
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(identity() + "/device/approve").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", userAgent);
        conn.setRequestProperty("Accept", "application/json");
        byte[] payload = new JSONObject()
                .put("userCode", userCode)
                .put("token", adminToken)
                .toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = ProxyWire.readText(conn);
        int status = conn.getResponseCode();
        conn.disconnect();
        if (status < 200 || status >= 300) {
            ProxyWire.writeJson(socket, status, serviceFailure(text, "account.approve_failed").toString());
            return;
        }
        ProxyWire.writeJson(socket, 200, text.isEmpty() ? "{\"ok\":true}" : text);
    }

    /**
     * End the account's server-side session before the local state goes.
     *
     * Best effort and short: signing out must not hang on a bad network. The
     * self-hosted service identifies a session by its Bearer token alone, so
     * there is no cookie to expire beside it.
     */
    void logout() {
        final String token = token();
        prefs.edit().remove(KEY_ACCOUNT_TOKEN).remove(KEY_ACCOUNT_USER).apply();
        if (token.isEmpty()) return;
        new Thread(() -> endSession(token), "reasonix-logout").start();
    }

    private void endSession(String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) URI.create(identity() + "/auth/logout").toURL().openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(1500);
            conn.setReadTimeout(2500);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("User-Agent", userAgent);
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
            }
            ProxyWire.readText(conn);
        } catch (IOException e) {
            Log.w(TAG, "cannot end the account session", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * A refused device poll, as the sign-in loop reads it.
     *
     * The account service nests its code under `error.code`; older bodies put
     * it at the top. An expired or denied grant ends the wait, everything else
     * is a failure the person can retry.
     */
    static JSONObject pollFailure(String text) {
        String code = "";
        try {
            JSONObject body = new JSONObject(text);
            JSONObject error = body.optJSONObject("error");
            code = error != null ? error.optString("code", "") : body.optString("code", "");
        } catch (JSONException ignored) {
            // A CDN page, not the service's error.
        }
        try {
            if ("access_denied".equals(code) || "expired_token".equals(code)) {
                return new JSONObject().put("status", "ended").put("code", code);
            }
            return new JSONObject().put("status", "error").put("code", code);
        } catch (JSONException impossible) {
            return new JSONObject();
        }
    }

    /** The service's own error code and sentence, when it sent one. */
    private static JSONObject serviceFailure(String text, String fallback) {
        try {
            JSONObject error = new JSONObject(text).optJSONObject("error");
            if (error != null) {
                return new JSONObject()
                        .put("code", error.optString("code", fallback))
                        .put("message", error.optString("message", ""));
            }
        } catch (JSONException ignored) {
            // A CDN page, not the service's JSON; the fallback names the call.
        }
        try {
            return new JSONObject().put("code", fallback).put("message", "");
        } catch (JSONException impossible) {
            return new JSONObject();
        }
    }
}
