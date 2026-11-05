package com.reasonix.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/** The notification channels, fixed once at creation by Android. */
final class TurnNotificationChannels {
    private TurnNotificationChannels() {}

    static final String CHANNEL_RUNNING = "turn_running";
    /**
     * The silent twin of {@link #CHANNEL_RUNNING}.
     *
     * A foreground service must carry a notification, so "off" cannot mean
     * "absent": it means a channel whose importance is MIN, which keeps the
     * service alive without taking a slot in the status bar or making a sound.
     * A separate channel rather than one with mutable importance, because
     * Android fixes a channel's importance at creation — and after the person
     * touches it, not even that.
     */
    static final String CHANNEL_RUNNING_QUIET = "turn_running_quiet";
    static final String CHANNEL_CLOUD = "turn_cloud";
    static final String CHANNEL_CLOUD_QUIET = "turn_cloud_quiet";
    static final String CHANNEL_DONE = "turn_done";
    static final String CHANNEL_ASK = "turn_ask";
    /**
     * The ask channel that waits in the shade instead of heads-up.
     *
     * Whether a notification interrupts is a channel property, not something a
     * builder can set per post, so the choice is made by choosing a channel:
     * {@link #CHANNEL_ASK} for heads-up, this one for quiet.
     */
    static final String CHANNEL_ASK_QUIET = "turn_ask_quiet";

    static void create(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel running = new NotificationChannel(
                CHANNEL_RUNNING, "运行中的会话", NotificationManager.IMPORTANCE_LOW);
        running.setShowBadge(false);
        manager.createNotificationChannel(running);
        // The twin the ongoing notification moves to when the person turns it
        // off: still required by startForeground, but no icon and no sound.
        NotificationChannel quiet = new NotificationChannel(
                CHANNEL_RUNNING_QUIET, "运行中的会话（静默）", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        quiet.setSound(null, null);
        manager.createNotificationChannel(quiet);
        NotificationChannel cloud = new NotificationChannel(
                CHANNEL_CLOUD, "云端后台提醒", NotificationManager.IMPORTANCE_LOW);
        cloud.setDescription("App 在后台时留意云端会话");
        cloud.setShowBadge(false);
        manager.createNotificationChannel(cloud);
        NotificationChannel cloudQuiet = new NotificationChannel(
                CHANNEL_CLOUD_QUIET, "云端后台提醒（静默）", NotificationManager.IMPORTANCE_MIN);
        cloudQuiet.setShowBadge(false);
        cloudQuiet.setSound(null, null);
        manager.createNotificationChannel(cloudQuiet);
        NotificationChannel done = new NotificationChannel(
                CHANNEL_DONE, "会话完成", NotificationManager.IMPORTANCE_DEFAULT);
        manager.createNotificationChannel(done);
        NotificationChannel ask = new NotificationChannel(
                CHANNEL_ASK, "需要你处理", NotificationManager.IMPORTANCE_HIGH);
        ask.setDescription("有提问、批准或恢复选择等你回答");
        ask.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(ask);
        // The same prompt, waiting quietly. Two channels rather than one whose
        // importance changes, because Android fixes importance at creation and
        // honours a change only while the person has not touched the channel.
        NotificationChannel askQuiet = new NotificationChannel(
                CHANNEL_ASK_QUIET, "需要你处理（不弹窗）", NotificationManager.IMPORTANCE_DEFAULT);
        askQuiet.setDescription("同样的提醒，但不以横幅弹出");
        askQuiet.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(askQuiet);
    }
}
