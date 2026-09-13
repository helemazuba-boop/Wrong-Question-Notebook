package cn.helema.wqn.prefs

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import cn.helema.wqn.Site

class AppPrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var locale: String
        get() {
            val cookie = CookieManager.getInstance().getCookie(Site.BASE_URL)
            if (cookie != null) {
                val match = NEXT_LOCALE_REGEX.find(cookie)
                if (match != null) {
                    val cookieLocale = match.groupValues[1]
                    if (cookieLocale == "zh-CN" || cookieLocale == "en") {
                        return cookieLocale
                    }
                }
            }
            return prefs.getString(KEY_LOCALE, DEFAULT_LOCALE) ?: DEFAULT_LOCALE
        }
        set(value) {
            val normalized = if (value == "en") "en" else "zh-CN"
            prefs.edit().putString(KEY_LOCALE, normalized).apply()
            CookieManager.getInstance().setCookie(
                Site.BASE_URL,
                "NEXT_LOCALE=$normalized; path=/; domain=helema.cn; SameSite=Lax"
            )
            CookieManager.getInstance().flush()
        }

    var lastUrl: String?
        get() = prefs.getString(KEY_LAST_URL, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_URL, value).apply()
        }

    fun syncLocaleFromCookie() {
        val cookie = CookieManager.getInstance().getCookie(Site.BASE_URL) ?: return
        val match = NEXT_LOCALE_REGEX.find(cookie) ?: return
        val cookieLocale = match.groupValues[1]
        if (cookieLocale == "zh-CN" || cookieLocale == "en") {
            prefs.edit().putString(KEY_LOCALE, cookieLocale).apply()
        }
    }

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "wqn_prefs"
        private const val KEY_LOCALE = "pref_locale"
        private const val KEY_LAST_URL = "pref_last_url"
        const val DEFAULT_LOCALE = "zh-CN"
        private val NEXT_LOCALE_REGEX = Regex("""NEXT_LOCALE=([^;]+)""")
    }
}
