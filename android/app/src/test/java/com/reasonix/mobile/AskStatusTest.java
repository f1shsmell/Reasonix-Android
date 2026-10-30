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
        assertEquals("需要你回答 · 用哪个方案", status.text);
        assertTrue(status.signature.contains("d1"));
    }

    @Test
    public void namesAnApprovalAsAnApproval() {
        AskStatus status = AskStatus.parse(
                "{\"decisions\":[{\"id\":\"d2\",\"kind\":\"tool_approval\"}]}");

        assertEquals("需要你批准", status.text);
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
}
