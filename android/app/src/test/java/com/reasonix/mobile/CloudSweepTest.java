package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

public class CloudSweepTest {
    private static final class FakeSink implements CloudSweep.Sink {
        final Map<String, PaneWatch> watches = new LinkedHashMap<>();
        final List<String> removed = new ArrayList<>();
        final Map<String, Integer> applied = new LinkedHashMap<>();

        @Override
        public PaneWatch get(String runtimeId) {
            return watches.get(runtimeId);
        }

        @Override
        public PaneWatch create(RuntimeList.Row row) {
            PaneWatch watch = new PaneWatch(
                    row.id, row.id, row.base, row.root, row.title, "", "", row.readOnly);
            watches.put(row.id, watch);
            return watch;
        }

        @Override
        public void update(PaneWatch watch, RuntimeList.Row row) {
            watch.update(row.base, row.root, row.title);
            watch.readOnly = row.readOnly;
        }

        @Override
        public void remove(PaneWatch watch) {
            watches.remove(watch.key);
            removed.add(watch.runtime);
        }

        @Override
        public Collection<PaneWatch> watches() {
            return watches.values();
        }

        @Override
        public void applyStatus(PaneWatch watch, AskStatus status) {
            applied.put(watch.runtime, status.count);
        }
    }

    @Test
    public void createsUpdatesRemovesAndAppliesStatuses() {
        FakeSink sink = new FakeSink();
        sink.watches.put("r1", new PaneWatch("r1", "r1", "/rt/old", "/old", "old", "", "", false));
        sink.watches.put("r3", new PaneWatch("r3", "r3", "/rt/r3", "/gone", "gone", "", "", false));

        CloudSweep.Counts counts = CloudSweep.apply(
                CloudSnapshot.parse(
                        "{\"ok\":true,\"runtimes\":["
                                + "{\"id\":\"r1\",\"base\":\"/rt/new\",\"root\":\"/new\",\"name\":\"one\"},"
                                + "{\"id\":\"r2\",\"base\":\"/rt/r2\",\"root\":\"/two\",\"name\":\"two\"}],"
                                + "\"statuses\":{"
                                + "\"r1\":{\"running\":true,\"decisions\":[]},"
                                + "\"r2\":{\"running\":false,\"decisions\":[{\"id\":\"d1\",\"kind\":\"tool_approval\"}]}}}"),
                sink);

        assertEquals(2, counts.runtimes);
        assertEquals(2, counts.statuses);
        assertEquals(1, counts.asks);
        assertEquals("/rt/new", sink.watches.get("r1").base);
        assertEquals("/new", sink.watches.get("r1").root);
        assertTrue(sink.watches.containsKey("r2"));
        assertEquals(List.of("r3"), sink.removed);
        assertEquals(0, (int) sink.applied.get("r1"));
        assertEquals(1, (int) sink.applied.get("r2"));
        assertFalse(sink.watches.containsKey("r3"));
    }

    @Test
    public void leavesAnUnnamedPaneWithoutAStatusAlone() {
        FakeSink sink = new FakeSink();
        sink.watches.put("r1", new PaneWatch("r1", "r1", "/rt/r1", "/work", "one", "", "", false));

        CloudSweep.Counts counts = CloudSweep.apply(
                CloudSnapshot.parse(
                        "{\"ok\":true,\"runtimes\":[{\"id\":\"r1\",\"base\":\"/rt/r1\",\"root\":\"/work\",\"name\":\"one\"}],"
                                + "\"statuses\":{}}"),
                sink);

        assertEquals(0, counts.asks);
        assertTrue(sink.applied.isEmpty());
        assertTrue(sink.removed.isEmpty());
    }
}