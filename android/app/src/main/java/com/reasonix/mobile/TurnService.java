package com.reasonix.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
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
    static final String EXTRA_MODE = "mode";

    private static final String TAG = "ReasonixTurn";
    private static final String CHANNEL_RUNNING = "turn_running";
    private static final String CHANNEL_DONE = "turn_done";
    private static final String CHANNEL_ASK = "turn_ask";
    private static final int RUNNING_ID = 4101;
    /**
     * Ask and done notifications are per runtime. A fixed id made a second
     * session overwrite the first, and a shared PendingIntent request code made
     * its deep link open whichever chat was built last. Four non-overlapping
     * bands of a million keep the chance of two sessions colliding negligible.
     */
    static final int DONE_BASE = 0x01000000;
    static final int ASK_BASE = 0x02000000;
    static final int REQUEST_RUNNING = 7101;
    static final int REQUEST_DONE_BASE = 0x03000000;
    static final int REQUEST_ASK_BASE = 0x04000000;
    static final int SESSION_BUCKETS = 1 << 20;
    private static final int OFFLINE_AFTER = 3;
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;
    private static final long ASK_POLL_MS = 3000L;
    private static final int MAX_BODY = 512 * 1024;

    /** Set by the plugin before stopService so onDestroy can notify. */
    static volatile boolean completed;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private volatile String title = "";
    private volatile String base = "";
    private volatile String root = "";
    private volatile String runtime = "";
    /** "lan" or "cloud"; names the path in the ongoing notification. */
    private volatile String mode = "";
    private volatile int pollFailures = 0;
    private volatile boolean stopping = false;
    private ScheduledExecutorService watcher;
    /** The decisions the current notification was built from. */
    private String askedSignature = "";
    /** The runtime that notification belongs to; a new pane cancels just it. */
    private String askedRuntime = "";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A previous stop may have left the flag set; a new turn starts clean.
        completed = false;
        stopping = false;
        title = extra(intent, EXTRA_TITLE);
        String nextBase = extra(intent, EXTRA_BASE);
        if (!nextBase.equals(base)) {
            // Another pane: the old pane's ask is no longer the one on screen.
            cancelAsk();
            pollFailures = 0;
        }
        base = nextBase;
        mode = extra(intent, EXTRA_MODE);
        root = extra(intent, EXTRA_ROOT);
        runtime = extra(intent, EXTRA_RUNTIME);
        try {
            Notification notification = buildRunning();
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
        acquireWifiLock();
        startWatching();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        // A poll already in flight must not re-post the notification after
        // stopForeground has removed it.
        stopping = true;
        stopWatching();
        cancelAsk();
        releaseWakeLock();
        releaseWifiLock();
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

    /** A stable bucket per runtime, so two sessions get their own notification. */
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
        if (stopping) return;
        String prefix = base;
        if (prefix.isEmpty()) return;
        HttpURLConnection connection = null;
        boolean answered = false;
        try {
            URI uri = URI.create("http://127.0.0.1:" + LoopbackProxy.PORT + prefix + "/status");
            connection = (HttpURLConnection) uri.toURL().openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setRequestProperty("Cookie", LoopbackProxy.authCookie(this));
            if (connection.getResponseCode() == 200) {
                String body;
                try (InputStream input = connection.getInputStream()) {
                    body = readText(input);
                }
                syncAsk(AskStatus.parse(body));
                answered = true;
            }
        } catch (Exception e) {
            // The next tick tries again; a dead upstream must not kill the service.
            Log.d(TAG, "ask poll skipped", e);
        } finally {
            if (connection != null) connection.disconnect();
            notePoll(answered);
        }
    }

    /**
     * Put the link's own health in the ongoing notification.
     *
     * One failed poll is noise — a phone rekeys Wi-Fi all the time. Only a
     * sustained run of failures changes the text, and one answer clears it, so
     * the notification never claims a connection it does not have.
     */
    private void notePoll(boolean answered) {
        if (stopping) return;
        boolean wasOffline = pollFailures >= OFFLINE_AFTER;
        if (answered) {
            pollFailures = 0;
        } else if (pollFailures < OFFLINE_AFTER) {
            pollFailures += 1;
        }
        boolean offline = pollFailures >= OFFLINE_AFTER;
        if (wasOffline != offline) refreshRunning();
    }

    private void refreshRunning() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(RUNNING_ID, buildRunning());
        } catch (RuntimeException e) {
            // A permission revoked mid-turn must not stop the watcher.
            Log.w(TAG, "cannot refresh the running notification", e);
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
        if (stopping) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (status.empty()) {
            if (!askedSignature.isEmpty()) {
                manager.cancel(askId(askedRuntime));
                askedSignature = "";
                askedRuntime = "";
            }
            return;
        }
        if (status.signature.equals(askedSignature) && runtime.equals(askedRuntime)) return;
        if (!manager.areNotificationsEnabled()) return;
        // This service watches one pane; an ask from the previous one is stale.
        if (!askedSignature.isEmpty() && !runtime.equals(askedRuntime)) {
            manager.cancel(askId(askedRuntime));
        }
        askedSignature = status.signature;
        askedRuntime = runtime;
        manager.notify(askId(runtime), buildAsk(status.text));
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
                .setContentIntent(openChat(askRequest(runtime)))
                .addAction(android.R.drawable.ic_dialog_info, "去回答", openChat(askRequest(runtime)));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        return builder.build();
    }

    private void cancelAsk() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(askId(askedRuntime));
        askedSignature = "";
        askedRuntime = "";
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

    /**
     * Keep the radio awake as well as the CPU.
     *
     * The kernel is on a LAN or across the internet; with Wi-Fi asleep the
     * poll fails until the phone wakes, which is exactly when the screen is
     * off. The lock covers Wi-Fi only — a cellular link is governed by the
     * system's data policy, which the battery-optimization setting addresses.
     */
    @SuppressWarnings("deprecation")
    private void acquireWifiLock() {
        if (wifiLock != null && wifiLock.isHeld()) return;
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi == null) return;
            int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(lockMode, "reasonix:turn-wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (RuntimeException e) {
            // A device that refuses the lock still runs the turn; only its
            // background polling is less reliable.
            Log.w(TAG, "cannot hold a Wi-Fi lock", e);
            wifiLock = null;
        }
    }

    private void releaseWifiLock() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (RuntimeException ignored) {
            // already released
        }
        wifiLock = null;
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

    private Notification buildRunning() {
        String heading = title == null || title.isEmpty() ? "Reasonix" : title;
        String text;
        if (pollFailures >= OFFLINE_AFTER) {
            text = "连接中断，正在重试…";
        } else if ("cloud".equals(mode)) {
            text = "云端连接 · 正在处理…";
        } else if ("lan".equals(mode)) {
            text = "局域网 · 正在处理…";
        } else {
            text = "正在处理…";
        }
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_RUNNING)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(heading)
                .setContentText(text)
                .setSubText("Reasonix")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openChat(REQUEST_RUNNING));
        return builder.build();
    }

    private void notifyFinished() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        String heading = title == null || title.isEmpty() ? "Reasonix" : title;
        Notification notification = new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(heading)
                .setContentText("这一轮已完成")
                .setSubText("Reasonix")
                .setAutoCancel(true)
                .setContentIntent(openChat(doneRequest(runtime)))
                .build();
        manager.notify(doneId(runtime), notification);
    }

    /** Open the conversation that was blocked; fall back to the app. */
    private PendingIntent openChat(int requestCode) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, openChatIfPossible(), flags);
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
