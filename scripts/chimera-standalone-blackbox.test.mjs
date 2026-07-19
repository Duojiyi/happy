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
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('standalone did not exit after forced kill')), 5000))]);
}

test('built standalone serves the Chimera public and control surfaces on loopback only', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-standalone-'));
  const port = await freePort();
  const env = { ...process.env, DATA_DIR: dir, PGLITE_DIR: join(dir, 'pglite'), FILES_DIR: join(dir, 'files'), PORT: String(port), HANDY_MASTER_SECRET: secret,
    CHIMERA_ADMIN_PASSWORD_HASH: passwordHash, CHIMERA_ADMIN_SESSION_SECRET: secret, CHIMERA_INVITATION_PEPPER: secret, CHIMERA_ACCOUNT_PSEUDONYM_KEY: secret, CHIMERA_UPDATE_PUBLIC_KEY: secret,
    PUBLIC_URL: 'https://39.98.68.173', RELAY_URL: 'https://39.98.68.173', S3_ENDPOINT: '', S3_ACCESS_KEY: '', S3_SECRET_KEY: '', S3_BUCKET: '' };
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
