package com.reasonix.mobile;

import android.app.Activity;
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

/**
 * The Studio share page, loaded invisibly to spend a pairing code.
 *
 * The page's own `#pair=` bootstrap is the path a browser uses and the one
 * known to pair; the direct proxy POST has been refused on codes the page
 * accepts. This activity shows only a small "正在配对" card while a 2x2
 * WebView loads the same link. It succeeds when the `reasonix_device` cookie
 * appears, then finishes and hands the result to PairPlugin.
 */
public class PairActivity extends Activity {
    private static final long TIMEOUT_MS = 15_000;
    static final String EXTRA_REASON = "reason";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String origin = "";
    private long startedAt;
    private boolean done;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        origin = getIntent().getStringExtra("origin");
        if (!Urls.isWebUrl(url) || !Urls.isWebUrl(origin)) {
            finishWith(RESULT_CANCELED, "invalid_url");
            return;
        }
        startedAt = System.currentTimeMillis();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.TRANSPARENT);

        WebView web = new WebView(this);
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
        try {
            String cookie = CookieManager.getInstance()
                    .getCookie(origin.endsWith("/") ? origin : origin + "/");
            return cookie != null && cookie.contains("reasonix_device=");
        } catch (RuntimeException e) {
            return false;
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
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        finishWith(RESULT_CANCELED, "cancelled");
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
