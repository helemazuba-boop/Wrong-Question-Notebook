package cn.helema.wqn

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build

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
}

object AppInfo {
    @Suppress("DEPRECATION")
    fun versionName(context: Context): String = try {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(context.packageName, 0)
        }
        info.versionName ?: "unknown"
    } catch (e: Exception) {
        "unknown"
    }

    @Suppress("DEPRECATION")
    fun versionCode(context: Context): Long = try {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            pm.getPackageInfo(context.packageName, 0)
        }
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    } catch (e: Exception) {
        1L
    }

    fun isDebuggable(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
