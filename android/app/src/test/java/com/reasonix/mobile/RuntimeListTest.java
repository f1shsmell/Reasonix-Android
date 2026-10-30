package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class RuntimeListTest {
    @Test
    public void readsThePanesAStatusIsAddressedTo() {
        List<RuntimeList.Row> rows = RuntimeList.parse(
                "[{\"id\":\"r1\",\"base\":\"/rt/r1\",\"root\":\"C:\\\\work\","
                        + "\"name\":\"app\",\"sessionPath\":\"C:\\\\work\\\\.reasonix\\\\one.jsonl\","
                        + "\"readOnly\":true},"
                        + "{\"id\":\"r2\",\"base\":\"/rt/r2\",\"root\":\"/work/docs\",\"name\":\"docs\"}]");

        assertEquals(2, rows.size());
        assertEquals("r1", rows.get(0).id);
        assertEquals("/rt/r1", rows.get(0).base);
        assertEquals("one.jsonl", rows.get(0).title);
        assertTrue(rows.get(0).readOnly);
        assertEquals("docs", rows.get(1).title);
        assertFalse(rows.get(1).readOnly);
    }

    @Test
    public void dropsRowsWithoutAnAddress() {
        List<RuntimeList.Row> rows = RuntimeList.parse(
                "[{\"id\":\"r1\"},{\"base\":\"/rt/r2\"},{\"id\":\"r3\",\"base\":\"/rt/r3\"}]");

        assertEquals(1, rows.size());
        assertEquals("r3", rows.get(0).id);
    }

    @Test
    public void distinguishesAnUnreadableBodyFromNoPanes() {
        assertNull(RuntimeList.parse("not json"));
        assertNull(RuntimeList.parse("{}"));
        assertNull(RuntimeList.parse(""));
        assertNull(RuntimeList.parse(null));
        assertTrue(RuntimeList.parse("[]").isEmpty());
    }

    @Test
    public void titlesFallBackToTheProjectName() {
        assertEquals("app", RuntimeList.titleOf("", "app"));
        assertEquals("app", RuntimeList.titleOf("C:\\work\\", "app"));
        assertEquals("b.jsonl", RuntimeList.titleOf("/work/b.jsonl", "app"));
    }
}
