// Root build file. AGP 9 ships built-in Kotlin support, so the
// org.jetbrains.kotlin.android plugin must NOT be applied here.
plugins {
    alias(libs.plugins.android.application) apply false
}
