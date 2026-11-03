package com.freshcart.manager;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;

// Thin native wrapper around the FreshCart management console (the /admin web app). Same idea
// as the customer app, but pointed at https://daqa.me/admin. Native code is just the
// Hebrew/Arabic keyboard fix and Back-button web navigation.
public class MainActivity extends Activity {

    private WebView web;

    // The management console, served by the Pi over the permanent Cloudflare tunnel.
    private static final String URL = "https://daqa.me/admin";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this) {
            @Override
            public android.view.inputmethod.InputConnection onCreateInputConnection(android.view.inputmethod.EditorInfo outAttrs) {
                android.view.inputmethod.InputConnection ic = super.onCreateInputConnection(outAttrs);
                if (outAttrs != null) outAttrs.inputType |= android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
                return ic;
            }
        };
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // localStorage holds the admin token between sessions
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        web.loadUrl(URL);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) { web.goBack(); return true; }
        return super.onKeyDown(keyCode, event);
    }
}
