package com.reasonix.mobile;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * Probing a batch of remembered doors together, against one deadline.
 *
 * Kept out of the proxy's socket code so the ordering, dedupe, cap and
 * deadline rules are covered by plain JUnit tests: a row still probing when
 * the batch's deadline passes is unreachable, and a probe that could not
 * even be submitted is as unreachable as one that failed.
 */
final class ReachBatch {
    private ReachBatch() {}

    /** One answer: the door, its kernel status (-1 when none), and how long it took. */
    static final class Row {
        final String origin;
        final int status;
        final long ms;

        Row(String origin, int status, long ms) {
            this.origin = origin;
            this.status = status;
            this.ms = ms;
        }
    }

    /**
     * The doors worth probing: normalized, deduplicated, in the caller's
     * order, at most [max] of them. An unreadable address is dropped rather
     * than guessed at.
     */
    static List<String> canonical(List<String> asked, int max) {
        List<String> next = new ArrayList<>();
        if (asked == null) return next;
        Set<String> seen = new LinkedHashSet<>();
        for (String raw : asked) {
            if (next.size() >= max) break;
            String origin = ProxyPaths.normalizeOrigin(raw == null ? "" : raw);
            if (origin.isEmpty() || !seen.add(origin)) continue;
            next.add(origin);
        }
        return next;
    }

    /** Probe every door at once; the deadline bounds the whole batch, not each row. */
    static List<Row> run(
            List<String> origins,
            ExecutorService pool,
            Function<String, Integer> prober,
            long deadlineMs) {
        int count = origins.size();
        List<Future<Row>> pending = new ArrayList<>(count);
        for (String origin : origins) {
            try {
                pending.add(pool.submit(() -> probe(origin, prober)));
            } catch (RejectedExecutionException e) {
                pending.add(null);
            }
        }
        long started = System.currentTimeMillis();
        long deadline = started + Math.max(1, deadlineMs);
        List<Row> rows = new ArrayList<>(count);
        for (int index = 0; index < count; index += 1) {
            String origin = origins.get(index);
            Future<Row> future = pending.get(index);
            Row row = null;
            if (future != null) {
                try {
                    long left = Math.max(1, deadline - System.currentTimeMillis());
                    row = future.get(left, TimeUnit.MILLISECONDS);
                } catch (Exception e) {
                    future.cancel(true);
                }
            }
            if (row != null) {
                rows.add(row);
            } else {
                // A probe that ran out of time still spent the wait; one that
                // was never submitted has no timing to report.
                rows.add(new Row(origin, -1, future == null ? -1 : Math.max(0, System.currentTimeMillis() - started)));
            }
        }
        return rows;
    }

    private static Row probe(String origin, Function<String, Integer> prober) {
        long started = System.currentTimeMillis();
        int status = -1;
        try {
            Integer answer = prober.apply(origin);
            if (answer != null) status = answer;
        } catch (RuntimeException e) {
            status = -1;
        }
        return new Row(origin, status, Math.max(0, System.currentTimeMillis() - started));
    }
}
