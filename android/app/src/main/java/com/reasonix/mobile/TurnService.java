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
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

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
import java.util.concurrent.ExecutorService;
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
 * A phone cannot see a pane the desktop never opened. LAN turns are read
 * through the loopback proxy; a persistent cloud watcher asks the WebView's
 * relay bridge for one snapshot at a time, so it only lives while the app
 * process and its WebView do. Both limits are stated rather than hidden.
 */
public class TurnService extends Service {
    static final String ACTION_START = "com.reasonix.mobile.TURN_START";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BASE = "base";
    static final String EXTRA_ROOT = "root";
    static final String EXTRA_RUNTIME = "runtime";
    static final String EXTRA_MODE = "mode";
    static final String EXTRA_CLOUD = "cloud";
    static final String ACTION_DECIDE = "com.reasonix.mobile.TURN_DECIDE";
    static final String EXTRA_DECISION = "decision";
    static final String EXTRA_QUESTION = "question";
    static final String EXTRA_SELECTED = "selected";
    static final String EXTRA_ALLOW = "allow";
    static final String EXTRA_SESSION = "session";
    static final String EXTRA_APPROVAL = "approval";

    private static final String TAG = "ReasonixTurn";
    private static final String CHANNEL_RUNNING = "turn_running";
    private static final String CHANNEL_CLOUD = "turn_cloud";
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
    static final int REQUEST_DECISION_BASE = 0x05000000;
    static final int SESSION_BUCKETS = 1 << 20;
    private static final int OFFLINE_AFTER = 3;
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;
    private static final long WATCH_POLL_MS = 5000L;
    private static final long CLOUD_POLL_MS = 60_000L;
    private static final long CLOUD_TIMEOUT_MS = 20_000L;
    private static final long CLOUD_WAKE_MS = 25_000L;
    /** Ten minutes without one answer means the computer is gone, not slow. */
    private static final long QUIET_STOP_MS = 10 * 60 * 1000L;
    private static final int MAX_BODY = 512 * 1024;

    /** Set by the plugin before stopService; kept for the plugin's contract. */
    static volatile boolean completed;

    /** One pane the phone is watching. */
    private static final class Watch {
        final String runtime;
        /** Notification identity; peers are prefixed so two kernels cannot collide. */
        final String key;
        /** The LAN target of the peer whose pane this is; empty on this computer. */
        final String peer;
        final String peerName;
        volatile String base;
        volatile String root;
        volatile String title;
        volatile boolean running;
        volatile boolean waiting;
        /** Another process holds the lease; this phone cannot answer its asks. */
        volatile boolean readOnly;
        volatile String askSignature = "";

