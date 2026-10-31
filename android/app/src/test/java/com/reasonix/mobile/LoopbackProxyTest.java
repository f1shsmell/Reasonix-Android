package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import org.json.JSONArray;
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
    public void classifiesLanTargetsForNetworkBinding() {
        assertNotNull(LoopbackProxy.lanTarget("192.168.1.20"));
        assertNotNull(LoopbackProxy.lanTarget("10.0.2.2"));
        assertNotNull(LoopbackProxy.lanTarget("172.16.4.8"));
        assertNotNull(LoopbackProxy.lanTarget("127.0.0.1"));
        assertNotNull(LoopbackProxy.lanTarget("fe80::1"));
        assertNotNull(LoopbackProxy.lanTarget("fd00::1"));
        assertNull(LoopbackProxy.lanTarget("8.8.8.8"));
        assertNull(LoopbackProxy.lanTarget("2001:4860:4860::8888"));
        assertNull(LoopbackProxy.lanTarget(""));
    }

    /**
     * The Wi-Fi detour is decided per subnet, not per "is this private": a
     * mesh VPN's 172.16.x address is private but is not a neighbour of the
     * Wi-Fi link, and pinning it there is a route that cannot work.
     */
    @Test
    public void bindsOnlyTargetsOnTheLinksOwnSubnet() throws Exception {
        InetAddress wifi = InetAddress.getByName("192.168.5.3");
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("192.168.5.2"), wifi, 24));
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("192.168.5.3"), wifi, 24));
        // The share on another subnet is still private, but not a neighbour.
        assertFalse(LoopbackProxy.inSubnet(InetAddress.getByName("192.168.7.9"), wifi, 24));

        // A Pgy (蒲公英) tunnel address beside that Wi-Fi.
        InetAddress pgy = InetAddress.getByName("172.16.2.59");
        assertFalse(LoopbackProxy.inSubnet(pgy, wifi, 24));
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("172.16.3.7"), pgy, 23));
        assertFalse(LoopbackProxy.inSubnet(InetAddress.getByName("172.16.4.7"), pgy, 23));

        // A /31 has one host bit, a /32 is a single address, a /0 is everything.
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("10.0.0.1"), InetAddress.getByName("10.0.0.0"), 31));
        assertFalse(LoopbackProxy.inSubnet(InetAddress.getByName("10.0.0.2"), InetAddress.getByName("10.0.0.0"), 31));
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("10.0.0.0"), 0));
        assertTrue(LoopbackProxy.inSubnet(InetAddress.getByName("10.0.0.0"), InetAddress.getByName("10.0.0.0"), 32));
        assertFalse(LoopbackProxy.inSubnet(InetAddress.getByName("10.0.0.1"), InetAddress.getByName("10.0.0.0"), 32));
    }

    @Test
    public void aSubnetCheckRefusesMixedAndMalformedFamilies() throws Exception {
        assertFalse(LoopbackProxy.inSubnet(
                InetAddress.getByName("192.168.5.2"), InetAddress.getByName("fe80::1"), 24));
        assertFalse(LoopbackProxy.inSubnet(
                InetAddress.getByName("192.168.5.2"), InetAddress.getByName("192.168.5.3"), -1));
        assertFalse(LoopbackProxy.inSubnet(null, InetAddress.getByName("192.168.5.3"), 24));
        assertFalse(LoopbackProxy.inSubnet(InetAddress.getByName("192.168.5.2"), null, 24));
    }

    /**
     * The same computer behind two doors: the Wi-Fi one is tried first, even
     * when the tunnel address is the newer pairing.
     */
    @Test
    public void prefersTheDirectDoorWithoutLosingTheOthers() {
        JSONArray saved = new JSONArray()
                .put("http://172.16.2.59:57074")
                .put("http://192.168.5.3:57074")
                .put("http://172.16.2.60:57074");

        JSONArray ordered = LoopbackProxy.preferredFirst(
                saved, (origin) -> LoopbackProxy.hostOf(origin).startsWith("192.168."));

        assertEquals(
                "[\"http://192.168.5.3:57074\",\"http://172.16.2.59:57074\",\"http://172.16.2.60:57074\"]",
                ordered.toString());
    }

    @Test
    public void aDirectDoorWithNoNeighboursKeepsTheOriginalOrder() {
        JSONArray saved = new JSONArray()
                .put("http://172.16.2.59:57074")
                .put("http://10.8.0.4:57074");

        JSONArray ordered = LoopbackProxy.preferredFirst(saved, (origin) -> false);

        assertEquals(saved.toString(), ordered.toString());
    }

    @Test
    public void anEmptyCandidateListStaysEmpty() {
        assertEquals("[]", LoopbackProxy.preferredFirst(new JSONArray(), (origin) -> true).toString());
        // A blank entry is dropped rather than becoming a door with no address.
        assertEquals(
                "[\"http://192.168.5.3:1\"]",
                LoopbackProxy
                        .preferredFirst(new JSONArray().put("").put("http://192.168.5.3:1"), (origin) -> true)
                        .toString());
    }

    @Test
    public void readsTheHostOutOfAnOrigin() {
        assertEquals("192.168.5.3", LoopbackProxy.hostOf("http://192.168.5.3:57074"));
        assertEquals("172.16.2.59", LoopbackProxy.hostOf("http://172.16.2.59"));
        assertEquals("", LoopbackProxy.hostOf(""));
        assertEquals("", LoopbackProxy.hostOf("not a url"));
    }

    /**
     * An ordering names every door, so it cannot answer "which of these is
     * direct" — that needs the subset, and a UI that confused the two would
     * label the tunnel address as fast.
     */
    @Test
    public void theOrderIsNotTheDirectSubset() {
        JSONArray saved = new JSONArray()
                .put("http://172.16.2.59:57074")
                .put("http://192.168.5.3:57074");
        java.util.function.Predicate<String> direct =
                (origin) -> LoopbackProxy.hostOf(origin).startsWith("192.168.");

        JSONArray ordered = LoopbackProxy.preferredFirst(saved, direct);

        assertEquals(2, ordered.length());
        assertEquals(1, countWhere(ordered, direct));
    }

    private static int countWhere(JSONArray list, java.util.function.Predicate<String> test) {
        int n = 0;
        for (int i = 0; i < list.length(); i++) {
            if (test.test(list.optString(i, ""))) n++;
        }
        return n;
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
