package cn.helema.wqn

import android.app.Application
import android.webkit.WebView

class WqnApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Must be called before any WebView is created to ensure
        // full-page printing does not produce blank or viewport-only pages.
        WebView.enableSlowWholeDocumentDraw()
    }
}
