package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.Test;

/** The reach batch's ordering, dedupe, cap and deadline rules. */
public class ReachBatchTest {
    @Test
    public void canonicalizesInTheCallersOrder() {
        List<String> kept = ReachBatch.canonical(
                Arrays.asList("http://a:80/", "http://a", "  https://b ", "not a url", "http://c:9000"),
                8);

        assertEquals(Arrays.asList("http://a:80", "https://b:443", "http://c:9000"), kept);
    }

    @Test
    public void keepsAtMostTheCap() {
        List<String> kept = ReachBatch.canonical(
                Arrays.asList("http://a:80", "http://b:80", "http://c:80"), 2);

        assertEquals(Arrays.asList("http://a:80", "http://b:80"), kept);
        assertTrue(ReachBatch.canonical(Collections.emptyList(), 2).isEmpty());
        assertTrue(ReachBatch.canonical(null, 2).isEmpty());
    }

    @Test
    public void answersInTheCallersOrder() {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            List<ReachBatch.Row> rows = ReachBatch.run(
                    Arrays.asList("http://a:80", "http://b:80", "http://c:80"),
                    pool,
                    origin -> origin.contains("b") ? 401 : 200,
                    2_000);
            assertEquals(3, rows.size());
            assertEquals("http://a:80", rows.get(0).origin);
            assertEquals(200, rows.get(0).status);
            assertEquals("http://b:80", rows.get(1).origin);
            assertEquals(401, rows.get(1).status);
            assertEquals(200, rows.get(2).status);
            assertTrue(rows.get(0).ms >= 0);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    public void reportsAProbeThatOutlivesTheDeadline() {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            long started = System.currentTimeMillis();
            List<ReachBatch.Row> rows = ReachBatch.run(
                    Arrays.asList("http://slow:80"),
                    pool,
                    origin -> {
                        try {
                            Thread.sleep(1_000);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return 200;
                    },
                    50);
            assertEquals(1, rows.size());
            assertEquals(-1, rows.get(0).status);
            // The row reports the wait it actually spent, not zero.
            assertTrue(rows.get(0).ms >= 40);
            assertTrue(System.currentTimeMillis() - started < 800);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    public void reportsAProbeThePoolRefused() {
        ExecutorService pool = Executors.newSingleThreadExecutor();
        pool.shutdown();
        List<ReachBatch.Row> rows = ReachBatch.run(
                Arrays.asList("http://a:80", "http://b:80"), pool, origin -> 200, 1_000);

        assertEquals(2, rows.size());
        assertEquals(-1, rows.get(0).status);
        assertEquals(-1, rows.get(1).status);
        // Never submitted: no timing to report.
        assertEquals(-1, rows.get(0).ms);
    }

    @Test
    public void reportsAProbeThatThrows() {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<ReachBatch.Row> rows = ReachBatch.run(
                    Arrays.asList("http://a:80"),
                    pool,
                    origin -> {
                        throw new IllegalStateException("boom");
                    },
                    1_000);

            assertEquals(-1, rows.get(0).status);
        } finally {
            pool.shutdownNow();
        }
    }
}
