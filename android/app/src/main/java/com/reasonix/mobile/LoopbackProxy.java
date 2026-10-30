package com.reasonix.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * A loopback HTTP proxy that makes a LAN kernel same-origin with the WebView.
 *
 * The WebView loads http://127.0.0.1:8788. Every request it makes is forwarded
 * to the upstream kernel, cookies included, and an event stream is relayed
 * chunk by chunk. That is what makes a phone able to use the kernel's cookie
 * session and SSE at all: the kernel sends no CORS headers and its auth cookie
 * is SameSite=Lax.
 *
 * The control routes under /__reasonix/ never leave the device. They let the
 * bundle read and change the upstream, pair with a scanned code, and drive the
 * account device flow without a browser origin in the way.
 */
public final class LoopbackProxy {
    private static final String TAG = "ReasonixProxy";
    public static final int PORT = 8788;

    private static final String PREFS = "reasonix_proxy";
    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_CANDIDATES = "candidates";
    private static final String KEY_ACCOUNT_TOKEN = "account_token";
    private static final String KEY_ACCOUNT_USER = "account_user";
    private static final String KEY_MODE = "mode";
    private static final String KEY_RELAY_DEVICE = "relay_device";
    private static final String KEY_PROXY_SECRET = "proxy_secret";
    private static final String KEY_FLEET = "fleet";
    /** Watching every remembered computer would make a sweep a port scan. */
    private static final int MAX_FLEET = 4;
    private static final String PROXY_COOKIE = "reasonix_loopback";
    private static final String LOOPBACK_ORIGIN = "http://127.0.0.1:" + PORT;
    private static final String IDENTITY = "https://id.reasonix.io";
    private static final String USER_AGENT = "reasonix-android/0.1";

    /** A 10 MB image becomes ~13.3 MB of base64 inside a JSON envelope. */
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_HEADER_LINE = 8192;
    private static final int SOCKET_READ_TIMEOUT_MS = 20_000;
    /** An idle SSE sends a comment this often so a dead WebView is noticed. */
    private static final int SSE_HEARTBEAT_MS = 25_000;
    /** A normal API call must not wait forever; only SSE may. */
    private static final int FORWARD_READ_TIMEOUT_MS = 60_000;

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade"));

    private static volatile LoopbackProxy instance;

    public static synchronized void start(Context context) {
        if (instance != null) return;
        try {
            instance = new LoopbackProxy(context.getApplicationContext());
            instance.serve();
        } catch (IOException e) {
            Log.e(TAG, "cannot start loopback proxy on " + PORT, e);
        }
    }

    /**
     * Put the per-install secret into the app's own WebView cookie jar before
     * Capacitor loads 127.0.0.1. The cookie is HttpOnly and scoped to the
     * loopback origin, so another app on the phone cannot read it, and the
     * proxy can refuse everyone else. It is not the kernel credential; it is
     * the door on the local port.
     */
    public static void installWebViewCookie(Context context) {
        try {
            android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setCookie(LOOPBACK_ORIGIN + "/",
                    PROXY_COOKIE + "=" + proxySecret(context) + "; Path=/; HttpOnly");
            cookies.flush();
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot install the loopback cookie", e);
        }
    }

    /**
     * The cookie a native component sends when it speaks to the proxy itself.
     *
     * The foreground service polls `/status` while a turn is blocked; it runs
     * in this app, so it may hold the same per-install secret the WebView has,
     * without going through the WebView.
     */
    static String authCookie(Context context) {
        return PROXY_COOKIE + "=" + proxySecret(context);
    }

