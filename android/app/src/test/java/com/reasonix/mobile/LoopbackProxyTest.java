package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import org.json.JSONObject;
import org.junit.Test;

/** Pure request-parsing checks; no Android runtime is involved. */
public class LoopbackProxyTest {
    private static Map<String, String> headers(String... pairs) {
        Map<String, String> out = new HashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            out.put(pairs[index], pairs[index + 1]);
        }
        return out;
    }

    private static ByteArrayInputStream bytes(String value) {
        return new ByteArrayInputStream(value.getBytes(StandardCharsets.ISO_8859_1));
    }

    @Test
    public void readsAFixedLengthBody() throws Exception {
        byte[] body = LoopbackProxy.readBody(bytes("hello"), headers("content-length", "5"));
        assertEquals("hello", new String(body, StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsAnOversizedFixedBodyBeforeAllocating() {
        assertThrows(LoopbackProxy.PayloadTooLargeException.class, () ->
                LoopbackProxy.readBody(bytes(""), headers("content-length", "40000000")));
    }

    @Test
    public void readsAChunkedBody() throws Exception {
        byte[] body = LoopbackProxy.readBody(
                bytes("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"),
                headers("transfer-encoding", "chunked"));
        assertEquals("Wikipedia", new String(body, StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsAnOversizedChunkBeforeReadingIt() {
        assertThrows(LoopbackProxy.PayloadTooLargeException.class, () ->
                LoopbackProxy.readChunked(bytes("2100000\r\n")));
    }

    @Test
    public void rejectsANegativeChunkSize() {
        assertThrows(IOException.class, () -> LoopbackProxy.readChunked(bytes("-1\r\n")));
    }

    @Test
    public void rejectsAnOverlongHeaderLine() {
        String line = "a".repeat(9000) + "\n";
        assertThrows(IOException.class, () -> LoopbackProxy.readLine(bytes(line)));
    }

    @Test
    public void stateChangingControlRoutesArePostOnly() {
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/account/logout", "GET"));
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/relay/clear", "GET"));
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/refresh", "GET"));
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/fleet", "DELETE"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/account/logout", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/relay/clear", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/config", "GET"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/config", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/fleet", "GET"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/fleet", "POST"));
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/account", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/account", "GET"));
    }

    // ---- fleet route parsing -------------------------------------------

    @Test
    public void fleetRouteKeepsTheKernelPathAndQuery() {
        assertEquals("/runtimes", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/runtimes"));
        assertEquals("/tree?scope=active&limit=60",
                LoopbackProxy.fleetKernelPath("/__reasonix/fleet/0/tree?scope=active&limit=60"));
        assertEquals("/rt/ab12/status",
                LoopbackProxy.fleetKernelPath("/__reasonix/fleet/2/rt/ab12/status"));
        assertEquals(1, LoopbackProxy.fleetPeerIndex("/__reasonix/fleet/1/runtimes"));
    }

    @Test
    public void fleetRouteRefusesControlPathsAndTraversal() {
        assertEquals("", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/__reasonix/config"));
        assertEquals("", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/../secret"));
        assertEquals("", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/runtimes/../pair"));
        assertEquals("", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1"));
        // A kernel may decode percent escapes before routing, so the encoded
        // forms are refused on their decoded shape.
        assertEquals("", LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/%2e%2e/secret"));
        assertEquals("",
                LoopbackProxy.fleetKernelPath("/__reasonix/fleet/1/%5F%5Freasonix%2Fconfig"));
    }

    @Test
    public void fleetRouteRefusesAnUnusableIndex() {
        assertEquals(-1, LoopbackProxy.fleetPeerIndex("/__reasonix/fleet/abc/runtimes"));
        assertEquals(-1, LoopbackProxy.fleetPeerIndex("/__reasonix/fleet//runtimes"));
    }

    @Test
    public void devicePollFailuresKeepTheServicesCodes() throws Exception {
        JSONObject expired = LoopbackProxy.pollFailure(
                "{\"error\":{\"code\":\"expired_token\",\"message\":\"expired\"}}");
        assertEquals("ended", expired.getString("status"));
        assertEquals("expired_token", expired.getString("code"));

        JSONObject denied = LoopbackProxy.pollFailure(
                "{\"error\":{\"code\":\"access_denied\"}}");
        assertEquals("ended", denied.getString("status"));

        JSONObject invalid = LoopbackProxy.pollFailure(
                "{\"error\":{\"code\":\"invalid_grant\"}}");
        assertEquals("error", invalid.getString("status"));
        assertEquals("invalid_grant", invalid.getString("code"));

        // A shape from an older service still reads.
        assertEquals("ended", LoopbackProxy.pollFailure("{\"code\":\"expired_token\"}")
                .getString("status"));
        assertEquals("", LoopbackProxy.pollFailure("not json").getString("code"));
    }
}
