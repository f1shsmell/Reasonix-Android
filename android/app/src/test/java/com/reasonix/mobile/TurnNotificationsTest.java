package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotification;
import org.robolectric.shadows.ShadowNotificationManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class TurnNotificationsTest {
    private Context context;
    private NotificationManager manager;
    private ShadowNotificationManager shadow;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        TurnNotificationChannels.create(context);
        manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        shadow = shadowOf(manager);
        manager.cancelAll();
        shadow.setNotificationsEnabled(true);
        context.getSharedPreferences(TurnNotifyPrefs.PREFS, Context.MODE_PRIVATE)
                .edit().clear().commit();
    }

    private static PaneWatch watch(String runtime) {
        return new PaneWatch(runtime, runtime, "/rt/" + runtime, "/work", "会话", "", "", false);
    }

    private static AskStatus ask(String prompt, int count) {
        StringBuilder decisions = new StringBuilder();
        for (int i = 0; i < count; i++) {
            if (i > 0) decisions.append(',');
            decisions.append("{\"id\":\"d").append(i)
                    .append("\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"")
                    .append(prompt).append("\"}]}");
        }
        return AskStatus.parse("{\"running\":true,\"decisions\":[" + decisions + "]}");
    }

    @Test
    public void postsAnAskAndCancelsIt() {
        PaneWatch watch = watch("r1");
        TurnNotifications.syncAsk(context, watch, ask("选一个", 1), false);

        Notification posted = shadow.getNotification(TurnNotificationIds.askId("r1"));
        assertNotNull(posted);
        ShadowNotification notification = shadowOf(posted);
        assertEquals("需要你回答", notification.getContentTitle().toString());

        TurnNotifications.cancelAsk(context, watch);
        assertNull(shadow.getNotification(TurnNotificationIds.askId("r1")));
    }

    @Test
    public void anEmptyStatusRemovesAWaitingAsk() {
        PaneWatch watch = watch("r1");
        TurnNotifications.syncAsk(context, watch, ask("选一个", 1), false);
        assertNotNull(shadow.getNotification(TurnNotificationIds.askId("r1")));

        TurnNotifications.syncAsk(context, watch, AskStatus.EMPTY, false);
        assertNull(shadow.getNotification(TurnNotificationIds.askId("r1")));
    }

    @Test
    public void turningAsksOffRemovesOneAlreadyInTheShade() {
        PaneWatch watch = watch("r1");
        TurnNotifications.syncAsk(context, watch, ask("选一个", 1), false);
        context.getSharedPreferences(TurnNotifyPrefs.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(TurnNotifyPrefs.KEY_ASK, false).commit();

        TurnNotifications.syncAsk(context, watch, ask("选一个", 1), false);
        assertNull(shadow.getNotification(TurnNotificationIds.askId("r1")));
    }

    @Test
    public void readOnlyPanesNeverPostAnAsk() {
        PaneWatch readOnly = new PaneWatch(
                "r1", "r1", "/rt/r1", "/work", "会话", "", "", true);
        TurnNotifications.syncAsk(context, readOnly, ask("选一个", 1), false);

        assertNull(shadow.getNotification(TurnNotificationIds.askId("r1")));
    }

    @Test
    public void aFinishedTurnPostsUnlessSwitchedOff() {
        PaneWatch watch = watch("r1");
        TurnNotifications.finished(context, watch);
        assertNotNull(shadow.getNotification(TurnNotificationIds.doneId("r1")));

        context.getSharedPreferences(TurnNotifyPrefs.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(TurnNotifyPrefs.KEY_DONE, false).commit();
        TurnNotifications.finished(context, watch("r2"));
        assertNull(shadow.getNotification(TurnNotificationIds.doneId("r2")));
    }

    @Test
    public void theRunningSummaryCountsBothStates() {
        PaneWatch running = watch("r1");
        running.running = true;
        PaneWatch waiting = watch("r2");
        waiting.waiting = true;
        PaneWatch idle = watch("r3");

        Notification notification = TurnNotifications.running(
                context, java.util.Arrays.asList(running, waiting, idle), false, false, "");
        ShadowNotification posted = shadowOf(notification);
        assertEquals("Reasonix", posted.getContentTitle().toString());
        assertEquals("局域网 · 1 个运行中 · 1 个待处理", posted.getContentText().toString());
        assertTrue(notification.flags != 0);
    }
}