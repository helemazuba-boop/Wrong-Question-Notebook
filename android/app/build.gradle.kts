plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "cn.helema.wqn"
    compileSdk = 36

    defaultConfig {
        applicationId = "cn.helema.wqn"
        minSdk = 26
        // AGP 9 defaults targetSdk to compileSdk when unset; keep it explicit.
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.swiperefreshlayout)
}
