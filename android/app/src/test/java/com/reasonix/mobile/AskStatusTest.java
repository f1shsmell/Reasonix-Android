package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AskStatusTest {
    @Test
    public void readsAnAskWithItsQuestion() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"id\":\"q1\",\"header\":\"用哪个方案\",\"prompt\":\"选一个\"}]}]}");

        assertFalse(status.empty());
        assertEquals(1, status.count);
        assertEquals("需要你回答 · 选一个", status.text);
        assertEquals("需要你回答", status.heading);
        assertEquals("选一个", status.question);
        assertTrue(status.signature.contains("d1"));
    }

    @Test
    public void namesAnApprovalAsAnApproval() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d2\",\"kind\":\"tool_approval\"}]}");

        assertEquals("需要你批准", status.text);
        assertEquals("需要你批准", status.heading);
        assertEquals("", status.question);
    }

    @Test
    public void countsWhatElseIsWaiting() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"先做哪个\"}]},"
                        + "{\"id\":\"d2\",\"kind\":\"tool_approval\"}]}");

        assertEquals(2, status.count);
        assertTrue(status.text.contains("先做哪个"));
        assertTrue(status.text.contains("还有 1 个"));
        assertTrue(status.signature.contains("d2"));
    }

    @Test
    public void answersEmptyForNoDecisions() {
        assertTrue(AskStatus.parse("{\"decisions\":[]}").empty());
        assertTrue(AskStatus.parse("{}").empty());
    }

    @Test
    public void answersEmptyForAnUnreadableBody() {
        assertTrue(AskStatus.parse("not json").empty());
        assertTrue(AskStatus.parse("").empty());
        assertTrue(AskStatus.parse(null).empty());
    }

    @Test
    public void carriesWhetherTheTurnIsStillRunning() {
        assertTrue(AskStatus.parse("{\"decisions\":[],\"running\":true}").running);
        assertFalse(AskStatus.parse("{\"decisions\":[]}").running);
        assertFalse(AskStatus.parse("not json").running);
    }

    @Test
    public void signatureChangesWhenTheQuestionChanges() {
        AskStatus first = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"甲\"}]}]}");
        AskStatus second = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"ask\",\"questions\":[{\"prompt\":\"乙\"}]}]}");

        assertFalse(first.signature.equals(second.signature));
    }

    @Test
    public void offersTheThreeApprovalActions() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d1\",\"kind\":\"tool_approval\"}]}");

        assertEquals(true, status.choice.approval);
        assertEquals("d1", status.choice.decisionId);
        assertEquals(3, status.choice.options.size());
        assertEquals("允许", status.choice.options.get(0));
    }

    @Test
    public void offersASingleChoiceQuestionsLabels() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d2\",\"kind\":\"ask\",\"questions\":[{"
                        + "\"id\":\"q1\",\"header\":\"选一个\",\"options\":["
                        + "{\"label\":\"茶\"},{\"label\":\"咖啡\"}]}]}]}");

        assertFalse(status.choice.approval);
        assertEquals("q1", status.choice.questionId);
        assertEquals(java.util.Arrays.asList("茶", "咖啡"), status.choice.options);
    }

    @Test
    public void keepsTheOpenActionForAMultiQuestionForm() {
        AskStatus form = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d6\",\"kind\":\"ask\",\"questions\":["
                        + "{\"id\":\"q1\",\"options\":[{\"label\":\"a\"}]},"
                        + "{\"id\":\"q2\",\"options\":[{\"label\":\"b\"}]}]}]}");

        assertEquals(null, form.choice);
    }

    @Test
    public void keepsTheOpenActionForAMultiSelectOrLongQuestion() {
        AskStatus multi = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d3\",\"kind\":\"ask\",\"questions\":[{"
                        + "\"id\":\"q1\",\"multi\":true,\"options\":[{\"label\":\"a\"}]}]}]}");
        AskStatus longList = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d4\",\"kind\":\"ask\",\"questions\":[{"
                        + "\"id\":\"q1\",\"options\":[{\"label\":\"a\"},{\"label\":\"b\"},"
                        + "{\"label\":\"c\"},{\"label\":\"d\"}]}]}]}");
        AskStatus freeText = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d5\",\"kind\":\"ask\",\"questions\":[{"
                        + "\"id\":\"q1\",\"prompt\":\"说说看\"}]}]}");
        AskStatus longLabel = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d6\",\"kind\":\"ask\",\"questions\":[{"
                        + "\"id\":\"q1\",\"options\":[{\"label\":\"这是一个很长的选项\"}]}]}]}");

        assertEquals(null, multi.choice);
        assertEquals(null, longList.choice);
        assertEquals(null, freeText.choice);
        assertEquals(null, longLabel.choice);
    }

    @Test
    public void readsTheRecordedStatusFixture() throws Exception {
        AskStatus status = AskStatus.parse(Fixtures.read("recorded/status.json"));

        assertTrue(status.empty());
        assertFalse(status.running);
    }

    @Test
    public void readsTheSharedContractFixture() throws Exception {
        AskStatus status = AskStatus.parse(Fixtures.read("status-ask.json"));

        assertEquals(2, status.count);
        assertTrue(status.running);
        assertTrue(status.text.contains("先做哪个"));
        assertTrue(status.signature.contains("d2"));
    }
}
