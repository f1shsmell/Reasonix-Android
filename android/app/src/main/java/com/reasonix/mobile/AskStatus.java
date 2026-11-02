package com.reasonix.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The decision part of `/rt/{id}/status`, reduced to what a notification says.
 *
 * The kernel derives decisions from the subsystem that owns them on every read;
 * this class only reads that answer. Pure and package-private so it can be
 * unit-tested without a Service.
 */
final class AskStatus {
    static final AskStatus EMPTY = new AskStatus("", "", 0, false, null);

    /** Changes when the set of decisions or their questions changes. */
    final String signature;
    /** One line for the notification body. */
    final String text;
    final int count;
    /** The turn is still working; a change to false completes a notification. */
    final boolean running;
    /** The first decision, when it can be settled from the notification. */
    final Choice choice;

    /**
     * One decision's inline actions.
     *
     * Approvals always fit (allow, deny, allow for the session). A question
     * only fits when it is single-select with at most three options; anything
     * else keeps the "open the conversation" action.
     */
    static final class Choice {
        final String decisionId;
        final String kind;
        final String questionId;
        final List<String> options;
        final boolean approval;

        Choice(String decisionId, String kind, String questionId, List<String> options, boolean approval) {
            this.decisionId = decisionId;
            this.kind = kind;
            this.questionId = questionId;
            this.options = options;
            this.approval = approval;
        }
    }

    private AskStatus(String signature, String text, int count, boolean running, Choice choice) {
        this.signature = signature;
        this.text = text;
        this.count = count;
        this.running = running;
        this.choice = choice;
    }

    boolean empty() {
        return count == 0;
    }

    static AskStatus parse(String json) {
        if (json == null || json.isEmpty()) return EMPTY;
        try {
            JSONObject body = new JSONObject(json);
            boolean running = body.optBoolean("running", false);
            JSONArray decisions = body.optJSONArray("decisions");
            // A working turn with nothing blocked is not a notification, but
            // its running state is what lets the watcher notice completion.
            if (decisions == null || decisions.length() == 0) {
                return new AskStatus("", "", 0, running, null);
            }
            StringBuilder signature = new StringBuilder();
            String first = "";
            int count = 0;
            Choice firstChoice = null;
            for (int index = 0; index < decisions.length(); index++) {
                JSONObject decision = decisions.optJSONObject(index);
                if (decision == null) continue;
                count++;
                String id = decision.optString("id", "");
                String kind = decision.optString("kind", "");
                String question = firstQuestion(decision);
                if (count == 1) {
                    first = label(kind) + (question.isEmpty() ? "" : " · " + question);
                    firstChoice = choiceOf(decision);
                }
                signature.append(id).append('|').append(kind).append('|').append(question).append(';');
                if (count == 1 && firstChoice != null) {
                    signature.append("options=");
                    for (String option : firstChoice.options) signature.append(option).append(',');
                    signature.append(';');
                }
            }
            if (count == 0) return new AskStatus("", "", 0, running, null);
            String text = first.isEmpty() ? "有新的问题等你处理" : first;
            if (count > 1) text += "（还有 " + (count - 1) + " 个）";
            return new AskStatus(signature.toString(), text, count, running, firstChoice);
        } catch (Exception ignored) {
            // A status this build cannot read is not a decision; never alert on it.
            return EMPTY;
        }
    }

    private static Choice choiceOf(JSONObject decision) {
        String id = decision.optString("id", "");
        String kind = decision.optString("kind", "");
        if ("tool_approval".equals(kind)
                || "plan_approval".equals(kind)
                || "recovery_approval".equals(kind)) {
            if (id.isEmpty()) return null;
            return new Choice(
                    id, kind, "", Arrays.asList("允许", "拒绝", "本会话允许"), true);
        }
        if (!"ask".equals(kind)) return null;
        JSONArray questions = decision.optJSONArray("questions");
        if (questions == null || questions.length() == 0) return null;
        JSONObject question = questions.optJSONObject(0);
        if (question == null || question.optBoolean("multi", false)) return null;
        JSONArray raw = question.optJSONArray("options");
        if (raw == null) return null;
        List<String> labels = new ArrayList<>();
        for (int index = 0; index < raw.length(); index++) {
            JSONObject option = raw.optJSONObject(index);
            String label = option == null ? "" : option.optString("label", "").trim();
            if (!label.isEmpty()) labels.add(label);
        }
        if (labels.isEmpty() || labels.size() > 3) return null;
        String questionId = question.optString("id", "");
        if (id.isEmpty() || questionId.isEmpty()) return null;
        return new Choice(id, kind, questionId, labels, false);
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
