import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyReleasePaths, resolveRelease, resolveReleaseWithAdapters } from './resolve-release.mjs';
import { bumpProduct, bumpRelease } from './bump-release.mjs';

const product = Object.freeze({ upstreamAppVersion: '1.7.0', chimeraRevision: 1, androidVersionCode: 41 });
const input = (overrides = {}) => ({ product, appConfigVersion: '1.7.0-chimera.1', packageVersion: '1.7.0-chimera.1', commitSha: 'a'.repeat(40), changedPaths: ['packages/happy-app/app.config.js'], tags: [], releases: [], ...overrides });

test('resolves the first release deterministically', () => {
  assert.deepEqual(resolveRelease(input()), { versionName: '1.7.0-chimera.1', versionCode: 41, tag: 'app-v1.7.0-chimera.1', commitSha: 'a'.repeat(40), artifactBase: 'Chimera-1.7.0-chimera.1-android-universal', clientReleaseRequired: true, serverDeployBeforeClient: false });
});

test('resolves a revision increment', () => {
  const next = resolveRelease(input({ product: { ...product, chimeraRevision: 2, androidVersionCode: 42 }, appConfigVersion: '1.7.0-chimera.2', packageVersion: '1.7.0-chimera.2' }));
  assert.equal(next.tag, 'app-v1.7.0-chimera.2');
  assert.equal(next.versionCode, 42);
});

test('resolves an upstream Expo version advance from revision one', () => {
  const next = resolveRelease(input({ product: { ...product, upstreamAppVersion: '1.8.0', androidVersionCode: 42 }, appConfigVersion: '1.8.0-chimera.1', packageVersion: '1.8.0-chimera.1' }));
  assert.equal(next.versionName, '1.8.0-chimera.1');
});

test('rejects product and generated-version disagreement', () => {
  assert.throws(() => resolveRelease(input({ packageVersion: '1.7.0-chimera.2' })), /package version/i);
  assert.throws(() => resolveRelease(input({ appConfigVersion: '1.7.0-chimera.2' })), /app config version/i);
});

test('rejects occupied tags and duplicate commits', () => {
  assert.throws(() => resolveRelease(input({ tags: ['app-v1.7.0-chimera.1'] })), /tag.*occupied/i);
  assert.throws(() => resolveRelease(input({ releases: [{ tag: 'app-v1.6.0-r9', commitSha: 'a'.repeat(40) }] })), /commit.*already/i);
});

test('rejects regressing or equal Android version codes', () => {
  const release = { tag: 'app-v1.7.0-chimera.0', versionCode: 41, commitSha: 'b'.repeat(40) };
  assert.throws(() => resolveRelease(input({ releases: [release] })), /versionCode.*greater/i);
  assert.throws(() => resolveRelease(input({ product: { ...product, androidVersionCode: 40 }, releases: [release] })), /versionCode.*greater/i);
});

test('pure resolution never calls reservation and accepts validated reservation data', () => {
  let calls = 0;
  const result = resolveRelease(input({ reserveTag: () => { calls++; return { status: 'occupied' }; }, reservation: { status: 'reserved' } }));
  assert.equal(calls, 0);
  assert.equal(result.tag, 'app-v1.7.0-chimera.1');
  assert.throws(() => resolveRelease(input({ reservation: { status: 'occupied' } })), /reservation conflict/i);
});

test('adapter integration reserves only after pure validation and handles async conflicts', async () => {
  let calls = 0;
  const adapters = { listTags: async () => [], listReleases: async () => [], reserveTag: async () => (++calls === 1 ? { status: 'reserved' } : { status: 'occupied' }) };
  await resolveReleaseWithAdapters(input(), adapters);
  await assert.rejects(() => resolveReleaseWithAdapters(input(), adapters), /reservation conflict/i);
  assert.equal(calls, 2);
  await assert.rejects(() => resolveReleaseWithAdapters(input(), { listTags: async () => [], listReleases: async () => [] }), /reserveTag/i);
});

test('invalid input never reserves a tag', async () => {
  for (const invalidInput of [input({ product: { ...product, upstreamAppVersion: '1.2.3-01' } }), input({ commitSha: 'bad' }), input({ appConfigVersion: 'stale' })]) {
    let calls = 0;
    await assert.rejects(() => resolveReleaseWithAdapters(invalidInput, { listTags: async () => [], listReleases: async () => [], reserveTag: async () => { calls++; return { status: 'reserved' }; } }));
    assert.equal(calls, 0);
  }
});

test('rejects invalid product JSON shape', () => {
  assert.throws(() => resolveRelease(input({ product: { upstreamAppVersion: 'bad', chimeraRevision: 0, androidVersionCode: 0 } })), /product/i);
});

test('classifies app, server, and protocol-client changes', () => {
  assert.equal(classifyReleasePaths(['packages/happy-app/app.config.js']), 'app-relevant');
  assert.equal(classifyReleasePaths(['packages/happy-server/sources/app.ts', 'Dockerfile.server']), 'server-only');
  assert.equal(classifyReleasePaths(['packages/happy-wire/src/index.ts']), 'app-relevant');
  assert.equal(classifyReleasePaths(['packages/happy-app/app.config.js', 'packages/happy-server/sources/app.ts']), 'combined');
  assert.equal(classifyReleasePaths([]), 'server-only');
  assert.equal(classifyReleasePaths(['docs/readme.md']), 'server-only');
  assert.equal(classifyReleasePaths(['scripts/chimera/resolve-release.mjs']), 'server-only');
});

test('sets release protocol flags from changed paths', () => {
  assert.deepEqual(resolveRelease(input({ changedPaths: ['packages/happy-server/sources/app.ts'] })), { ...resolveRelease(input()), clientReleaseRequired: false, serverDeployBeforeClient: false });
  const combined = resolveRelease(input({ changedPaths: ['packages/happy-app/app.config.js', 'packages/happy-server/sources/app.ts'] }));
  assert.equal(combined.clientReleaseRequired, true);
  assert.equal(combined.serverDeployBeforeClient, true);
  const wire = resolveRelease(input({ changedPaths: ['packages/happy-wire/src/index.ts'] }));
  assert.equal(wire.clientReleaseRequired, true);
  assert.equal(wire.serverDeployBeforeClient, true);
});

test('resets revision for a valid upstream advance and rejects an invalid upstream version', () => {
  assert.deepEqual(bumpProduct(product, '1.8.0'), { ...product, upstreamAppVersion: '1.8.0', chimeraRevision: 1, androidVersionCode: 42 });
  assert.throws(() => bumpProduct(product, 'not-a-version'), /SemVer/i);
  assert.throws(() => bumpProduct(product, '1.2.3-01'), /SemVer/i);
});

test('bump rolls product and generated outputs back when generation partially fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chimera-bump-'));
  const productFile = path.join(directory, 'product.json');
  const generated = path.join(directory, 'product.generated.mjs');
  await writeFile(productFile, JSON.stringify(product));
  await writeFile(generated, 'old-version');
  await assert.rejects(() => bumpRelease({ upstreamAppVersion: '1.8.0', productFile, generatedFiles: [generated], generate: async () => { await writeFile(generated, 'partial-version'); throw new Error('generation failed'); } }), /generation failed/);
  assert.equal(await readFile(productFile, 'utf8'), JSON.stringify(product));
  assert.equal(await readFile(generated, 'utf8'), 'old-version');
});
