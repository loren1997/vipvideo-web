package io.github.loren1997.vipvideoweb;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Message;
import android.text.InputType;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class MainActivity extends Activity {
    private static final int BACKGROUND = Color.rgb(17, 24, 39);
    private final ExecutorService connector = Executors.newSingleThreadExecutor();
    private final ExecutorService healthWorkers = Executors.newFixedThreadPool(2);
    private SharedPreferences preferences;
    private FrameLayout root;
    private LinearLayout browserPanel;
    private FrameLayout webHolder;
    private LinearLayout toolbar;
    private TextView connectionLabel;
    private WebView webView;
    private View fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private int previousOrientation;
    private String lanBase = "";
    private String externalBase = "";
    private String currentBase = "";
    private long connectionVersion = 0;
    private Future<?> connectionTask;
    private boolean television;
    private boolean clearHistoryNext = false;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("server-addresses", MODE_PRIVATE);
        UiModeManager mode = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        television = (mode != null && mode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) || getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        if (television) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (fullScreenView == null) view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            else view.setPadding(0, 0, 0, 0);
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        try {
            lanBase = EndpointPolicy.normalize(preferences.getString("lan", ""), true);
            externalBase = EndpointPolicy.normalize(preferences.getString("external", ""), false);
            connect(true);
        } catch (IllegalArgumentException error) { showSetup(""); }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextColor(Color.WHITE); view.setTextSize(size);
        view.setPadding(0, dp(8), 0, dp(8));
        return view;
    }

    private Button button(String label, Runnable action) {
        Button view = new Button(this);
        view.setText(label); view.setAllCaps(false); view.setTextColor(Color.WHITE);
        view.setBackgroundResource(R.drawable.control_background);
        view.setPadding(dp(16), dp(8), dp(16), dp(8)); view.setMinHeight(dp(48));
        view.setFocusable(true); view.setOnClickListener(ignored -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(dp(4), dp(8), dp(4), dp(8)); view.setLayoutParams(params);
        return view;
    }

    private LinearLayout panel() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL); column.setPadding(dp(television ? 56 : 24), dp(24), dp(television ? 56 : 24), dp(24));
        scroll.addView(column);
        root.removeAllViews(); root.addView(scroll);
        return column;
    }

    private void pauseWeb() {
        if (webView != null) {
            webView.evaluateJavascript("document.querySelectorAll('video,audio').forEach(function(v){v.pause()})", null);
            webView.stopLoading(); webView.onPause(); CookieManager.getInstance().flush();
        }
        hideFullScreen();
    }

    private void invalidateConnection() {
        connectionVersion++;
        if (connectionTask != null) connectionTask.cancel(true);
    }

    private boolean browserShown() { return browserPanel != null && browserPanel.getParent() == root; }

    private EditText addressInput(String value, String hint) {
        EditText input = new EditText(this);
        input.setSingleLine(true); input.setTextColor(Color.WHITE); input.setHintTextColor(Color.LTGRAY);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(value); input.setHint(hint); input.setSelectAllOnFocus(true);
        input.setMinHeight(dp(52)); input.setPadding(dp(12), dp(8), dp(12), dp(8));
        input.setBackgroundResource(R.drawable.control_background);
        return input;
    }

    private void showSetup(String message) {
        invalidateConnection(); pauseWeb();
        LinearLayout column = panel();
        column.addView(text("连接你的 VIPVideo Web", television ? 28 : 24));
        column.addView(text("先在 NAS 部署服务器。这里只保存地址，访问密码仍在网页中输入。", 16));
        column.addView(text("家庭局域网地址（必填）", 17));
        EditText lan = addressInput(preferences.getString("lan", ""), "http://192.168.1.20:3000"); column.addView(lan);
        column.addView(text("外网地址（可选，推荐 HTTPS）", 17));
        EditText external = addressInput(preferences.getString("external", ""), "https://video.example.com"); column.addView(external);
        TextView error = text(message, 16); error.setTextColor(Color.rgb(252, 165, 165)); column.addView(error);
        column.addView(button("保存并连接", () -> {
            try {
                String nextLan = EndpointPolicy.normalize(lan.getText().toString(), true);
                String nextExternal = EndpointPolicy.normalize(external.getText().toString(), false);
                preferences.edit().putString("lan", nextLan).putString("external", nextExternal).apply();
                lanBase = nextLan; externalBase = nextExternal; connect(true);
            } catch (IllegalArgumentException problem) { error.setText(problem.getMessage()); }
        }));
        column.addView(text("每次连接先检查局域网；不可用时再检查外网。手机和电视使用同一个家庭密码。", 15));
    }

    private void connect(boolean preferLan) {
        if (!preferLan && externalBase.isEmpty()) { showSetup("请先填写外网地址"); return; }
        invalidateConnection();
        long version = connectionVersion;
        pauseWeb();
        LinearLayout column = panel();
        column.addView(text("正在连接…", 24));
        column.addView(text(preferLan ? "先检查家庭局域网，再尝试外网地址。" : "正在检查外网地址。", 16));
        column.addView(button("修改地址", () -> showSetup("")));
        String lan = lanBase, external = externalBase;
        connectionTask = connector.submit(() -> {
            String selected = EndpointPolicy.select(lan, external, preferLan, this::healthy);
            runOnUiThread(() -> {
                if (version != connectionVersion || isFinishing() || isDestroyed()) return;
                if (selected == null) showOffline("服务器暂时不可用。请检查 NAS、Wi-Fi、地址或已有的外网访问服务。");
                else openServer(selected);
            });
        });
    }

    private boolean healthy(String base) {
        if (Thread.currentThread().isInterrupted()) return false;
        AtomicReference<HttpURLConnection> connection = new AtomicReference<>();
        Future<Boolean> probe = healthWorkers.submit(() -> {
            HttpURLConnection http = (HttpURLConnection) new URL(base + "/health").openConnection();
            connection.set(http);
            http.setConnectTimeout(1200); http.setReadTimeout(1200); http.setInstanceFollowRedirects(false);
            http.setUseCaches(false); http.setRequestProperty("Accept", "application/json");
            try {
                if (http.getResponseCode() != 200) return false;
                try (InputStream input = http.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] bytes = new byte[512]; int count;
                    while ((count = input.read(bytes)) != -1) {
                        if (output.size() + count > 4096) return false;
                        output.write(bytes, 0, count);
                    }
                    return "ok".equals(new JSONObject(output.toString(StandardCharsets.UTF_8.name())).optString("status"));
                }
            } finally { http.disconnect(); }
        });
        try { return probe.get(1800, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
        catch (Exception error) { return false; }
        finally { probe.cancel(true); HttpURLConnection http = connection.get(); if (http != null) http.disconnect(); }
    }

    private void showOffline(String reason) {
        invalidateConnection(); pauseWeb();
        LinearLayout column = panel();
        column.addView(text("暂时连不上服务器", 24)); column.addView(text(reason, 17));
        column.addView(button("重试连接", () -> connect(true)));
        if (!externalBase.isEmpty()) column.addView(button("只尝试外网地址", () -> connect(false)));
        column.addView(button("修改地址", () -> showSetup("")));
    }

    private void showAddressMenu() {
        new AlertDialog.Builder(this).setTitle("服务器地址")
                .setItems(new String[] { "优先局域网", "使用外网", "修改地址" }, (dialog, index) -> {
                    if (index == 2) showSetup(""); else connect(index == 0);
                }).show();
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (television) settings.setUserAgentString(settings.getUserAgentString() + " VIPVideoWebTV/1.0");
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setBackgroundColor(BACKGROUND); view.setFocusable(true); view.setFocusableInTouchMode(true);
    }

    private void openServer(String selected) {
        currentBase = selected; clearHistoryNext = true;
        if (webView == null) {
            try { createBrowser(); }
            catch (RuntimeException error) {
                Log.e("VipVideoWeb", "WebView 初始化失败", error);
                showOffline("系统 WebView 不可用，请先更新 Android System WebView 或 Chrome。"); return;
            }
        }
        root.removeAllViews(); root.addView(browserPanel);
        connectionLabel.setText(selected.equals(lanBase) ? "VIPVideo · 局域网" : "VIPVideo · 外网");
        webView.onResume(); webView.loadUrl(selected + "/"); webView.requestFocus();
    }

    private void createBrowser() {
        browserPanel = new LinearLayout(this); browserPanel.setOrientation(LinearLayout.VERTICAL);
        toolbar = new LinearLayout(this); toolbar.setOrientation(LinearLayout.HORIZONTAL); toolbar.setPadding(dp(8), 0, dp(8), 0);
        connectionLabel = text("VIPVideo", 16);
        toolbar.addView(connectionLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        toolbar.addView(button("重连", () -> connect(true))); toolbar.addView(button("地址", this::showAddressMenu));
        browserPanel.addView(toolbar);
        webHolder = new FrameLayout(this); browserPanel.addView(webHolder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        webView = new WebView(this); configureWebView(webView);
        webHolder.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!EndpointPolicy.isHttp(request.getUrl().toString())) return true;
                return request.isForMainFrame() && navigate(request.getUrl().toString(), request.hasGesture());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                int hit = view.getHitTestResult().getType();
                return navigate(url, hit == WebView.HitTestResult.SRC_ANCHOR_TYPE || hit == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                if ("file".equalsIgnoreCase(scheme) || "content".equalsIgnoreCase(scheme) || "intent".equalsIgnoreCase(scheme)) {
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!browserShown() || !EndpointPolicy.sameOrigin(currentBase, url)) return;
                CookieManager.getInstance().flush();
                if (clearHistoryNext) { view.clearHistory(); clearHistoryNext = false; }
                if (television) view.evaluateJavascript(TV_FOCUS_SCRIPT, null);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (browserShown() && request.isForMainFrame() && EndpointPolicy.sameOrigin(currentBase, request.getUrl().toString())) pageFailed("页面加载失败，请检查连接后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (browserShown() && request.isForMainFrame() && error.getStatusCode() >= 500) pageFailed("服务器返回错误，请稍后重试。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (browserShown() && EndpointPolicy.sameOrigin(currentBase, error.getUrl())) pageFailed("HTTPS 证书无效。请修复证书后重试，应用不会跳过验证。");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreenView != null) { callback.onCustomViewHidden(); return; }
                fullScreenView = view; fullScreenCallback = callback; previousOrientation = getRequestedOrientation();
                browserPanel.setVisibility(View.GONE); root.setPadding(0, 0, 0, 0);
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            }
            @Override public void onHideCustomView() { hideFullScreen(); }
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMessage) {
                if (!isUserGesture) return false;
                WebView popup = new WebView(MainActivity.this); configureWebView(popup); popup.getSettings().setJavaScriptEnabled(false);
                Runnable dismiss = () -> {
                    if (Boolean.TRUE.equals(popup.getTag())) return;
                    popup.setTag(Boolean.TRUE); popup.stopLoading(); popup.destroy();
                };
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handled = false;
                    private void open(String url) {
                        if (handled || "about:blank".equals(url)) return;
                        handled = true;
                        if (EndpointPolicy.sameOrigin(currentBase, url)) webView.loadUrl(url); else navigate(url, true);
                        popup.post(dismiss);
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView child, String url) { open(url); return true; }
                    @Override public void onPageStarted(WebView child, String url, android.graphics.Bitmap icon) { open(url); }
                });
                ((WebView.WebViewTransport) resultMessage.obj).setWebView(popup); resultMessage.sendToTarget();
                popup.postDelayed(dismiss, 5000);
                return true;
            }
        });
    }

    private boolean navigate(String url, boolean userGesture) {
        if (!EndpointPolicy.isHttp(url)) { Toast.makeText(this, "仅支持 HTTP/HTTPS 网页链接", Toast.LENGTH_SHORT).show(); return true; }
        if (EndpointPolicy.sameOrigin(currentBase, url)) return false;
        if (!userGesture) return true;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "未找到可打开此链接的浏览器", Toast.LENGTH_LONG).show(); }
        return true;
    }

    private void pageFailed(String reason) {
        if (currentBase.equals(lanBase) && !externalBase.isEmpty() && !externalBase.equals(currentBase)) connect(false);
        else showOffline(reason);
    }

    private void hideFullScreen() {
        if (fullScreenView == null) return;
        root.removeView(fullScreenView); fullScreenView = null;
        if (browserPanel != null) browserPanel.setVisibility(View.VISIBLE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        setRequestedOrientation(previousOrientation); root.requestApplyInsets();
        WebChromeClient.CustomViewCallback callback = fullScreenCallback; fullScreenCallback = null;
        if (callback != null) callback.onCustomViewHidden();
    }

    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU && !lanBase.isEmpty()) { showAddressMenu(); return true; }
        return super.onKeyDown(keyCode, event);
    }

    @Override public void onBackPressed() {
        if (fullScreenView != null) hideFullScreen();
        else if (webView != null && browserShown() && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @Override protected void onPause() {
        if (webView != null) { webView.evaluateJavascript("document.querySelectorAll('video,audio').forEach(function(v){v.pause()})", null); webView.onPause(); CookieManager.getInstance().flush(); }
        super.onPause();
    }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onDestroy() {
        connectionVersion++; connector.shutdownNow(); healthWorkers.shutdownNow(); hideFullScreen();
        if (webView != null) { webView.stopLoading(); webHolder.removeView(webView); webView.destroy(); webView = null; }
        super.onDestroy();
    }

    private static final String TV_FOCUS_SCRIPT = """
        (function(){
          if(window.__vipTvFocus)return;window.__vipTvFocus=true;document.documentElement.dataset.tv='true';
          var style=document.createElement('style');style.textContent=':focus{outline:3px solid #67e8f9!important;outline-offset:3px!important}';document.head.appendChild(style);
          window.addEventListener('keydown',function(e){
            if(e.defaultPrevented)return;
            var current=document.activeElement;
            if(e.key==='Enter'&&current&&current.matches('input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"]')){e.preventDefault();current.click();return;}
            if(current&&(current.matches('textarea,select,video,audio')||current.isContentEditable))return;
            if(current&&current.matches('input')&&!['ArrowUp','ArrowDown'].includes(e.key))return;
            if(e.key==='Enter'&&current&&current.matches('button,a[href],[role="button"]')){e.preventDefault();current.click();return;}
            if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;
            var candidates=Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(function(v){var r=v.getBoundingClientRect();return !v.disabled&&v.tabIndex>=0&&r.width>0&&r.height>0&&getComputedStyle(v).visibility!=='hidden'});
            if(!candidates.length)return;
            if(!current||current===document.body){e.preventDefault();candidates[0].focus();return;}
            var r=current.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,best=null,score=Infinity;
            candidates.forEach(function(v){if(v===current)return;var b=v.getBoundingClientRect(),dx=b.left+b.width/2-x,dy=b.top+b.height/2-y,p=e.key==='ArrowRight'?dx:e.key==='ArrowLeft'?-dx:e.key==='ArrowDown'?dy:-dy,c=e.key==='ArrowRight'||e.key==='ArrowLeft'?Math.abs(dy):Math.abs(dx);if(p>3&&p+c*2<score){score=p+c*2;best=v}});
            if(best){e.preventDefault();best.focus();best.scrollIntoView({block:'nearest',inline:'nearest'});}
          });
        })();
        """;
}
