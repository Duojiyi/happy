import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const node = process.execPath;
const entry = join(root, 'packages/happy-server/dist/standalone.mjs');
const secret = Buffer.alloc(32, 7).toString('base64url');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$QUJDREVGR0g$QUJDREVGR0hJSktMTU5PUA';

export function buildEnv(dir, port, parent = process.env) {
  const env = { ...parent };
  for (const key of ['DATABASE_URL', 'S3_HOST', 'S3_PORT', 'S3_USE_SSL', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_PUBLIC_URL', 'S3_ENDPOINT']) delete env[key];
  return { ...env, DB_PROVIDER: 'pglite', DATA_DIR: dir, PGLITE_DIR: join(dir, 'pglite'), FILES_DIR: join(dir, 'files'), PORT: String(port), HANDY_MASTER_SECRET: secret,
    CHIMERA_ADMIN_PASSWORD_HASH: passwordHash, CHIMERA_ADMIN_SESSION_SECRET: secret, CHIMERA_INVITATION_PEPPER: secret, CHIMERA_ACCOUNT_PSEUDONYM_KEY: secret, CHIMERA_UPDATE_PUBLIC_KEY: secret,
    PUBLIC_URL: 'https://103.250.173.136', RELAY_URL: 'https://103.250.173.136' };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [entry, ...args], { cwd: join(root, 'packages/happy-server'), env, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`standalone ${args[0]} exited ${code}`)));
  });
}
export async function stop(child, graceMs = 5000) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('standalone did not exit after forced kill')), 5000))]);
}

test('built standalone serves the Chimera public and control surfaces on loopback only', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-standalone-'));
  const port = await freePort();
  const env = buildEnv(dir, port);
  let child;
  try {
    await run(['migrate'], env);
    child = spawn(node, [entry, 'serve'], { cwd: join(root, 'packages/happy-server'), env, stdio: 'ignore', windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    let config;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`standalone exited during startup (${child.exitCode})`);
      try { config = await fetch(`${base}/v1/chimera/config`); if (config.ok) break; } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(config?.status, 200);
    assert.equal((await fetch(`${base}/chimera-control`)).headers.get('content-security-policy')?.includes("default-src 'self'"), true);
    for (const path of ['/chimera-control/control.css', '/chimera-control/control.js']) assert.equal((await fetch(`${base}${path}`)).status, 200);
    for (const path of ['/v1/voice/conversations', '/v1/push-tokens']) assert.equal((await fetch(`${base}${path}`)).status, 404);
    await assert.rejects(fetch(`http://127.0.0.2:${port}/v1/chimera/config`));
  } finally { if (child) await stop(child); await rm(dir, { recursive: true, force: true }); }
});

test('stop uses SIGKILL for the forced termination and waits for exit', async () => {
  const signals = [];
  let exitHandler;
  const child = { exitCode: null, once(event, handler) { if (event === 'exit') exitHandler = handler; }, kill(signal) { signals.push(signal); if (signal === 'SIGKILL') { child.exitCode = 137; exitHandler(); } } };
  await stop(child, 0);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.exitCode, 137);
});

test('standalone environment drops inherited database and S3 settings', () => {
  const env = buildEnv('C:/temporary', 4321, { DATABASE_URL: 'postgres://evil', DB_PROVIDER: 'postgres', S3_HOST: 'evil', S3_BUCKET: 'evil' });
  assert.equal(env.DB_PROVIDER, 'pglite');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.S3_HOST, undefined);
  assert.equal(env.S3_BUCKET, undefined);
});
