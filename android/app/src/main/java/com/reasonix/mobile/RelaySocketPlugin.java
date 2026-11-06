package com.reasonix.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The relay's WebSocket, dialled from native code.
 *
 * The relay rejects a WebSocket whose Origin is the app's loopback page
 * (`origin_rejected`); the browser cannot override that header, and the
 * desktop page is only allowed because its Origin is reasonix.io. OkHttp can
 * send the allowed Origin explicitly, while the encrypted protocol stays in
 * the WebView. Only the transport moves.
 */
@CapacitorPlugin(name = "RelaySocket")
public class RelaySocketPlugin extends Plugin {
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            // The link carries requests, not a byte stream, so it can sit
            // silent for a long time. A dead route (sleep, NAT expiry) never
            // raises TCP error on its own; a missed Pong is what reports it.
            .pingInterval(20, TimeUnit.SECONDS)
            .build();
    /**
     * Every connection the page has dialed, keyed by its tag. Capacitor
     * broadcasts an event to every listener ever registered, so each event
     * carries its tag; without that a slow close from a replaced socket
     * would arrive at the socket that replaced it and read as that one's
     * failure.
     */
    private final Map<Integer, WebSocket> sockets = new ConcurrentHashMap<>();
    /**
     * A page reload orphans the previous generation's socket: nothing on the
     * new page knows its tag, and OkHttp's ping keeps it healthy forever, so
     * it would hold a live relay session (and battery) until process death.
     * The page cannot name its generation, so every dial reaps every other
     * tag. The page's socket protocol is one live link per page — a new dial
     * names a fresh tag only after its previous socket closed or failed — and
     * the one coexistence the protocol allows (a device switch opens the new
     * link before closing the old) ends with the old link closed anyway, so
     * an early reap changes which side sends the close, not the outcome.
     */
    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        String origin = call.getString("origin", "https://reasonix.io");
        Integer tag = tagOf(call);
        JSArray array = call.getArray("protocols");
        List<String> protocols = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                String protocol = array.optString(i, "");
                if (!protocol.isEmpty()) protocols.add(protocol);
            }
        }
        if (url == null || url.isEmpty()) {
            call.reject("missing url");
            return;
        }
        for (Map.Entry<Integer, WebSocket> stale : sockets.entrySet()) {
            if (stale.getKey().equals(tag)) continue;
            stale.getValue().close(1000, "orphaned");
        }
        sockets.keySet().retainAll(java.util.Collections.singleton(tag));
        WebSocket previous = sockets.remove(tag);
        if (previous != null) {
            previous.close(1000, "replaced");
        }
        Request.Builder builder = new Request.Builder().url(url).header("Origin", origin);
        if (!protocols.isEmpty()) {
            // OkHttp sends this header through to the handshake; the relay
            // requires the ticket-bearing subprotocol.
            builder.header("Sec-WebSocket-Protocol", String.join(", ", protocols));
        }
        WebSocket webSocket = client.newWebSocket(builder.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                notifyTagged("open", tag, new JSObject());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                JSObject event = new JSObject();
                event.put("data", text);
                notifyTagged("message", tag, event);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                JSObject event = new JSObject();
                event.put("code", code);
                event.put("reason", reason);
                notifyTagged("close", tag, event);
                sockets.remove(tag, webSocket);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
                JSObject event = new JSObject();
                event.put("message", failure.getMessage() == null ? "relay socket failed" : failure.getMessage());
                event.put("status", response == null ? 0 : response.code());
                notifyTagged("error", tag, event);
                sockets.remove(tag, webSocket);
            }
        });
        sockets.put(tag, webSocket);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        WebSocket socket = sockets.get(tagOf(call));
        String data = call.getString("data");
        if (socket == null || data == null || !socket.send(data)) {
            call.reject("socket is not open");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        WebSocket socket = sockets.remove(tagOf(call));
        if (socket != null) {
            socket.close(1000, "closed");
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket socket : sockets.values()) {
            socket.close(1000, "destroyed");
        }
        sockets.clear();
        super.handleOnDestroy();
    }

    private static Integer tagOf(PluginCall call) {
        Object raw = call.getData().opt("tag");
        return raw instanceof Number ? Integer.valueOf(((Number) raw).intValue()) : Integer.valueOf(0);
    }

    /** An event addressed to one connection, not broadcast to all of them. */
    private void notifyTagged(String event, Integer tag, JSObject payload) {
        payload.put("tag", tag);
        notifyListeners(event, payload);
    }
}
