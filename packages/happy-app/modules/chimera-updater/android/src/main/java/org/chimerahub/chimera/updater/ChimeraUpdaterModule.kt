package org.chimerahub.chimera.updater

import android.content.Intent
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class ChimeraUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChimeraUpdater")

    AsyncFunction("hashFile") { fileUri: String ->
      val file = requireCachedUpdateFile(fileUri, allowPartial = true)
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(file).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
      digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }

    AsyncFunction("inspectApk") { fileUri: String ->
      val apk = requireCachedApk(fileUri)
      val packageInfo = readPackageInfo(apk)
        ?: throw CodedException("E_APK_INVALID", "The selected file is not a readable APK.", null)
      val versionName = packageInfo.versionName?.takeIf { it.isNotBlank() }
        ?: throw CodedException("E_APK_INVALID", "APK must declare a version name.", null)
      mapOf(
        "packageName" to packageInfo.packageName,
        "versionName" to versionName,
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
      val archiveInfo = readPackageInfo(apk)
        ?: throw CodedException("E_APK_INVALID", "The selected file is not a readable APK.", null)
      validateInstallIdentity(archiveInfo)
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
    return requireCachedUpdateFile(value, allowPartial = false)
  }

  private fun requireCachedUpdateFile(value: String, allowPartial: Boolean): File {
    val context = requireContext()
    try {
      val uri = Uri.parse(value)
      val rawPath = uri.path
      if (uri.scheme != "file" || rawPath.isNullOrEmpty()) throw IllegalArgumentException()
      val file = File(rawPath).canonicalFile
      val cacheDirectory = File(context.cacheDir, "chimera-updates").canonicalFile
      val allowedSuffix = file.name.endsWith(".apk", ignoreCase = true) || (allowPartial && file.name.endsWith(".partial", ignoreCase = true))
      if (file.parentFile != cacheDirectory || !file.isFile || !allowedSuffix) {
        throw IllegalArgumentException()
      }
      return file
    } catch (_: Exception) {
      throw CodedException("E_APK_URI", "APK must be a file in the Chimera update cache.", null)
    }
  }

  @Suppress("DEPRECATION")
  private fun readPackageInfo(apk: File): PackageInfo? = requireContext().packageManager.getPackageArchiveInfo(
    apk.absolutePath,
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  )

  @Suppress("DEPRECATION")
  private fun installedPackageInfo(context: Context): PackageInfo = try {
    context.packageManager.getPackageInfo(
      context.packageName,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    )
  } catch (_: PackageManager.NameNotFoundException) {
    throw CodedException("E_APK_IDENTITY", "Installed app identity is unavailable.", null)
  }

  private fun validateInstallIdentity(candidate: PackageInfo) {
    val context = requireContext()
    if (candidate.packageName != context.packageName) {
      throw CodedException("E_APK_IDENTITY", "APK package does not match this app.", null)
    }
    val installed = installedPackageInfo(context)
    if (signerDigest(candidate) != signerDigest(installed)) {
      throw CodedException("E_APK_IDENTITY", "APK signer does not match this app.", null)
    }
  }

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
