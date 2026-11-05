package com.reasonix.mobile;

import android.content.Context;

/** Phone-local notification choices, written by the settings switch. */
final class TurnNotifyPrefs {
    private TurnNotifyPrefs() {}

    static final String PREFS = "turn_notify";
    static final String KEY_SHOW_OPTIONS = "show_options";
    static final String KEY_ONGOING = "notify_ongoing";
    static final String KEY_ASK = "notify_ask";
    static final String KEY_DONE = "notify_done";
    static final String KEY_HEADS_UP = "notify_heads_up";

    static boolean read(Context context, String key, boolean fallback) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(key, fallback);
    }

    static boolean showOptions(Context context) {
        return read(context, KEY_SHOW_OPTIONS, false);
    }

    /**
     * The channel the ongoing notification posts on.
     *
     * Off does not cancel the notification — a foreground service cannot exist
     * without one — so it moves to the MIN-importance twin instead.
     */
    static String runningChannel(Context context, boolean cloud) {
        boolean silent = !read(context, KEY_ONGOING, false);
        if (cloud) {
            return silent
                    ? TurnNotificationChannels.CHANNEL_CLOUD_QUIET
                    : TurnNotificationChannels.CHANNEL_CLOUD;
        }
        return silent
                ? TurnNotificationChannels.CHANNEL_RUNNING_QUIET
                : TurnNotificationChannels.CHANNEL_RUNNING;
    }

    /** The ask channel, which is how heads-up is chosen at all. */
    static String askChannel(Context context) {
        return read(context, KEY_HEADS_UP, true)
                ? TurnNotificationChannels.CHANNEL_ASK
                : TurnNotificationChannels.CHANNEL_ASK_QUIET;
    }
}