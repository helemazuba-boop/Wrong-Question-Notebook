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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
        // The bridge calls us on its own background thread while the printing
        // APIs need the main thread, so the work is posted and this call waits
        // for the answer. Blocking the bridge thread is the correct semantics:
        // the page is already synchronously waiting on this return value.
        //
        // The wait has to be real. An earlier version answered before the work
        // had concluded — `post` is asynchronous, so it read an
        // AtomicBoolean that had not been written yet and reported false every
        // time. The page then fell back to its own window.print(), which the
        // injected script routes straight back here, and one click started two
        // print jobs for the same worksheet.
        val started = AtomicBoolean(false)
        val finished = CountDownLatch(1)

        mainHandler.post {
            try {
                started.set(startPrint(documentTitle))
            } finally {
                finished.countDown()
            }
        }

        // Past the timeout the work was still accepted, so that still reports
        // "took over": answering false there would send the page down its
        // fallback and start a second job. A failure that lands late is still
        // raised through onClientError from inside startPrint.
        val answered =
            finished.await(PRINT_SETUP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return if (answered) started.get() else true
    }

    /** The main-thread printing work. True when a print job was started. */
    private fun startPrint(documentTitle: String?): Boolean {
        val printManager = activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager
            ?: run {
                webView.evaluateJavascript(
                    "window.WQNAndroid.onClientError(${escapeJsString(activity.getString(R.string.print_unavailable_message))})",
                    null
                )
                return false
            }

        val title = documentTitle?.takeIf { it.isNotBlank() } ?: "WQN_Document"
        val jobName = "${activity.getString(R.string.app_name)} - $title"
        val printAdapter: PrintDocumentAdapter = webView.createPrintDocumentAdapter(jobName)

        // Print lifecycle hook. The page no longer listens for this: the
        // print sheet commits itself and waits for its own render before
        // asking for a print, so capture ordering no longer rides on the
        // event. Kept so a page that wants to run before a capture can.
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

        if (printJob == null) {
            webView.evaluateJavascript(
                "window.WQNAndroid.onClientError(${escapeJsString(activity.getString(R.string.print_failed_message))})",
                null
            )
            dispatchAfterPrint.run()
            return false
        }

        // Print lifecycle signal. The page used to reset its own print
        // state on this event, which made the 60s fallback below a
        // correctness hazard; nothing listens for it now, so it is
        // dispatched only so the document sees the same event a
        // browser would fire, and on the failure path so a page that
        // ever waits for one is not left waiting.
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
        return true
    }

    private fun escapeJsString(value: String): String {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
    }

    companion object {
        private const val POLL_INTERVAL_MS = 500L
        private const val AFTERPRINT_FALLBACK_MS = 60_000L

        /**
         * How long the bridge thread waits for the main thread to start a job.
         * The work is a binder call plus a WebView adapter, so this is
         * generous; it only bounds the case where the main looper is wedged.
         */
        private const val PRINT_SETUP_TIMEOUT_MS = 5_000L

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
