package com.reasonix.mobile;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The account sign-in page, inside the app's own WebView.
 *
 * It must be this WebView and not the system browser: `/me/remote-grants`
 * accepts the account's cookie, and only a WebView the app owns shares its
 * cookie store with the loopback proxy. The device-flow poll still runs in the
 * page behind this activity; this activity only hosts the approval page.
 *
 * The approval page's primary button has rendered white-on-white inside a
 * WebView (its own theme variables do not resolve there). The page is left
 * untouched except for forcing a light color scheme and giving the
 * approve-ish button an explicit color; a native "同意并批准" button is the
 * fallback when the page's own button is still invisible.
 */
public class LoginActivity extends Activity {
    private static final String FIX_APPROVAL_JS =
            "(function(){" +
            "document.documentElement.style.colorScheme='light';" +
            "var s=document.getElementById('rx-approve-style');" +
            "if(!s){s=document.createElement('style');s.id='rx-approve-style';document.head.appendChild(s);}" +
            "s.textContent='html,body{color-scheme:light !important;overflow:auto !important}" +
            "button,[role=button]{color:#111 !important;opacity:1 !important;visibility:visible !important}';" +
            "var bs=document.querySelectorAll('button,[role=button],a');" +
            "for(var i=0;i<bs.length;i++){var b=bs[i];var t=(b.textContent||'').trim();" +
            "if(/同意|批准|允许|授权|继续|Allow|Approve|Authorize|Confirm|Continue/i.test(t)){" +
            "b.style.setProperty('background-color','#2563eb','important');" +
            "b.style.setProperty('color','#fff','important');" +
            "b.style.setProperty('border-color','#2563eb','important');" +
            "b.style.setProperty('opacity','1','important');" +
            "b.style.setProperty('visibility','visible','important');" +
            "b.style.setProperty('display','inline-block','important');" +
            "try{b.scrollIntoView({block:'center'});}catch(e){}" +
            "}}})()";

    private static final String CLICK_APPROVE_JS =
            "(function(){var bs=document.querySelectorAll('button,[role=button],a');" +
            "for(var i=0;i<bs.length;i++){var b=bs[i];var t=(b.textContent||'').trim();" +
            "if(/同意|批准|允许|授权|继续|Allow|Approve|Authorize|Confirm|Continue/i.test(t)){" +
            "b.click();return 'clicked';}}return 'not-found';})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(247, 248, 250));

        TextView title = new TextView(this);
        title.setText("登录 Reasonix");
        title.setTextSize(18);
        title.setTextColor(Color.rgb(20, 23, 28));
        title.setPadding(48, 64, 48, 16);

        Button close = new Button(this);
        close.setText("完成 / 关闭");
        close.setAllCaps(false);
        close.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(37, 99, 235)));
        close.setTextColor(Color.WHITE);
        close.setOnClickListener(v -> finish());

        WebView web = new WebView(this);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        web.setBackgroundColor(Color.WHITE);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String pageUrl) {
                super.onPageFinished(view, pageUrl);
                view.evaluateJavascript(FIX_APPROVAL_JS, null);
                view.postDelayed(() -> view.evaluateJavascript(FIX_APPROVAL_JS, null), 1200);
                view.postDelayed(() -> view.evaluateJavascript(FIX_APPROVAL_JS, null), 3000);
            }
        });

        Button approve = new Button(this);
        approve.setText("同意并批准");
        approve.setAllCaps(false);
        approve.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(22, 163, 74)));
        approve.setTextColor(Color.WHITE);
        approve.setOnClickListener(v -> web.evaluateJavascript(
                CLICK_APPROVE_JS,
                value -> Toast.makeText(this, value, Toast.LENGTH_SHORT).show()));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.addView(close, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        actions.addView(approve, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        web.loadUrl(url);
        root.addView(title);
        root.addView(actions, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }
}
