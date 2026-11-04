package com.reasonix.mobile;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    /** Whether an activity is resumed; the turn service uses it to stay quiet. */
    public static volatile boolean visible = false;
    /** The page the cloud watcher asks for status; null once the screen is gone. */
    private static volatile WebView webView;
    /** This activity's own page, so an old destroy cannot clear a newer one. */
    private WebView ownWebView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The WebView loads http://127.0.0.1:8788, so the proxy must be
        // listening before Capacitor starts its bridge, and the loopback
        // cookie must already be in this app's cookie jar.
        LoopbackProxy.start(getApplicationContext());
        LoopbackProxy.installWebViewCookie(getApplicationContext());
        registerPlugin(LoginPlugin.class);
        registerPlugin(SpeechPlugin.class);
        registerPlugin(PairPlugin.class);
        registerPlugin(WebModePlugin.class);
        registerPlugin(RelaySocketPlugin.class);
        registerPlugin(NetworkWatchPlugin.class);
        registerPlugin(TurnPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(ThemeBarPlugin.class);
        super.onCreate(savedInstanceState);
        WebView view = getBridge() == null ? null : getBridge().getWebView();
        ownWebView = view;
        webView = view;
        if (view != null) {
            view.addJavascriptInterface(new CloudWatchBridge(), "__reasonixCloudWatchResult");
        }
        // The pre-super install is the load-bearing one: Capacitor starts
        // its first navigation inside super.onCreate. This retry only helps
        // a WebView created later and is harmless if the cookie is already
        // present.
        LoopbackProxy.installWebViewCookie(getApplicationContext());
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        TurnService.wakeCloud();
        super.onPause();
    }

    @Override
    public void onDestroy() {
        if (webView == ownWebView) webView = null;
        ownWebView = null;
        super.onDestroy();
    }

    /** The cloud watcher's one native→JS call; false when there is no page. */
    static boolean requestCloudSweep() {
        WebView view = webView;
        if (view == null) return false;
        try {
            view.post(() -> {
                try {
                    view.evaluateJavascript(
                            "window.__reasonixCloudWatch&&window.__reasonixCloudWatch()", null);
                } catch (Throwable ignored) {
                    // The WebView was destroyed between the check and the post.
                }
            });
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** The page reports one snapshot; the service owns the notification state. */
    static final class CloudWatchBridge {
        @JavascriptInterface
        public void deliver(String json) {
            TurnService.deliverCloud(json);
        }
    }

    /** Hand one decision to the page, which posts it through the relay. */
    static void requestCloudDecision(String path, String body) {
        WebView view = webView;
        if (view == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("path", path);
            payload.put("body", body);
            String js = "window.__reasonixCloudDecide&&window.__reasonixCloudDecide(" + payload + ")";
            view.post(() -> {
                try {
                    view.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                    // The page was destroyed before the action reached it.
                }
            });
        } catch (JSONException ignored) {
            // The path and body are built from parsed JSON; this cannot happen.
        }
    }
}
