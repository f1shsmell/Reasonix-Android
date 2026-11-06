package com.reasonix.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
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

    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_CANDIDATES = "candidates";
    private static final String KEY_MODE = "mode";
    private static final String KEY_RELAY_DEVICE = "relay_device";
    private static final String KEY_NET_POLICY = "net_policy";
    static final String LOOPBACK_ORIGIN = "http://127.0.0.1:" + PORT;
    private static final String IDENTITY = "https://id.reasonix.io";
    /**
     * The product token keeps its `rx-android/` prefix — the account service
     * may key on it and its source is not ours to check — but the version and
     * model are real now. A hardcoded "/0.1" made every release look like the
     * first one, and every paired phone identical in the device list.
     *
     * Pure, so both fallbacks are testable without a Context.
     */
    static String userAgentFor(String version, String model) {
        String v = asciiOnly(version).trim();
        if (v.isEmpty() || "null".equals(v)) v = "unknown";
        String m = asciiOnly(model).trim();
        return m.isEmpty()
                ? "reasonix-android/" + v
                : "reasonix-android/" + v + " (" + m + ")";
    }

    /**
     * Header values must be printable ASCII: HttpURLConnection throws on any
     * character outside 0x20..0x7e. A ROM whose Build.MODEL is a Chinese
     * marketing name would otherwise break every account call, not just the
     * label.
     *
     * Non-ASCII characters are dropped rather than transliterated, and become
     * a space so the readable part does not fuse together: "红米K30 Pro" keeps
     * "K30 Pro", which still tells one phone from another. A name that is
     * entirely non-ASCII leaves nothing, and the caller then omits the suffix
     * altogether — "??" would be worse than no model at all.
     */
    static String asciiOnly(String raw) {
        if (raw == null) return "";
        StringBuilder out = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= 0x20 && c <= 0x7e) {
                out.append(c);
            } else if (c > 0x7e) {
                out.append(' ');
            }
            // Control characters are dropped: they would end the header.
        }
        return out.toString().replaceAll("\\s+", " ").trim();
    }

    private static String appVersion(Context context) {
        try {
            return String.valueOf(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName);
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            // An unreadable version costs precision, not correctness.
            return "";
        }
    }
    private static final int SOCKET_READ_TIMEOUT_MS = 20_000;
    /** An idle SSE sends a comment this often so a dead WebView is noticed. */
    private static final int SSE_HEARTBEAT_MS = 25_000;
    /** A normal API call must not wait forever; only SSE may. */
    private static final int FORWARD_READ_TIMEOUT_MS = 60_000;

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade"));

    @SuppressLint("StaticFieldLeak") // Holds the application context for the process lifetime.
    private static volatile LoopbackProxy instance;

    public static synchronized boolean start(Context context) {
        if (instance != null) return true;
        try {
            instance = new LoopbackProxy(context.getApplicationContext());
            instance.serve();
            return true;
        } catch (IOException e) {
            Log.e(TAG, "cannot start loopback proxy on " + PORT, e);
            return false;
        }
    }

    /** Put the per-install secret into the app's own WebView cookie jar. */
    public static void installWebViewCookie(Context context) {
        ProxyAuth.installWebViewCookie(context, LOOPBACK_ORIGIN);
    }

    /** The cookie a native component sends when it speaks to the proxy itself. */
    static String authCookie(Context context) {
        return ProxyAuth.cookie(context);
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final ProxyAssets assets;
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
    private final ProxyCookies cookies = new ProxyCookies();
    private final String secret;
    private final AccountFlow account;
    private final FleetRoutes fleet;

    private LoopbackProxy(Context context) throws IOException {
        this.context = context;
        this.prefs = context.getSharedPreferences(ProxyAuth.PREFS, Context.MODE_PRIVATE);
        this.assets = new ProxyAssets(context);
        this.secret = ProxyAuth.secret(context);
        this.account = new AccountFlow(prefs, cookies, userAgentFor(appVersion(context), Build.MODEL));
        this.fleet = new FleetRoutes(prefs, this::forwardTo);
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
            String requestLine = ProxyWire.readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            // Bounded like the body is: an unauthenticated request must not be
            // able to grow this map either. A real browser sends well under
            // twenty headers and a few hundred bytes of cookies; 100 lines or
            // 64 KB total is already generous, and hitting either means the
            // peer is not someone this proxy agreed to serve.
            int headerLines = 0;
            int headerBytes = 0;
            while ((line = ProxyWire.readLine(in)) != null && !line.isEmpty()) {
                headerLines += 1;
                headerBytes += line.length() + 2;
                if (headerLines > ProxyWire.MAX_HEADER_LINES || headerBytes > ProxyWire.MAX_HEADER_BYTES) {
                    Log.w(TAG, "rejected oversized request head from " + s.getInetAddress());
                    ProxyWire.writeJson(s, 431, "{\"code\":\"proxy.headers_too_large\"}");
                    return;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }
            String path = target.split("\\?", 2)[0];
            if (!ProxyAuth.authorized(headers, LOOPBACK_ORIGIN, secret)) {
                // The app bundle is public code. Serving it before the loopback
                // cookie lands avoids a first-launch raw 403; kernel routes,
                // the control plane and the Studio page stay behind the cookie.
                String origin = headers.get("origin");
                boolean localOrigin =
                        origin == null || origin.isEmpty() || LOOPBACK_ORIGIN.equals(origin);
                if (localOrigin
                        && ("GET".equals(method) || "HEAD".equals(method))
                        && !ProxyPaths.isStudio(headers)
                        && assets.serve(s, method, path)) {
                    return;
                }
                Log.w(TAG, "rejected unauthenticated " + path);
                ProxyWire.writeJson(s, 403, "{\"code\":\"proxy.unauthorized\"}");
                return;
            }
            // Authenticate before reading a body: an unauthenticated request
            // must not be able to make the app allocate its 32 MB budget.
            byte[] body;
            try {
                body = ProxyWire.readBody(in, headers);
            } catch (ProxyWire.PayloadTooLargeException e) {
                ProxyWire.writeJson(s, 413, "{\"code\":\"request.too_large\"}");
                return;
            } catch (ProxyWire.BodyTruncatedException e) {
                // Forwarding a short body would have the kernel answer 400 for
                // a request the page believes it sent intact. Name the truncation.
                ProxyWire.writeJson(s, 400, "{\"code\":\"proxy.body_truncated\"}");
                return;
            }
            // Per-peer fleet reads live under /__reasonix/ but need the full
            // request target (query included) and the headers, which control()
            // does not carry; they are answered before the control plane.
            if (path.startsWith("/__reasonix/fleet/")) {
                fleet.forward(s, method, target, headers);
                return;
            }
            if (path.startsWith("/__reasonix/")) {
                control(s, method, path, body);
                return;
            }
            // The bundle is served from the APK, not from the kernel: only
            // paths the bundle does not own are forwarded. The full Studio
            // WebView is the exception — it is a second client on this same
            // origin and needs the kernel's own page and assets, not ours.
            if (!ProxyPaths.isStudio(headers) && ("GET".equals(method) || "HEAD".equals(method))
                    && assets.serve(s, method, path)) {
                return;
            }
            forward(s, method, target, headers, body);
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }


    // ---- control plane -------------------------------------------------

    private void control(Socket socket, String method, String path, byte[] body) throws IOException {
        try {
            // A control route that changes state must not be reachable by a
            // plain GET. The loopback cookie is HttpOnly, but a page rendered
            // inside the app's own WebView still carries it, and an <img> can
            // issue a GET without an Origin header.
            if (!ProxyPaths.controlMethodAllowed(path, method)) {
                ProxyWire.methodNotAllowed(socket);
                return;
            }
            switch (path) {
                case "/__reasonix/fleet":
                    fleet.handle(socket, method, body);
                    return;
                case "/__reasonix/config":
                    if ("GET".equals(method)) {
                        ProxyWire.writeJson(socket, 200, configJson().toString());
                    } else if ("POST".equals(method)) {
                        configure(socket, body);
                    } else {
                        ProxyWire.methodNotAllowed(socket);
                    }
                    return;
                case "/__reasonix/refresh":
                    refreshUpstream();
                    ProxyWire.writeJson(socket, 200, configJson().toString());
                    return;
                case "/__reasonix/account":
                    ProxyWire.writeJson(socket, 200, account.status().toString());
                    return;
                case "/__reasonix/account/grant":
                    account.grant(socket, body);
                    return;
                case "/__reasonix/account/devices":
                    account.devices(socket);
                    return;
                case "/__reasonix/relay":
                    setRelay(socket, body);
                    return;
                case "/__reasonix/net-policy":
                    setNetPolicy(socket, body);
                    return;
                case "/__reasonix/device":
                    deviceSelf(socket, body);
                    return;
                case "/__reasonix/disconnect":
                    disconnect(socket, body);
                    return;
                case "/__reasonix/relay/clear":
                    prefs.edit().putString(KEY_MODE, "lan").remove(KEY_RELAY_DEVICE).apply();
                    ProxyWire.writeJson(socket, 200, configJson().toString());
                    return;
                case "/__reasonix/account/start":
                    ProxyWire.writeJson(socket, 200, account.start().toString());
                    return;
                case "/__reasonix/account/poll":
                    ProxyWire.writeJson(socket, 200, account.poll(body).toString());
                    return;
                case "/__reasonix/account/signin":
                    account.signIn(socket, body);
                    return;
                case "/__reasonix/account/approve":
                    account.approve(socket, body);
                    return;
                case "/__reasonix/account/logout":
                    account.logout();
                    ProxyWire.writeJson(socket, 200, account.status().toString());
                    return;
                default:
                    ProxyWire.writeJson(socket, 404, "{\"code\":\"proxy.unknown_path\"}");
            }
        } catch (JSONException e) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_request\"}");
        } catch (IOException e) {
            ProxyWire.writeJson(socket, 502, "{\"code\":\"proxy.upstream_unreachable\"}");
        }
    }

    private void configure(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String origin = ProxyPaths.normalizeOrigin(request.optString("origin", ""));
        if (origin.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_origin\"}");
            return;
        }
        String pairCode = request.optString("pairCode", "");
        if (!pairCode.isEmpty()) {
            int status = pair(origin, pairCode);
            if (status == 403) {
                ProxyWire.writeJson(socket, 403, "{\"code\":\"device.pairing_invalid\"}");
                return;
            }
            if (status == 404) {
                // The address is the Studio's main port, not its share
                // listener: /pair does not exist there. Scanning the LAN code
                // carries the right port; typing 8791 does not.
                ProxyWire.writeJson(socket, 404, "{\"code\":\"device.pair_route_missing\"}");
                return;
            }
            if (status != 200 && status != 204) {
                ProxyWire.writeJson(socket, 502, "{\"code\":\"device.pair_unreachable\",\"status\":" + status + "}");
                return;
            }
        }
        saveOrigin(origin);
        prefs.edit().putString(KEY_MODE, "lan").remove(KEY_RELAY_DEVICE).apply();
        ProxyWire.writeJson(socket, 200, configJson().toString());
    }

    private void setRelay(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String deviceId = request.optString("deviceId", "").trim();
        if (deviceId.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_device\"}");
            return;
        }
        prefs.edit().putString(KEY_MODE, "relay").putString(KEY_RELAY_DEVICE, deviceId).apply();
        ProxyWire.writeJson(socket, 200, configJson().toString());
    }

    /**
     * Drop the active upstream and forget which one it was: the phone is
     * offline until the person connects again. Saved connections and pairing
     * cookies survive — this is a disconnect, not a factory reset.
     */
    private void disconnect(Socket socket, byte[] body) throws IOException, JSONException {
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_CANDIDATES, "[]"));
        } catch (JSONException e) {
            list = new JSONArray();
        }
        JSONArray candidates = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            String value = list.optString(i, "");
            if (!value.isEmpty()) candidates.put(value);
        }
        prefs.edit().remove(KEY_ORIGIN).putString(KEY_MODE, "lan")
                .remove(KEY_RELAY_DEVICE).putString(KEY_CANDIDATES, candidates.toString()).apply();
        ProxyWire.writeJson(socket, 200, configJson().toString());
    }

    /**
     * Adopt the UI's choice of network policy. Only the three known values
     * are accepted: a client that invents one would silently widen what the
     * connection code has to decide between.
     */
    private void setNetPolicy(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String policy = request.optString("policy", "").trim();
        if (!isValidNetPolicy(policy)) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_policy\"}");
            return;
        }
        prefs.edit().putString(KEY_NET_POLICY, policy).apply();
        ProxyWire.writeJson(socket, 200, configJson().toString());
    }

    /** The values the connection code knows how to honour. */
    static boolean isValidNetPolicy(String policy) {
        return policy.equals("auto") || policy.equals("bypass") || policy.equals("system");
    }

    /**
     * Ask one remembered LAN computer who it is.
     *
     * A paired device's `GET /device` names the machine it reaches — the same
     * host name the account lists for a cloud device. Reading it through the
     * proxy is what lets the app recognise that a LAN origin and a cloud
     * device are one computer, and it works while a VPN owns the default
     * route, where the page cannot reach the LAN origin directly.
     */
    private void deviceSelf(Socket socket, byte[] body) throws IOException, JSONException {
        JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String origin = ProxyPaths.normalizeOrigin(request.optString("origin", ""));
        if (origin.isEmpty()) {
            ProxyWire.writeJson(socket, 400, "{\"code\":\"proxy.bad_origin\"}");
            return;
        }
        URI uri = URI.create(origin + "/device");
        HttpURLConnection conn = null;
        try {
            conn = openKernelConnection(uri);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            String web = ProxyCookies.webCookie(origin.endsWith("/") ? origin : origin + "/");
            if (!web.isEmpty()) {
                conn.setRequestProperty("Cookie", web);
            } else {
                cookies.apply(conn, uri);
            }
            int status = conn.getResponseCode();
            if (status == 401 || status == 403) {
                ProxyWire.writeJson(socket, 401, "{\"code\":\"device.unauthorized\"}");
                return;
            }
            if (status != 200) {
                ProxyWire.writeJson(socket, 502, "{\"code\":\"proxy.upstream_unreachable\"}");
                return;
            }
            String machine = machineOf(ProxyWire.readText(conn));
            if (machine.isEmpty()) {
                ProxyWire.writeJson(socket, 502, "{\"code\":\"device.identity_missing\"}");
                return;
            }
            JSONObject out = new JSONObject();
            out.put("machine", machine);
            ProxyWire.writeJson(socket, 200, out.toString());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** The machine name in a `GET /device` body, or "" when it has none. */
    static String machineOf(String body) {
        try {
            return new JSONObject(body).optString("machine", "").trim();
        } catch (JSONException e) {
            return "";
        }
    }



    /**
     * Open a kernel connection. A phone with a VPN such as FlClash active often
     * routes private addresses through the tunnel; a LAN share on Wi-Fi has to
     * go around it. With no VPN, bypass any configured HTTP proxy for the same
     * private target.
     *
     * The detour is only for a target that is actually on the Wi-Fi's own
     * subnet. A mesh VPN such as Oray's Pgy (蒲公英) also hands out private
     * addresses — 172.16.x — but those exist only inside the tunnel, so
     * pinning them to Wi-Fi is a route that cannot work: the request leaves on
     * a network with no path to it and times out, while the tunnel that could
     * have carried it sits idle. Deciding by subnet rather than by "is this
     * address private" is what keeps the two apart.
     *
     * The net policy setting narrows or widens that behaviour: "bypass" keeps
     * the private-route path even without a VPN, "system" leaves every
     * connection on the default route so a chosen proxy sees LAN traffic too.
     * "auto" — the default — is the paragraph above.
     */
    private HttpURLConnection openKernelConnection(URI uri) throws IOException {
        String policy = prefs.getString(KEY_NET_POLICY, "auto");
        InetAddress target = LanRoute.lanTarget(uri.getHost());
        if ("system".equals(policy) || target == null) {
            return (HttpURLConnection) uri.toURL().openConnection();
        }
        // A VPN that owns the default route is exactly when binding to the
        // Wi-Fi matters: the neighbour is reachable there, not through the
        // tunnel. The bind is chosen by subnet, so a mesh-VPN address on no
        // local link still rides the default route.
        Network local = lanNetwork(target);
        switch (LanRoute.routeFor(policy, local != null, vpnActive())) {
            case "direct":
                return (HttpURLConnection) local.openConnection(uri.toURL());
            case "no-proxy":
                return (HttpURLConnection) uri.toURL().openConnection(Proxy.NO_PROXY);
            default:
                return (HttpURLConnection) uri.toURL().openConnection();
        }
    }



    /**
     * The Wi-Fi or Ethernet network that can actually reach [target], or null
     * when the target is not on any of their subnets.
     *
     * A neighbour is reached over the link that owns its subnet, whatever the
     * active network says. Split-tunnel VPNs such as Pgy (蒲公英) can leave
     * Wi-Fi as the active network while still capturing the LAN's routes in
     * the tunnel; only an explicit bind keeps the request on the local link.
     * The same lookup decides the "direct" label, so the path the app calls
     * direct is the path it actually takes.
     */
    private Network lanNetwork(InetAddress target) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return null;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                continue;
            }
            if (onLink(manager, network, target)) return network;
        }
        return null;
    }

    /** True when [network]'s own addresses make [target] a neighbour. */
    private static boolean onLink(ConnectivityManager manager, Network network, InetAddress target) {
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null) return false;
        for (LinkAddress address : properties.getLinkAddresses()) {
            if (LanRoute.inSubnet(target, address.getAddress(), address.getPrefixLength())) return true;
        }
        return false;
    }


    private boolean vpnActive() {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network active = manager.getActiveNetwork();
        NetworkCapabilities caps = active == null ? null : manager.getNetworkCapabilities(active);
        return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private boolean lanAvailable() {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                return true;
            }
        }
        return false;
    }

    private JSONObject configJson() throws JSONException {
        String origin = prefs.getString(KEY_ORIGIN, "");
        JSONObject out = new JSONObject();
        out.put("origin", origin);
        JSONArray saved;
        try {
            saved = new JSONArray(prefs.getString(KEY_CANDIDATES, "[]"));
        } catch (JSONException e) {
            saved = new JSONArray();
        }
        out.put("candidates", saved);
        // The same list in the order this phone would try it, and the subset it
        // can reach without a tunnel. Both are needed: the order is what the
        // app switches by, the subset is what it can honestly call "direct".
        out.put("preferred", LanRoute.preferredFirst(saved, this::directlyReachable));
        JSONArray direct = new JSONArray();
        for (int i = 0; i < saved.length(); i++) {
            String value = saved.optString(i, "");
            if (!value.isEmpty() && directlyReachable(value)) direct.put(value);
        }
        out.put("direct", direct);
        out.put("paired", !origin.isEmpty()
                && (cookies.has(origin) || !ProxyCookies.webCookie(origin.endsWith("/") ? origin : origin + "/").isEmpty()));
        String mode = prefs.getString(KEY_MODE, "lan");
        out.put("mode", mode);
        // The full Studio page can only reach a LAN kernel through this proxy:
        // a direct WebView loses the VPN detour, the device cookie and the
        // CSRF Origin that forwarding supplies. Hand the client the loopback
        // address for its in-app WebView, but only for a LAN door with an
        // upstream. The system browser keeps the kernel's real address — it
        // has no proxy cookie and cannot use 127.0.0.1.
        out.put("studioUrl", !origin.isEmpty() && !"relay".equals(mode)
                ? LOOPBACK_ORIGIN + "/" : "");
        out.put("relayDevice", prefs.getString(KEY_RELAY_DEVICE, ""));
        out.put("vpn", vpnActive());
        out.put("lan", lanAvailable());
        out.put("netPolicy", prefs.getString(KEY_NET_POLICY, "auto"));
        out.put("account", account.status());
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

    /**
     * Try every remembered origin, the ones this phone can reach directly
     * first.
     *
     * Order is the whole point. A computer that exposes both its Wi-Fi address
     * and a mesh-VPN one is two doors to the same kernel, and the direct door
     * is the faster one — no tunnel, no detour through someone else's relay.
     * Trying them newest-first would keep picking whichever was paired last,
     * which is the tunnel as often as not. A neighbour of a Wi-Fi/Ethernet
     * interface is preferred, and everything else stays as a fallback so a
     * phone that left that network still recovers.
     *
     * No origin means the person disconnected on purpose, and a network flip
     * must not quietly re-arm the proxy behind that choice: only an explicit
     * connect (configure, pair, relay) writes an origin again.
     */
    private void refreshUpstream() {
        if (prefs.getString(KEY_ORIGIN, "").isEmpty()) return;
        JSONArray list;
        try {
            list = new JSONArray(prefs.getString(KEY_CANDIDATES, "[]"));
        } catch (JSONException e) {
            return;
        }
        JSONArray ordered = LanRoute.preferredFirst(list, this::directlyReachable);
        for (int i = 0; i < ordered.length(); i++) {
            String origin = ordered.optString(i, "");
            if (origin.isEmpty()) continue;
            if (probe(origin)) {
                prefs.edit().putString(KEY_ORIGIN, origin).apply();
                return;
            }
        }
    }


    /**
     * Whether [origin]'s host sits on a Wi-Fi or Ethernet interface this phone
     * is attached to.
     *
     * This is the test for "direct", and it is deliberately not "is the
     * address private": a mesh VPN hands out 172.16.x too, but that address is
     * only reachable through the tunnel, so treating it as direct would pick
     * the slow door and call it the fast one.
     */
    private boolean directlyReachable(String origin) {
        String host = ProxyPaths.hostOf(origin);
        InetAddress target = LanRoute.lanTarget(host);
        return target != null && lanNetwork(target) != null;
    }


    private boolean probe(String origin) {
        HttpURLConnection conn = null;
        try {
            URI uri = URI.create(origin + "/runtimes");
            conn = openKernelConnection(uri);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            String web = ProxyCookies.webCookie(origin.endsWith("/") ? origin : origin + "/");
            if (!web.isEmpty()) {
                conn.setRequestProperty("Cookie", web);
            } else {
                cookies.apply(conn, uri);
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
        HttpURLConnection conn = openKernelConnection(uri);
        try {
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
                cookies.store(uri, conn);
                persistWebCookie(uri, conn);
            }
            return status;
        } finally {
            // A refusal from an unreachable kernel used to leave the connection
            // to GC; pairing retries on a flaky network piled up sockets.
            conn.disconnect();
        }
    }

    /**
     * The proxy's jar is memory-only; the WebView's cookie store is what
     * survives a restart. A pairing made through this POST must leave the
     * device credential in the store every later request already reads.
     */
    private void persistWebCookie(URI uri, HttpURLConnection conn) {
        try {
            android.webkit.CookieManager web = android.webkit.CookieManager.getInstance();
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null || !"set-cookie".equalsIgnoreCase(entry.getKey())) continue;
                for (String value : entry.getValue()) {
                    // Only the device credential is this exchange's to keep;
                    // other cookies belong to the page and its own lifetime.
                    if (!value.startsWith("reasonix_device=")) continue;
                    web.setCookie(uri.toString(), value);
                }
            }
            web.flush();
        } catch (RuntimeException ignored) {
            // The in-memory jar still serves this process; only a restart loses it.
        }
    }



    // ---- forwarding ----------------------------------------------------

    private void forward(Socket socket, String method, String target,
                         Map<String, String> headers, byte[] body) throws IOException {
        String origin = prefs.getString(KEY_ORIGIN, "");
        if (origin.isEmpty()) {
            ProxyWire.writeJson(socket, 503, "{\"code\":\"proxy.no_upstream\"}");
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
        HttpURLConnection conn = openKernelConnection(uri);
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
            String web = ProxyCookies.webCookie(origin.endsWith("/") ? origin : origin + "/");
            if (!web.isEmpty()) {
                // The Studio page was paired in this app's WebView; its cookie is
                // the device credential the kernel actually minted.
                conn.setRequestProperty("Cookie", web);
            } else {
                cookies.apply(conn, uri);
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
            cookies.store(uri, conn);
            if (contentType != null && contentType.startsWith("text/event-stream")) {
                streamSse(socket, conn, status, contentType);
                return;
            }
            byte[] payload;
            try (InputStream response = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                payload = response == null ? new byte[0] : ProxyWire.readAll(response);
            } catch (ProxyWire.PayloadTooLargeException e) {
                ProxyWire.writeJson(socket, 502, "{\"code\":\"proxy.upstream_too_large\"}");
                return;
            }
            // A redirect or a download is useless if only Content-Type is
            // copied: the WebView follows a Location, and a file needs its name.
            Map<String, String> forwarded = new LinkedHashMap<>();
            copyLocation(conn, forwarded, origin, headers);
            copyHeader(conn, forwarded, "Content-Disposition");
            copyHeader(conn, forwarded, "ETag");
            copyHeader(conn, forwarded, "Last-Modified");
            copyHeader(conn, forwarded, "Cache-Control");
            ProxyWire.writeResponse(socket, status, contentType, payload, forwarded);
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
        if (value == null || value.isEmpty()) return;
        // These arrive verbatim from the kernel over plain HTTP; a header that
        // smuggled a CR or LF would end the line early and inject arbitrary
        // headers into the WebView's loopback origin.
        out.put(name, asciiLine(value));
    }

    /** Strip CR and LF, the characters that would break the response head. */
    private static String asciiLine(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c != '\r' && c != '\n') out.append(c);
        }
        return out.toString();
    }

    /**
     * Keep a Studio WebView on the loopback origin when the kernel redirects.
     *
     * A kernel-absolute Location would send that WebView back to the LAN
     * address, which is exactly the path the loopback proxy exists to avoid
     * (VPN routing, cookies, CSRF Origin). Only the Studio client needs this:
     * the app's own API calls are unaffected.
     */
    private static void copyLocation(HttpURLConnection conn, Map<String, String> out,
                                     String origin, Map<String, String> headers) {
        String value = conn.getHeaderField("Location");
        if (value == null || value.isEmpty()) return;
        value = asciiLine(value);
        out.put("Location", ProxyPaths.isStudio(headers) ? ProxyPaths.studioLocation(value, origin) : value);
    }


    private void streamSse(Socket socket, HttpURLConnection conn, int status, String contentType) {
        OutputStream out = null;
        try {
            out = socket.getOutputStream();
            String head = "HTTP/1.1 " + status + " " + ProxyWire.reason(status) + "\r\n"
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

}
