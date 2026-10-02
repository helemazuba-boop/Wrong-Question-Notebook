package cn.helema.wqn

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FileChooserHelper(private val activity: ComponentActivity) {

    private var currentCallback: ValueCallback<Array<Uri>>? = null
    private var currentCameraUri: Uri? = null
    private var currentCameraFile: File? = null

    // Work around OEM camera bugs where camera app ignores EXTRA_OUTPUT URI grant
    private class TakePictureWithClipData : ActivityResultContracts.TakePicture() {
        override fun createIntent(context: Context, input: Uri): Intent {
            val intent = super.createIntent(context, input)
            intent.clipData = ClipData.newRawUri(null, input)
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            return intent
        }
    }

    private val takePictureLauncher: ActivityResultLauncher<Uri> =
        activity.registerForActivityResult(TakePictureWithClipData()) { success ->
            val uri = currentCameraUri
            val file = currentCameraFile
            // OEM quirk: some camera apps return RESULT_CANCELED but have already written the file
            if (success || (file != null && file.exists() && file.length() > 0)) {
                resolve(if (uri != null) arrayOf(uri) else null)
            } else {
                resolve(null)
            }
        }

    private val pickVisualMediaLauncher: ActivityResultLauncher<PickVisualMediaRequest> =
        activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            resolve(if (uri != null) arrayOf(uri) else null)
        }

    private val pickMultipleVisualMediaLauncher: ActivityResultLauncher<PickVisualMediaRequest> =
        activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
            resolve(if (!uris.isNullOrEmpty()) uris.toTypedArray() else null)
        }

    private val getContentLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            resolve(if (uri != null) arrayOf(uri) else null)
        }

    private val getMultipleContentsLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
            resolve(if (!uris.isNullOrEmpty()) uris.toTypedArray() else null)
        }

    init {
        cleanOldTempFiles()
    }

    fun onShowFileChooser(
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: WebChromeClient.FileChooserParams?
    ): Boolean {
        // Reset any pending callback to prevent webview from permanently hanging
        currentCallback?.let {
            try {
                it.onReceiveValue(null)
            } catch (_: Exception) {}
        }
        currentCallback = filePathCallback

        if (filePathCallback == null || fileChooserParams == null) {
            resolve(null)
            return false
        }

        try {
            if (fileChooserParams.isCaptureEnabled) {
                launchCamera()
            } else {
                launchPicker(fileChooserParams)
            }
            return true
        } catch (e: Exception) {
            resolve(null)
            return false
        }
    }

    private fun launchCamera() {
        val pickerDir = File(activity.cacheDir, "picker").apply { mkdirs() }
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val photoFile = File.createTempFile("IMG_${timeStamp}_", ".jpg", pickerDir)
        currentCameraFile = photoFile

        val authority = "${activity.packageName}.fileprovider"
        val photoUri = FileProvider.getUriForFile(activity, authority, photoFile)
        currentCameraUri = photoUri

        takePictureLauncher.launch(photoUri)
    }

    private fun launchPicker(params: WebChromeClient.FileChooserParams) {
        val isMultiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val acceptTypes = params.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
        val mimeType = if (acceptTypes.size == 1) acceptTypes.first() else "*/*"

        // The site's uploaders send "image/jpeg,image/png,..." (multiple types):
        // decide on the whole set, otherwise the photo picker would also allow
        // videos that the page would just reject.
        val allImages = acceptTypes.isNotEmpty() && acceptTypes.all { it.startsWith("image/", ignoreCase = true) }
        val allVisual = acceptTypes.isNotEmpty() && acceptTypes.all {
            it.startsWith("image/", ignoreCase = true) || it.startsWith("video/", ignoreCase = true)
        }
        val isVisualMediaSupported = ActivityResultContracts.PickVisualMedia.isPhotoPickerAvailable(activity)

        if (isVisualMediaSupported && allVisual) {
            val visualType = if (allImages) {
                ActivityResultContracts.PickVisualMedia.ImageOnly
            } else {
                ActivityResultContracts.PickVisualMedia.ImageAndVideo
            }
            val request = PickVisualMediaRequest(visualType)
            if (isMultiple) {
                pickMultipleVisualMediaLauncher.launch(request)
            } else {
                pickVisualMediaLauncher.launch(request)
            }
        } else {
            if (isMultiple) {
                getMultipleContentsLauncher.launch(mimeType)
            } else {
                getContentLauncher.launch(mimeType)
            }
        }
    }

    private fun resolve(result: Array<Uri>?) {
        val cb = currentCallback
        currentCallback = null
        currentCameraUri = null
        currentCameraFile = null
        try {
            cb?.onReceiveValue(result)
        } catch (e: Exception) {
            try {
                cb?.onReceiveValue(null)
            } catch (_: Exception) {}
        }
    }

    fun cancelPending() {
        resolve(null)
    }

    private fun cleanOldTempFiles() {
        Thread {
            try {
                val pickerDir = File(activity.cacheDir, "picker")
                if (pickerDir.exists() && pickerDir.isDirectory) {
                    val oneDayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
                    pickerDir.listFiles()?.forEach { file ->
                        if (file.lastModified() < oneDayAgo) {
                            file.delete()
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }
}
