package com.reasonix.mobile;

/** The sentences the notification builders put on screen. */
final class TurnNotificationText {
    private TurnNotificationText() {}

    static String running(int running, int waiting, boolean cloud, boolean hasWatches,
                          boolean offline, String cloudLastCode) {
        if (offline) return "连接中断，正在重试…";
        String where = cloud ? "云端 · " : "局域网 · ";
        if (waiting > 0) {
            return where + (running > 0
                    ? running + " 个运行中 · " + waiting + " 个待处理"
                    : waiting + " 个待处理");
        }
        if (running > 0) return where + running + " 个会话运行中";
        if (hasWatches) return "没有正在运行的会话";
        if (!cloud) return "正在准备…";
        if (cloudLastCode.isEmpty()) return "后台提醒已开启，App 在后台时留意";
        if (!"ok".equals(cloudLastCode)) return "云端提醒暂时读不到会话";
        return "云端提醒：没有打开的会话";
    }

    static String askHeading(AskStatus status) {
        return status.heading.isEmpty() ? "需要你处理" : status.heading;
    }

    static String askBody(AskStatus status) {
        if (status.question.isEmpty()) {
            return status.count > 1 ? status.text : "点开查看并处理";
        }
        String body = status.question;
        if (status.count > 1) body += "（还有 " + (status.count - 1) + " 个）";
        return body;
    }

    static String session(PaneWatch watch) {
        if (!watch.title.isEmpty()) return watch.title;
        return watch.peerName.isEmpty() ? "Reasonix" : watch.peerName;
    }
}