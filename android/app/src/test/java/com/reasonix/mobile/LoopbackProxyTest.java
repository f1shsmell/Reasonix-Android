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
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/account/logout", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/relay/clear", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/config", "GET"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/config", "POST"));
        assertFalse(LoopbackProxy.controlMethodAllowed("/__reasonix/account", "POST"));
        assertTrue(LoopbackProxy.controlMethodAllowed("/__reasonix/account", "GET"));
    }
}