        Watch(String runtime, String key, String base, String root, String title,
              String peer, String peerName, boolean readOnly) {
            this.runtime = runtime;
            this.key = key;
            this.base = base;
            this.root = root;
            this.title = title;
            this.peer = peer;
            this.peerName = peerName;
            this.readOnly = readOnly;
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
    /** True for the persistent cloud watcher; false for a LAN turn. */
    private volatile boolean cloud = false;
    private volatile boolean cloudPending = false;
    private volatile int cloudGeneration = 0;
    private volatile int cloudMisses = 0;
    /** The last sweep's outcome, for diagnostics and the summary. */
    private volatile String cloudLastCode = "";
    private volatile long cloudLastAt = 0;
    private volatile int cloudLastRuntimes = 0;
    private volatile int cloudLastStatuses = 0;
    private volatile int cloudLastAsks = 0;
    private PowerManager.WakeLock cloudWakeLock;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService decisions = Executors.newSingleThreadExecutor();
    /** The running watcher, for the WebView's result bridge. */
    private static volatile TurnService active;
    private volatile int pollFailures = 0;
    private volatile boolean stopping = false;
    private ScheduledExecutorService watcher;
    private ScheduledExecutorService peerWatcher;
    private final Map<String, Watch> watches = new ConcurrentHashMap<>();
    /** A failed read this pass means the pane is not proven idle. */
    private volatile boolean activeStatusFailed = false;
    /** True while a peer sweep is running or the last one failed. */
    private volatile boolean peerStatusFailed = true;
    private volatile boolean peerSweeping = false;
    /** Consecutive discovery passes with nothing running or waiting. */
    private int idlePolls = 0;
    /** Last time any proxy read answered; a watcher that cannot read must end. */
    private volatile long lastAnswerAt = System.currentTimeMillis();

    @Override
    public void onCreate() {
        super.onCreate();
        active = this;
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_DECIDE.equals(intent.getAction())) {
            decide(intent);
            return START_NOT_STICKY;
        }
        completed = false;
        stopping = false;
        lastAnswerAt = System.currentTimeMillis();
        boolean nextCloud = intent != null && intent.getBooleanExtra(EXTRA_CLOUD, false);
        if (nextCloud != cloud) {
            cloud = nextCloud;
            stopWatching();
            cancelAsks();
            watches.clear();
            cloudPending = false;
            cloudGeneration += 1;
            cloudMisses = 0;
            pollFailures = 0;
            releaseCloudWakeLock();
            if (cloud) {
                releaseWakeLock();
                releaseWifiLock();
            }
        }
        String nextMode = extra(intent, EXTRA_MODE);
        if (!nextMode.isEmpty()) mode = nextMode;
        if (cloud) mode = "cloud";
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
                watches.put(runtime, new Watch(runtime, runtime, nextBase, root, title, "", "", false));
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
        if (cloud) {
            // A persistent watcher takes a short lock per poll instead of
            // holding the CPU and Wi-Fi awake all day.
            releaseWakeLock();
            releaseWifiLock();
        } else {
            acquireWakeLock();
            acquireWifiLock();
        }
        startWatching();
        return START_NOT_STICKY;
    }
    @Override
    public void onDestroy() {
        // A poll already in flight must not re-post notifications after
        // stopForeground has removed them.
        stopping = true;
        cloudPending = false;
        cloudGeneration += 1;
        stopWatching();
        cancelAsks();
        clearCounts();
        decisions.shutdownNow();
        releaseWakeLock();
        releaseWifiLock();
        releaseCloudWakeLock();
        if (active == this) active = null;
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
        if (watcher == null) {
            watcher = Executors.newSingleThreadScheduledExecutor();
            if (cloud) {
                watcher.scheduleWithFixedDelay(() -> {
                    try {
                        pollCloud();
                    } catch (Exception e) {
                        Log.w(TAG, "cloud watch poll failed", e);
                    }
                }, 5_000, CLOUD_POLL_MS, TimeUnit.MILLISECONDS);
            } else {
                watcher.scheduleWithFixedDelay(() -> {
                    try {
                        pollAll();
                    } catch (Exception e) {
                        // A poll that failed is not an answer; keep the last state.
                        Log.w(TAG, "watch poll failed", e);
                    }
                }, 500, WATCH_POLL_MS, TimeUnit.MILLISECONDS);
            }
        }
        if (!cloud && peerWatcher == null) {
            peerWatcher = Executors.newSingleThreadScheduledExecutor();
            peerWatcher.scheduleWithFixedDelay(() -> {
                try {
                    pollPeers();
                } catch (Exception e) {
                    peerSweeping = false;
                    Log.w(TAG, "peer poll failed", e);
                }
            }, 3000, 15_000, TimeUnit.MILLISECONDS);
        }
    }

