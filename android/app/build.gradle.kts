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
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "WQN_CI_ASSETS", "false")
        buildConfigField("String", "WQN_SITE_HOST", "\"wqn.helema.cn\"")
    }

    buildTypes {
        debug {
            if (providers.gradleProperty("wqnCiAssets").orNull == "true") {
                buildConfigField("boolean", "WQN_CI_ASSETS", "true")
                buildConfigField("String", "WQN_SITE_HOST", "\"appassets.androidplatform.net\"")
            }
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.swiperefreshlayout)
}
