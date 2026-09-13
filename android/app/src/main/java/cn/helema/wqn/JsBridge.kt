package cn.helema.wqn

import android.webkit.JavascriptInterface

class JsBridge(
    private val activity: MainActivity,
    private val printBridge: PrintBridge
) {
    // Two arities: the JS bridge matches methods by argument count, and the
    // deployed web page may call either print() or print(title).

    @JavascriptInterface
    fun print(): Boolean = printBridge.print()

    @JavascriptInterface
    fun print(title: String?): Boolean = printBridge.print(title)

    @JavascriptInterface
    fun onClientError(message: String?) {
        activity.runOnUiThread {
            activity.showClientError(message)
        }
    }

    @JavascriptInterface
    fun openSettings() {
        activity.runOnUiThread {
            // Launched through the activity so the settings result
            // (locale change / data cleared) is applied to the WebView.
            activity.openSettings()
        }
    }
}
