import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { generateProductModule, validateProduct } from './generate-chimera-brand.mjs';

const root = path.resolve(import.meta.dirname, '..');
const productPath = path.join(root, 'brand/chimera/product.json');
const generatedPath = path.join(root, 'packages/happy-app/sources/chimera/product.generated.ts');
const images = path.join(root, 'packages/happy-app/sources/assets/images');
const expectedKeys = [
  'androidApplicationId', 'androidSignerSha256', 'androidVersionCode', 'chimeraRevision',
  'deepLinkSchemes', 'productName', 'relayOrigin', 'repository', 'slug',
  'updatePublicKey', 'upstreamAppVersion',
].sort();

async function product() {
  return JSON.parse(await readFile(productPath, 'utf8'));
}

test('accepts the fixed Chimera product metadata', async () => {
  const value = validateProduct(await product());
  assert.deepEqual(Object.keys(value).sort(), expectedKeys);
  assert.equal(value.productName, 'Chimera');
  assert.equal(value.androidApplicationId, 'org.chimerahub.chimera');
  assert.equal(value.relayOrigin, 'https://39.98.68.173');
  assert.deepEqual(value.deepLinkSchemes, ['chimera', 'happy']);
  assert.match(value.updatePublicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(value.updatePublicKey, 'base64url').length, 32);
  assert.match(value.androidSignerSha256, /^[0-9A-F]{64}$/);
});

test('rejects extra, missing, and non-fixed fields', async () => {
  const value = await product();
  assert.throws(() => validateProduct({ ...value, extra: true }), /exactly|unknown/i);
  const { slug: _slug, ...missing } = value;
  assert.throws(() => validateProduct(missing), /slug/i);
  assert.throws(() => validateProduct({ ...value, productName: 'Happy' }), /productName/i);
  assert.throws(() => validateProduct({ ...value, repository: 'other/repo' }), /repository/i);
  assert.throws(() => validateProduct({ ...value, deepLinkSchemes: ['happy', 'chimera'] }), /deepLinkSchemes/i);
});

test('rejects malformed network, version, integer, and key fields', async () => {
  const value = await product();
  for (const relayOrigin of ['http://39.98.68.173', 'https://example.com', 'https://39.98.68.173/path']) {
    assert.throws(() => validateProduct({ ...value, relayOrigin }), /relayOrigin/i);
  }
  assert.throws(() => validateProduct({ ...value, upstreamAppVersion: '1.7' }), /upstreamAppVersion/i);
  assert.throws(() => validateProduct({ ...value, chimeraRevision: 0 }), /chimeraRevision/i);
  assert.throws(() => validateProduct({ ...value, androidVersionCode: 1.5 }), /androidVersionCode/i);
  assert.throws(() => validateProduct({ ...value, updatePublicKey: 'A'.repeat(42) }), /updatePublicKey/i);
  assert.throws(() => validateProduct({ ...value, androidSignerSha256: 'a'.repeat(64) }), /androidSignerSha256/i);
});

test('generates a deterministic stable product module', async () => {
  const value = validateProduct(await product());
  const first = generateProductModule(value);
  assert.equal(first, generateProductModule({ ...value }));
  assert.match(first, /export const PRODUCT_NAME = "Chimera" as const;/);
  assert.match(first, /export const ANDROID_APPLICATION_ID = "org\.chimerahub\.chimera" as const;/);
  assert.match(first, /export const RELAY_ORIGIN = "https:\/\/39\.98\.68\.173" as const;/);
  assert.ok(first.endsWith('\n'));
});

test('--check compares bytes and never writes', async () => {
  execFileSync(process.execPath, ['scripts/generate-chimera-brand.mjs'], { cwd: root });
  const correct = await readFile(generatedPath);
  await writeFile(generatedPath, Buffer.concat([correct, Buffer.from('// stale\n')]));
  const result = spawnSync(process.execPath, ['scripts/generate-chimera-brand.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readFile(generatedPath), Buffer.concat([correct, Buffer.from('// stale\n')]));
  await writeFile(generatedPath, correct);
});

test('generated PNG assets use the established dimensions and alpha channel', async () => {
  const specs = {
    'icon.png': [1024, 1024], 'icon-adaptive.png': [1024, 1024],
    'icon-monochrome.png': [1024, 1024], 'splash-android-light.png': [1024, 1024],
    'splash-android-dark.png': [1024, 1024], 'favicon.png': [1024, 1024],
    'logotype-light.png': [1965, 523], 'logotype-dark.png': [1965, 523],
  };
  for (const [name, [width, height]] of Object.entries(specs)) {
    const metadata = await sharp(path.join(images, name)).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.hasAlpha], [width, height, true], name);
    const stats = await sharp(path.join(images, name)).stats();
    assert.ok(stats.channels.some((channel) => channel.min < channel.max), `${name} must not be blank`);
  }
});

test('logo remains a clear single-contour C at small sizes', async () => {
  const svg = await readFile(path.join(root, 'brand/chimera/logo.svg'), 'utf8');
  assert.equal((svg.match(/<path\b/g) ?? []).length, 1);
  const { data } = await sharp(Buffer.from(svg)).resize(16, 16).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * 16 + x) * 4 + 3];
  assert.ok(alpha(3, 8) > 200, 'left spine must remain visible');
  assert.ok(alpha(13, 8) < 20, 'right side must remain open');
});
