import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('signs a fixture payload offline and writes only the signed envelope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chimera-manifest-'));
    try {
        const payloadPath = join(directory, 'payload.json');
        const keyPath = join(directory, 'private.pem');
        const outputPath = join(directory, 'manifest.json');
        const keys = generateKeyPairSync('ed25519');
        writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, packageName: 'org.chimerahub.chimera', versionName: '1.7.1-chimera.2', versionCode: 2, apkPath: '/downloads/chimera-1.7.1-chimera.2.apk', size: 1234, sha256: 'a'.repeat(64), signerSha256: '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93', commitSha: 'b'.repeat(40), publishedAt: '2026-07-20T00:00:00.000Z' }));
        writeFileSync(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));

        const stdout = execFileSync(process.execPath, ['scripts/chimera/sign-update-manifest.mjs', payloadPath, keyPath, outputPath], { encoding: 'utf8' });
        const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
        assert.deepEqual(Object.keys(manifest).sort(), ['payload', 'signature']);
        assert.equal(typeof manifest.signature, 'string');
        assert.match(stdout, /sha256=[a-f0-9]{64}/);
        assert.doesNotMatch(stdout, /BEGIN PRIVATE KEY/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