    private synchronized void stopWatching() {
        ScheduledExecutorService current = watcher;
        watcher = null;
        if (current != null) current.shutdownNow();
        ScheduledExecutorService peers = peerWatcher;
        peerWatcher = null;
        if (peers != null) peers.shutdownNow();
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
        activeStatusFailed = false;
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
                            watches.put(row.id, new Watch(row.id, row.id, row.base, row.root, row.title, "", "", row.readOnly));
                            watch = watches.get(row.id);
                        } else {
                            watch.update(row.base, row.root, row.title);
                        }
                        watch.readOnly = row.readOnly;
                        pollStatus(watch, false);
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
            for (Watch watch : new ArrayList<>(watches.values())) answered |= pollStatus(watch, false);
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
        if (listed && !active && !activeStatusFailed && !peerStatusFailed && !peerSweeping) {
            if (++idlePolls >= 2) {
                stopSelf();
                return;
            }
        } else {
            idlePolls = 0;
        }
        refreshRunning();
    }

    /**
     * Ask the WebView for one cloud snapshot.
     *
     * The relay is a WebView transport; native code only evaluates the bridge
     * installed by `net/cloudWatch.ts`. A sweep runs even while the activity is
     * visible so the summary stays current, and the wake lock is taken every
     * time because the visibility flag cannot prove the page will run.
     */
    private void pollCloud() {
        if (stopping || !cloud) return;
        if (cloudPending) return;
        if (!MainActivity.requestCloudSweep()) {
            cloudLastCode = "bridge.unavailable";
            cloudLastAt = System.currentTimeMillis();
            cloudLastRuntimes = 0;
            cloudLastStatuses = 0;
            cloudLastAsks = 0;
            if (++cloudMisses >= 2) stopSelf();
            else refreshRunning();
            return;
        }
        cloudPending = true;
        int generation = ++cloudGeneration;
        acquireCloudWakeLock();
        mainHandler.postDelayed(() -> {
            if (!cloudPending || generation != cloudGeneration || stopping) return;
            cloudPending = false;
            releaseCloudWakeLock();
            cloudLastCode = "client.timeout";
            cloudLastAt = System.currentTimeMillis();
            cloudLastRuntimes = 0;
            cloudLastStatuses = 0;
            cloudLastAsks = 0;
            cloudMisses = 0;
            Log.d(TAG, "cloud sweep timed out");
            notePoll(false);
            refreshRunning();
        }, CLOUD_TIMEOUT_MS);
    }

    /** The cloud watcher's last sweep, for the About page's diagnostics. */
    static JSONObject cloudStatus() {
        JSONObject out = new JSONObject();
        TurnService service = active;
        if (service == null) return out;
        try {
            out.put("active", true);
            out.put("cloud", service.cloud);
            out.put("visible", MainActivity.visible);
            out.put("pending", service.cloudPending);
            out.put("misses", service.cloudMisses);
            out.put("watches", service.watches.size());
            out.put("code", service.cloudLastCode);
            out.put("at", service.cloudLastAt);
            out.put("runtimes", service.cloudLastRuntimes);
            out.put("statuses", service.cloudLastStatuses);
            out.put("asks", service.cloudLastAsks);
        } catch (Exception ignored) {
            // Every field above is a scalar or a size; none can fail.
        }
        return out;
    }

    /** The WebView's result bridge; called on its own thread. */
    static void deliverCloud(String json) {
        TurnService service = active;
        if (service != null) service.onCloudSnapshot(json);
    }

    /** The app just went to the background; do not wait out the next minute. */
    static void wakeCloud() {
        TurnService service = active;
        if (service != null) service.pollCloudSoon();
    }

    private void pollCloudSoon() {
        if (!cloud) return;
        mainHandler.postDelayed(this::pollCloud, 500);
    }

    private void onCloudSnapshot(String json) {
        mainHandler.post(() -> handleCloudSnapshot(json));
    }

