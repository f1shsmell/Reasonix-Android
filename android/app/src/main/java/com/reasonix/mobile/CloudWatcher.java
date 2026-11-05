package com.reasonix.mobile;

/**
 * The cloud sweep state machine: one request in flight, one timeout, two
 * bridge misses before the service stops.
 *
 * Scheduling is injected so the transitions can be tested without a Handler;
 * the service still owns the wake lock and the notification state.
 */
final class CloudWatcher {
    interface Scheduler {
        void post(Runnable runnable);

        void postDelayed(Runnable runnable, long delayMs);
    }

    interface Host {
        boolean requestSweep();

        void beginSweep();

        void endSweep();

        void stopService();

        CloudSweep.Counts apply(CloudSnapshot snapshot);

        void notePoll(boolean answered);

        void stateChanged();

        void log(String message);
    }

    static final long POLL_MS = 60_000L;
    static final long TIMEOUT_MS = 20_000L;
    static final long WAKE_DELAY_MS = 500L;

    private final Host host;
    private final Scheduler scheduler;
    private volatile boolean active;
    private boolean pending;
    private int generation;
    private int misses;
    private String lastCode = "";
    private long lastAt;
    private int lastRuntimes;
    private int lastStatuses;
    private int lastAsks;

    CloudWatcher(Host host, Scheduler scheduler) {
        this.host = host;
        this.scheduler = scheduler;
    }

    synchronized void setActive(boolean next) {
        if (next == active) return;
        active = next;
        pending = false;
        generation++;
        misses = 0;
        host.endSweep();
    }

    synchronized boolean active() {
        return active;
    }

    synchronized void poll() {
        if (!active || pending) return;
        if (!host.requestSweep()) {
            lastCode = "bridge.unavailable";
            lastAt = System.currentTimeMillis();
            zeroCounts();
            if (++misses >= 2) host.stopService();
            else host.stateChanged();
            return;
        }
        pending = true;
        int id = ++generation;
        host.beginSweep();
        scheduler.postDelayed(() -> timeout(id), TIMEOUT_MS);
    }

    /** The app just went to the background; do not wait out the next minute. */
    void pollSoon() {
        if (active) scheduler.postDelayed(this::poll, WAKE_DELAY_MS);
    }

    /** The WebView's result bridge; called on its own thread. */
    void deliver(String json) {
        scheduler.post(() -> handle(json));
    }

    private synchronized void timeout(int id) {
        if (!active || !pending || id != generation) return;
        pending = false;
        host.endSweep();
        lastCode = "client.timeout";
        lastAt = System.currentTimeMillis();
        zeroCounts();
        misses = 0;
        host.log("cloud sweep timed out");
        host.notePoll(false);
        host.stateChanged();
    }

    private synchronized void handle(String json) {
        if (!active || !pending) return;
        pending = false;
        host.endSweep();
        CloudSnapshot snapshot = CloudSnapshot.parse(json);
        lastAt = System.currentTimeMillis();
        lastCode = snapshot.ok ? "ok" : (snapshot.code.isEmpty() ? "watch.failed" : snapshot.code);
        if (!snapshot.ok) {
            zeroCounts();
            host.log("cloud sweep failed: " + lastCode);
            misses = 0;
            host.notePoll(false);
            host.stateChanged();
            return;
        }
        CloudSweep.Counts counts = host.apply(snapshot);
        lastRuntimes = counts.runtimes;
        lastStatuses = counts.statuses;
        lastAsks = counts.asks;
        host.log("cloud sweep ok: runtimes=" + lastRuntimes
                + " statuses=" + lastStatuses + " asks=" + lastAsks);
        misses = 0;
        host.notePoll(true);
        host.stateChanged();
    }

    private void zeroCounts() {
        lastRuntimes = 0;
        lastStatuses = 0;
        lastAsks = 0;
    }

    synchronized boolean pending() {
        return pending;
    }

    synchronized int misses() {
        return misses;
    }

    synchronized String lastCode() {
        return lastCode;
    }

    synchronized long lastAt() {
        return lastAt;
    }

    synchronized int lastRuntimes() {
        return lastRuntimes;
    }

    synchronized int lastStatuses() {
        return lastStatuses;
    }

    synchronized int lastAsks() {
        return lastAsks;
    }
}