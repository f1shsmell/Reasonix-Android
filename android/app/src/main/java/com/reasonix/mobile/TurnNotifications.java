package com.reasonix.mobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

import java.util.ArrayList;
import java.util.Collection;

import static com.reasonix.mobile.TurnNotificationIds.askId;
import static com.reasonix.mobile.TurnNotificationIds.askRequest;
import static com.reasonix.mobile.TurnNotificationIds.doneId;
import static com.reasonix.mobile.TurnNotificationIds.doneRequest;
import static com.reasonix.mobile.TurnNotificationChannels.CHANNEL_DONE;

/** Builds and cancels the notifications a watcher posts. */
final class TurnNotifications {
    private TurnNotifications() {}

    /**
     * Post, keep or cancel one pane's ask.
     *
     * The signature is the identity of the question; only a change posts again.
     */
    static void syncAsk(Context context, PaneWatch watch, AskStatus status, boolean stopping) {
        if (stopping) return;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (watch.readOnly || status.empty()) {
            if (!watch.askSignature.isEmpty()) cancelAsk(context, watch);
            return;
        }
        if (!TurnNotifyPrefs.read(context, TurnNotifyPrefs.KEY_ASK, true)) {
            // Off means nothing is posted, and an ask already waiting in the
            // shade is removed: a switch that stopped new prompts but left old
            // ones on screen would read as broken. The signature is cleared so
            // turning it back on posts the current prompt again at once.
            if (!watch.askSignature.isEmpty()) cancelAsk(context, watch);
            return;
        }
        if (status.signature.equals(watch.askSignature)) return;
        if (!manager.areNotificationsEnabled()) return;
        watch.askSignature = status.signature;
        manager.notify(askId(watch.key), buildAsk(context, watch, status));
    }

    private static Notification buildAsk(Context context, PaneWatch watch, AskStatus status) {
        String heading = TurnNotificationText.askHeading(status);
        String body = TurnNotificationText.askBody(status);
        String session = TurnNotificationText.session(watch);
        android.app.PendingIntent open =
                TurnIntents.chatPending(context, watch, askRequest(watch.key), true);
        Notification.Builder builder = new Notification.Builder(context, TurnNotifyPrefs.askChannel(context))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(heading)
                .setContentText(body)
                .setSubText(session)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                // A prompt can carry code and paths; the lock screen says only
                // that something is waiting until the phone is unlocked.
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicAsk(context))
                .setContentIntent(open);
        boolean showOptions = TurnNotifyPrefs.showOptions(context);
        AskStatus.Choice choice = watch.readOnly || !showOptions ? null : status.choice;
        if (choice == null) {
            builder.addAction(R.drawable.ic_notification, "去回答", open);
        } else {
            int added = 0;
            for (int index = 0; index < choice.options.size() && added < 3; index++) {
                builder.addAction(
                        R.drawable.ic_notification,
                        choice.options.get(index),
                        TurnIntents.decisionPending(context, watch, choice, index));
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

    static Notification running(Context context, Collection<PaneWatch> watches, boolean cloud,
                                boolean offline, String cloudLastCode) {
        int running = 0;
        int waiting = 0;
        for (PaneWatch watch : watches) {
            if (watch.running) running++;
            if (watch.waiting) waiting++;
        }
        String text = TurnNotificationText.running(
                running, waiting, cloud, !watches.isEmpty(), offline, cloudLastCode);
        String channel = TurnNotifyPrefs.runningChannel(context, cloud);
        return new Notification.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Reasonix")
                .setContentText(text)
                .setSubText("Reasonix")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(TurnIntents.appPending(context))
                .build();
    }

    static void finished(Context context, PaneWatch watch) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        // Off means the notification is not posted. A done already in the shade
        // is left alone: it reports something that really finished, and the
        // switch is about future turns rather than erasing history.
        if (!TurnNotifyPrefs.read(context, TurnNotifyPrefs.KEY_DONE, true)) return;
        String heading = watch.title == null || watch.title.isEmpty() ? "Reasonix" : watch.title;
        Notification notification = new Notification.Builder(context, CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(heading)
                .setContentText("这一轮已完成")
                .setSubText(watch.peerName.isEmpty() ? "Reasonix" : watch.peerName)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicDone(context))
                .setContentIntent(TurnIntents.chatPending(
                        context, watch, doneRequest(watch.key), false))
                .build();
        manager.notify(doneId(watch.key), notification);
    }

    static void cancelAsk(Context context, PaneWatch watch) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(askId(watch.key));
        watch.askSignature = "";
    }

    static void cancelAsks(Context context, Collection<PaneWatch> watches) {
        for (PaneWatch watch : new ArrayList<>(watches)) cancelAsk(context, watch);
    }

    /** The lock-screen stand-in: no session title, no question text. */
    private static Notification publicAsk(Context context) {
        return new Notification.Builder(context, TurnNotifyPrefs.askChannel(context))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Reasonix")
                .setContentText("有会话需要你处理")
                .setContentIntent(TurnIntents.appPending(context))
                .build();
    }

    private static Notification publicDone(Context context) {
        return new Notification.Builder(context, CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Reasonix")
                .setContentText("这一轮已完成")
                .setContentIntent(TurnIntents.appPending(context))
                .build();
    }
}