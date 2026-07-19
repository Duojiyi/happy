import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyChimeraClient } from './verify-chimera-client.mjs';

async function fixture(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chimera-client-policy-'));
  const defaults = {
    'packages/happy-app/app.config.js': "export default { expo: { name: 'Chimera', slug: 'chimera', android: { package: 'org.chimerahub.chimera' }, updates: { enabled: false }, plugins: [] } };\n",
    'packages/happy-app/sources/app/(app)/settings/index.tsx': "export const settings = ['account', 'appearance', 'language'];\n",
    'packages/happy-app/sources/app/(app)/index.tsx': "export const title = 'Chimera';\n",
  };
  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

async function policyResult(files) {
  const root = await fixture(files);
  try {
    return await verifyChimeraClient({ root, requireWebExport: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function policyResultWithEnv(files, environment) {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = environment;
  try {
    return await policyResult(files);
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
}

test('passes denylist constants and explicit non-production fixtures', async () => {
  const result = await policyResult({
    'packages/happy-app/sources/chimera/clientPolicy.ts': "export const DENYLIST = ['PostHog', 'RevenueCat', 'ElevenLabs'];\n",
    'packages/happy-app/sources/__fixtures__/legacy-happy.ts': "export const host = 'https://happy.engineering';\n",
    'packages/happy-app/sources/app/example.test.tsx': "const logo = 'Happy';\n",
  });
  assert.deepEqual(result, []);
});

for (const [name, files, rule] of [
  ['Happy branding', { 'packages/happy-app/sources/app/(app)/index.tsx': "export const title = 'Happy';\n" }, 'happy-branding'],
  ['Happy logo asset', { 'packages/happy-app/sources/app/(app)/index.tsx': "export const logo = require('../../../assets/happy-logo.png');\n" }, 'happy-logo'],
  ['official host', { 'packages/happy-app/sources/app/(app)/index.tsx': "fetch('https://happy.engineering/api');\n" }, 'official-host'],
  ['server selector', { 'packages/happy-app/sources/app/(app)/server.tsx': 'export default function ServerSelector() {}\n' }, 'server-selector'],
  ['voice button', { 'packages/happy-app/sources/app/(app)/index.tsx': '<VoiceButton onPress={startVoice} />\n' }, 'voice-integration'],
  ['push plugin', { 'packages/happy-app/app.config.js': "export default { expo: { name: 'Chimera', slug: 'chimera', android: { package: 'org.chimerahub.chimera' }, updates: { enabled: false }, plugins: ['expo-notifications'] } };\n" }, 'push-integration'],
  ['PostHog initialization', { 'packages/happy-app/sources/app/(app)/index.tsx': "new PostHog('public-key');\n" }, 'telemetry-or-purchases'],
  ['RevenueCat initialization', { 'packages/happy-app/sources/app/(app)/index.tsx': "RevenueCat.configure({ apiKey: 'public-key' });\n" }, 'telemetry-or-purchases'],
  ['ElevenLabs initialization', { 'packages/happy-app/sources/app/(app)/index.tsx': "useConversation({ agentId: 'agent' });\n" }, 'voice-integration'],
  ['Expo project ID', { 'packages/happy-app/app.config.js': "export default { expo: { name: 'Chimera', slug: 'chimera', android: { package: 'org.chimerahub.chimera' }, updates: { enabled: false }, extra: { eas: { projectId: 'not-a-secret' } }, plugins: [] } };\n" }, 'expo-project-id'],
  ['removed settings ID', { 'packages/happy-app/sources/app/(app)/settings/index.tsx': "export const settings = [{ id: 'voice' }];\n" }, 'removed-settings-or-route'],
]) {
  test(`fails when production source adds ${name}`, async () => {
    const result = await policyResult(files);
    assert(result.some((finding) => finding.rule === rule), JSON.stringify(result));
  });
}

for (const [name, files, rule] of [
  ['a voice import in components', { 'packages/happy-app/sources/components/AgentInput.tsx': "import { useConversation } from '@elevenlabs/react';\n" }, 'voice-integration'],
  ['a RevenueCat initialization in sync', { 'packages/happy-app/sources/sync/sync.ts': "RevenueCat.configure({ apiKey: 'public-key' });\n" }, 'telemetry-or-purchases'],
  ['an official host in track', { 'packages/happy-app/sources/track/tracking.ts': "fetch('https://happy.engineering/events');\n" }, 'official-host'],
]) {
  test(`fails when ${name}`, async () => {
    const result = await policyResult(files);
    assert(result.some((finding) => finding.rule === rule), JSON.stringify(result));
  });
}

test('evaluates a production Expo config through a relative import', async () => {
  const result = await policyResultWithEnv({
    'packages/happy-app/config-values.js': "export const plugins = process.env.APP_ENV === 'production' ? ['expo-notifications'] : [];\n",
    'packages/happy-app/app.config.js': "import { plugins } from './config-values.js'; export default { expo: { name: 'Chimera', slug: 'chimera', android: { package: 'org.chimerahub.chimera' }, updates: { enabled: false }, plugins } };\n",
  }, 'production');
  assert(result.some((finding) => finding.rule === 'push-integration'), JSON.stringify(result));
});

test('uses the production Expo config variant even when the caller is development', async () => {
  const result = await policyResultWithEnv({
    'packages/happy-app/app.config.js': "const bad = process.env.APP_ENV === 'production'; export default { expo: { name: 'Chimera', slug: 'chimera', android: { package: 'org.chimerahub.chimera' }, updates: { enabled: false }, plugins: bad ? ['expo-notifications'] : [] } };\n",
  }, 'development');
  assert(result.some((finding) => finding.rule === 'push-integration'), JSON.stringify(result));
});

test('fails when the production web export contains a prohibited host', async () => {
  const result = await policyResult({
    'packages/happy-app/dist/_expo/static/js/web/app.js': "fetch('https://happy.engineering/api');\n",
  });
  assert(result.some((finding) => finding.rule === 'official-host'), JSON.stringify(result));
});

test('fails for a hidden integration route in the routable dev folder', async () => {
  const result = await policyResult({
    'packages/happy-app/sources/app/(app)/dev/index.tsx': "router.push('/dev/purchases');\n",
  });
  assert(result.some((finding) => finding.rule === 'removed-settings-or-route'), JSON.stringify(result));
});

test('fails for a Link server selector', async () => {
  const result = await policyResult({
    'packages/happy-app/sources/app/(app)/index.tsx': "<Link href='/server'>Server</Link>\n",
  });
  assert(result.some((finding) => finding.rule === 'server-selector'), JSON.stringify(result));
});

test('fails when a minified production bundle initializes analytics', async () => {
  const result = await policyResult({
    'packages/happy-app/dist/_expo/static/js/web/app.js': 'new PostHog("public-key")',
  });
  assert(result.some((finding) => finding.rule === 'telemetry-or-purchases'), JSON.stringify(result));
});

test('fails when a forbidden physical route is restored without a route string', async () => {
  const result = await policyResult({
    'packages/happy-app/sources/app/(app)/dev/purchases.tsx': 'export default function Screen() { return null; }\n',
  });
  assert(result.some((finding) => finding.rule === 'forbidden-route-file'), JSON.stringify(result));
});
