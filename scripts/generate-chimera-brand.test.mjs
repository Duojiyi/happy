import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { generateProductConfigModule, generateProductModule, validateProduct, writeOutputsAtomically } from './generate-chimera-brand.mjs';

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

function countOpaqueComponents(data, width, height) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const opaque = (index) => data[index * 4 + 3] > 128;
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || !opaque(start)) continue;
    let size = 0;
    const pending = [start];
    visited[start] = 1;
    while (pending.length) {
      const current = pending.pop();
      size++;
      const x = current % width;
      const y = Math.floor(current / width);
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) {
        if (next >= 0 && !visited[next] && opaque(next)) {
          visited[next] = 1;
          pending.push(next);
        }
      }
    }
    if (size > 100) components.push(size);
  }
  return components.length;
}

test('accepts the fixed Chimera product metadata', async () => {
  const value = validateProduct(await product());
  assert.deepEqual(Object.keys(value).sort(), expectedKeys);
  assert.equal(value.productName, 'Chimera');
  assert.equal(value.androidApplicationId, 'org.chimerahub.chimera');
  assert.equal(value.relayOrigin, 'https://103.250.173.136');
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
  for (const relayOrigin of ['http://103.250.173.136', 'https://example.com', 'https://103.250.173.136/path']) {
    assert.throws(() => validateProduct({ ...value, relayOrigin }), /relayOrigin/i);
  }
  assert.throws(() => validateProduct({ ...value, upstreamAppVersion: '1.7' }), /upstreamAppVersion/i);
  assert.throws(() => validateProduct({ ...value, upstreamAppVersion: '1.2.3-01' }), /upstreamAppVersion/i);
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
  assert.match(first, /export const RELAY_ORIGIN = "https:\/\/103\.250\.173\.136" as const;/);
  const versionName = `${value.upstreamAppVersion}-chimera.${value.chimeraRevision}`;
  assert.ok(first.includes(`export const ANDROID_VERSION_CODE = ${value.androidVersionCode} as const;`));
  assert.ok(first.includes(`export const VERSION_NAME = "${versionName}" as const;`));
  assert.ok(generateProductConfigModule(value).includes(`export const VERSION_NAME = "${versionName}";`));
  assert.ok(first.endsWith('\n'));
});

test('--check compares bytes and never writes', async () => {
  execFileSync(process.execPath, ['scripts/generate-chimera-brand.mjs'], { cwd: root });
  const correct = await readFile(generatedPath);
  const stale = Buffer.concat([correct, Buffer.from('// stale\n')]);
  try {
    await writeFile(generatedPath, stale);
    const result = spawnSync(process.execPath, ['scripts/generate-chimera-brand.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(generatedPath), stale);
  } finally {
    await writeFile(generatedPath, correct);
  }
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
    if (name === 'logotype-light.png' || name === 'logotype-dark.png') {
      assert.equal(stats.channels[3].min, 0, `${name} background must be transparent`);
      const foreground = stats.channels.slice(0, 3).map((channel) => channel.max);
      if (name === 'logotype-light.png') assert.ok(foreground.every((value) => value > 220), 'dark-theme wordmark must be light');
      else assert.ok(stats.channels.slice(0, 3).every((channel) => channel.min < 35), 'light-theme wordmark must be dark');
    }
  }
});

test('generated wordmarks contain the C mark and every letter in CHIMERA', async () => {
  for (const name of ['logotype-light.png', 'logotype-dark.png']) {
    const { data, info } = await sharp(path.join(images, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(countOpaqueComponents(data, info.width, info.height), 8, `${name} must render C mark plus CHIMERA`);
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

test('failed asset staging cleans temporary files without replacing outputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chimera-brand-atomic-'));
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await writeFile(first, 'old-first');
  await writeFile(second, 'old-second');
  try {
    await assert.rejects(() => writeOutputsAtomically(new Map([[first, Buffer.from('new-first')], [second, Buffer.from('new-second')]]), {
      rename: async () => { throw new Error('injected rename failure'); },
      unlink,
      writeFile,
    }), /injected rename failure/);
    assert.equal(await readFile(first, 'utf8'), 'old-first');
    assert.equal(await readFile(second, 'utf8'), 'old-second');
    assert.deepEqual((await readdir(directory)).sort(), ['first.txt', 'second.txt']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('second asset install failure rolls every target back byte-for-byte', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chimera-brand-rollback-'));
  const first = path.join(directory, 'first.bin');
  const second = path.join(directory, 'second.bin');
  const oldFirst = Buffer.from([0, 1, 2, 255]);
  const oldSecond = Buffer.from([255, 3, 2, 1]);
  await writeFile(first, oldFirst);
  await writeFile(second, oldSecond);
  let installs = 0;
  try {
    await assert.rejects(() => writeOutputsAtomically(new Map([[first, Buffer.from('new-first')], [second, Buffer.from('new-second')]]), {
      rename: async (source, destination) => {
        if (source.endsWith('.tmp') && ++installs === 2) throw new Error('injected second install failure');
        await rename(source, destination);
      },
      unlink,
      writeFile,
    }), /injected second install failure/);
    assert.deepEqual(await readFile(first), oldFirst);
    assert.deepEqual(await readFile(second), oldSecond);
    assert.deepEqual((await readdir(directory)).sort(), ['first.bin', 'second.bin']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
