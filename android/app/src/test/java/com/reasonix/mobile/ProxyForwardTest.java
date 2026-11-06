package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import org.json.JSONObject;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.io.BufferedReader;
import java.net.Socket;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class ProxyForwardTest {
    static {
        // HttpURLConnection silently drops Origin unless this is set.
        System.setProperty("sun.net.http.allowRestrictedHeaders", "true");
    }

    private static FakeUpstream upstream;
    private static String cookie;

    @Before
    public void setUp() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        assertTrue("loopback proxy did not start", LoopbackProxy.start(context));
        if (cookie == null) cookie = LoopbackProxy.authCookie(context);
        if (upstream == null) upstream = new FakeUpstream();
        assertEquals(200, postConfig(upstream.origin()));
    }

    @AfterClass
    public static void stop() {
        if (upstream != null) upstream.close();
    }

    private static String base() {
        return "http://127.0.0.1:" + LoopbackProxy.PORT;
    }

    private static HttpURLConnection open(String path, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base() + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(5000);
        return connection;
    }

    private static int postConfig(String origin) throws Exception {
        HttpURLConnection connection = open("/__reasonix/config", "POST");
        connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("Origin", base());
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        byte[] body = new JSONObject().put("origin", origin).toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body);
        }
        int status = connection.getResponseCode();
        try (InputStream in = status >= 400
                ? connection.getErrorStream() : connection.getInputStream()) {
            if (in != null) {
                while (in.read() != -1) {
                    // drain
                }
            }
        } finally {
            connection.disconnect();
        }
        return status;
    }

    private static String get(String path, String withCookie, String origin) throws Exception {
        HttpURLConnection connection = open(path, "GET");
        if (withCookie != null) connection.setRequestProperty("Cookie", withCookie);
        if (origin != null) connection.setRequestProperty("Origin", origin);
        int status = connection.getResponseCode();
        if (status >= 400) {
            connection.disconnect();
            return "status:" + status;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = connection.getInputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        } finally {
            connection.disconnect();
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    @Test
    public void refusesALocalSocketWithoutTheLoopbackCookie() throws Exception {
        assertEquals("status:403", get("/runtimes", null, null));
    }

    @Test
    public void servesTheAppBundleBeforeTheCookieButNotTheKernel() throws Exception {
        assertEquals(200, rawStatus("/index.html", null, null));
        assertEquals(403, rawStatus("/runtimes", null, null));
    }

    @Test
    public void refusesAForeignOrigin() throws Exception {
        // Raw socket: HttpURLConnection can drop a restricted Origin header,
        // which made this test pass locally and lie on CI.
        assertEquals(403, rawStatus("/runtimes", cookie, "http://evil.example"));
    }

    private static int rawStatus(String path, String withCookie, String origin) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", LoopbackProxy.PORT)) {
            StringBuilder request = new StringBuilder()
                    .append("GET ").append(path).append(" HTTP/1.1\r\n")
                    .append("Host: 127.0.0.1\r\n")
                    .append("Connection: close\r\n");
            if (withCookie != null) request.append("Cookie: ").append(withCookie).append("\r\n");
            if (origin != null) request.append("Origin: ").append(origin).append("\r\n");
            request.append("\r\n");
            OutputStream out = socket.getOutputStream();
            out.write(request.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
            String status = reader.readLine();
            return status == null ? 0 : Integer.parseInt(status.split(" ")[1]);
        }
    }

    @Test
    public void forwardsAnAuthorizedKernelRead() throws Exception {
        String body = get("/runtimes", cookie, base());
        assertTrue(body, body.contains("\"id\":\"up\""));
        assertTrue(body, body.contains("/rt/up"));
    }

    @Test
    public void relaysTheEventStream() throws Exception {
        String body = get("/rt/up/events", cookie, base());
        assertTrue(body, body.contains("data:"));
        assertTrue(body, body.contains("hello"));
    }

    private static final class FakeUpstream implements Runnable {
        private final ServerSocket server;
        private final Thread thread;

        FakeUpstream() throws IOException {
            server = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(this, "proxy-test-upstream");
            thread.setDaemon(true);
            thread.start();
        }

        String origin() {
            return "http://127.0.0.1:" + server.getLocalPort();
        }

        @Override
        public void run() {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
                    String request = reader.readLine();
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        // Drain the headers.
                    }
                    String path = request == null ? "" : request.split(" ")[1];
                    if ("/runtimes".equals(path)) {
                        write(socket, "application/json",
                                "[{\"id\":\"up\",\"base\":\"/rt/up\",\"root\":\"/up\",\"name\":\"up\"}]");
                    } else if ("/rt/up/events".equals(path)) {
                        write(socket, "text/event-stream", "data: {\"kind\":\"text\",\"text\":\"hello\"}\n\n");
                    } else {
                        write(socket, "application/json", "{}");
                    }
                } catch (IOException ignored) {
                    // The test closed the listener.
                }
            }
        }

        private static void write(Socket socket, String type, String body) throws IOException {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            OutputStream out = socket.getOutputStream();
            out.write(("HTTP/1.1 200 OK\r\n"
                    + "Content-Type: " + type + "\r\n"
                    + "Content-Length: " + payload.length + "\r\n"
                    + "Connection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.write(payload);
            out.flush();
        }

        void close() {
            try {
                server.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }
}