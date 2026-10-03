package cn.helema.wqn.prefs

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import cn.helema.wqn.Site

class AppPrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * The locale the site should open in. A NEXT_LOCALE cookie (the user's
     * in-site choice) wins; otherwise follow the system language. There is no
     * in-app override.
     */
    val locale: String
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
            return Site.systemLocale()
        }

    var lastUrl: String?
        get() = prefs.getString(KEY_LAST_URL, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_URL, value).apply()
        }

    companion object {
        private const val PREFS_NAME = "wqn_prefs"
        private const val KEY_LAST_URL = "pref_last_url"
        private val NEXT_LOCALE_REGEX = Regex("""NEXT_LOCALE=([^;]+)""")
    }
}
