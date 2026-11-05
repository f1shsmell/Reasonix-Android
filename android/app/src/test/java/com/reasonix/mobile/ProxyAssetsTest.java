package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The bundle's content types; serving itself needs an Android Context. */
public class ProxyAssetsTest {
    @Test
    public void mapsEveryBundleExtensionTheWebViewLoads() {
        assertEquals("text/html; charset=utf-8", ProxyAssets.contentType("index.html"));
        assertEquals("text/javascript; charset=utf-8", ProxyAssets.contentType("app.js"));
        assertEquals("text/css; charset=utf-8", ProxyAssets.contentType("index.css"));
        assertEquals("application/json; charset=utf-8", ProxyAssets.contentType("manifest.json"));
        assertEquals("image/svg+xml", ProxyAssets.contentType("icon.svg"));
        assertEquals("font/woff2", ProxyAssets.contentType("font.woff2"));
    }

    @Test
    public void answersOctetStreamForAnythingElse() {
        assertEquals("application/octet-stream", ProxyAssets.contentType("archive.bin"));
        assertEquals("application/octet-stream", ProxyAssets.contentType("no-extension"));
    }
}
