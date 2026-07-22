import { ANDROID_VERSION_CODE, VERSION_NAME } from './sources/chimera/product.generated.mjs';
const generated = './sources/assets/images';
const commitSha = process.env.HAPPY_BUILD_COMMIT_SHA || process.env.EAS_BUILD_GIT_COMMIT_HASH || process.env.GITHUB_SHA;
const commitTimestamp = process.env.HAPPY_BUILD_COMMIT_TIMESTAMP;

export default { expo: {
  name: 'Chimera', slug: 'chimera', version: VERSION_NAME, runtimeVersion: VERSION_NAME, orientation: 'default',
  icon: `${generated}/icon.png`, scheme: ['chimera', 'happy'], userInterfaceStyle: 'automatic',
  ios: { supportsTablet: true, bundleIdentifier: 'org.chimerahub.chimera', config: { usesNonExemptEncryption: false }, infoPlist: {} },
  android: { versionCode: ANDROID_VERSION_CODE, adaptiveIcon: { foregroundImage: `${generated}/icon-adaptive.png`, monochromeImage: `${generated}/icon-monochrome.png`, backgroundColor: '#18171C' }, package: 'org.chimerahub.chimera', permissions: ['android.permission.CAMERA'], blockedPermissions: ['com.android.vending.BILLING', 'com.android.vending.CHECK_LICENSE'] },
  web: { bundler: 'metro', output: 'single', favicon: `${generated}/favicon.png` },
  plugins: [['expo-router', { root: './sources/app' }], 'expo-asset', 'expo-localization', 'expo-secure-store', 'expo-web-browser', './plugins/withChimeraUpdater', ['expo-camera', { cameraPermission: 'Allow $(PRODUCT_NAME) to scan QR codes and share photos.' }], ['expo-splash-screen', { image: `${generated}/splash-android-light.png`, backgroundColor: '#F5F5F5' }]],
  updates: { enabled: false }, autolinking: { nativeModulesDir: './modules' }, experiments: { typedRoutes: true },
  extra: { router: { root: './sources/app' }, app: { buildCommitSha: commitSha, buildCommitTimestamp: commitTimestamp } }
} };
