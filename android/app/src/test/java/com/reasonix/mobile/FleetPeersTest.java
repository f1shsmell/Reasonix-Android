package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class FleetPeersTest {
    @Test
    public void keepsTheIndexTheReadRoutesUse() {
        List<FleetPeers.Peer> peers = FleetPeers.parse(
                "{\"peers\":["
                        + "{\"kind\":\"lan\",\"target\":\"http://a:56789\",\"name\":\"A\",\"watchable\":true},"
                        + "{\"kind\":\"cloud\",\"target\":\"dev-1\",\"name\":\"Mac\",\"watchable\":false},"
                        + "{\"kind\":\"lan\",\"target\":\"http://b:56789\",\"name\":\"\",\"watchable\":true}]}");

        assertEquals(2, peers.size());
        assertEquals(0, peers.get(0).index);
        assertEquals("http://a:56789", peers.get(0).target);
        assertEquals("A", peers.get(0).name);
        assertEquals(2, peers.get(1).index);
        assertEquals("http://b:56789", peers.get(1).name);
    }

    @Test
    public void dropsUnwatchableAndEmptyRows() {
        List<FleetPeers.Peer> peers = FleetPeers.parse(
                "{\"peers\":["
                        + "{\"kind\":\"cloud\",\"target\":\"dev\",\"watchable\":false},"
                        + "{\"kind\":\"lan\",\"target\":\"\",\"watchable\":true},"
                        + "{\"kind\":\"lan\",\"target\":\"http://a:1\",\"watchable\":false}]}");

        assertTrue(peers.isEmpty());
    }

    @Test
    public void distinguishesAnUnreadableBodyFromNoPeers() {
        assertNull(FleetPeers.parse("not json"));
        assertNull(FleetPeers.parse("{}"));
        assertNull(FleetPeers.parse(""));
        assertNull(FleetPeers.parse(null));
        assertTrue(FleetPeers.parse("{\"peers\":[]}").isEmpty());
    }
}
