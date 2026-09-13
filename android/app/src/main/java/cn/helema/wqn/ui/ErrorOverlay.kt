package cn.helema.wqn.ui

import android.view.View
import cn.helema.wqn.R
import cn.helema.wqn.databinding.ViewErrorBinding

class ErrorOverlay(
    private val binding: ViewErrorBinding,
    private val onRetry: () -> Unit,
    private val onOpenInBrowser: (url: String) -> Unit
) {
    private var failedUrl: String? = null

    init {
        binding.errorRetry.setOnClickListener {
            hide()
            onRetry()
        }
        binding.errorOpenInBrowser.setOnClickListener {
            failedUrl?.let { onOpenInBrowser(it) }
        }
    }

    val isVisible: Boolean
        get() = binding.root.visibility == View.VISIBLE

    fun show(
        url: String,
        title: String? = null,
        message: String? = null,
        showRetry: Boolean = true
    ) {
        failedUrl = url
        val context = binding.root.context
        binding.errorTitle.text = title ?: context.getString(R.string.error_title)
        binding.errorMessage.text = message ?: context.getString(R.string.error_offline)
        // Without a working WebView (version gate failure) a retry is pointless.
        binding.errorRetry.visibility = if (showRetry) View.VISIBLE else View.GONE
        binding.root.visibility = View.VISIBLE
    }

    fun hide() {
        binding.root.visibility = View.GONE
    }
}
