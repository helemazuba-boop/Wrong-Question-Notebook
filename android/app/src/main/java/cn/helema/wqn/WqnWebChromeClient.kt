package cn.helema.wqn

import android.content.Context
import android.net.Uri
import android.os.Message
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent

class WqnWebChromeClient(
    private val fileChooserHelper: FileChooserHelper,
    private val onProgressChangedListener: (Int) -> Unit
) : WebChromeClient() {

    override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?
    ): Boolean {
        return fileChooserHelper.onShowFileChooser(filePathCallback, fileChooserParams)
    }

    override fun onProgressChanged(view: WebView, newProgress: Int) {
        super.onProgressChanged(view, newProgress)
        onProgressChangedListener(newProgress)
        if (newProgress == 100) {
            view.evaluateJavascript(PrintBridge.SCRIPT_INJECTION, null)
        }
    }

    override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message?
    ): Boolean {
        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
        val tempWebView = WebView(view.context)
        var destroyed = false
        // Destroy outside of the WebViewClient callback - calling destroy()
        // synchronously from inside a WebView callback crashes on some OEM ROMs.
        fun destroyTemp() {
            if (destroyed) return
            destroyed = true
            tempWebView.post { runCatching { tempWebView.destroy() } }
        }
        tempWebView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(tempView: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (Site.isOwnUrl(uri.toString())) {
                    view.loadUrl(uri.toString())
                } else {
                    launchExternalUrl(view.context, uri)
                }
                destroyTemp()
                return true
            }
        }
        transport.webView = tempWebView
        resultMsg.sendToTarget()
        // window.open() that never navigates would otherwise leak the temp WebView.
        view.postDelayed({
            if (tempWebView.url == null) destroyTemp()
        }, TEMP_WEBVIEW_TIMEOUT_MS)
        return true
    }

    private fun launchExternalUrl(context: Context, uri: Uri) {
        try {
            val customTabsIntent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
            customTabsIntent.launchUrl(context, uri)
        } catch (_: Exception) {
            try {
                val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, uri)
                context.startActivity(intent)
            } catch (_: Exception) {}
        }
    }

    private companion object {
        const val TEMP_WEBVIEW_TIMEOUT_MS = 30_000L
    }
}
