package com.reasonix.mobile;

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

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

/**
 * The paired computer's own Studio page, full screen.
 *
 * The kernel serves the whole Studio SPA on its port, and the phone-browser
 * path ("设备访问" share QR) is that same page with no native bridge at all —
 * so this activity is deliberately a plain WebView: the page owns its
 * connection, its SSE stream and its own reconnection, and the app's link
 * machine stays out of its way.
 *
 * For a LAN door the page is loaded through the loopback proxy instead of
 * straight at the kernel. A direct WebView loses the three things the proxy
 * supplies: the Wi-Fi-bound connection that survives an active VPN, the
 * pairing cookie, and the kernel's own CSRF Origin. With a VPN owning the
 * default route a direct load simply times out ("打不开完整界面"). The proxy
 * recognises this WebView by its UA marker and forwards everything to the
 * kernel rather than serving the app's own bundle.
 *
 * Only the paired (or share) origin runs here. Anything else — the account
 * sign-in page, an external link in the transcript — is handed to the browser
 * so the page never becomes a general-purpose window.
 */
public class WebModeActivity extends ComponentActivity {
    private WebView web;
    private TextView errorCard;
    private Button retryButton;
    private ProgressBar progress;
    private String origin;
    private boolean viaProxy;
    /** The real kernel origin, when viaProxy; absolute self-links are rewritten. */
    private String kernelOrigin;
    /** This phone's WebView cannot read the Studio palette; repaint it myself. */
    private boolean needsCompat;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web != null && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                finish();
            }
        });
        Intent source = getIntent();
        String url = source.getStringExtra("url");
        if (!Urls.isWebUrl(url)) {
            finish();
            return;
        }
        origin = originOf(url);
        viaProxy = source.getBooleanExtra("viaProxy", false);
        kernelOrigin = source.getStringExtra("origin");
        if (viaProxy) {
            // The proxy refuses sockets without its HttpOnly loopback cookie.
            // MainActivity installed it for the app WebView; this is a second
            // WebView in the same process, and re-installing is idempotent.
            LoopbackProxy.installWebViewCookie(getApplicationContext());
        }

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
        {
            // Read the phone's own WebView version before any marker is added:
            // the Studio palette is written in oklch()/color-mix(), which only
            // Chrome 111 understands. This is the only place the real build is
            // visible — the page reports its own UA, not its engine.
            needsCompat = StudioCompat.needsCompat(
                    StudioCompat.chromeMajor(settings.getUserAgentString()));
        }
        if (viaProxy) {
            // The marker tells the proxy this is the Studio page, not the app
            // bundle: static paths must be forwarded to the kernel, not served
            // from the APK's assets.
            String agent = settings.getUserAgentString();
            settings.setUserAgentString(
                    (agent == null || agent.isEmpty() ? "Mozilla/5.0" : agent)
                            + " " + ProxyPaths.STUDIO_UA_MARKER);
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String target = uri.toString();
                // Another host is not ours to swallow: the account sign-in and
                // shared links go to the browser, like a tap in Chrome would.
                if (!Urls.isWebUrl(target)) return true;
                if (viaProxy && kernelOrigin != null && !kernelOrigin.isEmpty()) {
                    // The SPA can name its own host absolutely. Loaded as-is
                    // that would put the WebView back on the LAN address and
                    // lose the proxy's VPN detour; keep it on loopback. The
                    // boundary check also covers "?query" and "#fragment"
                    // forms, which carry no slash after the authority.
                    String base = kernelOrigin.endsWith("/")
                            ? kernelOrigin.substring(0, kernelOrigin.length() - 1) : kernelOrigin;
                    String path = ProxyPaths.loopbackPath(base, target);
                    if (path != null) {
                        view.loadUrl(LoopbackProxy.LOOPBACK_ORIGIN + path);
                        return true;
                    }
                }
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
                applyCompat(view);
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // Earlier than onPageFinished: the page is painted, its images
                // and fonts may still be arriving. Repaint the palette now so
                // the first thing a person sees is already legible.
                applyCompat(view);
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
            web.loadUrl(source.getStringExtra("url"));
        });
        retryWrap.addView(retryButton);
        FrameLayout.LayoutParams retryParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER | Gravity.BOTTOM);
        retryParams.bottomMargin = 96;
        root.addView(retryWrap, retryParams);

        setContentView(root);
        // This is a plain Activity, not a BridgeActivity: Capacitor's
        // SystemBars never runs here, so the bar would otherwise keep the
        // theme's system-night colour while the app may have pinned the
        // opposite appearance. Replay the page's last reported colour.
        ThemeBarPlugin.reapply(this);
        web.loadUrl(url);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Returning from another app may have let the system repaint the
        // window; put the app's own appearance back.
        ThemeBarPlugin.reapply(this);
    }

    /**
     * Repaint the page's palette on a WebView that cannot read oklch().
     *
     * Runs on both onPageCommitVisible and onPageFinished, so the sheet is
     * installed once per document and the second call is a no-op. The CSS
     * carries no quotes, which is what lets it sit inside a single-quoted JS
     * string without escaping.
     */
    private void applyCompat(WebView view) {
        if (!needsCompat) return;
        String script = "(function(){"
                + "if(document.getElementById('rx-webview-compat'))return;"
                + "var s=document.createElement('style');"
                + "s.id='rx-webview-compat';"
                + "s.appendChild(document.createTextNode('" + StudioCompat.css() + "'));"
                + "(document.head||document.documentElement).appendChild(s);"
                + "})()";
        view.evaluateJavascript(script, null);
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
