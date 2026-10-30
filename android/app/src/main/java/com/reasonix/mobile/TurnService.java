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
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Keeps the phone informed while agent turns run in a pocket.
 *
 * The service discovers every open pane on the active computer from
 * `GET /runtimes` and polls each pane's `/status`. A decision blocks a turn,
 * so it earns a per-session heads-up; a turn that stops after running earns a
 * completion; the ongoing notification summarizes the rest. The desktop still
 * owns the turns: this is a watcher, not a transport.
 *
 * A phone cannot see a pane the desktop never opened, and a cloud computer is
 * out of reach until relay links can coexist. Both limits are stated rather
 * than hidden.
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
     * Ask and done notifications are per runtime. Four non-overlapping bands
     * of a million keep two sessions from sharing an identity or a deep link.
     */
    static final int DONE_BASE = 0x01000000;
    static final int ASK_BASE = 0x02000000;
    static final int REQUEST_DONE_BASE = 0x03000000;
    static final int REQUEST_ASK_BASE = 0x04000000;
    static final int SESSION_BUCKETS = 1 << 20;
    private static final int OFFLINE_AFTER = 3;
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;
    private static final long WATCH_POLL_MS = 5000L;
    /** Ten minutes without one answer means the computer is gone, not slow. */
    private static final long QUIET_STOP_MS = 10 * 60 * 1000L;
    private static final int MAX_BODY = 512 * 1024;

    /** Set by the plugin before stopService; kept for the plugin's contract. */
    static volatile boolean completed;

    /** One pane the phone is watching. */
    private static final class Watch {
        final String runtime;
        volatile String base;
        volatile String root;
        volatile String title;
        volatile boolean running;
        volatile boolean waiting;
        volatile String askSignature = "";

        Watch(String runtime, String base, String root, String title) {
            this.runtime = runtime;
            this.base = base;
            this.root = root;
            this.title = title;
        }

        void update(String nextBase, String nextRoot, String nextTitle) {
            if (!nextBase.isEmpty()) base = nextBase;
            if (!nextRoot.isEmpty()) root = nextRoot;
            // A chat already knows the session's title; discovery only has the
            // transcript file name, so it fills gaps instead of replacing it.
            if (title == null || title.isEmpty()) title = nextTitle;
        }
    }

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    /** "lan" or "cloud"; names the link in the ongoing summary. */
    private volatile String mode = "";
    private volatile int pollFailures = 0;
    private volatile boolean stopping = false;
    private ScheduledExecutorService watcher;
    private final Map<String, Watch> watches = new ConcurrentHashMap<>();
    /** Consecutive discovery passes with nothing running or waiting. */
    private int idlePolls = 0;
    /** Last time any proxy read answered; a watcher that cannot read must end. */
    private volatile long lastAnswerAt = System.currentTimeMillis();

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        completed = false;
        stopping = false;
        lastAnswerAt = System.currentTimeMillis();
        String nextMode = extra(intent, EXTRA_MODE);
        if (!nextMode.isEmpty()) mode = nextMode;
        // A start from the open chat seeds one pane; discovery adds the rest
        // and replaces this row with the kernel's own labels when it answers.
        String nextBase = extra(intent, EXTRA_BASE);
        if (!nextBase.isEmpty()) {
            String runtime = extra(intent, EXTRA_RUNTIME);
            if (runtime.isEmpty()) runtime = nextBase;
            String title = extra(intent, EXTRA_TITLE);
            String root = extra(intent, EXTRA_ROOT);
            Watch watch = watches.get(runtime);
            if (watch == null) {
                watches.put(runtime, new Watch(runtime, nextBase, root, title));
            } else {
                watch.update(nextBase, root, title);
            }
        }
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
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        acquireWifiLock();
        startWatching();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        // A poll already in flight must not re-post notifications after
        // stopForeground has removed them.
        stopping = true;
        stopWatching();
        cancelAsks();
        releaseWakeLock();
        releaseWifiLock();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (RuntimeException ignored) {
            // already gone
        }
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

    private synchronized void startWatching() {
        if (watcher != null) return;
        watcher = Executors.newSingleThreadScheduledExecutor();
        watcher.scheduleWithFixedDelay(() -> {
            try {
                pollAll();
            } catch (Exception e) {
                // A poll that failed is not an answer; keep the last state.
                Log.w(TAG, "watch poll failed", e);
            }
        }, 500, WATCH_POLL_MS, TimeUnit.MILLISECONDS);
    }

    private synchronized void stopWatching() {
        ScheduledExecutorService current = watcher;
        watcher = null;
        if (current != null) current.shutdownNow();
    }

    /**
     * Discover the panes on the active computer and read each one.
     *
     * `/runtimes` is authoritative when it answers: a pane that disappeared is
     * finished (and its ask cleared). When it cannot answer, the panes already
     * known are still polled, so an open chat's notification survives a list
     * read failure.
     */
    private void pollAll() {
        if (stopping) return;
        renewWakeLock();
        boolean listed = false;
        boolean answered = false;
        HttpURLConnection connection = null;
        try {
            connection = open("/runtimes");
            if (connection.getResponseCode() == 200) {
                String body;
                try (InputStream input = connection.getInputStream()) {
                    body = readText(input);
                }
                List<RuntimeList.Row> rows = RuntimeList.parse(body);
                if (rows != null) {
                    listed = true;
                    Set<String> seen = new HashSet<>();
                    for (RuntimeList.Row row : rows) {
                        seen.add(row.id);
                        Watch watch = watches.get(row.id);
                        if (watch == null) {
                            watches.put(row.id, new Watch(row.id, row.base, row.root, row.title));
                            watch = watches.get(row.id);
                        } else {
                            watch.update(row.base, row.root, row.title);
                        }
                        pollStatus(watch);
                    }
                    for (String id : new ArrayList<>(watches.keySet())) {
                        if (seen.contains(id)) continue;
                        Watch gone = watches.remove(id);
                        if (gone != null) finishWatch(gone);
                    }
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "runtime list skipped", e);
        } finally {
            if (connection != null) connection.disconnect();
        }
        if (!listed) {
            for (Watch watch : new ArrayList<>(watches.values())) answered |= pollStatus(watch);
        }
        if (listed || answered) lastAnswerAt = System.currentTimeMillis();
        notePoll(listed);
        if (System.currentTimeMillis() - lastAnswerAt > QUIET_STOP_MS) {
            stopSelf();
            return;
        }

        boolean active = false;
        for (Watch watch : watches.values()) {
            if (watch.running || watch.waiting) {
                active = true;
                break;
            }
        }
        if (listed && !active) {
            if (++idlePolls >= 2) {
                stopSelf();
                return;
            }
        } else {
            idlePolls = 0;
        }
        refreshRunning();
    }

    /** One pane's status: asks and completion live here. */
    private boolean pollStatus(Watch watch) {
        if (stopping) return false;
        String prefix = watch.base;
        if (prefix.isEmpty()) return false;
        HttpURLConnection connection = null;
        try {
            connection = open(prefix + "/status");
            if (connection.getResponseCode() != 200) return false;
            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readText(input);
            }
            AskStatus status = AskStatus.parse(body);
            boolean wasRunning = watch.running;
            watch.running = status.running;
            watch.waiting = !status.empty();
            syncAsk(watch, status);
            if (wasRunning && !status.running && !MainActivity.visible) {
                notifyFinished(watch);
            }
            return true;
        } catch (Exception e) {
            // The next tick tries again; a dead pane must not kill the rest.
            Log.d(TAG, "status poll skipped", e);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private HttpURLConnection open(String path) throws IOException {
        URI uri = URI.create("http://127.0.0.1:" + LoopbackProxy.PORT + path);
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(3000);
        connection.setRequestProperty("Cookie", LoopbackProxy.authCookie(this));
        return connection;
    }

    private void notePoll(boolean answered) {
        if (stopping) return;
        if (answered) {
            pollFailures = 0;
        } else if (pollFailures < OFFLINE_AFTER) {
            pollFailures += 1;
        }
    }

    private void refreshRunning() {
        if (stopping) return;
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

    private void syncAsk(Watch watch, AskStatus status) {
        if (stopping) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (status.empty()) {
            if (!watch.askSignature.isEmpty()) cancelAsk(watch);
            return;
        }
        if (status.signature.equals(watch.askSignature)) return;
        if (!manager.areNotificationsEnabled()) return;
        watch.askSignature = status.signature;
        manager.notify(askId(watch.runtime), buildAsk(watch, status.text));
    }

    private Notification buildAsk(Watch watch, String text) {
        String heading = watch.title.isEmpty() ? "需要你处理" : watch.title;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ASK)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(heading)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                // A prompt can carry code and paths; the lock screen says only
                // that something is waiting until the phone is unlocked.
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicAsk())
                .setContentIntent(openChat(watch, askRequest(watch.runtime)))
                .addAction(android.R.drawable.ic_dialog_info, "去回答", openChat(watch, askRequest(watch.runtime)));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        return builder.build();
    }

    /** The lock-screen stand-in: no session title, no question text. */
    private Notification publicAsk() {
        return new Notification.Builder(this, CHANNEL_ASK)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Reasonix")
                .setContentText("有会话需要你处理")
                .setContentIntent(openApp())
                .build();
    }

    private Notification publicDone() {
        return new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Reasonix")
                .setContentText("这一轮已完成")
                .setContentIntent(openApp())
                .build();
    }

    private void cancelAsk(Watch watch) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(askId(watch.runtime));
        watch.askSignature = "";
    }

    private void cancelAsks() {
        for (Watch watch : new ArrayList<>(watches.values())) cancelAsk(watch);
    }

    /** A pane that left the list: finish its ask and announce its last turn. */
    private void finishWatch(Watch watch) {
        if (watch.running && !MainActivity.visible) notifyFinished(watch);
        cancelAsk(watch);
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

    private void renewWakeLock() {
        if (wakeLock == null || wakeLock.isHeld()) return;
        try {
            wakeLock.acquire(WAKE_LOCK_MS);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot renew the wake lock", e);
        }
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
        ask.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(ask);
    }

    private Notification buildRunning() {
        int running = 0;
        int waiting = 0;
        for (Watch watch : watches.values()) {
            if (watch.running) running++;
            if (watch.waiting) waiting++;
        }
        String text;
        if (pollFailures >= OFFLINE_AFTER) {
            text = "连接中断，正在重试…";
        } else {
            String where = "cloud".equals(mode) ? "云端 · " : "lan".equals(mode) ? "局域网 · " : "";
            if (waiting > 0) {
                text = where + (running > 0
                        ? running + " 个运行中 · " + waiting + " 个待处理"
                        : waiting + " 个待处理");
            } else if (running > 0) {
                text = where + running + " 个会话运行中";
            } else {
                text = watches.isEmpty() ? "正在准备…" : "没有正在运行的会话";
            }
        }
        return new Notification.Builder(this, CHANNEL_RUNNING)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Reasonix")
                .setContentText(text)
                .setSubText("Reasonix")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openApp())
                .build();
    }

    private void notifyFinished(Watch watch) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        String heading = watch.title == null || watch.title.isEmpty() ? "Reasonix" : watch.title;
        Notification notification = new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(heading)
                .setContentText("这一轮已完成")
                .setSubText("Reasonix")
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicDone())
                .setContentIntent(openChat(watch, doneRequest(watch.runtime)))
                .build();
        manager.notify(doneId(watch.runtime), notification);
    }

    /** Open the conversation that was blocked; fall back to the app. */
    private PendingIntent openChat(Watch watch, int requestCode) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        Intent intent;
        if (!watch.runtime.isEmpty()) {
            String link = "reasonix://chat?runtime=" + Uri.encode(watch.runtime)
                    + "&root=" + Uri.encode(watch.root)
                    + "&title=" + Uri.encode(watch.title);
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link), this, MainActivity.class);
        } else {
            intent = new Intent(this, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, flags);
    }
}
