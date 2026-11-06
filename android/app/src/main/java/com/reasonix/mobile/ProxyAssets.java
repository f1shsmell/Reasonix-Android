package com.reasonix.mobile;

import android.content.Context;

import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Serves the WebView bundle from the APK; anything else is the kernel's. */
final class ProxyAssets {
    interface Source {
        java.io.InputStream open(String name) throws IOException;
    }

    private final Source source;

    ProxyAssets(Context context) {
        this(name -> context.getAssets().open(name));
    }

    ProxyAssets(Source source) {
        this.source = source;
    }

    boolean serve(Socket socket, String method, String path) throws IOException {
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
        boolean head = "HEAD".equals(method);
        try {
            byte[] bytes;
            try (InputStream stream = source.open("public/" + name)) {
                bytes = head ? new byte[0] : ProxyWire.readAll(stream);
            }
            Map<String, String> extra = new LinkedHashMap<>();
            // Hashed asset names are safe to cache; the entry document is not,
            // or an update would keep loading the old bundle.
            extra.put("Cache-Control", "index.html".equals(name)
                    ? "no-store"
                    : "public, max-age=86400");
            // A HEAD answers the headers only: writing the body would violate
            // the method contract, and a strict client reads the trailing
            // bytes as the start of the next response on a keep-alive socket.
            ProxyWire.writeResponse(socket, 200, contentType(name), bytes, extra);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    static String contentType(String name) {
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
}
