package com.reasonix.mobile;

import android.annotation.SuppressLint;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

/**
 * The Studio share page, loaded invisibly to spend a pairing code.
 *
 * The page's own `#pair=` bootstrap is the path a browser uses and the one
 * known to pair; the direct proxy POST has been refused on codes the page
 * accepts. This activity shows only a small "正在配对" card while a 2x2
 * WebView loads the same link. It succeeds when the page sets a NEW
 * `reasonix_device` credential — a phone that paired once keeps its cookie
 * for thirty days, so the value the jar held before the page loads is read
 * once and only a change counts — then finishes and hands the result to
 * PairPlugin.
 */
@SuppressLint("SetJavaScriptEnabled")
public class PairActivity extends ComponentActivity {
    private static final long TIMEOUT_MS = 15_000;
    static final String EXTRA_REASON = "reason";

    private final Handler handler = new Handler(Looper.getMainLooper());
    /** Kept for onDestroy: an invisible WebView with JS running still leaks if only GC'd. */
    private WebView web;
    private String origin = "";
    /** The credential the jar held before the page loaded: what the page
     *  writes is judged against this, not against mere existence. */
    private String credentialBefore = "";
    private long startedAt;
    private boolean done;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                finishWith(RESULT_CANCELED, "cancelled");
            }
        });
        String url = getIntent().getStringExtra("url");
        origin = getIntent().getStringExtra("origin");
        if (!Urls.isWebUrl(url) || !Urls.isWebUrl(origin)) {
            finishWith(RESULT_CANCELED, "invalid_url");
            return;
        }
        startedAt = System.currentTimeMillis();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.TRANSPARENT);

        WebView web = this.web = new WebView(this);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) finishWith(RESULT_CANCELED, "load_failed");
            }
        });
        web.setAlpha(0f);
        root.addView(web, new FrameLayout.LayoutParams(2, 2));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(48, 48, 48, 32);
        card.setBackgroundColor(Color.rgb(247, 248, 250));

        ProgressBar progress = new ProgressBar(this);
        TextView label = new TextView(this);
        label.setText("正在配对…");
        label.setTextSize(16);
        label.setTextColor(Color.rgb(20, 23, 28));
        label.setPadding(0, 16, 0, 20);

        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setAllCaps(false);
        cancel.setOnClickListener(v -> finishWith(RESULT_CANCELED, "cancelled"));

        card.addView(progress);
        card.addView(label);
        card.addView(cancel, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.gravity = Gravity.CENTER;
        root.addView(card, cardParams);

        setContentView(root);
        // Read before the page loads, so what the page writes is a change this
        // code can see rather than the copy it could not tell apart from one.
        credentialBefore = deviceCookieValue();
        web.loadUrl(url);
        handler.postDelayed(this::poll, 250);
    }

    private void poll() {
        if (done) return;
        if (hasDeviceCookie()) {
            // Persist the credential the page just set before the activity goes.
            CookieManager.getInstance().flush();
            finishWith(RESULT_OK, "paired");
            return;
        }
        if (System.currentTimeMillis() - startedAt > TIMEOUT_MS) {
            // A cookie that landed just after the last check is a success,
            // not a pairing to ask for a new code.
            CookieManager.getInstance().flush();
            boolean paired = hasDeviceCookie();
            finishWith(paired ? RESULT_OK : RESULT_CANCELED, paired ? "paired" : "timeout");
            return;
        }
        handler.postDelayed(this::poll, 250);
    }

    private boolean hasDeviceCookie() {
        return isNewCredential(credentialBefore, deviceCookieValue());
    }

    /**
     * A pairing is judged by a new credential, not by any credential. A phone
     * that paired once keeps its `reasonix_device` cookie for thirty days, and
     * the very first poll — before the page could have answered — would
     * otherwise find the old copy and call the pairing done; the page would be
     * torn down before it could spend the code, and the proxy would go on to
     * carry the stale credential, which the kernel refuses exactly as it
     * refuses a phone that never paired. Static and pure, so the judgement is
     * tested without a WebView.
     */
    static boolean isNewCredential(String before, String now) {
        return !now.isEmpty() && !now.equals(before);
    }

    /** The `reasonix_device` value at the one spelling of the door, or ""
     *  when the jar holds none. */
    private String deviceCookieValue() {
        try {
            String cookie = CookieManager.getInstance().getCookie(ProxyCookies.cookieUrl(origin));
            if (cookie == null) return "";
            for (String piece : cookie.split(";")) {
                String pair = piece.trim();
                if (pair.startsWith("reasonix_device=")) {
                    return pair.substring("reasonix_device=".length());
                }
            }
            return "";
        } catch (RuntimeException e) {
            return "";
        }
    }

    private void finishWith(int resultCode, String reason) {
        if (done) return;
        done = true;
        Intent data = new Intent();
        data.putExtra(EXTRA_REASON, reason);
        setResult(resultCode, data);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
