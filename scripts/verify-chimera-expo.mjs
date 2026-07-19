import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
process.env.APP_ENV = 'production';
const mod = await import('../packages/happy-app/app.config.js');
const config = mod.default.expo;
assert.equal(config.name, 'Chimera'); assert.equal(config.slug, 'chimera');
assert.equal(config.android.package, 'org.chimerahub.chimera'); assert.deepEqual(config.scheme, ['chimera', 'happy']);
assert.equal(config.updates?.enabled, false); assert.equal(config.android.googleServicesFile, undefined);
assert(!config.plugins.some(p => (Array.isArray(p) ? p[0] : p) === 'expo-notifications'));
const permissions = config.android.permissions ?? [];
assert(permissions.includes('android.permission.CAMERA')); assert(!permissions.includes('android.permission.RECORD_AUDIO')); assert(!permissions.includes('android.permission.POST_NOTIFICATIONS'));
assert(config.plugins.some(p => (Array.isArray(p) ? p[0] : p) === 'expo-camera'));
const sourceRoot = new URL('../packages/happy-app/sources/', import.meta.url);
for (const relative of ['sync/pushRegistration.ts', 'track/index.ts', 'track/tracking.ts', 'app/(app)/dev/expo-constants.tsx']) {
  const url = new URL(relative, sourceRoot);
  if (relative === 'sync/pushRegistration.ts') {
    await assert.rejects(readFile(url));
  } else {
    const source = await readFile(url, 'utf8');
    assert(!/expo-updates|expo-notifications|posthog-react-native/.test(source), `${relative} still imports disabled integrations`);
    assert(!/\bUpdates\./.test(source), `${relative} still calls Updates`);
  }
}
await assert.rejects(readFile(new URL('sync/apiPush.ts', sourceRoot)), 'sync/apiPush.ts still exists');
const account = await readFile(new URL('app/(app)/settings/account.tsx', sourceRoot), 'utf8');
assert(!/PushPermission|Registered Tokens|push notification/i.test(account), 'account still exposes push UI');
const repositoryRoot = new URL('../', import.meta.url);
const appPackage = await readFile(new URL('packages/happy-app/package.json', repositoryRoot), 'utf8');
assert(!/eas build|auto-submit|release:build:appstore/i.test(appPackage), 'happy-app package still exposes EAS release commands');
for (const relative of [
  'packages/happy-app/eas.json',
  'packages/happy-app/release.cjs',
  'packages/happy-app/release-dev.sh',
  'packages/happy-app/release-production.sh',
]) {
  await assert.rejects(readFile(new URL(relative, repositoryRoot)), `${relative} still exists`);
}
const storage = await readFile(new URL('sync/storage.ts', sourceRoot), 'utf8');
assert(!/nativeUpdateStatus|applyNativeUpdateStatus/.test(storage), 'storage still exposes native update state');
const layoutSource = await readFile(new URL('app/_layout.tsx', sourceRoot), 'utf8');
assert(!/RealtimeProvider|PUSH ROUTING|push notification routing/i.test(layoutSource), 'root layout still mounts disabled integrations');
console.log('Chimera Expo config verified');
