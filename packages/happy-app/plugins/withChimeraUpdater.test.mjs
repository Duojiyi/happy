import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import withChimeraUpdater from './withChimeraUpdater.js';

const pluginSource = fs.readFileSync(fileURLToPath(new URL('./withChimeraUpdater.js', import.meta.url)), 'utf8');

const androidManifestFixture = () => ({
  manifest: {
    application: [{ $: { 'android:name': '.MainApplication' } }],
  },
});

function applyPlugin(fixture) {
  withChimeraUpdater.applyToManifest(fixture.manifest);
  return fixture;
}

test('adds a minimal, non-exported APK FileProvider and install permission', () => {
  const result = applyPlugin(androidManifestFixture());
  const manifest = result.manifest;
  const applications = manifest.application;
  const providers = applications.flatMap((application) => application.provider ?? []);

  assert.equal(manifest['uses-permission'].filter((entry) => entry.$['android:name'] === 'android.permission.REQUEST_INSTALL_PACKAGES').length, 1);
  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0].$, {
    'android:name': 'androidx.core.content.FileProvider',
    'android:authorities': '${applicationId}.chimera.updates',
    'android:exported': 'false',
    'android:grantUriPermissions': 'true',
  });
  assert.equal(providers[0]['meta-data'][0].$['android:resource'], '@xml/chimera_update_paths');
});

test('is idempotent and does not introduce broad external storage paths', () => {
  const once = applyPlugin(androidManifestFixture());
  const twice = applyPlugin(once);
  const manifest = twice.manifest;
  const providers = manifest.application.flatMap((application) => application.provider ?? []);

  assert.equal(manifest['uses-permission'].filter((entry) => entry.$['android:name'] === 'android.permission.REQUEST_INSTALL_PACKAGES').length, 1);
  assert.equal(providers.length, 1);
  assert.equal(manifest['uses-permission'].some((entry) => /EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/.test(entry.$['android:name'])), false);
});

test('repairs unsafe duplicate update providers without changing unrelated providers', () => {
  const fixture = androidManifestFixture();
  fixture.manifest.application[0].provider = [
    { $: { 'android:name': 'com.example.UnsafeProvider', 'android:authorities': '${applicationId}.chimera.updates', 'android:exported': 'true' } },
    { $: { 'android:name': 'com.example.DuplicateProvider', 'android:authorities': '${applicationId}.chimera.updates', 'android:grantUriPermissions': 'false' } },
    { $: { 'android:name': 'com.example.UnrelatedProvider', 'android:authorities': '${applicationId}.other', 'android:exported': 'true' } },
  ];

  const result = applyPlugin(applyPlugin(fixture));
  const providers = result.manifest.application[0].provider;
  const updates = providers.filter((provider) => provider.$['android:authorities'] === '${applicationId}.chimera.updates');

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].$, {
    'android:name': 'androidx.core.content.FileProvider',
    'android:authorities': '${applicationId}.chimera.updates',
    'android:exported': 'false',
    'android:grantUriPermissions': 'true',
  });
  assert.equal(updates[0]['meta-data'].length, 1);
  assert.equal(updates[0]['meta-data'][0].$['android:resource'], '@xml/chimera_update_paths');
  assert.equal(providers.some((provider) => provider.$['android:authorities'] === '${applicationId}.other'), true);
});

test('does not copy native sources into the generated Android app', () => {
  assert.doesNotMatch(pluginSource, /withDangerousMod|copyFileSync|ChimeraUpdaterModule\.kt/);
});
