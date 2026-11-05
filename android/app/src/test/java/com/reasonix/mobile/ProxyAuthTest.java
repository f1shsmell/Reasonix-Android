package com.reasonix.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/** The loopback door: cookie plus origin, before any route is considered. */
public class ProxyAuthTest {
    private static final String ORIGIN = "http://127.0.0.1:8788";
    private static final String SECRET = "a-per-install-secret";

    private static Map<String, String> headers(String... pairs) {
        Map<String, String> out = new HashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            out.put(pairs[index], pairs[index + 1]);
        }
        return out;
    }

    @Test
    public void acceptsTheNativeCookieWithoutAnOrigin() {
        assertTrue(ProxyAuth.authorized(
                headers("cookie", ProxyAuth.PROXY_COOKIE + "=" + SECRET), ORIGIN, SECRET));
    }

    @Test
    public void acceptsTheAppWebViewCookieOnTheLoopbackOrigin() {
        assertTrue(ProxyAuth.authorized(
                headers("cookie", "other=1; " + ProxyAuth.PROXY_COOKIE + "=" + SECRET,
                        "origin", ORIGIN),
                ORIGIN, SECRET));
    }

    @Test
    public void refusesAForeignOriginEvenWithTheRightCookie() {
        assertFalse(ProxyAuth.authorized(
                headers("cookie", ProxyAuth.PROXY_COOKIE + "=" + SECRET,
                        "origin", "http://evil.example"),
                ORIGIN, SECRET));
    }

    @Test
    public void refusesAMissingOrDifferentCookie() {
        assertFalse(ProxyAuth.authorized(headers(), ORIGIN, SECRET));
        assertFalse(ProxyAuth.authorized(
                headers("cookie", ProxyAuth.PROXY_COOKIE + "=not-the-secret"), ORIGIN, SECRET));
        assertFalse(ProxyAuth.authorized(
                headers("cookie", "unrelated=" + SECRET), ORIGIN, SECRET));
    }
}
