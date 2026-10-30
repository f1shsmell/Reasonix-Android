package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The decision part of `/rt/{id}/status`, reduced to what a notification says.
 *
 * The kernel derives decisions from the subsystem that owns them on every read;
 * this class only reads that answer. Pure and package-private so it can be
 * unit-tested without a Service.
 */
final class AskStatus {
    static final AskStatus EMPTY = new AskStatus("", "", 0);

    /** Changes when the set of decisions or their questions changes. */
    final String signature;
    /** One line for the notification body. */
    final String text;
    final int count;

    private AskStatus(String signature, String text, int count) {
        this.signature = signature;
        this.text = text;
        this.count = count;
    }

    boolean empty() {
        return count == 0;
    }

    static AskStatus parse(String json) {
        if (json == null || json.isEmpty()) return EMPTY;
        try {
            JSONArray decisions = new JSONObject(json).optJSONArray("decisions");
            if (decisions == null || decisions.length() == 0) return EMPTY;
            StringBuilder signature = new StringBuilder();
            String first = "";
            int count = 0;
            for (int index = 0; index < decisions.length(); index++) {
                JSONObject decision = decisions.optJSONObject(index);
                if (decision == null) continue;
                count++;
                String id = decision.optString("id", "");
                String kind = decision.optString("kind", "");
                String question = firstQuestion(decision);
                if (count == 1) {
                    first = label(kind) + (question.isEmpty() ? "" : " · " + question);
                }
                signature.append(id).append('|').append(kind).append('|').append(question).append(';');
            }
            if (count == 0) return EMPTY;
            String text = first.isEmpty() ? "有新的问题等你处理" : first;
            if (count > 1) text += "（还有 " + (count - 1) + " 个）";
            return new AskStatus(signature.toString(), text, count);
        } catch (Exception ignored) {
            // A status this build cannot read is not a decision; never alert on it.
            return EMPTY;
        }
    }

    private static String firstQuestion(JSONObject decision) {
        JSONArray questions = decision.optJSONArray("questions");
        if (questions == null || questions.length() == 0) return "";
        JSONObject question = questions.optJSONObject(0);
        if (question == null) return "";
        String header = question.optString("header", "").trim();
        if (!header.isEmpty()) return header;
        return question.optString("prompt", "").trim();
    }

    static String label(String kind) {
        switch (kind) {
            case "ask":
                return "需要你回答";
            case "tool_approval":
                return "需要你批准";
            case "plan_approval":
                return "需要你批准计划";
            case "recovery_approval":
                return "需要你恢复";
            default:
                return "需要你处理";
        }
    }
}
