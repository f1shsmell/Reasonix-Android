package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** The Studio WebView's navigation table. */
public class WebModeLinksTest {
    private static final String PAGE = "reasonix.io";

    @Test
    public void keepsThePagesOwnOriginInside() {
        assertEquals(WebModeLinks.Verdict.LOAD, WebModeLinks.decide("https://reasonix.io/remote/", true, PAGE));
        assertEquals(WebModeLinks.Verdict.LOAD, WebModeLinks.decide("https://Reasonix.IO/next", true, PAGE));
        assertEquals(WebModeLinks.Verdict.LOAD, WebModeLinks.decide("https://reasonix.io:443/next", true, PAGE));
    }

    @Test
    public void keepsADeclaredHostInside() {
        // The cloud page hands itself from reasonix.io to studio.reasonix.io;
        // that is the same visit, not an external link.
        Set<String> allowed = new HashSet<>(Collections.singletonList("studio.reasonix.io"));
        assertEquals(
                WebModeLinks.Verdict.LOAD,
                WebModeLinks.decide("https://studio.reasonix.io/?device=1", true, PAGE, allowed));
        assertEquals(
                WebModeLinks.Verdict.EXTERNAL,
                WebModeLinks.decide("https://studio.reasonix.io/?device=1", true, PAGE));
        assertEquals(
                WebModeLinks.Verdict.EXTERNAL,
                WebModeLinks.decide("http://studio.reasonix.io/?device=1", true, PAGE, allowed));
        assertEquals(
                WebModeLinks.Verdict.EXTERNAL,
                WebModeLinks.decide("https://evil.example/", true, PAGE, allowed));
    }

    @Test
    public void sendsAnotherHostToTheBrowser() {
        assertEquals(
                WebModeLinks.Verdict.EXTERNAL,
                WebModeLinks.decide("https://id.reasonix.io/login", true, PAGE));
    }

    @Test
    public void leavesSubframesToThePage() {
        // A challenge or an embed lives in an iframe; the person must not be
        // thrown out of the Studio for it.
        assertEquals(
                WebModeLinks.Verdict.LOAD,
                WebModeLinks.decide("https://challenges.cloudflare.com/x", false, PAGE));
        assertEquals(WebModeLinks.Verdict.LOAD, WebModeLinks.decide("intent://x", false, PAGE));
    }

    @Test
    public void handsNonWebSchemesToTheirApp() {
        assertEquals(WebModeLinks.Verdict.HAND_OFF, WebModeLinks.decide("mailto:a@b.c", true, PAGE));
        assertEquals(WebModeLinks.Verdict.HAND_OFF, WebModeLinks.decide("reasonix://connect", true, PAGE));
        // These are non-web too; the activity's helper ignores them, which is
        // the same answer this rule gave before the extraction.
        assertEquals(WebModeLinks.Verdict.HAND_OFF, WebModeLinks.decide("about:blank", true, PAGE));
    }

    @Test
    public void refusesToGuessAtABrokenAddress() {
        assertEquals(WebModeLinks.Verdict.HAND_OFF, WebModeLinks.decide("http://[", true, PAGE));
        assertEquals(WebModeLinks.Verdict.HAND_OFF, WebModeLinks.decide("", true, PAGE));
    }

    @Test
    public void doesNotTrapAPageWhoseHostCouldNotBeRead() {
        assertEquals(WebModeLinks.Verdict.EXTERNAL, WebModeLinks.decide("https://reasonix.io/x", true, ""));
        assertEquals(WebModeLinks.Verdict.EXTERNAL, WebModeLinks.decide("https://reasonix.io/x", true, null));
    }
}
