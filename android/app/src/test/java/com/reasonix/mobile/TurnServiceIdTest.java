package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TurnServiceIdTest {
    @Test
    public void oneRuntimeKeepsOneStableIdentity() {
        assertEquals(TurnNotificationIds.askId("rt-1"), TurnNotificationIds.askId("rt-1"));
        assertEquals(TurnNotificationIds.doneId("rt-1"), TurnNotificationIds.doneId("rt-1"));
        assertEquals(TurnNotificationIds.askRequest("rt-1"), TurnNotificationIds.askRequest("rt-1"));
        assertEquals(TurnNotificationIds.doneRequest("rt-1"), TurnNotificationIds.doneRequest("rt-1"));
    }

    @Test
    public void neighbouringRuntimesDoNotShareANotification() {
        assertNotEquals(TurnNotificationIds.sessionBucket("rt-a"), TurnNotificationIds.sessionBucket("rt-b"));
        assertNotEquals(TurnNotificationIds.askId("rt-a"), TurnNotificationIds.askId("rt-b"));
        assertNotEquals(TurnNotificationIds.doneId("rt-a"), TurnNotificationIds.doneId("rt-b"));
    }

    @Test
    public void everyRangeStaysInsideItsOwnBand() {
        String[] runtimes = {"", "rt-1", "rt-b", "a-very-long-runtime-id"};
        for (String runtime : runtimes) {
            int bucket = TurnNotificationIds.sessionBucket(runtime);
            assertTrue(bucket >= 0 && bucket < TurnNotificationIds.SESSION_BUCKETS);
            assertInBand(TurnNotificationIds.askId(runtime), TurnNotificationIds.ASK_BASE);
            assertInBand(TurnNotificationIds.doneId(runtime), TurnNotificationIds.DONE_BASE);
            assertInBand(TurnNotificationIds.askRequest(runtime), TurnNotificationIds.REQUEST_ASK_BASE);
            assertInBand(TurnNotificationIds.doneRequest(runtime), TurnNotificationIds.REQUEST_DONE_BASE);
        }
    }

    @Test
    public void anEmptyOrNullRuntimeUsesTheZeroBucket() {
        assertEquals(0, TurnNotificationIds.sessionBucket(""));
        assertEquals(0, TurnNotificationIds.sessionBucket(null));
    }

    private static void assertInBand(int value, int base) {
        assertTrue(value >= base && value < base + TurnNotificationIds.SESSION_BUCKETS);
    }
}
