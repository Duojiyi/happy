package org.chimerahub.chimera.updater

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

class ChimeraUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChimeraUpdater")

    AsyncFunction("inspectApk") { fileUri: String ->
      val apk = requireCachedApk(fileUri)
      val packageInfo = readPackageInfo(apk)
        ?: throw CodedException("E_APK_INVALID", "The selected file is not a readable APK.", null)
      mapOf(
        "packageName" to packageInfo.packageName,
        "versionName" to packageInfo.versionName,
        "versionCode" to versionCode(packageInfo),
        "signerSha256" to signerDigest(packageInfo)
      )
    }

    AsyncFunction("canRequestPackageInstalls") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || appContext.reactContext?.packageManager?.canRequestPackageInstalls() == true
    }

    AsyncFunction("openInstallPermissionSettings") {
      val context = requireContext()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startActivity(Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    AsyncFunction("launchInstaller") { fileUri: String ->
      val context = requireContext()
      val apk = requireCachedApk(fileUri)
      val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.chimera.updates", apk)
      context.startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    }
  }

  private fun requireContext() = appContext.reactContext
    ?: throw CodedException("E_CONTEXT_UNAVAILABLE", "Android context is unavailable.", null)

  private fun requireCachedApk(value: String): File {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") throw CodedException("E_APK_URI", "APK URI must use the file scheme.", null)
    val file = File(requireNotNull(uri.path) { "APK URI has no path." }).canonicalFile
    val cacheDirectory = File(requireContext().cacheDir, "chimera-updates").canonicalFile
    if (file.parentFile != cacheDirectory || !file.isFile || !file.name.endsWith(".apk", ignoreCase = true)) {
      throw CodedException("E_APK_URI", "APK must be a file in the Chimera update cache.", null)
    }
    return file
  }

  @Suppress("DEPRECATION")
  private fun readPackageInfo(apk: File): PackageInfo? = requireContext().packageManager.getPackageArchiveInfo(
    apk.absolutePath,
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  )

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signerDigest(info: PackageInfo): String {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else info.signatures
    if (signatures == null || signatures.size != 1) {
      throw CodedException("E_APK_SIGNERS", "APK must contain exactly one signing certificate.", null)
    }
    return MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()).joinToString("") { byte -> "%02X".format(byte) }
  }
}