    private void handleCloudSnapshot(String json) {
        if (stopping || !cloud) return;
        if (!cloudPending) return;
        cloudPending = false;
        releaseCloudWakeLock();
        CloudSnapshot snapshot = CloudSnapshot.parse(json);
        cloudLastAt = System.currentTimeMillis();
        cloudLastCode = snapshot.ok ? "ok" : (snapshot.code.isEmpty() ? "watch.failed" : snapshot.code);
        if (!snapshot.ok) {
            cloudLastRuntimes = 0;
            cloudLastStatuses = 0;
            cloudLastAsks = 0;
            Log.d(TAG, "cloud sweep failed: " + cloudLastCode);
            cloudMisses = 0;
            notePoll(false);
            refreshRunning();
            return;
        }

        Set<String> seen = new HashSet<>();
        for (RuntimeList.Row row : snapshot.runtimes) {
            seen.add(row.id);
            Watch watch = watches.get(row.id);
            if (watch == null) {
                watches.put(row.id, new Watch(
                        row.id, row.id, row.base, row.root, row.title, "", "", row.readOnly));
            } else {
                watch.update(row.base, row.root, row.title);
                watch.readOnly = row.readOnly;
            }
        }
        for (String id : new ArrayList<>(watches.keySet())) {
            if (seen.contains(id)) continue;
            Watch gone = watches.remove(id);
            if (gone != null) finishWatch(gone);
        }
        int asks = 0;
        for (Watch watch : watches.values()) {
            String status = snapshot.statuses.get(watch.runtime);
            if (status == null) continue;
            AskStatus parsed = AskStatus.parse(status);
            asks += parsed.count;
            applyStatus(watch, parsed);
        }
        cloudLastRuntimes = snapshot.runtimes.size();
        cloudLastStatuses = snapshot.statuses.size();
        cloudLastAsks = asks;
        Log.d(TAG, "cloud sweep ok: runtimes=" + cloudLastRuntimes
                + " statuses=" + cloudLastStatuses + " asks=" + asks);
        cloudMisses = 0;
        notePoll(true);
        refreshRunning();
    }

    /** The one place a status becomes notification state, LAN or cloud. */
    private void applyStatus(Watch watch, AskStatus status) {
        boolean wasRunning = watch.running;
        watch.running = status.running;
        watch.waiting = !status.empty() && !watch.readOnly;
        syncAsk(watch, status);
        if (wasRunning && !status.running && !MainActivity.visible) {
            notifyFinished(watch);
        }
    }

