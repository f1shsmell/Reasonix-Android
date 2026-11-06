package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class JsStringTest {
    @Test
    public void escapesTheLineTerminatorsOldWebViewsReject() {
        assertEquals("\"a\\u2028b\"", JsString.quote("a\u2028b"));
        assertEquals("\"a\\u2029b\"", JsString.quote("a\u2029b"));
    }

    @Test
    public void keepsQuotesAndBackslashesInert() {
        assertEquals("\"a\\\"b\"", JsString.quote("a\"b"));
        assertEquals("\"a\\\\b\"", JsString.quote("a\\b"));
    }
}
