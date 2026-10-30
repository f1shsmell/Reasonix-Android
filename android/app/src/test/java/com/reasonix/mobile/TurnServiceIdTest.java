package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TurnServiceIdTest {
    @Test
    public void oneRuntimeKeepsOneStableIdentity() {
        assertEquals(TurnService.askId("rt-1"), TurnService.askId("rt-1"));
        assertEquals(TurnService.doneId("rt-1"), TurnService.doneId("rt-1"));
        assertEquals(TurnService.askRequest("rt-1"), TurnService.askRequest("rt-1"));
        assertEquals(TurnService.doneRequest("rt-1"), TurnService.doneRequest("rt-1"));
    }

    @Test
    public void neighbouringRuntimesDoNotShareANotification() {
        assertNotEquals(TurnService.sessionBucket("rt-a"), TurnService.sessionBucket("rt-b"));
        assertNotEquals(TurnService.askId("rt-a"), TurnService.askId("rt-b"));
        assertNotEquals(TurnService.doneId("rt-a"), TurnService.doneId("rt-b"));
    }

    @Test
    public void everyRangeStaysInsideItsOwnBand() {
        String[] runtimes = {"", "rt-1", "rt-b", "a-very-long-runtime-id"};
        for (String runtime : runtimes) {
            int bucket = TurnService.sessionBucket(runtime);
            assertTrue(bucket >= 0 && bucket < TurnService.SESSION_BUCKETS);
            assertInBand(TurnService.askId(runtime), TurnService.ASK_BASE);
            assertInBand(TurnService.doneId(runtime), TurnService.DONE_BASE);
            assertInBand(TurnService.askRequest(runtime), TurnService.REQUEST_ASK_BASE);
            assertInBand(TurnService.doneRequest(runtime), TurnService.REQUEST_DONE_BASE);
        }
    }

    @Test
    public void anEmptyOrNullRuntimeUsesTheZeroBucket() {
        assertEquals(0, TurnService.sessionBucket(""));
        assertEquals(0, TurnService.sessionBucket(null));
    }

    private static void assertInBand(int value, int base) {
        assertTrue(value >= base && value < base + TurnService.SESSION_BUCKETS);
    }
}
