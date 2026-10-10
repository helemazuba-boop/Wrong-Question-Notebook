class WebViewClientFixture {
    void certificateError(android.webkit.SslErrorHandler handler) {
        // ruleid: webview-ssl-error-bypass
        handler.proceed();
        // ok: webview-ssl-error-bypass
        handler.cancel();
    }
}
