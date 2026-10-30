package com.reasonix.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Keeps a running agent turn alive while the phone is in a pocket, and tells
 * the person when that turn stops on a question.
 *
 * A WebView alone is cached and frozen as soon as the screen locks. A
 * foreground service raises the process priority and a partial wake lock keeps
 * the CPU available, so the stream can still deliver the turn that the person
 * is waiting for. It is not a second transport: if the process is killed the
 * turn continues on the desktop and is recovered from the cursor on the next
 * launch.
 *
 * While it runs it polls the pane's `/status` through the loopback proxy. A
 * decision (an ask, a tool approval, a plan or a recovery choice) is exactly
 * the state where the turn cannot finish, so that is when a heads-up
 * notification is owed. The phone only watches the pane it is running; a turn
 * on the desktop with no pane open here has no service to watch it, and that
 * limit is stated rather than hidden.
 */
public class TurnService extends Service {
    static final String ACTION_START = "com.reasonix.mobile.TURN_START";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BASE = "base";
    static final String EXTRA_ROOT = "root";
    static final String EXTRA_RUNTIME = "runtime";

    private static final String TAG = "ReasonixTurn";
    private static final String CHANNEL_RUNNING = "turn_running";
    private static final String CHANNEL_DONE = "turn_done";
    private static final String CHANNEL_ASK = "turn_ask";
    private static final int RUNNING_ID = 4101;
    private static final int DONE_ID = 4102;
    private static final int ASK_ID = 4103;
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;
    private static final long ASK_POLL_MS = 3000L;
    private static final int MAX_BODY = 512 * 1024;

    /** Set by the plugin before stopService so onDestroy can notify. */
    static volatile boolean completed;

    private PowerManager.WakeLock wakeLock;
    private volatile String title = "";
    private volatile String base = "";
    private volatile String root = "";
    private volatile String runtime = "";
    private ScheduledExecutorService watcher;
    /** The decisions the current notification was built from. */
    private String askedSignature = "";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A previous stop may have left the flag set; a new turn starts clean.
        completed = false;
        title = extra(intent, EXTRA_TITLE);
        String nextBase = extra(intent, EXTRA_BASE);
        if (!nextBase.equals(base)) {
            // Another pane: the old pane's ask is no longer the one on screen.
            askedSignature = "";
            cancelAsk();
        }
        base = nextBase;
        root = extra(intent, EXTRA_ROOT);
        runtime = extra(intent, EXTRA_RUNTIME);
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
        startWatching();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWatching();
        cancelAsk();
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

    private static String extra(Intent intent, String key) {
        if (intent == null) return "";
        String value = intent.getStringExtra(key);
        return value == null ? "" : value.trim();
    }

    private void startWatching() {
        if (base.isEmpty()) return;
        if (watcher != null) return;
        watcher = Executors.newSingleThreadScheduledExecutor();
        watcher.scheduleWithFixedDelay(() -> {
            try {
                pollAsk();
            } catch (Exception e) {
                // A poll that failed is not an answer; keep the last state.
                Log.w(TAG, "ask poll failed", e);
            }
        }, 500, ASK_POLL_MS, TimeUnit.MILLISECONDS);
    }

    private void stopWatching() {
        ScheduledExecutorService current = watcher;
        watcher = null;
        if (current != null) current.shutdownNow();
    }

    /** Read the pane's decisions and post/clear the notification they own. */
    private void pollAsk() {
        String prefix = base;
        if (prefix.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            URI uri = URI.create("http://127.0.0.1:" + LoopbackProxy.PORT + prefix + "/status");
            connection = (HttpURLConnection) uri.toURL().openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setRequestProperty("Cookie", LoopbackProxy.authCookie(this));
            if (connection.getResponseCode() != 200) return;
            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readText(input);
            }
            syncAsk(AskStatus.parse(body));
        } catch (Exception e) {
            // The next tick tries again; a dead upstream must not kill the service.
            Log.d(TAG, "ask poll skipped", e);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readText(InputStream input) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (out.size() + read > MAX_BODY) break;
            out.write(buffer, 0, read);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private void syncAsk(AskStatus status) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (status.empty()) {
            if (!askedSignature.isEmpty()) {
                manager.cancel(ASK_ID);
                askedSignature = "";
            }
            return;
        }
        if (status.signature.equals(askedSignature)) return;
        if (!manager.areNotificationsEnabled()) return;
        askedSignature = status.signature;
        manager.notify(ASK_ID, buildAsk(status.text));
    }

    private Notification buildAsk(String text) {
        String heading = title.isEmpty() ? "需要你处理" : title;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ASK)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(heading)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(openChat())
                .addAction(android.R.drawable.ic_dialog_info, "去回答", openChat());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        return builder.build();
    }

    private void cancelAsk() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(ASK_ID);
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
        NotificationChannel ask = new NotificationChannel(
                CHANNEL_ASK, "需要你处理", NotificationManager.IMPORTANCE_HIGH);
        ask.setDescription("有提问、批准或恢复选择等你回答");
        ask.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(ask);
    }

    private Notification buildRunning(String title) {
        String text = title == null || title.isEmpty() ? "正在处理…" : title + " · 正在处理…";
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_RUNNING)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Reasonix")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openChat());
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
                .setContentIntent(openChat())
                .build();
        manager.notify(DONE_ID, notification);
    }

    /** Open the conversation that was blocked; fall back to the app. */
    private PendingIntent openChat() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, ASK_ID, openChatIfPossible(), flags);
    }

    private Intent openChatIfPossible() {
        Intent intent;
        if (!runtime.isEmpty()) {
            String link = "reasonix://chat?runtime=" + Uri.encode(runtime)
                    + "&root=" + Uri.encode(root)
                    + "&title=" + Uri.encode(title);
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link), this, MainActivity.class);
        } else {
            intent = new Intent(this, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, flags);
    }
}
