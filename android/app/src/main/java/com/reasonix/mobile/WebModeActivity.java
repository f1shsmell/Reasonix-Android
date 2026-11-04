package com.reasonix.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.View;
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
 * The paired computer's own Studio page, full screen.
 *
 * The kernel serves the whole Studio SPA on its port, and the phone-browser
 * path ("设备访问" share QR) is that same page with no native bridge at all —
 * so this activity is deliberately a plain WebView: the page owns its
 * connection, its SSE stream and its own reconnection, and the app's proxy and
 * link machine stay out of its way. What the pairing left behind travels with
 * the CookieManager, which every WebView in this process shares; a lost cookie
 * falls back to the page's own connect screen, exactly like a browser.
 *
 * Only the paired (or share) origin runs here. Anything else — the account
 * sign-in page, an external link in the transcript — is handed to the browser
 * so the page never becomes a general-purpose window.
 */
public class WebModeActivity extends Activity {
    private WebView web;
    private TextView errorCard;
    private Button retryButton;
    private ProgressBar progress;
    private String origin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        if (!Urls.isWebUrl(url)) {
            finish();
            return;
        }
        origin = originOf(url);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        web = new WebView(this);
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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String target = uri.toString();
                // Another host is not ours to swallow: the account sign-in and
                // shared links go to the browser, like a tap in Chrome would.
                if (!Urls.isWebUrl(target)) return true;
                String host = originOf(target);
                if (host.equals(origin)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    // No browser to hand it to; staying put beats crashing.
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showCard(true);
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));

        errorCard = new TextView(this);
        errorCard.setText("打不开这个页面。确认手机和电脑还在同一网络，或云端还在线。");
        errorCard.setTextSize(15);
        errorCard.setTextColor(Color.rgb(20, 23, 28));
        errorCard.setGravity(Gravity.CENTER);
        errorCard.setPadding(64, 32, 64, 32);
        errorCard.setVisibility(View.GONE);
        root.addView(errorCard, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));

        LinearLayout retryWrap = new LinearLayout(this);
        retryWrap.setOrientation(LinearLayout.VERTICAL);
        retryWrap.setGravity(Gravity.CENTER);
        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setAllCaps(false);
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(v -> {
            showCard(false);
            web.loadUrl(getIntent().getStringExtra("url"));
        });
        retryWrap.addView(retryButton);
        FrameLayout.LayoutParams retryParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER | Gravity.BOTTOM);
        retryParams.bottomMargin = 96;
        root.addView(retryWrap, retryParams);

        setContentView(root);
        web.loadUrl(url);
    }

    private void showCard(boolean shown) {
        errorCard.setVisibility(shown ? View.VISIBLE : View.GONE);
        retryButton.setVisibility(shown ? View.VISIBLE : View.GONE);
        progress.setVisibility(shown ? View.GONE : View.VISIBLE);
    }

    /** The scheme-and-authority half of a URL, which is what "same origin" means here. */
    private static String originOf(String url) {
        try {
            Uri uri = Uri.parse(url);
            return uri.getScheme() + "://" + uri.getHost()
                    + (uri.getPort() > 0 ? ":" + uri.getPort() : "");
        } catch (RuntimeException e) {
            return url == null ? "" : url;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // The page may hold a fresh session cookie; flush so a kill mid-visit
        // does not cost the next visit its pairing.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
