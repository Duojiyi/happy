import assert from 'node:assert/strict';
import test from 'node:test';
import withChimeraUpdater from './withChimeraUpdater.js';

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
