package com.reasonix.mobile;

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

    static int sessionBucket(String runtime) {
        if (runtime == null || runtime.isEmpty()) return 0;
        return (runtime.hashCode() & 0x7fffffff) % SESSION_BUCKETS;
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