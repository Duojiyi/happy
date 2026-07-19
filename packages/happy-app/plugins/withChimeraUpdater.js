const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

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
    application.provider ??= [];
    if (!application.provider.some((provider) => provider.$?.['android:authorities'] === PROVIDER_AUTHORITY)) {
      application.provider.push({
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
      });
    }
  return manifest;
}

function withChimeraUpdaterManifest(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    applyToManifest(manifestConfig.modResults.manifest);
    return manifestConfig;
  });
}

function copyNativeSource(config) {
  return withDangerousMod(config, ['android', async (modConfig) => {
    const moduleRoot = path.join(modConfig.modRequest.projectRoot, 'modules', 'chimera-updater', 'android', 'src', 'main');
    const destinationRoot = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main');
    const files = [
      ['java', 'org', 'chimerahub', 'chimera', 'updater', 'ChimeraUpdaterModule.kt'],
      ['res', 'xml', 'chimera_update_paths.xml'],
    ];
    for (const parts of files) {
      const source = path.join(moduleRoot, ...parts);
      const destination = path.join(destinationRoot, ...parts);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    return modConfig;
  }]);
}

module.exports = (config) => copyNativeSource(withChimeraUpdaterManifest(config));
module.exports.applyToManifest = applyToManifest;
