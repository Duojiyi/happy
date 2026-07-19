import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const payloadKeys = ['apkPath', 'commitSha', 'packageName', 'publishedAt', 'schemaVersion', 'sha256', 'signerSha256', 'size', 'versionCode', 'versionName'];

function assert(condition, name) {
    if (!condition) throw new Error(`Invalid update manifest ${name}`);
}

function assertExactKeys(value, keys, name) {
    const actual = Object.keys(value).sort();
    assert(actual.length === keys.length && actual.every((key, index) => key === keys[index]), `${name} fields`);
}

function validatePayload(value) {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'payload');
    assertExactKeys(value, payloadKeys, 'payload');
    assert(value.schemaVersion === 1, 'schemaVersion');
    assert(value.packageName === 'org.chimerahub.chimera', 'packageName');
    assert(typeof value.versionName === 'string' && value.versionName.length > 0, 'versionName');
    assert(Number.isSafeInteger(value.versionCode) && value.versionCode > 0, 'versionCode');
    assert(typeof value.apkPath === 'string' && /^\/downloads\/chimera-[A-Za-z0-9._-]+\.apk$/.test(value.apkPath), 'apkPath');
    assert(Number.isSafeInteger(value.size) && value.size > 0, 'size');
    assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'sha256');
    assert(value.signerSha256 === '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93', 'signerSha256');
    assert(typeof value.commitSha === 'string' && /^[a-f0-9]{40}$/.test(value.commitSha), 'commitSha');
    assert(typeof value.publishedAt === 'string' && !Number.isNaN(Date.parse(value.publishedAt)) && new Date(value.publishedAt).toISOString() === value.publishedAt, 'publishedAt');
}

function canonicalize(payload) {
    validatePayload(payload);
    return `{${payloadKeys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(payload[key])}`).join(',')}}`;
}

function main(args) {
    if (args.length !== 3) throw new Error('Usage: sign-update-manifest.mjs <payload.json> <private-key.pk8> <output.json>');
    const [payloadPath, privateKeyPath, outputPath] = args;
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    const canonical = canonicalize(payload);
    const privateKey = createPrivateKey(readFileSync(privateKeyPath));
    const message = Buffer.from(canonical, 'utf8');
    const signatureBytes = sign(null, message, privateKey);
    assert(verify(null, message, createPublicKey(privateKey), signatureBytes), 'signature self-test');
    const signature = signatureBytes.toString('base64url');
    writeFileSync(outputPath, `${JSON.stringify({ payload, signature })}\n`, 'utf8');
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    process.stdout.write(`sha256=${digest} size=${Buffer.byteLength(canonical, 'utf8')}\n`);
}

main(process.argv.slice(2));
