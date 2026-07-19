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
assert(!permissions.includes('android.permission.RECORD_AUDIO')); assert(!permissions.includes('android.permission.POST_NOTIFICATIONS'));
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
const account = await readFile(new URL('app/(app)/settings/account.tsx', sourceRoot), 'utf8');
assert(!/PushPermission|Registered Tokens|push notification/i.test(account), 'account still exposes push UI');
console.log('Chimera Expo config verified');
