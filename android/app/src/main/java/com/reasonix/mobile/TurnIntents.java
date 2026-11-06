package com.reasonix.mobile;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import static com.reasonix.mobile.TurnNotificationIds.REQUEST_DECISION_BASE;
import static com.reasonix.mobile.TurnNotificationIds.sessionBucket;

/** The intents a notification action can start. */
final class TurnIntents {
    private TurnIntents() {}

    static PendingIntent appPending(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, 0, intent, flags());
    }

    /** Open the conversation that was blocked; fall back to the app. */
    static PendingIntent chatPending(Context context, PaneWatch watch,
                                     int requestCode, boolean focusAsk) {
        Intent intent;
        if (!watch.runtime.isEmpty()) {
            String link = "reasonix://chat?runtime=" + Uri.encode(watch.runtime)
                    + "&root=" + Uri.encode(watch.root)
                    + "&title=" + Uri.encode(watch.title);
            if (!watch.peer.isEmpty()) {
                link += "&peer=" + Uri.encode(watch.peer)
                        + "&peerName=" + Uri.encode(watch.peerName);
            }
            if (focusAsk) link += "&focus=ask";
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity.class);
        } else {
            intent = new Intent(context, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent, flags());
    }

    /** One action on the ask notification; the service settles it. */
    static PendingIntent decisionPending(Context context, PaneWatch watch,
                                         AskStatus.Choice choice, int index) {
        Intent intent = new Intent(context, TurnService.class);
        intent.setAction(TurnService.ACTION_DECIDE);
        // The map key, not the bare runtime id: peer watches are filed under
        // "p:<target>:<id>", so a decision tap must name the row the way the
        // service looks it up, or it resolves to nothing (or to a same-id
        // pane on another computer).
        intent.putExtra(TurnService.EXTRA_RUNTIME, watch.key);
        intent.putExtra(TurnService.EXTRA_DECISION, choice.decisionId);
        intent.putExtra(TurnService.EXTRA_QUESTION, choice.questionId);
        intent.putExtra(TurnService.EXTRA_APPROVAL, choice.approval);
        if (choice.approval) {
            intent.putExtra(TurnService.EXTRA_ALLOW, index != 1);
            intent.putExtra(TurnService.EXTRA_SESSION, index == 2);
        } else {
            intent.putExtra(TurnService.EXTRA_SELECTED, choice.options.get(index));
        }
        int request = REQUEST_DECISION_BASE + sessionBucket(watch.key) * 4 + index;
        return PendingIntent.getService(context, request, intent, flags());
    }

    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }
}