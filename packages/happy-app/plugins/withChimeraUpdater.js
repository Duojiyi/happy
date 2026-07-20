const { withAndroidManifest } = require('@expo/config-plugins');

const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
const PROVIDER_AUTHORITY = '${applicationId}.chimera.updates';
const PROVIDER_NAME = 'androidx.core.content.FileProvider';

function applyToManifest(manifest) {
  manifest['uses-permission'] ??= [];
  if (!manifest['uses-permission'].some((permission) => permission.$?.['android:name'] === INSTALL_PERMISSION)) {
    manifest['uses-permission'].push({ $: { 'android:name': INSTALL_PERMISSION } });
  }

  manifest.application ??= [{ $: { 'android:name': '.MainApplication' } }];
  const application = manifest.application[0];
  const unrelatedProviders = (application.provider ?? []).filter((provider) => provider.$?.['android:authorities'] !== PROVIDER_AUTHORITY);
  application.provider = [...unrelatedProviders, {
    $: {
      'android:name': PROVIDER_NAME,
      'android:authorities': PROVIDER_AUTHORITY,
      'android:exported': 'false',
      'android:grantUriPermissions': 'true',
    },
    'meta-data': [{
      $: {
        'android:name': 'android.support.FILE_PROVIDER_PATHS',
        'android:resource': '@xml/chimera_update_paths',
      },
    }],
  }];
  return manifest;
}

function withChimeraUpdaterManifest(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    applyToManifest(manifestConfig.modResults.manifest);
    return manifestConfig;
  });
}

module.exports = withChimeraUpdaterManifest;
module.exports.applyToManifest = applyToManifest;
