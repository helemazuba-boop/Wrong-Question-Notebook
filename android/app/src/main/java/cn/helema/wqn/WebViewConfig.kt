package cn.helema.wqn

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageInfo
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewCompat

object WebViewConfig {

    fun isWebViewAvailable(context: Context): Boolean {
        val packageInfo = getWebViewPackageInfo(context) ?: return false
        val majorVersion = packageInfo.versionName?.split('.')?.firstOrNull()?.toIntOrNull() ?: 0
        // Next.js 16 requires a modern browser engine baseline (Chrome/WebView 80+)
        return majorVersion >= 80
    }

    fun getWebViewPackageInfo(context: Context): PackageInfo? {
        return try {
            WebViewCompat.getCurrentWebViewPackage(context)
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("SetJavaScriptEnabled")
    fun applySettings(webView: WebView, context: Context) {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.mediaPlaybackRequiresUserGesture = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.allowContentAccess = true
        settings.allowFileAccess = false
        settings.saveFormData = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(true)

        // Append "; WQNAndroid/<version>" to User-Agent
        val defaultUa = settings.userAgentString
        val appVersion = BuildConfig.VERSION_NAME
        if (!defaultUa.contains("WQNAndroid")) {
            settings.userAgentString = "$defaultUa; WQNAndroid/$appVersion"
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }
}
