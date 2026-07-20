import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) => fs.readFileSync(path.join(moduleRoot, relativePath), 'utf8');

test('TypeScript exposes the asynchronous inspected APK contract', () => {
  const types = source('index.ts');
  assert.match(types, /export type InspectedApk = \{[\s\S]*versionName: string;[\s\S]*versionCode: number;[\s\S]*signerSha256: string;/);
  assert.match(types, /canRequestPackageInstalls\(\): Promise<boolean>;/);
  assert.match(types, /openInstallPermissionSettings\(\): Promise<void>;/);
  assert.match(types, /launchInstaller\(uri: string\): Promise<void>;/);
  assert.match(types, /hashFile\(uri: string\): Promise<string>;/);
});

test('Kotlin exposes asynchronous API methods and rejects ambiguous APK signers', () => {
  const kotlin = source('android/src/main/java/org/chimerahub/chimera/updater/ChimeraUpdaterModule.kt');
  for (const method of ['hashFile', 'inspectApk', 'canRequestPackageInstalls', 'openInstallPermissionSettings', 'launchInstaller']) {
    assert.match(kotlin, new RegExp(`AsyncFunction\\(\"${method}\"`));
  }
  assert.match(kotlin, /FileInputStream\(file\)\.use/);
  assert.match(kotlin, /digest\.update\(buffer, 0, count\)/);
  assert.doesNotMatch(kotlin, /readBytes\(\)/);
  assert.match(kotlin, /PackageManager\.GET_SIGNING_CERTIFICATES/);
  assert.match(kotlin, /signatures\.size != 1/);
  assert.match(kotlin, /"signerSha256" to signerDigest\(packageInfo\)/);
  assert.match(kotlin, /"versionCode" to versionCode\(packageInfo\)/);
  assert.match(kotlin, /val versionName = packageInfo\.versionName\?\.takeIf \{ it\.isNotBlank\(\) \}/);
  assert.match(kotlin, /"versionName" to versionName/);
});

test('installer revalidates APK identity against the installed app before granting a URI', () => {
  const kotlin = source('android/src/main/java/org/chimerahub/chimera/updater/ChimeraUpdaterModule.kt');
  const launchInstaller = kotlin.slice(kotlin.indexOf('AsyncFunction("launchInstaller")'), kotlin.indexOf('\n    }\n  }', kotlin.indexOf('AsyncFunction("launchInstaller")')));

  assert.match(launchInstaller, /val archiveInfo = readPackageInfo\(apk\)/);
  assert.match(launchInstaller, /validateInstallIdentity\(archiveInfo\)/);
  assert.ok(launchInstaller.indexOf('validateInstallIdentity(archiveInfo)') < launchInstaller.indexOf('FileProvider.getUriForFile'));
  assert.match(kotlin, /getPackageInfo\(\s*context\.packageName,\s*[\s\S]*PackageManager\.GET_SIGNING_CERTIFICATES/);
  assert.match(kotlin, /candidate\.packageName != context\.packageName/);
  assert.match(kotlin, /signerDigest\(candidate\) != signerDigest\(installed\)/);
  assert.match(kotlin, /CodedException\("E_APK_IDENTITY"/);
});

test('malformed cache file URIs are reduced to a non-leaking APK URI error', () => {
  const kotlin = source('android/src/main/java/org/chimerahub/chimera/updater/ChimeraUpdaterModule.kt');
  const cachedApk = kotlin.slice(kotlin.indexOf('private fun requireCachedApk'), kotlin.indexOf('\n  @Suppress', kotlin.indexOf('private fun requireCachedApk')));

  assert.match(cachedApk, /try \{/);
  assert.match(cachedApk, /uri\.scheme != "file" \|\| rawPath\.isNullOrEmpty\(\)/);
  assert.match(cachedApk, /catch \(_:\s*Exception\)/);
  assert.match(cachedApk, /CodedException\("E_APK_URI", "APK must be a file in the Chimera update cache\."/);
  assert.doesNotMatch(cachedApk, /value\}|rawPath\}|file\.absolutePath/);
});

test('autolinking discovers the local module and its Gradle project supplies FileProvider', () => {
  const packageJson = JSON.parse(source('package.json'));
  const config = JSON.parse(source('expo-module.config.json'));
  const gradle = source('android/build.gradle');
  assert.equal(packageJson.name, 'chimera-updater');
  assert.deepEqual(config.android.modules, ['org.chimerahub.chimera.updater.ChimeraUpdaterModule']);
  assert.match(gradle, /androidx\.core:core:/);
  assert.doesNotMatch(gradle, /sourceSets/);
  assert.match(source('../../app.config.js'), /autolinking: \{ nativeModulesDir: '\.\/modules' \}/);
});
