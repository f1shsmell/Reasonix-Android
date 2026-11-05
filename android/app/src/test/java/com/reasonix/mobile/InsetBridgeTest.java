package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The arithmetic behind the inset the page is handed, checked on the JVM.
 *
 * The measured values come from the device this was diagnosed on: a 96px
 * status bar at density 2.75, where the WebView starts 96px down the screen.
 * That pairing is the whole bug — `env()` reported 96px there too, so the page
 * padded a second bar's worth beneath one it was already clear of.
 */
public class InsetBridgeTest {
    private static final float DENSITY = 2.75f;

    @Test
    public void aPageAlreadyBelowTheBarIsOwedNothing() {
        // The reported device: 96px of screen already cleared by the window.
        assertEquals(0, InsetBridge.cssInset(96, 96, DENSITY));
    }

    @Test
    public void aPageLaidUnderTheBarIsOwedTheWholeBar() {
        // The other arrangement Capacitor can pick: the WebView starts at 0.
        assertEquals(35, InsetBridge.cssInset(96, 0, DENSITY));
    }

    @Test
    public void aPagePartlyClearOfTheBarIsOwedOnlyTheDifference() {
        // A shorter bar, or a window pushed down by something else.
        assertEquals(24, InsetBridge.cssInset(96, 30, DENSITY));
    }

    @Test
    public void aViewPushedPastTheBarOwesNoNegativeSpace() {
        // A cutout taller than the status bar inset must not produce a negative
        // padding, which CSS would reject and the page would silently ignore.
        assertEquals(0, InsetBridge.cssInset(96, 140, DENSITY));
        // A WebView positioned off the top of the screen clamps to 0, so the
        // page is owed the bar in full rather than an out-of-range value.
        assertEquals(35, InsetBridge.cssInset(96, -20, DENSITY));
    }

    @Test
    public void anUnknownDensityReportsNothing() {
        // Guards against a zero density turning into an infinity.
        assertEquals(0, InsetBridge.cssInset(96, 0, 0f));
        assertEquals(0, InsetBridge.cssInset(96, 0, -1f));
    }

    @Test
    public void theScriptWritesThePropertyTheCssReads() {
        String js = InsetBridge.script(35);
        assertTrue(js.contains("--rx-inset-top"));
        assertTrue(js.contains("'35px'"));
        // A page whose documentElement is not ready yet must not throw.
        assertTrue(js.contains("try{"));
        assertTrue(js.contains("catch(e){}"));
    }
}