    private void acquireCloudWakeLock() {
        if (cloudWakeLock != null && cloudWakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power == null) return;
        cloudWakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "reasonix:cloud-watch");
        cloudWakeLock.setReferenceCounted(false);
        cloudWakeLock.acquire(CLOUD_WAKE_MS);
    }

    private void releaseCloudWakeLock() {
        if (cloudWakeLock != null && cloudWakeLock.isHeld()) cloudWakeLock.release();
        cloudWakeLock = null;
    }

    /**
     * The other watchable LAN computers, on their own slower cadence.
     *
     * The active computer is in the fleet list too; it is skipped by comparing
     * its target with the proxy's own origin, because /runtimes already
     * watches that one directly. A peer read must not delay the active poll,
     * so this runs on its own thread.
     */
    private boolean pollPeers() {
        if (stopping) return false;
        // Hold the idle stop for the whole sweep; only a clean pass releases it.
        peerSweeping = true;
        peerStatusFailed = false;
        boolean answered = false;
        String activeTarget = "";
        HttpURLConnection config = null;
        try {
            config = open("/__reasonix/config");
            if (config.getResponseCode() == 200) {
                String body;
                try (InputStream input = config.getInputStream()) {
                    body = readText(input);
                }
                activeTarget = new JSONObject(body).optString("origin", "").trim();
                answered = true;
            }
        } catch (Exception e) {
            peerStatusFailed = true;
            Log.d(TAG, "peer config skipped", e);
        } finally {
            if (config != null) config.disconnect();
        }
        List<FleetPeers.Peer> peers = null;
        HttpURLConnection list = null;
        try {
            list = open("/__reasonix/fleet");
            if (list.getResponseCode() == 200) {
                String body;
                try (InputStream input = list.getInputStream()) {
                    body = readText(input);
                }
                peers = FleetPeers.parse(body);
                if (peers != null) answered = true;
            }
        } catch (Exception e) {
            Log.d(TAG, "peer list skipped", e);
        } finally {
            if (list != null) list.disconnect();
        }
        if (peers == null) {
            peerStatusFailed = true;
            peerSweeping = false;
            return answered;
        }
        Set<String> live = new HashSet<>();
        for (FleetPeers.Peer peer : peers) {
            if (!activeTarget.isEmpty() && peer.target.equalsIgnoreCase(activeTarget)) continue;
            live.add(peer.target);
            boolean read = pollPeer(peer);
            answered |= read;
            if (!read) peerStatusFailed = true;
        }
        // A peer that left the list, or became the active computer, must not
        // keep an ask or a stale running state.
        for (Watch watch : new ArrayList<>(watches.values())) {
            if (watch.peer.isEmpty() || live.contains(watch.peer)) continue;
            watches.remove(watch.key);
            finishWatch(watch);
        }
        if (answered) lastAnswerAt = System.currentTimeMillis();
        peerSweeping = false;
        return answered;
    }

    /** One peer's runtimes, then the status of each. */
    private boolean pollPeer(FleetPeers.Peer peer) {
        boolean answered = false;
        HttpURLConnection connection = null;
        try {
            connection = open("/__reasonix/fleet/" + peer.index + "/runtimes");
            if (connection.getResponseCode() != 200) return false;
            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readText(input);
            }
            List<RuntimeList.Row> rows = RuntimeList.parse(body);
            if (rows == null) return false;
            answered = true;
            Set<String> keys = new HashSet<>();
            String prefix = "/__reasonix/fleet/" + peer.index;
            for (RuntimeList.Row row : rows) {
                String key = "p:" + peer.target + ":" + row.id;
                keys.add(key);
                String base = prefix + (row.base.startsWith("/") ? row.base : "/" + row.base);
                Watch watch = watches.get(key);
                if (watch == null) {
                    watches.put(key, new Watch(row.id, key, base, row.root, row.title, peer.target, peer.name, row.readOnly));
                    watch = watches.get(key);
                } else {
                    watch.update(base, row.root, row.title);
                }
                watch.readOnly = row.readOnly;
                answered |= pollStatus(watch, true);
            }
            for (Watch watch : new ArrayList<>(watches.values())) {
                if (!watch.peer.equals(peer.target) || keys.contains(watch.key)) continue;
                watches.remove(watch.key);
                finishWatch(watch);
            }
        } catch (Exception e) {
            Log.d(TAG, "peer poll skipped", e);
        } finally {
            if (connection != null) connection.disconnect();
        }
        return answered;
    }

    /** One pane's status: asks and completion live here. */
    private boolean pollStatus(Watch watch, boolean peer) {
        if (stopping) return false;
        String prefix = watch.base;
        if (prefix.isEmpty()) {
            markStatusFailed(peer);
            return false;
        }
        HttpURLConnection connection = null;
        try {
            connection = open(prefix + "/status");
            if (connection.getResponseCode() != 200) {
                markStatusFailed(peer);
                return false;
            }
            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readText(input);
            }
            AskStatus status = AskStatus.parse(body);
            applyStatus(watch, status);
            return true;
        } catch (Exception e) {
            // The next tick tries again; a dead pane must not kill the rest.
            Log.d(TAG, "status poll skipped", e);
            markStatusFailed(peer);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void markStatusFailed(boolean peer) {
        if (peer) peerStatusFailed = true;
        else activeStatusFailed = true;
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
        rememberCounts();
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(RUNNING_ID, buildRunning());
        } catch (RuntimeException e) {
            // A permission revoked mid-turn must not stop the watcher.
            Log.w(TAG, "cannot refresh the running notification", e);
        }
    }

    /** Keep the Quick Settings tile's counts in step with this summary. */
    private void rememberCounts() {
        int running = 0;
        int waiting = 0;
        for (Watch watch : watches.values()) {
            if (watch.running) running++;
            if (watch.waiting) waiting++;
        }
        getSharedPreferences(ReasonixTileService.PREFS, MODE_PRIVATE)
                .edit()
                .putInt(ReasonixTileService.KEY_RUNNING, running)
                .putInt(ReasonixTileService.KEY_WAITING, waiting)
                .apply();
        ReasonixTileService.requestRefresh(this);
    }

    private void clearCounts() {
        getSharedPreferences(ReasonixTileService.PREFS, MODE_PRIVATE)
                .edit()
                .putInt(ReasonixTileService.KEY_RUNNING, 0)
                .putInt(ReasonixTileService.KEY_WAITING, 0)
                .apply();
        ReasonixTileService.requestRefresh(this);
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
        if (watch.readOnly || status.empty()) {
            if (!watch.askSignature.isEmpty()) cancelAsk(watch);
            return;
        }
        if (status.signature.equals(watch.askSignature)) return;
        if (!manager.areNotificationsEnabled()) return;
        watch.askSignature = status.signature;
        manager.notify(askId(watch.key), buildAsk(watch, status));
    }

    private Notification buildAsk(Watch watch, AskStatus status) {
        String heading = watch.title.isEmpty() ? "需要你处理" : watch.title;
        PendingIntent open = openChat(watch, askRequest(watch.key));
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ASK)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(heading)
                .setContentText(status.text)
                .setSubText(watch.peerName.isEmpty() ? "Reasonix" : watch.peerName)
                .setStyle(new Notification.BigTextStyle().bigText(status.text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                // A prompt can carry code and paths; the lock screen says only
                // that something is waiting until the phone is unlocked.
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicAsk())
                .setContentIntent(open);
        AskStatus.Choice choice = watch.readOnly ? null : status.choice;
        if (choice == null) {
            builder.addAction(R.drawable.ic_notification, "去回答", open);
        } else {
            int added = 0;
            for (int index = 0; index < choice.options.size() && added < 3; index++) {
                builder.addAction(
                        R.drawable.ic_notification,
                        choice.options.get(index),
                        decision(watch, choice, index));
                added++;
            }
            if (added < 3) {
                builder.addAction(R.drawable.ic_notification, "去回答", open);
            }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        return builder.build();
    }

    /** One action on the ask notification; the service settles it. */
    private PendingIntent decision(Watch watch, AskStatus.Choice choice, int index) {
        Intent intent = new Intent(this, TurnService.class);
        intent.setAction(ACTION_DECIDE);
        intent.putExtra(EXTRA_RUNTIME, watch.runtime);
        intent.putExtra(EXTRA_DECISION, choice.decisionId);
        intent.putExtra(EXTRA_QUESTION, choice.questionId);
        intent.putExtra(EXTRA_APPROVAL, choice.approval);
        if (choice.approval) {
            intent.putExtra(EXTRA_ALLOW, index != 1);
            intent.putExtra(EXTRA_SESSION, index == 2);
        } else {
            intent.putExtra(EXTRA_SELECTED, choice.options.get(index));
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        int request = REQUEST_DECISION_BASE + sessionBucket(watch.key) * 4 + index;
        return PendingIntent.getService(this, request, intent, flags);
    }

    /**
     * Settle the decision an action named.
     *
     * LAN goes straight through the proxy. Cloud has no upstream there — the
     * relay lives in the WebView — so the same POST is handed to the page's
     * bridge, and the next sweep reflects it.
     */
    private void decide(Intent intent) {
        String runtime = extra(intent, EXTRA_RUNTIME);
        Watch watch = watches.get(runtime);
        if (watch == null || watch.base.isEmpty()) return;
        String decisionId = extra(intent, EXTRA_DECISION);
        if (decisionId.isEmpty()) return;
        boolean approval = intent.getBooleanExtra(EXTRA_APPROVAL, false);
        try {
            JSONObject body = new JSONObject();
            String path;
            if (approval) {
                body.put("id", decisionId);
                body.put("allow", intent.getBooleanExtra(EXTRA_ALLOW, false));
                body.put("session", intent.getBooleanExtra(EXTRA_SESSION, false));
                body.put("persist", false);
                path = watch.base + "/approve";
            } else {
                JSONObject answer = new JSONObject();
                answer.put("QuestionID", extra(intent, EXTRA_QUESTION));
                answer.put("Selected", new JSONArray().put(extra(intent, EXTRA_SELECTED)));
                body.put("id", decisionId);
                body.put("answers", new JSONArray().put(answer));
                path = watch.base + "/answer";
            }
            if (cloud) {
                MainActivity.requestCloudDecision(path, body.toString());
                // Let the relay POST land before the next sweep reads status.
                mainHandler.postDelayed(this::pollCloud, 2_000);
                return;
            }
            decisions.execute(() -> {
                if (post(path, body)) {
                    pollStatus(watch, false);
                    mainHandler.post(this::refreshRunning);
                }
            });
        } catch (Exception e) {
            Log.d(TAG, "decision skipped", e);
        }
    }

    private boolean post(String path, JSONObject body) {
        HttpURLConnection connection = null;
        try {
            connection = open(path);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            // Name the app's own page: the proxy still refuses a foreign
            // Origin before routing a write.
            connection.setRequestProperty("Origin", "http://127.0.0.1:" + LoopbackProxy.PORT);
            connection.setRequestProperty("Referer", "http://127.0.0.1:" + LoopbackProxy.PORT + "/");
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(data.length);
            try (java.io.OutputStream out = connection.getOutputStream()) {
                out.write(data);
            }
            int code = connection.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** The lock-screen stand-in: no session title, no question text. */
    private Notification publicAsk() {
        return new Notification.Builder(this, CHANNEL_ASK)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Reasonix")
                .setContentText("有会话需要你处理")
                .setContentIntent(openApp())
                .build();
    }

    private Notification publicDone() {
        return new Notification.Builder(this, CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Reasonix")
                .setContentText("这一轮已完成")
                .setContentIntent(openApp())
                .build();
    }

    private void cancelAsk(Watch watch) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(askId(watch.key));
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
        NotificationChannel cloud = new NotificationChannel(
                CHANNEL_CLOUD, "云端后台提醒", NotificationManager.IMPORTANCE_LOW);
        cloud.setDescription("App 在后台时留意云端会话");
        cloud.setShowBadge(false);
        manager.createNotificationChannel(cloud);
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
            } else if (!watches.isEmpty()) {
                text = "没有正在运行的会话";
            } else if (!"cloud".equals(mode)) {
                text = "正在准备…";
            } else if (cloudLastCode.isEmpty()) {
                text = "后台提醒已开启，App 在后台时留意";
            } else if (!"ok".equals(cloudLastCode)) {
                text = "云端提醒暂时读不到会话";
            } else {
                text = "云端提醒：没有打开的会话";
            }
        }
        String channel = "cloud".equals(mode) ? CHANNEL_CLOUD : CHANNEL_RUNNING;
        return new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_notification)
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
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(heading)
                .setContentText("这一轮已完成")
                .setSubText(watch.peerName.isEmpty() ? "Reasonix" : watch.peerName)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicDone())
                .setContentIntent(openChat(watch, doneRequest(watch.key)))
                .build();
        manager.notify(doneId(watch.key), notification);
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
            if (!watch.peer.isEmpty()) {
                link += "&peer=" + Uri.encode(watch.peer) + "&peerName=" + Uri.encode(watch.peerName);
            }
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
