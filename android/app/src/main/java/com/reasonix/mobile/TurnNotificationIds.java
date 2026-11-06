package com.reasonix.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Notification identities per runtime.
 *
 * Four non-overlapping bands of a million keep two sessions from sharing an
 * identity or a deep link.
 */
final class TurnNotificationIds {
    private TurnNotificationIds() {}

    static final int DONE_BASE = 0x01000000;
    static final int ASK_BASE = 0x02000000;
    static final int REQUEST_DONE_BASE = 0x03000000;
    static final int REQUEST_ASK_BASE = 0x04000000;
    static final int REQUEST_DECISION_BASE = 0x05000000;
    static final int SESSION_BUCKETS = 1 << 20;

    /**
     * Buckets are handed out, not hashed. Hashing a million buckets merged
     * two concurrently watched panes one time in a million: the second ask
     * overwrote the first notification and cancelAsk ended both. The
     * assignment is remembered in prefs so the ids also survive a service
     * restart — a restarted watcher re-derives the same ids, which is what
     * lets its first poll cancel the tray notifications the dead process
     * left behind.
     */
    private static final Map<String, Integer> assigned = new ConcurrentHashMap<>();
    private static SharedPreferences persisted;
    /** One past the highest bucket ever handed out; 0 is the empty-key bucket. */
    private static int next = 1;

    /** Bind the process-wide prefs once, from the service that posts. */
    static void bind(Context context) {
        persisted = context.getApplicationContext()
                .getSharedPreferences("reasonix.turn.ids", Context.MODE_PRIVATE);
        synchronized (assigned) {
            assigned.clear();
            next = 1;
            for (Map.Entry<String, ?> entry : persisted.getAll().entrySet()) {
                Object value = entry.getValue();
                if (!(value instanceof Integer)) continue;
                assigned.put(entry.getKey(), (Integer) value);
                next = Math.max(next, (Integer) value + 1);
            }
        }
    }

    static int sessionBucket(String runtime) {
        if (runtime == null || runtime.isEmpty()) return 0;
        Integer known = assigned.get(runtime);
        if (known != null) return known;
        synchronized (assigned) {
            known = assigned.get(runtime);
            if (known != null) return known;
            // A million distinct runtimes cannot coexist; the clear is a bound,
            // not a path anything reaches.
            if (assigned.size() >= SESSION_BUCKETS) {
                assigned.clear();
                next = 1;
                if (persisted != null) persisted.edit().clear().apply();
            }
            int bucket = next++;
            assigned.put(runtime, bucket);
            if (persisted != null) persisted.edit().putInt(runtime, bucket).apply();
            return bucket;
        }
    }

    static int askId(String runtime) {
        return ASK_BASE + sessionBucket(runtime);
    }

    static int doneId(String runtime) {
        return DONE_BASE + sessionBucket(runtime);
    }

    static int askRequest(String runtime) {
        return REQUEST_ASK_BASE + sessionBucket(runtime);
    }

    static int doneRequest(String runtime) {
        return REQUEST_DONE_BASE + sessionBucket(runtime);
    }
}