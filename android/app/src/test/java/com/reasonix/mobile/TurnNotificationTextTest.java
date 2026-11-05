package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class TurnNotificationTextTest {
    @Test
    public void offlineWinsOverEveryCount() {
        assertEquals("连接中断，正在重试…",
                TurnNotificationText.running(2, 1, false, true, true, "ok"));
    }

    @Test
    public void countsWaitingAndRunningInTheRightOrder() {
        assertEquals("局域网 · 2 个运行中 · 1 个待处理",
                TurnNotificationText.running(2, 1, false, true, false, ""));
        assertEquals("云端 · 1 个待处理",
                TurnNotificationText.running(0, 1, true, true, false, ""));
        assertEquals("局域网 · 2 个会话运行中",
                TurnNotificationText.running(2, 0, false, true, false, ""));
    }

    @Test
    public void explainsAnEmptyWatchList() {
        assertEquals("正在准备…",
                TurnNotificationText.running(0, 0, false, false, false, ""));
        assertEquals("后台提醒已开启，App 在后台时留意",
                TurnNotificationText.running(0, 0, true, false, false, ""));
        assertEquals("云端提醒暂时读不到会话",
                TurnNotificationText.running(0, 0, true, false, false, "watch.failed"));
        assertEquals("云端提醒：没有打开的会话",
                TurnNotificationText.running(0, 0, true, false, false, "ok"));
    }

    @Test
    public void anAskCarriesItsQuestionAndRemainingCount() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":["
                        + "{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"先做哪个\"}]},"
                        + "{\"id\":\"d2\",\"kind\":\"tool_approval\"}]}");

        assertEquals("需要你回答", TurnNotificationText.askHeading(status));
        assertEquals("先做哪个（还有 1 个）", TurnNotificationText.askBody(status));
    }

    @Test
    public void aSingleAskWithoutAQuestionPointsAtTheScreen() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"配好了吗\"}]}]}");

        assertEquals("配好了吗", TurnNotificationText.askBody(status));
        assertEquals("需要你回答", TurnNotificationText.askHeading(status));
    }

    @Test
    public void sessionFallsBackFromTitleToPeerToProduct() {
        PaneWatch titled = new PaneWatch("r1", "r1", "/rt/r1", "/work", "会话", "", "", false);
        PaneWatch peer = new PaneWatch("r2", "p:r2", "/rt/r2", "/work", "", "http://a:1", "工作站", false);
        PaneWatch bare = new PaneWatch("r3", "r3", "/rt/r3", "/work", "", "", "", false);

        assertEquals("会话", TurnNotificationText.session(titled));
        assertEquals("工作站", TurnNotificationText.session(peer));
        assertEquals("Reasonix", TurnNotificationText.session(bare));
    }
}