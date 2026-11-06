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
import java.util.List;
import java.util.Map;

/**
 * The account device flow, isolated from the loopback server.
 *
 * The password is used once and never stored; the only credential kept is the
 * returned session token plus the WebView cookie the grant endpoint needs.
 */
final class AccountFlow {
    private static final String TAG = "ReasonixProxy";
    private static final String IDENTITY = "https://id.reasonix.io";
    private static final String KEY_ACCOUNT_TOKEN = "account_token";
    private static final String KEY_ACCOUNT_USER = "account_user";

    private final SharedPreferences prefs;
    private final ProxyCookies cookies;
    private final String userAgent;

    AccountFlow(SharedPreferences prefs, ProxyCookies cookies, String userAgent) {
        this.prefs = prefs;
        this.cookies = cookies;
        this.userAgent = userAgent;
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
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/me/remote-grants").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("User-Agent", userAgent);
        // The web page calls this endpoint from reasonix.io with the account
        // cookie. A service that checks Origin needs the same one; the proxy
        // is not a browser and would otherwise send none.
        conn.setRequestProperty("Origin", "https://reasonix.io");
        conn.setRequestProperty("Referer", "https://reasonix.io/remote/");
        conn.setRequestProperty("Accept", "application/json");
        // The WebView that hosted the sign-in page owns the account cookie;
        // /me/remote-grants wants that cookie, not the Bearer API token.
        String webCookie = ProxyCookies.webCookie();
        if (!webCookie.isEmpty()) {
            conn.setRequestProperty("Cookie", webCookie);
        } else {
            cookies.apply(conn, URI.create(IDENTITY + "/me/remote-grants"));
        }
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
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/me/devices").toURL().openConnection();
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
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/device/start").toURL().openConnection();
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
        cookies.store(URI.create(IDENTITY + "/device/start"), conn);
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
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/device/poll").toURL().openConnection();
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
        cookies.store(URI.create(IDENTITY + "/device/poll"), conn);
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
     * Sign in with the account's email and password, keeping the web session
     * cookie the account grant needs.
     *
     * The password is used once and never stored: the request goes straight to
     * the identity service over HTTPS, and the only thing kept is the response
     * cookie, in the same jar the in-app login page would use.
     */
    void signIn(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String email = request.optString("email", "").trim();
        String password = request.optString("password", "");
        if (email.isEmpty() || password.isEmpty()) {
            ProxyWire.writeJson(socket, 400, new JSONObject().put("code", "account.missing_credentials").toString());
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/auth/login").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Origin", "https://reasonix.io");
        conn.setRequestProperty("Referer", "https://reasonix.io/login/");
        conn.setRequestProperty("User-Agent", userAgent);
        conn.setRequestProperty("Accept", "application/json");
        byte[] payload = new JSONObject().put("email", email).put("password", password)
                .toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = ProxyWire.readText(conn);
        int status = conn.getResponseCode();
        if (status >= 200 && status < 300) persistAccountCookies(conn);
        conn.disconnect();
        if (status < 200 || status >= 300) {
            ProxyWire.writeJson(socket, status, serviceFailure(text, "account.signin_failed").toString());
            return;
        }
        JSONObject result = new JSONObject().put("signedIn", true);
        JSONObject user = new JSONObject(text).optJSONObject("user");
        if (user != null) result.put("user", user);
        ProxyWire.writeJson(socket, 200, result.toString());
    }

    /**
     * Approve the pending device code with the web session cookie.
     *
     * The cookie is the one either sign-in path left in the WebView jar; the
     * device code itself is only a short-lived grant, so both must match.
     */
    void approve(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String userCode = request.optString("userCode", "").trim();
        if (userCode.isEmpty()) {
            ProxyWire.writeJson(socket, 400, new JSONObject().put("code", "account.missing_user_code").toString());
            return;
        }
        String cookie = ProxyCookies.webCookie();
        if (cookie.isEmpty()) {
            ProxyWire.writeJson(socket, 401, new JSONObject().put("code", "account.signin_required").toString());
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/device/approve").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Origin", "https://reasonix.io");
        conn.setRequestProperty("Referer", "https://reasonix.io/device/");
        conn.setRequestProperty("User-Agent", userAgent);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Cookie", cookie);
        byte[] payload = new JSONObject().put("userCode", userCode).toString().getBytes(StandardCharsets.UTF_8);
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
     * End the account's server-side sessions before the local state goes.
     *
     * Best effort and short: signing out must not hang on a bad network. The
     * web session cookie is expired locally as well, or the next sign-in page
     * would still believe the previous person is here.
     */
    void logout() {
        String token = token();
        String cookie = ProxyCookies.webCookie();
        // The identity service's /auth/logout deletes one credential, cookie
        // first. Two calls end both sessions: the web cookie and the device
        // token minted by the poll. The token call runs beside the cookie call
        // so sign-out does not pay two network deadlines in series.
        if (!token.isEmpty()) {
            final String deviceToken = token;
            new Thread(() -> endSession("", deviceToken), "reasonix-logout-token").start();
        }
        endSession(cookie, "");
        try {
            android.webkit.CookieManager jar = android.webkit.CookieManager.getInstance();
            jar.setCookie("https://id.reasonix.io/",
                    "rxid=; Max-Age=0; Path=/; Domain=.reasonix.io; Secure; SameSite=Lax");
            jar.flush();
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot expire the account cookie", e);
        }
        prefs.edit().remove(KEY_ACCOUNT_TOKEN).remove(KEY_ACCOUNT_USER).apply();
    }

    private void endSession(String cookie, String token) {
        if (cookie.isEmpty() && token.isEmpty()) return;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) URI.create(IDENTITY + "/auth/logout").toURL().openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(1500);
            conn.setReadTimeout(2500);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Origin", "https://reasonix.io");
            conn.setRequestProperty("User-Agent", userAgent);
            if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
            }
            ProxyWire.readText(conn);
            persistAccountCookies(conn);
        } catch (IOException e) {
            Log.w(TAG, "cannot end the account session", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Keep the identity service's Set-Cookie in the WebView's jar. */
    private void persistAccountCookies(HttpURLConnection conn) {
        try {
            android.webkit.CookieManager jar = android.webkit.CookieManager.getInstance();
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null || !"set-cookie".equalsIgnoreCase(entry.getKey())) continue;
                for (String value : entry.getValue()) jar.setCookie("https://id.reasonix.io/", value);
            }
            jar.flush();
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot keep the account cookie", e);
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
