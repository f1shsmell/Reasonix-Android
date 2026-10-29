package com.reasonix.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Whether an activity is resumed; the turn service uses it to stay quiet. */
    public static volatile boolean visible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The WebView loads http://127.0.0.1:8788, so the proxy must be
        // listening before Capacitor starts its bridge, and the loopback
        // cookie must already be in this app's cookie jar.
        LoopbackProxy.start(getApplicationContext());
        LoopbackProxy.installWebViewCookie(getApplicationContext());
        registerPlugin(LoginPlugin.class);
        registerPlugin(PairPlugin.class);
        registerPlugin(RelaySocketPlugin.class);
        registerPlugin(TurnPlugin.class);
        super.onCreate(savedInstanceState);
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
        super.onPause();
    }
}
