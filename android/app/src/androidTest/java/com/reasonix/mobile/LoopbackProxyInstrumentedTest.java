package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The loopback proxy is the app's only local port; a foreign app must not read
 * or change the kernel connection through it.
 */
@RunWith(AndroidJUnit4.class)
public class LoopbackProxyInstrumentedTest {
    private static final String CONFIG = "/__reasonix/config";

    @Test
    public void servesOnlyTheAppWithTheLoopbackCookie() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        LoopbackProxy.start(context);
        String target = "http://127.0.0.1:" + LoopbackProxy.PORT + CONFIG;
        String cookie = LoopbackProxy.authCookie(context);

        assertEquals(403, get(target, null, null));
        assertEquals(200, get(target, cookie, null));
        assertEquals(403, get(target, cookie, "http://evil.example"));
    }

    @Test
    public void allowsTheNativeWriterButRejectsAForeignOrigin() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        LoopbackProxy.start(context);
        String target = "http://127.0.0.1:" + LoopbackProxy.PORT + "/runtimes";
        String cookie = LoopbackProxy.authCookie(context);
        String loopback = "http://127.0.0.1:" + LoopbackProxy.PORT;

        // The foreground service is the app itself; it may name no origin.
        assertNotEquals(403, request(target, cookie, null, "POST"));
        assertNotEquals(403, request(target, cookie, loopback, "POST"));
        assertEquals(403, request(target, cookie, "http://evil.example", "POST"));
    }

    private static int get(String target, String cookie, String origin) throws Exception {
        return request(target, cookie, origin, "GET");
    }

    private static int request(String target, String cookie, String origin, String method)
            throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
        try {
            connection.setConnectTimeout(3_000);
            connection.setReadTimeout(3_000);
            connection.setRequestMethod(method);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (origin != null) connection.setRequestProperty("Origin", origin);
            if ("POST".equals(method)) connection.setDoOutput(true);
            int code = connection.getResponseCode();
            try (InputStream body = code >= 400
                    ? connection.getErrorStream() : connection.getInputStream()) {
                // Drain so the connection can be reused or closed cleanly.
                if (body != null) {
                    byte[] buffer = new byte[4096];
                    while (body.read(buffer) != -1) {
                        // no content is needed
                    }
                }
            }
            return code;
        } finally {
            connection.disconnect();
        }
    }
}
