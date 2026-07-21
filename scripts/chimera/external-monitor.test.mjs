import test from 'node:test';
import assert from 'node:assert/strict';
import { APK_RANGE_TIMEOUT_MS, PUBLIC_PORT_POLICY, hashRemoteRanges, hashStream, parseArgs, validateManifest } from './external-monitor.mjs';

const manifest = {
  payload: {
    apkPath: '/downloads/chimera-1.apk', commitSha: 'b'.repeat(40), packageName: 'org.chimerahub.chimera',
    publishedAt: '2026-07-22T00:00:00.000Z', schemaVersion: 1, sha256: 'a'.repeat(64),
    signerSha256: 'c'.repeat(64), size: 42, versionCode: 1, versionName: '1.0.0-chimera.1',
  },
  signature: 'A'.repeat(86),
};

test('accepts the strict public update contract', () => assert.equal(validateManifest(structuredClone(manifest)).size, 42));
test('rejects traversal APK paths', () => {
  const value = structuredClone(manifest);
  value.payload.apkPath = '/downloads/../secret.apk';
  assert.throws(() => validateManifest(value));
});
test('rejects extra top-level manifest fields', () => assert.throws(() => validateManifest({ ...manifest, debug: true })));
test('hashes a streamed APK without buffering the full response', async () => {
  async function* chunks() { yield Buffer.from('Chimera'); yield Buffer.from('-APK'); }
  assert.deepEqual(await hashStream(chunks()), { size: 11, sha256: 'bdd41a363e43841ddf74cc880cd7109a01d0eac1e51799cb7745b6c7f8f83cc7' });
});
test('allows bounded range transfers without relaxing route timeouts', () => assert.equal(APK_RANGE_TIMEOUT_MS, 120_000));
test('scheduled mode is range-only and release mode explicitly enables a full APK hash', () => {
  assert.deepEqual(parseArgs(['https://103.250.173.136']), { origin: 'https://103.250.173.136', fullApk: false });
  assert.deepEqual(parseArgs(['--full-apk', 'https://103.250.173.136']), { origin: 'https://103.250.173.136', fullApk: true });
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});
test('pins the public port allowlist and internal port denylist', () => {
  assert.deepEqual(PUBLIC_PORT_POLICY.open, [22, 80, 443]);
  assert.deepEqual(PUBLIC_PORT_POLICY.closed, [3000, 3005, 50001, 50002, 50003, 50004, 50005]);
});
test('hashes all public APK range bytes in order with bounded windows', async () => {
  const bytes = Buffer.from('0123456789abcdef');
  const calls = [];
  const result = await hashRemoteRanges(new URL('https://103.250.173.136/a.apk'), bytes.length, {
    chunkSize: 3,
    concurrency: 2,
    fetchRange: async (start, end) => {
      calls.push([start, end]);
      return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
    },
  });
  assert.deepEqual(calls, [[0, 2], [3, 5], [6, 8], [9, 11], [12, 14], [15, 15]]);
  assert.deepEqual(result, { size: 16, sha256: '9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f' });
});
