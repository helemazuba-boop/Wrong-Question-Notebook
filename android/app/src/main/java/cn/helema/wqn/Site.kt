package cn.helema.wqn

import java.util.Locale

/** Constants that describe the hosted site this shell wraps. */
object Site {
    const val HOST = "wqn.helema.cn"
    const val BASE_URL = "https://wqn.helema.cn"

    /**
     * The site always prefixes the locale (next-intl `prefix: 'always'`), so `/`
     * would only 307-redirect to `/en`. Never load the bare origin.
     */
    fun startUrl(locale: String): String = "$BASE_URL/$locale"

    fun isOwnHost(host: String?): Boolean =
        host == HOST || host?.endsWith(".helema.cn") == true || host == "helema.cn"

    fun acceptLanguage(locale: String): String =
        if (locale.startsWith("zh")) "zh-CN,zh;q=0.9" else "en-US,en;q=0.9"

    /** Map the device language onto one of the site's two locales. */
    fun systemLocale(): String =
        if (Locale.getDefault().language == "zh") "zh-CN" else "en"
}
