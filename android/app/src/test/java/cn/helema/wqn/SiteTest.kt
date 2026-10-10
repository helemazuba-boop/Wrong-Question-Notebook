package cn.helema.wqn

import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale

class SiteTest {
    private val originalLocale = Locale.getDefault()

    @After fun restoreLocale() { Locale.setDefault(originalLocale) }

    @Test fun ownHostsIncludeOnlyTheConfiguredSiteAndHelemaDomains() {
        assertTrue(Site.isOwnHost(Site.HOST))
        assertTrue(Site.isOwnHost("data.helema.cn"))
        assertTrue(Site.isOwnHost("helema.cn"))
    }

    @Test fun lookalikeAndMissingHostsAreExternal() {
        listOf(null, "", "evilhelema.cn", "helema.cn.evil.invalid", "wqn.helema.cn.evil.invalid")
            .forEach { assertFalse("Unexpected own host: $it", Site.isOwnHost(it)) }
    }

    @Test fun startUrlsUseAnExplicitLocale() {
        assertEquals("https://wqn.helema.cn/en", Site.startUrl("en"))
        assertEquals("https://wqn.helema.cn/zh-CN", Site.startUrl("zh-CN"))
    }

    @Test fun chineseAndOtherSystemLocalesMapToSupportedLanguages() {
        Locale.setDefault(Locale.SIMPLIFIED_CHINESE)
        assertEquals("zh-CN", Site.systemLocale())
        assertEquals("zh-CN,zh;q=0.9", Site.acceptLanguage(Site.systemLocale()))
        Locale.setDefault(Locale.FRENCH)
        assertEquals("en", Site.systemLocale())
        assertEquals("en-US,en;q=0.9", Site.acceptLanguage(Site.systemLocale()))
    }
}
