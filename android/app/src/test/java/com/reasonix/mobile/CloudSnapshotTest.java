package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CloudSnapshotTest {
    private static final String SNAPSHOT =
            "{\"ok\":true,\"runtimes\":[{\"id\":\"r1\",\"base\":\"/rt/r1\","
                    + "\"root\":\"/work\",\"name\":\"app\",\"sessionPath\":\"/work/.reasonix/a.jsonl\","
                    + "\"readOnly\":false}],"
                    + "\"statuses\":{\"r1\":{\"running\":true,\"decisions\":[]}}}";

    @Test
    public void readsPanesAndStatuses() {
        CloudSnapshot snapshot = CloudSnapshot.parse(SNAPSHOT);

        assertTrue(snapshot.ok);
        assertEquals(1, snapshot.runtimes.size());
        RuntimeList.Row row = snapshot.runtimes.get(0);
        assertEquals("r1", row.id);
        assertEquals("/rt/r1", row.base);
        assertEquals("a.jsonl", row.title);
        assertEquals(1, snapshot.statuses.size());
        assertTrue(AskStatus.parse(snapshot.statuses.get("r1")).running);
    }

    @Test
    public void keepsAFailedSweepAsItsCode() {
        CloudSnapshot snapshot = CloudSnapshot.parse("{\"ok\":false,\"code\":\"relay.offline\"}");

        assertFalse(snapshot.ok);
        assertEquals("relay.offline", snapshot.code);
        assertTrue(snapshot.runtimes.isEmpty());
        assertTrue(snapshot.statuses.isEmpty());
    }

    @Test
    public void treatsAnUnreadableAnswerAsAFailure() {
        assertFalse(CloudSnapshot.parse("not json").ok);
        assertFalse(CloudSnapshot.parse("").ok);
        assertFalse(CloudSnapshot.parse("{\"ok\":true,\"runtimes\":\"nope\"}").ok);
        // A truncated success must not be read as "the computer has no panes":
        // that would clear every open ask.
        assertFalse(CloudSnapshot.parse("{\"ok\":true,\"statuses\":{}}").ok);
    }

    @Test
    public void acceptsAnEmptyListAsARealAnswer() {
        CloudSnapshot snapshot = CloudSnapshot.parse("{\"ok\":true,\"runtimes\":[],\"statuses\":{}}");

        assertTrue(snapshot.ok);
        assertTrue(snapshot.runtimes.isEmpty());
        assertTrue(snapshot.statuses.isEmpty());
    }
}
