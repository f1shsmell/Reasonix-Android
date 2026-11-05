package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/** The bundle's content types and its pre-read refusal rules. */
public class ProxyAssetsTest {
    private static final class FakeSocket extends Socket {
        final ByteArrayOutputStream out = new ByteArrayOutputStream();

        @Override
        public OutputStream getOutputStream() {
            return out;
        }

        String text() {
            return out.toString(StandardCharsets.ISO_8859_1);
        }
    }

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

    @Test
    public void servesAFileWithItsCachePolicy() throws Exception {
        List<String> opened = new ArrayList<>();
        ProxyAssets assets = new ProxyAssets(name -> {
            opened.add(name);
            return new ByteArrayInputStream("console.log(1)".getBytes(StandardCharsets.UTF_8));
        });
        FakeSocket socket = new FakeSocket();

        assertTrue(assets.serve(socket, "GET", "/app.js"));
        assertEquals(List.of("public/app.js"), opened);
        String response = socket.text();
        assertTrue(response.startsWith("HTTP/1.1 200 OK"));
        assertTrue(response.contains("Content-Type: text/javascript; charset=utf-8"));
        assertTrue(response.contains("Cache-Control: public, max-age=86400"));
        assertTrue(response.endsWith("console.log(1)"));
    }

    @Test
    public void servesIndexWithoutCachingIt() throws Exception {
        ProxyAssets assets = new ProxyAssets(name -> new ByteArrayInputStream("<html>".getBytes()));
        FakeSocket socket = new FakeSocket();

        assertTrue(assets.serve(socket, "GET", "/"));
        assertTrue(socket.text().contains("Cache-Control: no-store"));
    }

    @Test
    public void refusesTraversalAndControlPathsBeforeOpeningAnything() throws Exception {
        ProxyAssets assets = new ProxyAssets(name -> {
            throw new AssertionError("opened " + name);
        });
        FakeSocket socket = new FakeSocket();

        assertFalse(assets.serve(socket, "GET", "/../secret"));
        assertFalse(assets.serve(socket, "GET", "/__reasonix/config"));
        assertFalse(assets.serve(socket, "GET", "/runtimes"));
        assertFalse(assets.serve(socket, "GET", "/rt/ab12/status"));
    }

    @Test
    public void aMissingAssetIsANonStaticRoute() throws Exception {
        ProxyAssets assets = new ProxyAssets(name -> {
            throw new IOException("missing");
        });

        assertFalse(assets.serve(new FakeSocket(), "GET", "/app.js"));
    }
}