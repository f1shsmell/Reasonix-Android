package com.reasonix.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts and stops the foreground service that keeps a turn alive.
 *
 * It carries no protocol: the WebView still owns the SSE stream. The service
 * only raises process priority and posts the notification the person needs
 * when the phone is face down.
 */
@CapacitorPlugin(name = "TurnNotifications")
public class TurnPlugin extends Plugin {
    private static final String TAG = "ReasonixTurn";
    private static final int NOTIFICATION_REQUEST = 4102;

    @PluginMethod
    public void start(PluginCall call) {
        requestNotificationPermission();
        Context context = getContext();
        Intent intent = new Intent(context, TurnService.class);
        intent.setAction(TurnService.ACTION_START);
        String title = call.getString("title");
        if (title != null && !title.isEmpty()) intent.putExtra(TurnService.EXTRA_TITLE, title);
        String base = call.getString("base");
        if (base != null && !base.isEmpty()) intent.putExtra(TurnService.EXTRA_BASE, base);
        String root = call.getString("root");
        if (root != null && !root.isEmpty()) intent.putExtra(TurnService.EXTRA_ROOT, root);
        String runtime = call.getString("runtimeId");
        if (runtime != null && !runtime.isEmpty()) intent.putExtra(TurnService.EXTRA_RUNTIME, runtime);
        launch(intent);
        call.resolve(new JSObject());
    }

    /**
     * The persistent cloud watcher.
     *
     * It has to be started while the app is in the foreground: Android 12+
     * refuses a foreground-service start from the background. The service
     * itself skips polling while this activity is visible.
     */
    @PluginMethod
    public void startCloudWatch(PluginCall call) {
        requestNotificationPermission();
        Intent intent = new Intent(getContext(), TurnService.class);
        intent.setAction(TurnService.ACTION_START);
        intent.putExtra(TurnService.EXTRA_CLOUD, true);
        launch(intent);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void stopCloudWatch(PluginCall call) {
        TurnService.stopCloudWatchIfCloud();
        call.resolve(new JSObject());
    }

    /** Whether ask notifications may inline their options or only open the chat. */
    @PluginMethod
    public void setNotificationOptions(PluginCall call) {
        boolean show = Boolean.TRUE.equals(call.getBoolean("showOptions", false));
        getContext().getSharedPreferences(TurnService.PREFS_NOTIFY, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(TurnService.KEY_SHOW_OPTIONS, show)
                .apply();
        TurnService.notificationOptionsChanged();
        call.resolve(new JSObject());
    }

    private void launch(Intent intent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (RuntimeException e) {
            // A background start can be refused; the turn still runs, and the
            // next foreground entry will try again.
            Log.w(TAG, "cannot start the turn service", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        TurnService.completed = Boolean.TRUE.equals(call.getBoolean("completed", false));
        getContext().stopService(new Intent(getContext(), TurnService.class));
        call.resolve(new JSObject());
    }

    /** Whether the system will let this app keep working in the background. */
    @PluginMethod
    public void backgroundStatus(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        NotificationManager notifications =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        JSObject result = new JSObject();
        result.put("exempt",
                power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
        result.put("notifications", notifications != null && notifications.areNotificationsEnabled());
        call.resolve(result);
    }

    /** The settings page's copy-diagnostics row: version, device, permissions. */
    @PluginMethod
    public void diagnostics(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        try {
            android.content.pm.PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            result.put("version", info.versionName);
            result.put("build", Build.VERSION.SDK_INT >= 28
                    ? info.getLongVersionCode() : info.versionCode);
        } catch (PackageManager.NameNotFoundException e) {
            // The app's own package is always installed; leave the fields out.
        }
        result.put("android", Build.VERSION.RELEASE);
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("model", Build.MODEL);
        result.put("manufacturer", Build.MANUFACTURER);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        result.put("exempt",
                power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
        NotificationManager notifications =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        result.put("notifications", notifications != null && notifications.areNotificationsEnabled());
        result.put("cloud", TurnService.cloudStatus());
        call.resolve(result);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        openSystemSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), call);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        openSystemSettings(intent, call);
    }

    private void openSystemSettings(Intent intent, PluginCall call) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve(new JSObject());
        } catch (RuntimeException e) {
            call.reject("no system settings page for this action", e);
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        Activity activity = getActivity();
        if (activity == null) return;
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        activity.requestPermissions(
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
    }
}
