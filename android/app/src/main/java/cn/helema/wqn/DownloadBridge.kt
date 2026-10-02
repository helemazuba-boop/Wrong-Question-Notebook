package cn.helema.wqn

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.webkit.WebView
import android.widget.Toast
import java.io.File

class DownloadBridge(
    private val context: Context,
    private var webView: WebView
) : DownloadListener {

    fun updateWebView(newWebView: WebView) {
        this.webView = newWebView
    }

    override fun onDownloadStart(
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimetype: String?,
        contentLength: Long
    ) {
        if (url.isNullOrBlank()) return

        try {
            val downloadUri = Uri.parse(url)
            val request = DownloadManager.Request(downloadUri)

            val cookie = CookieManager.getInstance().getCookie(url)
            if (!cookie.isNullOrEmpty()) {
                request.addRequestHeader("Cookie", cookie)
            }
            val currentUrl = webView.url
            if (!currentUrl.isNullOrEmpty()) {
                request.addRequestHeader("Referer", currentUrl)
            }
            if (!userAgent.isNullOrEmpty()) {
                request.addRequestHeader("User-Agent", userAgent)
            }

            if (!mimetype.isNullOrEmpty()) {
                request.setMimeType(mimetype)
            }

            var filename = URLUtil.guessFileName(url, contentDisposition, mimetype)
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            if (dir != null) {
                val wqnDir = File(dir, "WQN")
                if (!wqnDir.exists()) {
                    wqnDir.mkdirs()
                }
                filename = ensureUniqueFileName(wqnDir, filename)
            }

            val subPath = "WQN/$filename"
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, subPath)
            request.setTitle(filename)
            request.setDescription(url)
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)

            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            if (downloadManager != null) {
                downloadManager.enqueue(request)
                Toast.makeText(context, "正在下载: $filename", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Toast.makeText(context, "下载失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun ensureUniqueFileName(dir: File, originalName: String): String {
        var file = File(dir, originalName)
        if (!file.exists()) return originalName

        val dotIndex = originalName.lastIndexOf('.')
        val baseName = if (dotIndex != -1) originalName.substring(0, dotIndex) else originalName
        val extension = if (dotIndex != -1) originalName.substring(dotIndex) else ""

        var counter = 1
        while (file.exists()) {
            file = File(dir, "${baseName}_$counter$extension")
            counter++
        }
        return file.name
    }
}
