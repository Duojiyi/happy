import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) => fs.readFileSync(path.join(moduleRoot, relativePath), 'utf8');

test('TypeScript exposes the asynchronous inspected APK contract', () => {
  const types = source('index.ts');
  assert.match(types, /export type InspectedApk = \{[\s\S]*versionCode: number;[\s\S]*signerSha256: string;/);
  assert.match(types, /canRequestPackageInstalls\(\): Promise<boolean>;/);
  assert.match(types, /openInstallPermissionSettings\(\): Promise<void>;/);
  assert.match(types, /launchInstaller\(uri: string\): Promise<void>;/);
});

test('Kotlin exposes asynchronous API methods and rejects ambiguous APK signers', () => {
  const kotlin = source('android/src/main/java/org/chimerahub/chimera/updater/ChimeraUpdaterModule.kt');
  for (const method of ['inspectApk', 'canRequestPackageInstalls', 'openInstallPermissionSettings', 'launchInstaller']) {
    assert.match(kotlin, new RegExp(`AsyncFunction\\(\"${method}\"`));
  }
  assert.match(kotlin, /PackageManager\.GET_SIGNING_CERTIFICATES/);
  assert.match(kotlin, /signatures\.size != 1/);
  assert.match(kotlin, /"signerSha256" to signerDigest\(packageInfo\)/);
  assert.match(kotlin, /"versionCode" to versionCode\(packageInfo\)/);
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
