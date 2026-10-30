package com.reasonix.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
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
