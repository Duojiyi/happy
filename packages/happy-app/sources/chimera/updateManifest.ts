import sodium from '@/encryption/libsodium.lib';
import { ANDROID_APPLICATION_ID, ANDROID_SIGNER_SHA256, UPDATE_PUBLIC_KEY } from './product.generated.ts';

export type UpdateManifestPayload = {
    schemaVersion: 1;
    packageName: typeof ANDROID_APPLICATION_ID;
    versionName: string;
    versionCode: number;
    apkPath: string;
    size: number;
    sha256: string;
    signerSha256: typeof ANDROID_SIGNER_SHA256;
    commitSha: string;
    publishedAt: string;
};

export type SignedUpdateManifest = { payload: UpdateManifestPayload; signature: string };

export type VerifyUpdateManifestOptions = {
    origin: string;
    publicKey?: string;
    currentVersionCode?: number;
    commitSha?: string;
    now?: string | Date;
    maxAgeMs?: number;
};

const payloadKeys = ['apkPath', 'commitSha', 'packageName', 'publishedAt', 'schemaVersion', 'sha256', 'signerSha256', 'size', 'versionCode', 'versionName'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], name: string) {
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        throw new Error(`${name} contains unknown or missing fields`);
    }
}

function assert(condition: unknown, name: string): asserts condition {
    if (!condition) throw new Error(`Invalid update manifest ${name}`);
}

function fromBase64Url(value: string): Uint8Array {
    assert(/^[A-Za-z0-9_-]+$/.test(value), 'base64url');
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    if (typeof globalThis.atob === 'function') {
        return Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
    }
    return Uint8Array.from(Buffer.from(padded, 'base64'));
}

function toBase64Url(value: Uint8Array): string {
    if (typeof globalThis.btoa === 'function') {
        return globalThis.btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    return Buffer.from(value).toString('base64url');
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function canonicalizeUpdatePayload(payload: UpdateManifestPayload): string {
    validatePayload(payload);
    return stableJson(payload);
}

export function signUpdatePayload(payload: UpdateManifestPayload, secretKey: Uint8Array): string {
    assert(secretKey instanceof Uint8Array && secretKey.length === 64, 'signing key');
    return toBase64Url(sodium.crypto_sign_detached(new TextEncoder().encode(canonicalizeUpdatePayload(payload)), secretKey));
}

function validatePayload(value: unknown): asserts value is UpdateManifestPayload {
    assert(isPlainObject(value), 'payload');
    assertExactKeys(value, payloadKeys, 'payload');
    assert(value.schemaVersion === 1, 'schemaVersion');
    assert(value.packageName === ANDROID_APPLICATION_ID, 'packageName');
    assert(typeof value.versionName === 'string' && value.versionName.length > 0, 'versionName');
    assert(typeof value.versionCode === 'number' && Number.isSafeInteger(value.versionCode) && value.versionCode > 0, 'versionCode');
    assert(typeof value.apkPath === 'string' && /^\/downloads\/chimera-[A-Za-z0-9._-]+\.apk$/.test(value.apkPath), 'apkPath');
    assert(typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0, 'size');
    assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'sha256');
    assert(value.signerSha256 === ANDROID_SIGNER_SHA256 && /^[A-F0-9]{64}$/.test(value.signerSha256), 'signerSha256');
    assert(typeof value.commitSha === 'string' && /^[a-f0-9]{40}$/.test(value.commitSha), 'commitSha');
    assert(typeof value.publishedAt === 'string' && !Number.isNaN(Date.parse(value.publishedAt)) && new Date(value.publishedAt).toISOString() === value.publishedAt, 'publishedAt');
}

export function validateUpdateManifest(value: unknown): asserts value is SignedUpdateManifest {
    assert(isPlainObject(value), 'envelope');
    assertExactKeys(value, ['payload', 'signature'], 'envelope');
    validatePayload(value.payload);
    assert(typeof value.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.signature), 'signature');
}

export async function verifyUpdateManifest(value: unknown, options: VerifyUpdateManifestOptions): Promise<UpdateManifestPayload> {
    validateUpdateManifest(value);
    const manifest = value;
    const updateUrl = new URL(manifest.payload.apkPath, options.origin);
    const origin = new URL(options.origin).origin;
    assert(updateUrl.origin === origin && updateUrl.pathname === manifest.payload.apkPath, 'apkPath origin');
    assert(options.currentVersionCode === undefined || manifest.payload.versionCode > options.currentVersionCode, 'versionCode must be newer');
    assert(options.commitSha === undefined || manifest.payload.commitSha === options.commitSha, 'commitSha');
    if (options.maxAgeMs !== undefined) {
        const now = new Date(options.now ?? new Date());
        assert(Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs >= 0 && !Number.isNaN(now.getTime()), 'maxAgeMs');
        assert(now.getTime() - new Date(manifest.payload.publishedAt).getTime() <= options.maxAgeMs, 'manifest expired');
    }

    const message = new TextEncoder().encode(canonicalizeUpdatePayload(manifest.payload));
    const valid = sodium.crypto_sign_verify_detached(fromBase64Url(manifest.signature), message, fromBase64Url(options.publicKey ?? UPDATE_PUBLIC_KEY));
    assert(valid, 'signature');
    return manifest.payload;
}
