package com.reasonix.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlsTest {
    @Test
    public void acceptsHttpAndHttps() {
        assertTrue(Urls.isWebUrl("https://id.reasonix.io/device"));
        assertTrue(Urls.isWebUrl("http://192.168.1.20:8788/#pair=abc"));
    }

    @Test
    public void refusesOtherSchemes() {
        assertFalse(Urls.isWebUrl("javascript:alert(1)"));
        assertFalse(Urls.isWebUrl("file:///data/data/com.reasonix.mobile/x"));
        assertFalse(Urls.isWebUrl("content://com.example/x"));
        assertFalse(Urls.isWebUrl("intent://scan/#Intent;end"));
    }

    @Test
    public void refusesMissingOrMalformedValues() {
        assertFalse(Urls.isWebUrl(null));
        assertFalse(Urls.isWebUrl(""));
        assertFalse(Urls.isWebUrl("not a url"));
    }
}
