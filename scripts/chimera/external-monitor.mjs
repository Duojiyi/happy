import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { connect } from 'node:tls';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ORIGIN = 'https://103.250.173.136';
export const EXPECTED_IP = '103.250.173.136';
export const APK_RANGE_TIMEOUT_MS = 120_000;
const MANIFEST_PUBLIC_KEY = 'ze6ngKGbk7dgWN5d6rXGO0YRE5y54hbLMULFoW5YTHc';
export const PUBLIC_PORT_POLICY = Object.freeze({ open: [22, 80, 443], closed: [3000, 3005, 50001, 50002, 50003, 50004, 50005] });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function validateManifest(value) {
  assert.deepEqual(Object.keys(value).sort(), ['payload', 'signature']);
  const payload = value.payload;
  assert.deepEqual(Object.keys(payload).sort(), ['apkPath', 'commitSha', 'packageName', 'publishedAt', 'schemaVersion', 'sha256', 'signerSha256', 'size', 'versionCode', 'versionName']);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.packageName, 'org.chimerahub.chimera');
  assert.match(payload.apkPath, /^\/downloads\/chimera-[A-Za-z0-9._-]+\.apk$/);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(payload.size) && payload.size > 0);
  assert.match(value.signature, /^[A-Za-z0-9_-]{86}$/);
  return payload;
}

export function verifyManifest(value) {
  const payload = validateManifest(value);
  const raw = Buffer.from(MANIFEST_PUBLIC_KEY, 'base64url');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(verify(null, Buffer.from(JSON.stringify(canonical(payload))), key, Buffer.from(value.signature, 'base64url')), 'manifest Ed25519 signature mismatch');
  return payload;
}

async function request(url, options = {}) {
  const { timeoutMs = 15_000, ...fetchOptions } = options;
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...fetchOptions });
  return response;
}

export async function hashStream(stream) {
  assert.ok(stream, 'response body is missing');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

export async function hashRemoteRanges(url, size, { chunkSize = 4 * 1024 * 1024, concurrency = 6, fetchRange } = {}) {
  assert.ok(Number.isSafeInteger(size) && size > 0);
  const load = fetchRange ?? (async (start, end) => request(url, { headers: { range: `bytes=${start}-${end}` }, timeoutMs: APK_RANGE_TIMEOUT_MS }));
  const hash = createHash('sha256');
  let downloaded = 0;
  for (let windowStart = 0; windowStart < size; windowStart += chunkSize * concurrency) {
    const ranges = Array.from({ length: concurrency }, (_, index) => {
      const start = windowStart + index * chunkSize;
      return start < size ? { start, end: Math.min(size - 1, start + chunkSize - 1) } : null;
    }).filter(Boolean);
    const chunks = await Promise.all(ranges.map(async ({ start, end }) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await load(start, end);
          assert.equal(response.status, 206);
          assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${size}`);
          const chunk = Buffer.from(await response.arrayBuffer());
          assert.equal(chunk.length, end - start + 1);
          return chunk;
        } catch (error) { lastError = error; }
      }
      throw lastError;
    }));
    for (const chunk of chunks) { downloaded += chunk.length; hash.update(chunk); }
  }
  return { size: downloaded, sha256: hash.digest('hex') };
}

export async function checkCertificate(hostname, minimumHours = 72) {
  const certificate = await new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443, servername: '', rejectUnauthorized: true }, () => {
      const peer = socket.getPeerCertificate();
      socket.end();
      resolve(peer);
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error('TLS timeout')));
    socket.once('error', reject);
  });
  assert.ok(certificate.subjectaltname?.split(', ').includes(`IP Address:${hostname}`), 'certificate IP SAN mismatch');
  const hours = (Date.parse(certificate.valid_to) - Date.now()) / 3_600_000;
  assert.ok(hours >= minimumHours, `certificate expires in ${hours.toFixed(1)} hours`);
  return { expiresAt: certificate.valid_to, remainingHours: hours };
}

export async function checkPort(host, port, shouldBeOpen) {
  const opened = await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(5_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  assert.equal(opened, shouldBeOpen, `public port ${port} must be ${shouldBeOpen ? 'open' : 'closed'}`);
}

export function parseArgs(args) {
  let origin = DEFAULT_ORIGIN;
  let fullApk = false;
  for (const arg of args) {
    if (arg === '--full-apk') fullApk = true;
    else if (arg.startsWith('https://')) origin = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { origin, fullApk };
}

export async function runMonitor(origin = DEFAULT_ORIGIN, { fullApk = false } = {}) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, EXPECTED_IP);
  const certificate = await checkCertificate(url.hostname);
  await Promise.all([
    ...PUBLIC_PORT_POLICY.open.map((port) => checkPort(url.hostname, port, true)),
    ...PUBLIC_PORT_POLICY.closed.map((port) => checkPort(url.hostname, port, false)),
  ]);
  const redirect = await request(`http://${url.hostname}/`);
  assert.ok([301, 302, 307, 308].includes(redirect.status));
  assert.equal(new URL(redirect.headers.get('location'), origin).protocol, 'https:');
  for (const path of ['/health', '/v1/chimera/config', '/chimera-control/', '/']) {
    const response = await request(new URL(path, origin));
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
  }
  const polling = await request(new URL('/v1/updates/?EIO=4&transport=polling', origin));
  assert.equal(polling.status, 200, 'WebSocket polling handshake failed');
  assert.match(await polling.text(), /^0\{/);
  const manifestResponse = await request(new URL('/downloads/chimera-update.json', origin));
  assert.equal(manifestResponse.status, 200);
  const payload = verifyManifest(await manifestResponse.json());
  const apk = await request(new URL(payload.apkPath, origin), { headers: { range: 'bytes=0-0' } });
  assert.equal(apk.status, 206, 'APK server must honor byte ranges');
  assert.match(apk.headers.get('content-range') ?? '', new RegExp(`^bytes 0-0/${payload.size}$`));
  const byte = Buffer.from(await apk.arrayBuffer());
  assert.equal(byte.length, 1);
  const head = await request(new URL(payload.apkPath, origin), { method: 'HEAD' });
  assert.equal(Number(head.headers.get('content-length')), payload.size);
  if (fullApk) {
    const downloaded = await hashRemoteRanges(new URL(payload.apkPath, origin), payload.size);
    assert.equal(downloaded.size, payload.size);
    assert.equal(downloaded.sha256, payload.sha256, 'APK sha256 mismatch');
  }
  return { certificate, commitSha: payload.commitSha, apkSha256: payload.sha256, apkSize: payload.size, fullApkVerified: fullApk, probeSha256: createHash('sha256').update(byte).digest('hex') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArgs(process.argv.slice(2));
  runMonitor(options.origin, options).then((result) => console.log(JSON.stringify({ ok: true, ...result }))).catch((error) => {
    console.error(`Chimera external monitor failed: ${error.message}`);
    process.exitCode = 1;
  });
}
