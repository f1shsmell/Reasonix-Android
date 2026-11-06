package com.reasonix.mobile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP/1.1 framing for the loopback proxy.
 *
 * Kept out of the server so the parsing rules — bounded headers, bounded
 * bodies, chunked uploads, 204/304 without a length — can be tested without a
 * socket.
 */
final class ProxyWire {
    private ProxyWire() {}

    /** A 10 MB image becomes ~13.3 MB of base64 inside a JSON envelope. */
    static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    static final int MAX_HEADER_LINE = 8192;
    /** Total request-head bounds, enforced before authentication. */
    static final int MAX_HEADER_LINES = 100;
    static final int MAX_HEADER_BYTES = 64 * 1024;

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
            if (got < 0) throw new BodyTruncatedException();
            read += got;
        }
        return body;
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

    /** The stream ended before Content-Length said it would. */
    static final class BodyTruncatedException extends IOException {
        BodyTruncatedException() {
            super("request body ended early");
        }
    }

    /**
     * Responses buffer whole before they are written to the socket. A request
     * body is capped at read time, but nothing capped the upstream's answer:
     * one large artifact fetched through the in-app Studio page buffered to an
     * OOM. The buffer and its final copy cost roughly twice the bound, so
     * 16 MB keeps the peak well inside a phone heap; past it the transfer is
     * refused rather than half-kept — a phone that needs a bigger file opens
     * it in the system browser, which streams it instead of holding it.
     */
    static final long MAX_UPSTREAM_BYTES = 16L * 1024 * 1024;

    static byte[] readAll(InputStream in) throws IOException {
        return readAll(in, MAX_UPSTREAM_BYTES);
    }

    static byte[] readAll(InputStream in, long maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) != -1) {
            total += n;
            if (total > maxBytes) throw new PayloadTooLargeException();
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    static String readText(HttpURLConnection conn) throws IOException {
        InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        return in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
    }

    static void writeJson(Socket socket, int status, String json) throws IOException {
        writeResponse(socket, status, "application/json; charset=utf-8",
                json.getBytes(StandardCharsets.UTF_8));
    }

    static void writeResponse(Socket socket, int status, String contentType, byte[] payload)
            throws IOException {
        writeResponse(socket, status, contentType, payload, null);
    }

    static void writeResponse(Socket socket, int status, String contentType, byte[] payload,
                              Map<String, String> extra) throws IOException {
        write(socket, status, contentType, payload.length, payload, extra);
    }

    /** A HEAD answer: the GET headers, including its length, without the body. */
    static void writeHead(Socket socket, int status, String contentType, long contentLength,
                          Map<String, String> extra) throws IOException {
        write(socket, status, contentType, contentLength, null, extra);
    }

    private static void write(Socket socket, int status, String contentType, long contentLength,
                              byte[] payload, Map<String, String> extra) throws IOException {
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
        // A 204 must not carry Content-Length (RFC 9110 §8.6): some clients
        // read it as "a body of that length follows" and hang.
        if (status != 204 && status != 304) {
            head.append("Content-Length: ").append(contentLength).append("\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (payload != null) out.write(payload);
        out.flush();
    }

    static void methodNotAllowed(Socket socket) throws IOException {
        writeJson(socket, 405, "{\"code\":\"request.method_not_allowed\"}");
    }

    static String reason(int status) {
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
            case 429: return "Too Many Requests";
            case 431: return "Request Header Fields Too Large";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Response";
        }
    }
}