    private static String proxySecret(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = prefs.getString(KEY_PROXY_SECRET, "");
        if (!existing.isEmpty()) return existing;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        String value = out.toString();
        prefs.edit().putString(KEY_PROXY_SECRET, value).apply();
        return value;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final ServerSocket server;
    // The accept loop has its own thread: a core thread parked in accept() used
    // to leave only three workers for the WebView, and a queue meant the pool
    // never grew past its core size. Workers are created on demand up to 32.
    private final ExecutorService pool = new ThreadPoolExecutor(
            8, 32, 60L, TimeUnit.SECONDS,
            new SynchronousQueue<>(),
            runnable -> {
                Thread thread = new Thread(runnable, "reasonix-proxy");
                thread.setDaemon(true);
                return thread;
            },
            new ThreadPoolExecutor.AbortPolicy());
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
    private final String secret;

    private LoopbackProxy(Context context) throws IOException {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.secret = proxySecret(context);
        this.server = new ServerSocket();
        this.server.setReuseAddress(true);
        this.server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
    }

    private void serve() {
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket socket = server.accept();
                    try {
                        pool.execute(() -> handle(socket));
                    } catch (RejectedExecutionException e) {
                        // A burst of aborted navigations must not exhaust the
                        // app; refusing one connection is better than dying.
                        Log.w(TAG, "too many connections; closing one");
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                            // already gone
                        }
                    }
                } catch (IOException e) {
                    if (!server.isClosed()) Log.e(TAG, "accept failed", e);
                }
            }
        }, "reasonix-proxy-accept");
        accept.setDaemon(true);
        accept.start();
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            // Bound the request-head phase. This timeout does not affect an
            // SSE response, which is written to this socket, not read from it.
            s.setSoTimeout(SOCKET_READ_TIMEOUT_MS);
            InputStream in = s.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }
            String path = target.split("\\?", 2)[0];
            if (!authorized(headers)) {
                Log.w(TAG, "rejected unauthenticated " + path);
                writeJson(s, 403, "{\"code\":\"proxy.unauthorized\"}");
                return;
            }
            // Authenticate before reading a body: an unauthenticated request
            // must not be able to make the app allocate its 32 MB budget.
            byte[] body;
            try {
                body = readBody(in, headers);
            } catch (PayloadTooLargeException e) {
                writeJson(s, 413, "{\"code\":\"request.too_large\"}");
                return;
            }
            // Per-peer fleet reads live under /__reasonix/ but need the full
            // request target (query included) and the headers, which control()
            // does not carry; they are answered before the control plane.
            if (path.startsWith("/__reasonix/fleet/")) {
                fleetForward(s, method, target, headers);
                return;
            }
            if (path.startsWith("/__reasonix/")) {
                control(s, method, path, body);
                return;
            }
            // The bundle is served from the APK, not from the kernel: only
            // paths the bundle does not own are forwarded.
            if (("GET".equals(method) || "HEAD".equals(method)) && serveStatic(s, method, path)) {
                return;
            }
            forward(s, method, target, headers, body);
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    /**
     * Only the app's own WebView has this HttpOnly cookie. A local socket
     * without it is refused before any path is routed, so another app cannot
     * read the kernel's conversation or repoint the upstream.
     */
    private boolean authorized(Map<String, String> headers) {
        String origin = headers.get("origin");
        if (origin != null && !origin.isEmpty() && !LOOPBACK_ORIGIN.equals(origin)) return false;
        String header = headers.get("cookie");
        if (header == null) return false;
        for (String part : header.split(";")) {
            int equals = part.indexOf('=');
            if (equals <= 0) continue;
            if (!PROXY_COOKIE.equals(part.substring(0, equals).trim())) continue;
            byte[] sent = part.substring(equals + 1).trim().getBytes(StandardCharsets.UTF_8);
            if (MessageDigest.isEqual(sent, secret.getBytes(StandardCharsets.UTF_8))) return true;
        }
        return false;
    }

    // ---- control plane -------------------------------------------------

    private void control(Socket socket, String method, String path, byte[] body) throws IOException {
        try {
            // A control route that changes state must not be reachable by a
            // plain GET. The loopback cookie is HttpOnly, but a page rendered
            // inside the app's own WebView still carries it, and an <img> can
            // issue a GET without an Origin header.
            if (!controlMethodAllowed(path, method)) {
                methodNotAllowed(socket);
                return;
            }
            switch (path) {
                case "/__reasonix/fleet":
                    fleet(socket, method, body);
                    return;
                case "/__reasonix/config":
                    if ("GET".equals(method)) {
                        writeJson(socket, 200, configJson().toString());
                    } else if ("POST".equals(method)) {
                        configure(socket, body);
                    } else {
                        methodNotAllowed(socket);
                    }
                    return;
                case "/__reasonix/refresh":
                    refreshUpstream();
                    writeJson(socket, 200, configJson().toString());
                    return;
                case "/__reasonix/account":
                    writeJson(socket, 200, accountJson().toString());
                    return;
                case "/__reasonix/account/grant":
                    accountGrant(socket, body);
                    return;
                case "/__reasonix/account/devices":
                    accountDevices(socket);
                    return;
                case "/__reasonix/relay":
                    setRelay(socket, body);
                    return;
                case "/__reasonix/relay/clear":
                    prefs.edit().putString(KEY_MODE, "lan").remove(KEY_RELAY_DEVICE).apply();
                    writeJson(socket, 200, configJson().toString());
                    return;
                case "/__reasonix/account/start":
                    writeJson(socket, 200, accountStart().toString());
                    return;
                case "/__reasonix/account/poll":
                    writeJson(socket, 200, accountPoll(body).toString());
                    return;
                case "/__reasonix/account/logout":
                    prefs.edit().remove(KEY_ACCOUNT_TOKEN).remove(KEY_ACCOUNT_USER).apply();
                    writeJson(socket, 200, accountJson().toString());
                    return;
                default:
                    writeJson(socket, 404, "{\"code\":\"proxy.unknown_path\"}");
            }
        } catch (JSONException e) {
            writeJson(socket, 400, "{\"code\":\"proxy.bad_request\"}");
        } catch (IOException e) {
            writeJson(socket, 502, "{\"code\":\"proxy.upstream_unreachable\"}");
        }
    }

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
            case "/__reasonix/account/logout":
            case "/__reasonix/relay":
            case "/__reasonix/relay/clear":
                return "POST".equals(method);
            default:
                // The switch below answers 404 for unknown control paths.
                return true;
        }
    }

    // ---- fleet: the other computers this phone listens to ----------------

    /**
     * The watch list behind `/__reasonix/fleet/<index>/<kernel path>`.
     *
     * The app replaces the whole list: per-entry writes would need the app and
     * the proxy to agree on identity during a reorder, and a stale mirror
     * would then read one computer's cookies from another's row. LAN rows
     * carry the origin the reads go to; a cloud row is recorded so the app can
     * name it, but the relay carries one link, so it is `watchable: false`.
     */
    private void fleet(Socket socket, String method, byte[] body) throws IOException, JSONException {
        if ("GET".equals(method)) {
            writeJson(socket, 200, fleetList().toString());
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
                    String origin = normalizeOrigin(target);
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
        writeJson(socket, 200, fleetList().toString());
    }

    private JSONObject fleetList() throws JSONException {
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
    private void fleetForward(Socket socket, String method, String target,
                              Map<String, String> headers) throws IOException {
        if (!"GET".equals(method)) {
            methodNotAllowed(socket);
            return;
        }
        String kernelPath = fleetKernelPath(target);
        if (kernelPath.isEmpty()) {
            writeJson(socket, 400, "{\"code\":\"fleet.bad_path\"}");
            return;
        }
        int index = fleetPeerIndex(target);
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_FLEET, "[]"));
        } catch (JSONException e) {
            list = new JSONArray();
        }
        if (index < 0 || index >= list.length()) {
            writeJson(socket, 404, "{\"code\":\"fleet.no_peer\"}");
            return;
        }
        JSONObject entry = list.optJSONObject(index);
        String origin = entry != null && "lan".equals(entry.optString("kind", "lan"))
                ? entry.optString("target", "")
                : "";
        if (origin.isEmpty()) {
            writeJson(socket, 503, "{\"code\":\"fleet.unwatchable\"}");
            return;
        }
        forwardTo(socket, origin, method, kernelPath, headers, new byte[0]);
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
            decoded = URLDecoder.decode(kernelPath, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return "";
        }
        if (!kernelPath.startsWith("/") || kernelPath.contains("..")
                || kernelPath.startsWith("/__reasonix/")
                || decoded.contains("..") || decoded.startsWith("/__reasonix/")) {
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

    private void configure(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String origin = normalizeOrigin(request.optString("origin", ""));
        if (origin.isEmpty()) {
            writeJson(socket, 400, "{\"code\":\"proxy.bad_origin\"}");
            return;
        }
        String pairCode = request.optString("pairCode", "");
        if (!pairCode.isEmpty()) {
            int status = pair(origin, pairCode);
            if (status == 403) {
                writeJson(socket, 403, "{\"code\":\"device.pairing_invalid\"}");
                return;
            }
            if (status == 404) {
                // The address is the Studio's main port, not its share
                // listener: /pair does not exist there. Scanning the LAN code
                // carries the right port; typing 8791 does not.
                writeJson(socket, 404, "{\"code\":\"device.pair_route_missing\"}");
                return;
            }
            if (status != 200 && status != 204) {
                writeJson(socket, 502, "{\"code\":\"device.pair_unreachable\",\"status\":" + status + "}");
                return;
            }
        }
        saveOrigin(origin);
        prefs.edit().putString(KEY_MODE, "lan").remove(KEY_RELAY_DEVICE).apply();
        writeJson(socket, 200, configJson().toString());
    }

    private void setRelay(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String deviceId = request.optString("deviceId", "").trim();
        if (deviceId.isEmpty()) {
            writeJson(socket, 400, "{\"code\":\"proxy.bad_device\"}");
            return;
        }
        prefs.edit().putString(KEY_MODE, "relay").putString(KEY_RELAY_DEVICE, deviceId).apply();
        writeJson(socket, 200, configJson().toString());
    }

    private void accountGrant(Socket socket, byte[] body) throws IOException, JSONException {
        String token = prefs.getString(KEY_ACCOUNT_TOKEN, "");
        if (token.isEmpty()) {
            writeJson(socket, 401, "{\"code\":\"account.signed_out\"}");
            return;
        }
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String deviceId = request.optString("deviceId", "").trim();
        if (deviceId.isEmpty()) {
            writeJson(socket, 400, "{\"code\":\"proxy.bad_device\"}");
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/me/remote-grants").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("User-Agent", USER_AGENT);
        // The web page calls this endpoint from reasonix.io with the account
        // cookie. A service that checks Origin needs the same one; the proxy
        // is not a browser and would otherwise send none.
        conn.setRequestProperty("Origin", "https://reasonix.io");
        conn.setRequestProperty("Referer", "https://reasonix.io/remote/");
        conn.setRequestProperty("Accept", "application/json");
        // The WebView that hosted the sign-in page owns the account cookie;
        // /me/remote-grants wants that cookie, not the Bearer API token.
        String webCookie = webCookie();
        if (!webCookie.isEmpty()) {
            conn.setRequestProperty("Cookie", webCookie);
        } else {
            applyCookies(conn, URI.create(IDENTITY + "/me/remote-grants"));
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
        String text = readText(conn);
        conn.disconnect();
        if (status < 200 || status >= 300) {
            writeJson(socket, status, text.isEmpty() ? "{\"code\":\"account.grant_failed\"}" : text);
            return;
        }
        writeJson(socket, 200, text);
    }

    private void accountDevices(Socket socket) throws IOException {
        String token = prefs.getString(KEY_ACCOUNT_TOKEN, "");
        if (token.isEmpty()) {
            writeJson(socket, 401, "{\"code\":\"account.signed_out\"}");
            return;
        }
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/me/devices").toURL().openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("User-Agent", USER_AGENT);
        int status = conn.getResponseCode();
        String text = readText(conn);
        conn.disconnect();
        writeJson(socket, status, text.isEmpty() ? "{\"devices\":[]}" : text);
    }

    private JSONObject configJson() throws JSONException {
        String origin = prefs.getString(KEY_ORIGIN, "");
        JSONObject out = new JSONObject();
        out.put("origin", origin);
        out.put("candidates", new JSONArray(prefs.getString(KEY_CANDIDATES, "[]")));
        out.put("paired", !origin.isEmpty()
                && (hasCookie(origin) || !webCookie(origin.endsWith("/") ? origin : origin + "/").isEmpty()));
        out.put("mode", prefs.getString(KEY_MODE, "lan"));
        out.put("relayDevice", prefs.getString(KEY_RELAY_DEVICE, ""));
        out.put("account", accountJson());
        return out;
    }

    private JSONObject accountJson() throws JSONException {
        JSONObject out = new JSONObject();
        String token = prefs.getString(KEY_ACCOUNT_TOKEN, "");
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

    private void saveOrigin(String origin) {
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_CANDIDATES, "[]"));
        } catch (JSONException e) {
            list = new JSONArray();
        }
        JSONArray next = new JSONArray();
        next.put(origin);
        for (int i = 0; i < list.length(); i++) {
            String value = list.optString(i, "");
            if (!value.isEmpty() && !value.equals(origin)) next.put(value);
        }
        prefs.edit().putString(KEY_ORIGIN, origin).putString(KEY_CANDIDATES, next.toString()).apply();
    }

    private boolean hasCookie(String origin) {
        try {
            return !cookies.getCookieStore().get(URI.create(origin + "/")).isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Try every remembered origin, newest first. An address that still answers
     * becomes the upstream again; a phone that changed Wi-Fi can recover
     * without a new scan as long as the address itself did not change.
     */
    private void refreshUpstream() {
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_CANDIDATES, "[]"));
        } catch (JSONException e) {
            return;
        }
        for (int i = 0; i < list.length(); i++) {
            String origin = list.optString(i, "");
            if (origin.isEmpty()) continue;
            if (probe(origin)) {
                prefs.edit().putString(KEY_ORIGIN, origin).apply();
                return;
            }
        }
    }

    private boolean probe(String origin) {
        HttpURLConnection conn = null;
        try {
            URI uri = URI.create(origin + "/runtimes");
            conn = (HttpURLConnection) uri.toURL().openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            String web = webCookie(origin.endsWith("/") ? origin : origin + "/");
            if (!web.isEmpty()) {
                conn.setRequestProperty("Cookie", web);
            } else {
                applyCookies(conn, uri);
            }
            int status = conn.getResponseCode();
            return status == 200 || status == 401 || status == 403;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private int pair(String origin, String code) throws IOException {
        URI uri = URI.create(origin + "/pair");
        HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Origin", origin);
        conn.setRequestProperty("Referer", origin + "/");
        byte[] payload = ("{\"code\":" + JSONObject.quote(code) + "}").getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        int status = conn.getResponseCode();
        if (status == 200 || status == 204) {
            storeCookies(uri, conn);
        }
        conn.disconnect();
        return status;
    }

    // ---- account device flow ------------------------------------------

    private JSONObject accountStart() throws IOException, JSONException {
        HttpURLConnection conn = (HttpURLConnection) URI.create(IDENTITY + "/device/start").toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", USER_AGENT);
        byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = readText(conn);
        int status = conn.getResponseCode();
        storeCookies(URI.create(IDENTITY + "/device/start"), conn);
        conn.disconnect();
        if (status < 200 || status >= 300) {
            throw new IOException("account start answered " + status);
        }
        return new JSONObject(text);
    }

    private JSONObject accountPoll(byte[] body) throws IOException, JSONException {
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
        conn.setRequestProperty("User-Agent", USER_AGENT);
        byte[] payload = new JSONObject().put("deviceCode", deviceCode).toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }
        String text = readText(conn);
        int status = conn.getResponseCode();
        storeCookies(URI.create(IDENTITY + "/device/poll"), conn);
        conn.disconnect();
        if (status == 400 || status == 403) {
            JSONObject out = new JSONObject(text);
            String error = out.optString("code", "");
            if ("access_denied".equals(error) || "expired_token".equals(error)) {
                return new JSONObject().put("status", "ended").put("code", error);
            }
            return new JSONObject().put("status", "error").put("code", error);
        }
        if (status < 200 || status >= 300) {
            throw new IOException("account poll answered " + status);
        }
        JSONObject out = new JSONObject(text);
        if ("complete".equals(out.optString("status"))) {
            String token = out.optString("sessionToken", "");
            JSONObject user = out.optJSONObject("user");
            SharedPreferences.Editor edit = prefs.edit().remove(KEY_ACCOUNT_USER);
            if (!token.isEmpty()) edit.putString(KEY_ACCOUNT_TOKEN, token);
            if (user != null) edit.putString(KEY_ACCOUNT_USER, user.toString());
            edit.apply();
            out.remove("sessionToken");
            if (user != null) out.put("user", user);
        }
        return out;
    }

    // ---- static bundle -------------------------------------------------

    private boolean serveStatic(Socket socket, String method, String path) throws IOException {
        String name;
        if (path.equals("/")) {
            name = "index.html";
        } else {
            name = path.substring(1);
        }
        if (name.contains("..") || name.startsWith("__reasonix")) return false;
        // A path with no extension is a kernel route (/runtimes, /rt/...) or a
        // client route the bundle owns; only real files are served here.
        boolean hasExtension = name.lastIndexOf('.') > name.lastIndexOf('/');
        if (!hasExtension && !name.equals("index.html")) return false;
        try {
            InputStream in = context.getAssets().open("public/" + name);
            byte[] bytes;
            try (InputStream stream = in) {
                bytes = readAll(stream);
            }
            Map<String, String> extra = new LinkedHashMap<>();
            // Hashed asset names are safe to cache; the entry document is not,
            // or an update would keep loading the old bundle.
            extra.put("Cache-Control", "index.html".equals(name)
                    ? "no-store"
                    : "public, max-age=86400");
            writeResponse(socket, 200, contentType(name), bytes, extra);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String contentType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".map")) return "application/json; charset=utf-8";
        return "application/octet-stream";
    }

    // ---- forwarding ----------------------------------------------------

    private void forward(Socket socket, String method, String target,
                         Map<String, String> headers, byte[] body) throws IOException {
        String origin = prefs.getString(KEY_ORIGIN, "");
        if (origin.isEmpty()) {
            writeJson(socket, 503, "{\"code\":\"proxy.no_upstream\"}");
            return;
        }
        forwardTo(socket, origin, method, target, headers, body);
    }

    /**
     * Forward one request to a named kernel origin.
     *
     * The active upstream and the fleet route both land here, so cookies, the
     * CSRF Origin and the SSE relay behave the same whichever upstream the
     * request goes to.
     */
    private void forwardTo(Socket socket, String origin, String method, String target,
                           Map<String, String> headers, byte[] body) throws IOException {
        URI uri = URI.create(origin + target);
        HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(10000);
            // SSE waits in long stretches, but not forever: a finite timeout
            // lets the relay wake up and notice a WebView that already closed
            // its side, instead of leaking one thread per reconnection.
            conn.setReadTimeout(isEventStream(target, headers) ? SSE_HEARTBEAT_MS : FORWARD_READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String key = entry.getKey();
                if (HOP_BY_HOP.contains(key) || key.equals("host") || key.equals("content-length")
                        || key.equals("accept-encoding") || key.equals("cookie") || key.equals("origin")
                        || key.equals("referer") || key.startsWith("sec-fetch-")) {
                    // The kernel's CSRF guard judges Origin; a WebView origin is
                    // not the kernel's, so the proxy speaks as its own client.
                    // Cookies come from the proxy's jar, never from the WebView.
                    continue;
                }
                conn.setRequestProperty(key, entry.getValue());
            }
            conn.setRequestProperty("Accept-Encoding", "identity");
            // DeviceGate's loopbackOriginAllowed accepts an empty Origin only for
            // GET/HEAD: a state change must name the listener. The browser sends
            // this; the proxy speaks as the kernel's own client.
            conn.setRequestProperty("Origin", origin);
            conn.setRequestProperty("Referer", origin + "/");
            String web = webCookie(origin.endsWith("/") ? origin : origin + "/");
            if (!web.isEmpty()) {
                // The Studio page was paired in this app's WebView; its cookie is
                // the device credential the kernel actually minted.
                conn.setRequestProperty("Cookie", web);
            } else {
                applyCookies(conn, uri);
            }
            if (body.length > 0) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
            }
            int status = conn.getResponseCode();
            String contentType = conn.getContentType();
            storeCookies(uri, conn);
            if (contentType != null && contentType.startsWith("text/event-stream")) {
                streamSse(socket, conn, status, contentType);
                return;
            }
            byte[] payload;
            try (InputStream response = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                payload = response == null ? new byte[0] : readAll(response);
            }
            // A redirect or a download is useless if only Content-Type is
            // copied: the WebView follows a Location, and a file needs its name.
            Map<String, String> forwarded = new LinkedHashMap<>();
            copyHeader(conn, forwarded, "Location");
            copyHeader(conn, forwarded, "Content-Disposition");
            copyHeader(conn, forwarded, "ETag");
            copyHeader(conn, forwarded, "Last-Modified");
            copyHeader(conn, forwarded, "Cache-Control");
            writeResponse(socket, status, contentType, payload, forwarded);
        } finally {
            conn.disconnect();
        }
    }

    private static boolean isEventStream(String target, Map<String, String> headers) {
        if (target.contains("/events")) return true;
        String accept = headers.get("accept");
        return accept != null && accept.contains("text/event-stream");
    }

    private static void copyHeader(HttpURLConnection conn, Map<String, String> out, String name) {
        String value = conn.getHeaderField(name);
        if (value != null && !value.isEmpty()) out.put(name, value);
    }

    private void applyCookies(HttpURLConnection conn, URI uri) {
        try {
            Map<String, List<String>> request = cookies.get(uri, new HashMap<>());
            for (List<String> values : request.values()) {
                for (String value : values) conn.addRequestProperty("Cookie", value);
            }
        } catch (IOException ignored) {
            // No cookie is a request the kernel will refuse, not a crash.
        }
    }

    private void storeCookies(URI uri, HttpURLConnection conn) throws IOException {
        Map<String, List<String>> response = new HashMap<>();
        for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
            if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey())) {
                response.put("Set-Cookie", entry.getValue());
            }
        }
        if (!response.isEmpty()) cookies.put(uri, response);
    }

    /** The account cookie the in-app sign-in WebView holds. */
    private static String webCookie() {
        return webCookie("https://id.reasonix.io");
    }

    /** The CookieManager cookie for any origin a WebView paired with. */
    private static String webCookie(String url) {
        try {
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            return cookie == null ? "" : cookie;
        } catch (RuntimeException e) {
            return "";
        }
    }

    private void streamSse(Socket socket, HttpURLConnection conn, int status, String contentType) {
        OutputStream out = null;
        try {
            out = socket.getOutputStream();
            String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                    + "Content-Type: " + contentType + "\r\n"
                    + "Cache-Control: no-cache\r\n"
                    + "Connection: close\r\n"
                    + "Transfer-Encoding: chunked\r\n\r\n";
            out.write(head.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            InputStream upstream = conn.getInputStream();
            byte[] buffer = new byte[8192];
            byte[] heartbeat = ": keepalive\n\n".getBytes(StandardCharsets.UTF_8);
            while (true) {
                int n;
                try {
                    n = upstream.read(buffer);
                } catch (SocketTimeoutException quiet) {
                    // Nothing from the kernel for a while. A comment chunk keeps
                    // the client's stream open and throws here once it is gone.
                    out.write((Integer.toHexString(heartbeat.length) + "\r\n")
                            .getBytes(StandardCharsets.ISO_8859_1));
                    out.write(heartbeat);
                    out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    out.flush();
                    continue;
                }
                if (n == -1) break;
                out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
                out.write(buffer, 0, n);
                out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            }
            out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException e) {
            // The phone went away or the kernel closed the stream; nothing to
            // report to a client that is no longer reading. If it is still
            // there, a terminating chunk is the difference between "the turn
            // ended" and "the connection was cut".
            try {
                if (out != null) {
                    out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    out.flush();
                }
            } catch (IOException ignored) {
                // the client is gone
            }
        } finally {
            conn.disconnect();
            try {
                if (out != null) socket.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    // ---- HTTP helpers --------------------------------------------------

    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') {
                out.write(b);
                if (out.size() > MAX_HEADER_LINE) throw new IOException("header line too long");
            }
        }
        if (b == -1 && out.size() == 0) return null;
        return new String(out.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    static byte[] readBody(InputStream in, Map<String, String> headers) throws IOException {
        String transfer = headers.get("transfer-encoding");
        if (transfer != null && transfer.toLowerCase(Locale.ROOT).contains("chunked")) {
            return readChunked(in);
        }
        String length = headers.get("content-length");
        if (length == null) return new byte[0];
        int n;
        try {
            n = Integer.parseInt(length);
        } catch (NumberFormatException e) {
            return new byte[0];
        }
        if (n <= 0) return new byte[0];
        // Never allocate from an untrusted Content-Length directly: a phone
        // would OOM before it could even reject the request.
        if (n > MAX_BODY_BYTES) throw new PayloadTooLargeException();
        byte[] body = new byte[n];
        int read = 0;
        while (read < n) {
            int got = in.read(body, read, n - read);
            if (got < 0) break;
            read += got;
        }
        return read == n ? body : Arrays.copyOf(body, read);
    }

    /** A chunked upload streams; buffer it under the same cap as a fixed body. */
    static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String line = readLine(in);
            if (line == null) throw new IOException("truncated chunked body");
            int semicolon = line.indexOf(';');
            String sizeText = (semicolon >= 0 ? line.substring(0, semicolon) : line).trim();
            int size;
            try {
                size = Integer.parseInt(sizeText, 16);
            } catch (NumberFormatException e) {
                throw new IOException("bad chunk size", e);
            }
            if (size < 0) throw new IOException("bad chunk size");
            if (size == 0) {
                String trailer;
                while ((trailer = readLine(in)) != null && !trailer.isEmpty()) {
                    // Trailers carry nothing this proxy needs.
                }
                return out.toByteArray();
            }
            if (out.size() + (long) size > MAX_BODY_BYTES) throw new PayloadTooLargeException();
            byte[] chunk = new byte[size];
            int read = 0;
            while (read < size) {
                int got = in.read(chunk, read, size - read);
                if (got < 0) throw new IOException("truncated chunk");
                read += got;
            }
            out.write(chunk);
            readLine(in);
        }
    }

    static final class PayloadTooLargeException extends IOException {
        PayloadTooLargeException() {
            super("request body too large");
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static String readText(HttpURLConnection conn) throws IOException {
        InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        return in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
    }

    private static void writeJson(Socket socket, int status, String json) throws IOException {
        writeResponse(socket, status, "application/json; charset=utf-8",
                json.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeResponse(Socket socket, int status, String contentType, byte[] payload)
            throws IOException {
        writeResponse(socket, status, contentType, payload, null);
    }

    private static void writeResponse(Socket socket, int status, String contentType, byte[] payload,
                                      Map<String, String> extra) throws IOException {
        OutputStream out = socket.getOutputStream();
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        if (contentType != null) head.append("Content-Type: ").append(contentType).append("\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> entry : extra.entrySet()) {
                String key = entry.getKey();
                if ("content-type".equalsIgnoreCase(key) || "content-length".equalsIgnoreCase(key)
                        || "connection".equalsIgnoreCase(key) || "transfer-encoding".equalsIgnoreCase(key)) {
                    continue;
                }
                head.append(key).append(": ").append(entry.getValue()).append("\r\n");
            }
        }
        if (extra == null || !extra.containsKey("Cache-Control")) {
            head.append("Cache-Control: no-store\r\n");
        }
        head.append("Content-Length: ").append(payload.length).append("\r\n");
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }

    private static void methodNotAllowed(Socket socket) throws IOException {
        writeJson(socket, 405, "{\"code\":\"request.method_not_allowed\"}");
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 422: return "Unprocessable Entity";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "OK";
        }
    }

    private static String normalizeOrigin(String raw) {
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
