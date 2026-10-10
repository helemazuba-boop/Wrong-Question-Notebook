package cn.helema.wqn

import android.app.Activity
import android.app.DownloadManager
import android.app.Instrumentation.ActivityResult
import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativeBridgeTest {
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)

    @Before fun startFixture() {
        assertTrue("Build instrumentation with -PwqnCiAssets=true", BuildConfig.WQN_CI_ASSETS)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        awaitJs("document.title", "\"WQN CI fixture\"")
    }

    @After fun closeFixture() {
        if (::scenario.isInitialized) scenario.close()
    }

    private fun js(script: String): String {
        val ready = CountDownLatch(1)
        var result = ""
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.webView).evaluateJavascript(script) {
                result = it ?: "null"
                ready.countDown()
            }
        }
        assertTrue("JavaScript callback timed out", ready.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun awaitJs(script: String, expected: String) {
        val deadline = System.currentTimeMillis() + 20_000
        var actual: String
        do {
            actual = js(script)
            if (actual == expected) return
            Thread.sleep(100)
        } while (System.currentTimeMillis() < deadline)
        assertEquals(expected, actual)
    }

    @Test fun fixtureLoadsWithTheProductionWebViewSettingsAndBridge() {
        assertEquals("\"function\"", js("typeof window.WQNAndroid.print"))
        assertEquals("true", js("window.__wqnPrintInstalled === true"))
        scenario.onActivity {
            val settings = it.findViewById<WebView>(R.id.webView).settings
            assertTrue(settings.javaScriptEnabled)
            assertFalse(settings.allowFileAccess)
            assertEquals(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.mixedContentMode)
        }
    }

    @Test fun backNavigatesWithinTheWebView() {
        js("document.querySelector('#next').click()")
        awaitJs("document.title", "\"WQN CI second\"")
        device.pressBack()
        awaitJs("document.title", "\"WQN CI fixture\"")
    }

    @Test fun clientErrorUsesTheNativeOverlayAndRetryRecovers() {
        js("window.WQNAndroid.onClientError('CI controlled error')")
        onView(withId(R.id.errorMessage)).check(matches(isDisplayed()))
        onView(withId(R.id.errorRetry)).perform(androidx.test.espresso.action.ViewActions.click())
        awaitJs("document.title", "\"WQN CI fixture\"")
        onView(withId(R.id.errorMessage)).check(matches(org.hamcrest.Matchers.not(isDisplayed())))
    }

    @Test fun fileSelectionReturnsAContentUriToTheWebInput() {
        val context = instrumentation.targetContext
        val file = File(context.cacheDir, "picker/wqn-ci.csv")
        file.parentFile!!.mkdirs()
        file.writeText("word,meaning\napple,fruit\n")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        Intents.init()
        try {
            intending(hasAction(Intent.ACTION_GET_CONTENT)).respondWith(
                ActivityResult(Activity.RESULT_OK, Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)))
            js("document.querySelector('#upload').click()")
            awaitJs("window.selectedFile", "\"wqn-ci.csv\"")
        } finally {
            Intents.release()
            file.delete()
        }
    }

    @Test fun printBridgeOpensTheSystemPrintUi() {
        assertEquals("true", js("window.WQNAndroid.print('CI worksheet')"))
        assertTrue("Native print UI did not open", device.wait(Until.hasObject(By.pkg("com.android.printspooler")), 10_000))
        device.pressBack()
    }

    @Test fun downloadBridgeSavesTheActualBytesAndForwardsSessionHeaders() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "text/csv").setBody("word,meaning\napple,fruit\n"))
        server.start()
        val url = server.url("/wqn-ci.csv").toString()
        val context = instrumentation.targetContext
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        var downloadId = -1L
        try {
            val cookieSet = CountDownLatch(1)
            scenario.onActivity {
                CookieManager.getInstance().setCookie(url, "download-session=ci") { cookieSet.countDown() }
            }
            assertTrue(cookieSet.await(5, TimeUnit.SECONDS))
            scenario.onActivity {
                DownloadBridge(it, it.findViewById(R.id.webView)).onDownloadStart(
                    url, "WQN-CI", "attachment; filename=\"wqn-ci.csv\"", "text/csv", 25)
            }
            val deadline = System.currentTimeMillis() + 20_000
            var completed = false
            while (System.currentTimeMillis() < deadline && !completed) {
                manager.query(DownloadManager.Query()).use { cursor ->
                    while (cursor.moveToNext()) {
                        if (cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_URI)) == url) {
                            downloadId = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID))
                            completed = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL
                        }
                    }
                }
                if (!completed) Thread.sleep(100)
            }
            assertTrue("Download did not finish", completed)
            manager.openDownloadedFile(downloadId).use { descriptor ->
                assertEquals("word,meaning\napple,fruit\n", FileInputStream(descriptor.fileDescriptor).readBytes().toString(Charsets.UTF_8))
            }
            val request = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertTrue(request.getHeader("Cookie")!!.contains("download-session=ci"))
            assertEquals("WQN-CI", request.getHeader("User-Agent"))
            assertTrue(request.getHeader("Referer")!!.startsWith(Site.BASE_URL))
        } finally {
            if (downloadId >= 0) manager.remove(downloadId)
            server.shutdown()
        }
    }
}
