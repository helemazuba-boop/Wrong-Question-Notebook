package cn.helema.wqn

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import cn.helema.wqn.databinding.ActivitySettingsBinding
import cn.helema.wqn.prefs.AppPrefs

class SettingsActivity : ComponentActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var appPrefs: AppPrefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 30) {
            WindowCompat.enableEdgeToEdge(window)
        }

        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Same API-30 gate as MainActivity: on 26-29 manual IME insets are
        // unavailable and adjustResize must be left to do the work.
        if (Build.VERSION.SDK_INT >= 30) {
            ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, windowInsets ->
                val insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
                )
                view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
                windowInsets
            }
        }

        appPrefs = AppPrefs(this)

        setupLocale()
        setupActions()
        setupAbout()
    }

    private fun setupLocale() {
        val currentLocale = appPrefs.locale
        if (currentLocale == "en") {
            binding.localeEn.isChecked = true
        } else {
            binding.localeZh.isChecked = true
        }

        binding.localeGroup.setOnCheckedChangeListener { _, checkedId ->
            val newLocale = if (checkedId == R.id.localeEn) "en" else "zh-CN"
            if (newLocale != appPrefs.locale) {
                appPrefs.locale = newLocale
                val resultIntent = Intent().apply {
                    putExtra(EXTRA_LOCALE_CHANGED, true)
                }
                setResult(Activity.RESULT_OK, resultIntent)
            }
        }
    }

    private fun setupActions() {
        binding.openInBrowser.setOnClickListener {
            val targetUrl = appPrefs.lastUrl ?: Site.startUrl(appPrefs.locale)
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl))
                startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(this, "无法打开浏览器: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }

        binding.clearData.setOnClickListener {
            // Clear cookies
            val cookieManager = CookieManager.getInstance()
            cookieManager.removeAllCookies(null)
            cookieManager.flush()

            // Clear WebStorage (localStorage, indexedDB)
            WebStorage.getInstance().deleteAllData()

            // Clear last URL
            appPrefs.lastUrl = null

            Toast.makeText(this, R.string.settings_clear_data_done, Toast.LENGTH_SHORT).show()

            val resultIntent = Intent().apply {
                putExtra(EXTRA_DATA_CLEARED, true)
            }
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
        }
    }

    private fun setupAbout() {
        val appVersion = AppInfo.versionName(this)
        binding.versionText.text = getString(R.string.settings_version, appVersion, AppInfo.versionCode(this))
        val webViewVersion = WebViewConfig.getWebViewVersionString(this)
        binding.webViewText.text = getString(R.string.settings_webview, webViewVersion)
    }

    companion object {
        const val EXTRA_LOCALE_CHANGED = "extra_locale_changed"
        const val EXTRA_DATA_CLEARED = "extra_data_cleared"
    }
}
