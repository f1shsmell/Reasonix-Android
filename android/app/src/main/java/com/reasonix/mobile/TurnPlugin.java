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
        String mode = call.getString("mode");
        if (mode != null && !mode.isEmpty()) intent.putExtra(TurnService.EXTRA_MODE, mode);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException e) {
            // A background start can be refused; the turn still runs, and the
            // next foreground entry will try again.
            Log.w(TAG, "cannot start the turn service", e);
        }
        call.resolve(new JSObject());
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
