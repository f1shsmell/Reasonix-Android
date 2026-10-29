package com.reasonix.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Keeps a running agent turn alive while the phone is in a pocket.
 *
 * A WebView alone is cached and frozen as soon as the screen locks. A
 * foreground service raises the process priority and a partial wake lock keeps
 * the CPU available, so the stream can still deliver the turn that the person
 * is waiting for. It is not a second transport: if the process is killed the
 * turn continues on the desktop and is recovered from the cursor on the next
 * launch.
 */
public class TurnService extends Service {
    static final String ACTION_START = "com.reasonix.mobile.TURN_START";
    static final String EXTRA_TITLE = "title";

    private static final String TAG = "ReasonixTurn";
    private static final String CHANNEL_RUNNING = "turn_running";
    private static final String CHANNEL_DONE = "turn_done";
    private static final int RUNNING_ID = 4101;
    private static final int DONE_ID = 4102;
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;

    /** Set by the plugin before stopService so onDestroy can notify. */
    static volatile boolean completed;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A previous stop may have left the flag set; a new turn starts clean.
        completed = false;
        String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
        try {
            Notification notification = buildRunning(title);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(RUNNING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(RUNNING_ID, notification);
            }
        } catch (RuntimeException e) {
            // Android 12+ can refuse a foreground start from the background.
            // The turn itself is unaffected; only the notification is lost.
            Log.w(TAG, "cannot enter the foreground", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        boolean announce = completed && !MainActivity.visible;
        completed = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (RuntimeException ignored) {
            // already gone
        }
        if (announce) notifyFinished();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "reasonix:turn");
        wakeLock.setReferenceCounted(false);
        // A cap, not an expectation: a forgotten service must not drain the
        // battery for a turn that already ended.
        wakeLock.acquire(WAKE_LOCK_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel running = new NotificationChannel(
                CHANNEL_RUNNING, "运行中的会话", NotificationManager.IMPORTANCE_LOW);
        running.setShowBadge(false);
        manager.createNotificationChannel(running);
        NotificationChannel done = new NotificationChannel(
                CHANNEL_DONE, "会话完成", NotificationManager.IMPORTANCE_DEFAULT);
        manager.createNotificationChannel(done);
    }

    private Notification buildRunning(String title) {
        String text = title == null || title.isEmpty() ? "正在处理…" : title + " · 正在处理…";
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_RUNNING)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Reasonix")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openApp());
        return builder.build();
    }

    private void notifyFinished() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        Notification notification = new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Reasonix")
                .setContentText("这一轮已完成")
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
        manager.notify(DONE_ID, notification);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, flags);
    }
}
