import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validator = path.join(import.meta.dirname, 'libexec/chimera-validate-android-release');
const packageName = 'org.chimerahub.chimera';
const signer = '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93';
const commit = 'b'.repeat(40);

function canonical(payload) {
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'chimera-android-server-'));
  const apk = path.join(root, 'candidate.apk');
  const bytes = Buffer.from('server-side-apk-fixture');
  writeFileSync(apk, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const payload = {
    schemaVersion: 1,
    packageName,
    versionName: '1.7.0-chimera.2',
    versionCode: 2,
    apkPath: `/downloads/chimera-1.7.0-chimera.2-${sha256.slice(0, 12)}.apk`,
    size: bytes.length,
    sha256,
    signerSha256: signer,
    commitSha: commit,
    publishedAt: '2026-07-20T00:00:00.000Z',
  };
  const keys = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64url');
  const manifest = path.join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ payload, signature }));
  return { root, apk, bytes, payload, signature, manifest, keys };
}

function validate(f, overrides = {}) {
  const work = path.join(f.root, `work-${Math.random().toString(16).slice(2)}`);
  mkdirSync(work);
  const result = spawnSync('python3', [validator, overrides.manifest ?? f.manifest, f.apk, commit, String(overrides.version ?? 2), packageName, signer, work]);
  return { ...result, work };
}

test('server fixture canonicalizes and verifies signed Android release bytes', () => {
  const f = fixture();
  try {
    const result = validate(f);
    assert.equal(result.status, 0, result.stderr.toString());
    const canonicalBytes = readFileSync(path.join(result.work, 'payload.json'));
    const signatureBytes = readFileSync(path.join(result.work, 'signature.bin'));
    assert.equal(canonicalBytes.toString(), canonical(f.payload));
    assert.equal(verify(null, canonicalBytes, f.keys.publicKey, signatureBytes), true);
    assert.match(readFileSync(path.join(result.work, 'metadata'), 'utf8').replaceAll('\r\n', '\n'), /^chimera-.*\.apk\n1\.7\.0-chimera\.2\n$/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('server fixture rejects byte, schema, version, and path mutations', () => {
  const f = fixture();
  try {
    writeFileSync(f.apk, Buffer.concat([f.bytes, Buffer.from('tampered')]));
    assert.notEqual(validate(f).status, 0, 'tampered APK bytes must fail');
    writeFileSync(f.apk, f.bytes);

    for (const payload of [
      { ...f.payload, unknown: true },
      { ...f.payload, apkPath: '/../candidate.apk' },
    ]) {
      const manifest = path.join(f.root, `mutated-${Math.random()}.json`);
      writeFileSync(manifest, JSON.stringify({ payload, signature: f.signature }));
      assert.notEqual(validate(f, { manifest }).status, 0);
    }
    assert.notEqual(validate(f, { version: 3 }).status, 0, 'release-id version mismatch must fail');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('cryptographic signature mutation is rejected by the server verification boundary', () => {
  const f = fixture();
  try {
    const result = validate(f);
    assert.equal(result.status, 0);
    const signature = Buffer.from(readFileSync(path.join(result.work, 'signature.bin')));
    signature[0] ^= 0x80;
    assert.equal(verify(null, readFileSync(path.join(result.work, 'payload.json')), f.keys.publicKey, signature), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
