package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The version gate and the sheet's shape, checked on the JVM: the parsing has
 * to survive the user agents phones actually send, and the sheet must never
 * contain a quote (it is injected inside a single-quoted JS string).
 */
public class StudioCompatTest {
    @Test
    public void readsTheChromeMajorFromARealWebViewAgent() {
        String webView = "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Zoom Edition Build/SKQ1.211006.001; wv) "
                + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/96.0.4664.104 Mobile Safari/537.36";
        assertEquals(96, StudioCompat.chromeMajor(webView));
    }

    @Test
    public void handlesAModernAgentAndAMarkerSuffix() {
        String modern = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36 rx-studio/1";
        assertEquals(131, StudioCompat.chromeMajor(modern));
    }

    @Test
    public void returnsZeroWhenThereIsNothingToRead() {
        assertEquals(0, StudioCompat.chromeMajor(null));
        assertEquals(0, StudioCompat.chromeMajor(""));
        assertEquals(0, StudioCompat.chromeMajor("Mozilla/5.0 AppleWebKit/537.36"));
        assertEquals(0, StudioCompat.chromeMajor("Chrome/"));
        assertEquals(0, StudioCompat.chromeMajor("Chrome/abc"));
    }

    @Test
    public void onlyAnOlderEngineNeedsTheSheet() {
        // oklch() and color-mix() arrived in Chrome 111.
        assertTrue(StudioCompat.needsCompat(96));
        assertTrue(StudioCompat.needsCompat(110));
        assertFalse(StudioCompat.needsCompat(111));
        assertFalse(StudioCompat.needsCompat(131));
        // Unknown is not "old": do not repaint a browser we could not read.
        assertFalse(StudioCompat.needsCompat(0));
    }

    @Test
    public void theSheetCarriesBothThemesAndRepaintsTheCoreSurfaces() {
        String css = StudioCompat.css();
        assertTrue(css.contains("--page:#f4f1ea"));
        assertTrue(css.contains(":root[data-theme=dark]"));
        assertTrue(css.contains("--page:#060a10"));
        // Every declaration has to win over the page's own higher-specificity
        // theme blocks, so none of them may be a plain override.
        assertTrue(css.contains("--text:#342e22 !important"));
    }

    @Test
    public void theSheetIsSafeInsideASingleQuotedJsString() {
        String css = StudioCompat.css();
        assertFalse(css.contains("'"));
        assertFalse(css.contains("\""));
        assertFalse(css.contains("\\"));
        assertFalse(css.contains("\n"));
    }
}
