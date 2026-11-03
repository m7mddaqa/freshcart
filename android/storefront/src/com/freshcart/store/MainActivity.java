package com.freshcart.store;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;

// Thin native wrapper around the FreshCart storefront: the whole app is just a full-screen
// WebView pointed at the public site (https://daqa.me). The only native code here is the
// Hebrew/Arabic keyboard fix and making the hardware Back button navigate the web history
// instead of closing the app.
public class MainActivity extends Activity {

    private WebView web;

    // Public store URL (permanent Cloudflare named tunnel -> the Pi). Unlike the old
    // quick-tunnel builds, this address is stable and never needs a rebuild.
    private static final String URL = "https://daqa.me";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Fix Hebrew/Arabic typing in WebView: disable the keyboard's composing/predictive mode
        // so characters commit immediately on first focus (no need to hide+reopen the keyboard).
        web = new WebView(this) {
            @Override
            public android.view.inputmethod.InputConnection onCreateInputConnection(android.view.inputmethod.EditorInfo outAttrs) {
                android.view.inputmethod.InputConnection ic = super.onCreateInputConnection(outAttrs);
                if (outAttrs != null) outAttrs.inputType |= android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
                return ic;
            }
        };
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);   // the app is all JS
        s.setDomStorageEnabled(true);   // localStorage (cart, login token) needs this
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        web.setWebViewClient(new WebViewClient()); // keep navigation inside the WebView (no external browser)
        setContentView(web);
        web.loadUrl(URL);
    }

    // Hardware Back: step back through the web history if we can, otherwise let Android
    // handle it (which exits the app).
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) { web.goBack(); return true; }
        return super.onKeyDown(keyCode, event);
    }
}
