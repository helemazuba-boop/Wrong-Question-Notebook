package cn.helema.wqn

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import cn.helema.wqn.databinding.ActivityMainBinding
import cn.helema.wqn.prefs.AppPrefs
import cn.helema.wqn.ui.ErrorOverlay

class MainActivity : ComponentActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var appPrefs: AppPrefs
    private lateinit var fileChooserHelper: FileChooserHelper
    private lateinit var printBridge: PrintBridge
    private lateinit var downloadBridge: DownloadBridge
    private lateinit var jsBridge: JsBridge
    private lateinit var errorOverlay: ErrorOverlay
    private lateinit var webView: WebView

    private var lastBackPressTime = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyEdgeToEdge()

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyInsets()

        appPrefs = AppPrefs(this)
        fileChooserHelper = FileChooserHelper(this)
        webView = binding.webView

        printBridge = PrintBridge(this, webView)
        downloadBridge = DownloadBridge(this, webView)
        jsBridge = JsBridge(this, printBridge)

        errorOverlay = ErrorOverlay(
            binding = binding.errorOverlay,
            onRetry = {
                val retryUrl = webView.url ?: appPrefs.lastUrl ?: Site.startUrl(appPrefs.locale)
                loadSiteUrl(retryUrl)
            },
            onOpenInBrowser = { url ->
                val targetUrl = url.ifEmpty { webView.url ?: Site.startUrl(appPrefs.locale) }
                try {
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                    startActivity(browserIntent)
                } catch (e: Exception) {
                    Toast.makeText(this, "无法打开浏览器: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        )

        setupBackPress()
        setupSwipeRefresh()

        // WebView version gate check
        if (!WebViewConfig.isWebViewAvailable(this)) {
            // setupWebView has not run at this point (no JS, no clients), so a retry
            // would just load into a dead WebView - hide the retry button.
            errorOverlay.show(
                url = "",
                title = getString(R.string.webview_missing_title),
                message = getString(R.string.webview_missing_message),
                showRetry = false
            )
            return
        }

        setupWebView(webView)

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            val targetUrl = determineInitialUrl(intent)
            loadSiteUrl(targetUrl)
        }
    }

    /**
     * Edge-to-edge with manual insets is only safe from API 30: on API 26-29
     * WindowInsetsCompat.Type.ime() always reports zero, and once the decor no
     * longer fits system windows the legacy adjustResize stops working - the
     * keyboard would cover WebView inputs. Keep classic behavior there.
     */
    private fun applyEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowCompat.enableEdgeToEdge(window)
        }
    }

    private fun applyInsets() {
        if (Build.VERSION.SDK_INT < 30) return
        // Apply systemBars and IME padding to the root container FrameLayout
        // (not the WebView directly)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
            )
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val targetUrl = determineInitialUrl(intent)
        if (targetUrl != webView.url) {
            loadSiteUrl(targetUrl)
        }
    }

    private fun determineInitialUrl(intent: Intent?): String {
        val data = intent?.data
        if (data != null && Site.isOwnUrl(data.toString())) {
            return data.toString()
        }
        return Site.startUrl(appPrefs.locale)
    }

    private fun setupWebView(targetWebView: WebView) {
        WebViewConfig.applySettings(targetWebView, this)

        targetWebView.setDownloadListener(downloadBridge)
        targetWebView.addJavascriptInterface(jsBridge, "WQNAndroid")

        targetWebView.webViewClient = WqnWebViewClient(
            context = this,
            appPrefs = appPrefs,
            onError = { url, errorCode, description ->
                binding.swipeRefresh.isRefreshing = false
                val msg = when {
                    errorCode in OFFLINE_ERROR_CODES -> getString(R.string.error_offline)
                    errorCode >= 400 -> getString(R.string.error_http, errorCode)
                    else -> getString(R.string.error_generic, description ?: "Unknown", errorCode)
                }
                errorOverlay.show(url, message = msg)
            },
            onPageFinishedListener = {
                binding.swipeRefresh.isRefreshing = false
                errorOverlay.hide()
            },
            onRendererCrash = {
                recreateWebView()
            }
        )

        targetWebView.webChromeClient = WqnWebChromeClient(
            fileChooserHelper = fileChooserHelper,
            onProgressChangedListener = { progress ->
                if (progress < 100) {
                    binding.progress.visibility = View.VISIBLE
                    binding.progress.progress = progress
                } else {
                    binding.progress.visibility = View.GONE
                    binding.swipeRefresh.isRefreshing = false
                }
            }
        )
    }

    private fun recreateWebView() {
        runOnUiThread {
            try {
                binding.swipeRefresh.removeView(webView)
                webView.destroy()
            } catch (_: Exception) {}

            val newWebView = WebView(this).apply {
                id = R.id.webView
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            }
            binding.swipeRefresh.addView(newWebView)
            webView = newWebView
            printBridge.updateWebView(newWebView)
            downloadBridge.updateWebView(newWebView)

            setupWebView(newWebView)
            loadSiteUrl(appPrefs.lastUrl ?: Site.startUrl(appPrefs.locale))
        }
    }

    private fun loadSiteUrl(url: String) {
        if (!Site.isOwnUrl(url)) {
            loadSiteUrl(Site.startUrl(appPrefs.locale))
            return
        }
        val headers = mapOf("Accept-Language" to Site.acceptLanguage(appPrefs.locale))
        webView.loadUrl(url, headers)
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefresh.setOnRefreshListener {
            if (errorOverlay.isVisible) {
                errorOverlay.hide()
            }
            webView.reload()
        }
    }

    private fun setupBackPress() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (errorOverlay.isVisible) {
                    errorOverlay.hide()
                    if (webView.canGoBack()) {
                        webView.goBack()
                        return
                    }
                }

                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    val now = System.currentTimeMillis()
                    if (now - lastBackPressTime < 2000L) {
                        finish()
                    } else {
                        lastBackPressTime = now
                        Toast.makeText(this@MainActivity, R.string.toast_back_to_exit, Toast.LENGTH_SHORT).show()
                    }
                }
            }
        })
    }

    fun showClientError(message: String?) {
        val currentUrl = webView.url ?: Site.startUrl(appPrefs.locale)
        errorOverlay.show(
            url = currentUrl,
            message = message ?: getString(R.string.error_title)
        )
    }

    override fun onResume() {
        super.onResume()
        webView.resumeTimers()
    }

    override fun onPause() {
        super.onPause()
        webView.pauseTimers()
        CookieManager.getInstance().flush()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        fileChooserHelper.cancelPending()
        try {
            binding.swipeRefresh.removeView(webView)
            webView.stopLoading()
            webView.clearHistory()
            webView.removeAllViews()
            webView.destroy()
        } catch (_: Exception) {}
        super.onDestroy()
    }

    private companion object {
        // WebViewClient.ERROR_HOST_LOOKUP(-2) / ERROR_CONNECT(-6) / ERROR_TIMEOUT(-8):
        // all mean "network unreachable", not "server said no".
        val OFFLINE_ERROR_CODES = setOf(-2, -6, -8)
    }
}
