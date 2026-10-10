package cn.helema.wqn

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebViewAssetLoader
import cn.helema.wqn.prefs.AppPrefs

class WqnWebViewClient(
    private val context: Context,
    private val appPrefs: AppPrefs,
    private val onError: (url: String, errorCode: Int, description: String?) -> Unit,
    private val onPageFinishedListener: (url: String) -> Unit,
    private val onRendererCrash: () -> Unit
) : WebViewClient() {

    private val testAssets by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(Site.HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        if (BuildConfig.WQN_CI_ASSETS) testAssets.shouldInterceptRequest(request.url) else null

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // API routes and sub-resources must not be intercepted
        if (!request.isForMainFrame) {
            return false
        }

        val uri = request.url
        val scheme = uri.scheme?.lowercase() ?: return false

        when (scheme) {
            "http", "https" -> {
                val host = uri.host
                return if (Site.isOwnHost(host)) {
                    // In-site navigation: let WebView handle it
                    false
                } else {
                    // External link: open in Custom Tabs
                    launchExternalUrl(context, uri)
                    true
                }
            }
            "mailto", "tel" -> {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, uri)
                    context.startActivity(intent)
                } catch (_: Exception) {}
                return true
            }
            "intent" -> {
                handleIntentUri(view, uri)
                return true
            }
            else -> {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, uri)
                    context.startActivity(intent)
                    return true
                } catch (_: Exception) {
                    return false
                }
            }
        }
    }

    private fun handleIntentUri(view: WebView, uri: Uri) {
        try {
            val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
            if (intent.resolveActivity(context.packageManager) != null) {
                context.startActivity(intent)
            } else {
                val fallbackUrl = intent.getStringExtra("browser_fallback_url")
                if (!fallbackUrl.isNullOrEmpty()) {
                    val fallbackUri = Uri.parse(fallbackUrl)
                    if (Site.isOwnHost(fallbackUri.host)) {
                        view.loadUrl(fallbackUrl)
                    } else {
                        launchExternalUrl(context, fallbackUri)
                    }
                } else {
                    val pkg = intent.`package`
                    if (!pkg.isNullOrEmpty()) {
                        val marketIntent = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg"))
                        if (marketIntent.resolveActivity(context.packageManager) != null) {
                            context.startActivity(marketIntent)
                        }
                    }
                }
            }
        } catch (_: Exception) {}
    }

    fun launchExternalUrl(context: Context, uri: Uri) {
        try {
            val customTabsIntent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
            customTabsIntent.launchUrl(context, uri)
        } catch (_: Exception) {
            try {
                val intent = Intent(Intent.ACTION_VIEW, uri)
                context.startActivity(intent)
            } catch (_: Exception) {}
        }
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        view.evaluateJavascript(PrintBridge.SCRIPT_INJECTION, null)

        CookieManager.getInstance().flush()
        if (url != null && !url.startsWith("data:") && !url.startsWith("about:")) {
            appPrefs.lastUrl = url
            onPageFinishedListener(url)
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        super.onReceivedError(view, request, error)
        if (request.isForMainFrame) {
            onError(request.url.toString(), error.errorCode, error.description?.toString())
        }
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse
    ) {
        super.onReceivedHttpError(view, request, errorResponse)
        // Only 5xx deserves the native overlay: the site renders its own 404/403
        // pages (notFound() etc.) and the native screen would just hide them.
        if (request.isForMainFrame && errorResponse.statusCode >= 500) {
            onError(request.url.toString(), errorResponse.statusCode, errorResponse.reasonPhrase)
        }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRendererCrash()
        return true
    }
}
