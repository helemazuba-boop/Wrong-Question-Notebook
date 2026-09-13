package cn.helema.wqn

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintJob
import android.print.PrintManager
import android.webkit.WebView
import java.util.concurrent.atomic.AtomicBoolean

class PrintBridge(
    private val activity: Activity,
    private var webView: WebView
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    fun updateWebView(newWebView: WebView) {
        this.webView = newWebView
    }

    fun print(documentTitle: String? = null): Boolean {
        mainHandler.post {
            val printManager = activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager
                ?: return@post

            val title = documentTitle?.takeIf { it.isNotBlank() } ?: "WQN_Document"
            val jobName = "${activity.getString(R.string.app_name)} - $title"
            val printAdapter: PrintDocumentAdapter = webView.createPrintDocumentAdapter(jobName)

            // problem-review.tsx renders KaTeX inside its 'beforeprint' listener,
            // so the event must reach the page before the document is captured.
            webView.evaluateJavascript("window.dispatchEvent(new Event('beforeprint'))", null)

            val afterPrintDispatched = AtomicBoolean(false)
            val dispatchAfterPrint = Runnable {
                if (afterPrintDispatched.compareAndSet(false, true)) {
                    webView.evaluateJavascript("window.dispatchEvent(new Event('afterprint'))", null)
                }
            }

            val printAttributes = PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build()

            val printJob: PrintJob? = try {
                printManager.print(jobName, printAdapter, printAttributes)
            } catch (e: Exception) {
                null
            }

            // afterprint must NOT fire too early: print-dialog.tsx uses it to reset
            // data-print-mode, and resetting before the print preview has captured
            // the document would drop the answer-placement mode from the printout.
            // Dispatch only once the job has actually progressed; the fallback is
            // deliberately generous.
            if (printJob != null) {
                val pollJob = object : Runnable {
                    override fun run() {
                        if (afterPrintDispatched.get()) return
                        if (printJob.isStarted || printJob.isCompleted ||
                            printJob.isFailed || printJob.isCancelled
                        ) {
                            dispatchAfterPrint.run()
                        } else {
                            mainHandler.postDelayed(this, POLL_INTERVAL_MS)
                        }
                    }
                }
                mainHandler.postDelayed(pollJob, POLL_INTERVAL_MS)
                mainHandler.postDelayed(dispatchAfterPrint, AFTERPRINT_FALLBACK_MS)
            } else {
                // Printing could not even be started - clean up immediately.
                dispatchAfterPrint.run()
            }
        }
        return true
    }

    companion object {
        private const val POLL_INTERVAL_MS = 500L
        private const val AFTERPRINT_FALLBACK_MS = 60_000L

        const val SCRIPT_INJECTION = """
(function() {
    if (window.__wqnPrintInstalled) return;
    window.__wqnPrintInstalled = true;
    var _origPrint = window.print;
    var nativePrint = function() {
        if (window.WQNAndroid) {
            var ok = false;
            try {
                ok = window.WQNAndroid.print(String(document.title || ''));
            } catch (e) {}
            if (ok) return true;
        }
        return false;
    };
    var wrapped = function() {
        if (nativePrint()) return;
        if (_origPrint) {
            _origPrint.call(window);
        }
    };
    try {
        Object.defineProperty(window, 'print', {
            configurable: true,
            writable: true,
            value: wrapped
        });
    } catch(e) {
        window.print = wrapped;
    }
})();
"""
    }
}
