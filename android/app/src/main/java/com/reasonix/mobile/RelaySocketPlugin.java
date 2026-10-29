package com.reasonix.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
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
            .build();
    private WebSocket socket;

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        String origin = call.getString("origin", "https://reasonix.io");
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
        if (socket != null) {
            socket.close(1000, "replaced");
            socket = null;
        }
        Request.Builder builder = new Request.Builder().url(url).header("Origin", origin);
        if (!protocols.isEmpty()) {
            // OkHttp sends this header through to the handshake; the relay
            // requires the ticket-bearing subprotocol.
            builder.header("Sec-WebSocket-Protocol", String.join(", ", protocols));
        }
        socket = client.newWebSocket(builder.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                notifyListeners("open", new JSObject());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                JSObject event = new JSObject();
                event.put("data", text);
                notifyListeners("message", event);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                JSObject event = new JSObject();
                event.put("code", code);
                event.put("reason", reason);
                notifyListeners("close", event);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
                JSObject event = new JSObject();
                event.put("message", failure.getMessage() == null ? "relay socket failed" : failure.getMessage());
                event.put("status", response == null ? 0 : response.code());
                notifyListeners("error", event);
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (socket == null || data == null || !socket.send(data)) {
            call.reject("socket is not open");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (socket != null) {
            socket.close(1000, "closed");
            socket = null;
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (socket != null) socket.close(1000, "destroyed");
        super.handleOnDestroy();
    }
}
