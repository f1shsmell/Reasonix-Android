package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class CloudWatcherTest {
    private static final class FakeScheduler implements CloudWatcher.Scheduler {
        final List<Runnable> posted = new ArrayList<>();
        final List<Runnable> delayed = new ArrayList<>();

        @Override
        public void post(Runnable runnable) {
            posted.add(runnable);
        }

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            delayed.add(runnable);
        }

        void runPosted() {
            Runnable runnable = posted.remove(0);
            runnable.run();
        }

        void runDelayed() {
            Runnable runnable = delayed.remove(0);
            runnable.run();
        }
    }

    private static final class FakeHost implements CloudWatcher.Host {
        boolean request = true;
        int begins;
        int ends;
        int stops;
        int polls;
        boolean answered;
        int applied;
        CloudSweep.Counts counts = new CloudSweep.Counts(2, 1, 3);

        @Override
        public boolean requestSweep() {
            return request;
        }

        @Override
        public void beginSweep() {
            begins++;
        }

        @Override
        public void endSweep() {
            ends++;
        }

        @Override
        public void stopService() {
            stops++;
        }

        @Override
        public CloudSweep.Counts apply(CloudSnapshot snapshot) {
            applied++;
            return counts;
        }

        @Override
        public void notePoll(boolean answered) {
            polls++;
            this.answered = answered;
        }

        @Override
        public void stateChanged() {
        }

        @Override
        public void log(String message) {
        }
    }

    private static CloudWatcher watcher(FakeHost host, FakeScheduler scheduler) {
        CloudWatcher watcher = new CloudWatcher(host, scheduler);
        watcher.setActive(true);
        return watcher;
    }

    @Test
    public void oneSweepThenATimeoutIsReportedAsAFailure() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        watcher.poll();
        assertEquals(1, host.begins);
        assertTrue(watcher.pending());
        scheduler.runDelayed();

        assertFalse(watcher.pending());
        assertEquals("client.timeout", watcher.lastCode());
        assertEquals(2, host.ends);
        assertEquals(1, host.polls);
        assertFalse(host.answered);
    }

    @Test
    public void twoBridgeMissesStopTheService() {
        FakeHost host = new FakeHost();
        host.request = false;
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        watcher.poll();
        assertEquals(0, host.stops);
        assertEquals("bridge.unavailable", watcher.lastCode());
        watcher.poll();
        assertEquals(1, host.stops);
    }

    @Test
    public void twoTimedOutSweepsStopTheService() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        // A bridge that accepts sweeps but never answers them must not keep
        // the watcher alive: a timeout counts as a miss.
        watcher.poll();
        scheduler.runDelayed();
        assertEquals(0, host.stops);
        watcher.poll();
        scheduler.runDelayed();
        assertEquals(1, host.stops);
    }

    @Test
    public void aSuccessBetweenFailuresResetsTheMisses() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        watcher.poll();
        scheduler.runDelayed();
        watcher.poll();
        watcher.deliver("{\"ok\":true,\"runtimes\":[],\"statuses\":{}}");
        scheduler.runPosted();
        assertEquals(0, host.stops);
        watcher.poll();
        scheduler.runDelayed();
        assertEquals(0, host.stops);
    }

    @Test
    public void aSnapshotLandsTheCountsAndAnswersThePoll() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        watcher.poll();
        watcher.deliver("{\"ok\":true,\"runtimes\":[],\"statuses\":{}}");
        scheduler.runPosted();

        assertEquals(1, host.applied);
        assertEquals("ok", watcher.lastCode());
        assertEquals(2, watcher.lastRuntimes());
        assertEquals(1, watcher.lastStatuses());
        assertEquals(3, watcher.lastAsks());
        assertTrue(host.answered);
        assertEquals(2, host.ends);
    }

    @Test
    public void aSnapshotBeforeAPollIsIgnored() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);

        watcher.deliver("{\"ok\":true,\"runtimes\":[],\"statuses\":{}}");
        scheduler.runPosted();

        assertEquals(0, host.applied);
        assertEquals("", watcher.lastCode());
    }

    @Test
    public void aDeactivatedWatcherDoesNothing() {
        FakeHost host = new FakeHost();
        FakeScheduler scheduler = new FakeScheduler();
        CloudWatcher watcher = watcher(host, scheduler);
        watcher.setActive(false);

        watcher.poll();
        watcher.deliver("{\"ok\":true,\"runtimes\":[],\"statuses\":{}}");
        scheduler.runPosted();

        assertEquals(0, host.applied);
        assertEquals(0, host.begins);
        assertEquals(0, host.stops);
    }
}