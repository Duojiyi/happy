import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    canonicalizeUpdatePayload,
    signUpdatePayload,
    validateUpdateManifest,
    verifyUpdateManifest,
    type UpdateManifestPayload,
} from './updateManifest';

const payload: UpdateManifestPayload = {
    schemaVersion: 1,
    packageName: 'org.chimerahub.chimera',
    versionName: '1.7.1-chimera.2',
    versionCode: 2,
    apkPath: '/downloads/chimera-1.7.1-chimera.2.apk',
    size: 1234,
    sha256: 'a'.repeat(64),
    signerSha256: '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93',
    commitSha: 'b'.repeat(40),
    publishedAt: '2026-07-20T00:00:00.000Z',
};

const toBase64Url = (value: Buffer) => value.toString('base64url');

describe('update manifest', () => {
    it('canonicalizes the exact payload schema with recursively sorted keys and no whitespace', () => {
        expect(canonicalizeUpdatePayload(payload)).toBe('{"apkPath":"/downloads/chimera-1.7.1-chimera.2.apk","commitSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","packageName":"org.chimerahub.chimera","publishedAt":"2026-07-20T00:00:00.000Z","schemaVersion":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","signerSha256":"58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93","size":1234,"versionCode":2,"versionName":"1.7.1-chimera.2"}');
    });

    it('rejects a changed byte or signature', async () => {
        const keys = generateKeyPairSync('ed25519');
        const signature = toBase64Url(sign(null, Buffer.from(canonicalizeUpdatePayload(payload)), keys.privateKey));
        const publicKey = toBase64Url(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

        await expect(verifyUpdateManifest({ payload, signature }, { publicKey, origin: 'https://updates.example.test', commitSha: payload.commitSha })).resolves.toEqual(payload);
        await expect(verifyUpdateManifest({ payload: { ...payload, size: 1235 }, signature }, { publicKey, origin: 'https://updates.example.test', commitSha: payload.commitSha })).rejects.toThrow(/signature/i);
        await expect(verifyUpdateManifest({ payload, signature: `${signature.slice(0, -1)}A` }, { publicKey, origin: 'https://updates.example.test', commitSha: payload.commitSha })).rejects.toThrow(/signature/i);
    });

    it('signs canonical payload bytes as a base64url Ed25519 signature', async () => {
        const keys = generateKeyPairSync('ed25519');
        const privateJwk = keys.privateKey.export({ format: 'jwk' });
        const seed = Buffer.from(privateJwk.d!, 'base64url');
        const secretKey = Uint8Array.from(Buffer.concat([seed, keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]));
        const publicKey = toBase64Url(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
        const signature = signUpdatePayload(payload, secretKey);

        await expect(verifyUpdateManifest({ payload, signature }, { publicKey, origin: 'https://updates.example.test' })).resolves.toEqual(payload);
    });

    it('strictly rejects malformed or unsafe manifests before verification', () => {
        expect(() => validateUpdateManifest({ payload: { ...payload, extra: true }, signature: 'A'.repeat(86) })).toThrow(/unknown/i);
        expect(() => validateUpdateManifest({ payload: { ...payload, packageName: 'com.example.other' }, signature: 'A'.repeat(86) })).toThrow(/package/i);
        expect(() => validateUpdateManifest({ payload: { ...payload, apkPath: 'https://evil.test/chimera.apk' }, signature: 'A'.repeat(86) })).toThrow(/apkPath/i);
        expect(() => validateUpdateManifest({ payload: { ...payload, apkPath: '/downloads/../chimera-1.apk' }, signature: 'A'.repeat(86) })).toThrow(/apkPath/i);
        expect(() => validateUpdateManifest({ payload: { ...payload, sha256: 'A'.repeat(64) }, signature: 'A'.repeat(86) })).toThrow(/sha256/i);
        expect(() => validateUpdateManifest({ payload: { ...payload, signerSha256: 'a'.repeat(64) }, signature: 'A'.repeat(86) })).toThrow(/signerSha256/i);
    });

    it('requires a newer version and the expected commit', async () => {
        const keys = generateKeyPairSync('ed25519');
        const signature = toBase64Url(sign(null, Buffer.from(canonicalizeUpdatePayload(payload)), createPrivateKey(keys.privateKey.export({ format: 'pem', type: 'pkcs8' }))));
        const publicKey = toBase64Url(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
        const manifest = { payload, signature };

        await expect(verifyUpdateManifest(manifest, { publicKey, origin: 'https://updates.example.test', currentVersionCode: 2, commitSha: payload.commitSha })).rejects.toThrow(/newer/i);
        await expect(verifyUpdateManifest(manifest, { publicKey, origin: 'https://updates.example.test', commitSha: 'c'.repeat(40) })).rejects.toThrow(/commit/i);
    });

    it('rejects manifests outside the configured publication lifetime', async () => {
        const keys = generateKeyPairSync('ed25519');
        const signature = toBase64Url(sign(null, Buffer.from(canonicalizeUpdatePayload(payload)), keys.privateKey));
        const publicKey = toBase64Url(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

        await expect(verifyUpdateManifest({ payload, signature }, {
            publicKey,
            origin: 'https://updates.example.test',
            now: '2026-07-22T00:00:00.000Z',
            maxAgeMs: 24 * 60 * 60 * 1000,
        })).rejects.toThrow(/expired/i);
    });
});
