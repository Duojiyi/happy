import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requiredRoutes, verifyChimeraServer } from './verify-chimera-server.mjs';

const defaults = {
  'sources/app/api/api.ts': "authRoutes(typed); attachmentRoutes(typed); registerPublicConfigRoute(typed); adminRoutes(typed); export const host = opts.host ?? '127.0.0.1';\n",
  'sources/app/api/routes/authRoutes.ts': "app.post('/v1/auth/challenge', handler); const schema = { challengeId: z.string() };\n",
  'sources/app/chimera/adminRoutes.ts': [
    'GET /chimera-control', 'GET /chimera-control/', 'GET /chimera-control/control.css', 'GET /chimera-control/control.js',
    'POST /chimera-control/api/session', 'GET /chimera-control/api/session', 'DELETE /chimera-control/api/session', 'POST /chimera-control/api/session/revoke-all',
    'GET /chimera-control/api/invitations', 'POST /chimera-control/api/invitations', 'POST /chimera-control/api/invitations/:id/revoke',
    'GET /chimera-control/api/accounts', 'POST /chimera-control/api/accounts/:id/disable', 'POST /chimera-control/api/accounts/:id/restore',
    'POST /chimera-control/api/accounts/:id/revoke-tokens', 'PUT /chimera-control/api/accounts/:id/quota',
  ].map((route) => { const [method, path] = route.split(' '); return `app.${method.toLowerCase()}('${path}', handler);`; }).join('\n'),
  'sources/app/chimera/publicConfig.ts': "app.get('/v1/chimera/config', handler); app.get('/chimera-control/api/config', handler); app.put('/chimera-control/api/config', handler);\n",
  'sources/app/api/socket.ts': "const cors = { origin: 'https://39.98.68.173' }; socket.use(guard);\n",
  'sources/app/api/routes/attachmentRoutes.ts': "app.post('/v1/sessions/:sessionId/attachments/request-upload', handler); app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', handler); app.post('/v1/sessions/:sessionId/attachments/request-download', handler); app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', handler); await quota.reserve(account, size); await quota.claim(id);\n",
  'sources/app/chimera/control/index.html': '<title>Chimera Control</title>\n',
  'sources/app/chimera/control/control.js': "headers['X-Chimera-CSRF'] = csrf;\n",
  'sources/standalone.ts': "const host = '127.0.0.1';\n",
  'sources/app/chimera/accountPolicy.ts': "return { id, createdAt, disabled, attachmentUsedBytes, attachmentQuotaBytes };\n",
  'sources/app/api/utils/enableErrorHandlers.ts': "log({ path }, 'Not found');\n",
  'sources/utils/log.ts': "const safeUrl = request.url.split('?', 1)[0];\n",
};

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chimera-server-policy-'));
  for (const [path, value] of Object.entries({ ...defaults, ...overrides })) {
    const target = join(root, 'packages/happy-server', path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value);
  }
  return root;
}
async function result(overrides) { const root = await fixture(overrides); try { return await verifyChimeraServer({ root }); } finally { await rm(root, { recursive: true, force: true }); } }

test('accepts the minimal enforced Chimera server surface', async () => assert.deepEqual(await result({}), []));

test('does not count a required route mentioned only in a comment', async () => {
  const findings = await result({
    'sources/app/chimera/publicConfig.ts': '// app.get("/v1/chimera/config", handler);\n',
  });
  assert(findings.some((item) => item.rule === 'missing-route:get:/v1/chimera/config'), JSON.stringify(findings));
});

test('rejects a dynamic required route registration', async () => {
  const findings = await result({
    'sources/app/chimera/publicConfig.ts': 'const path = "/v1/chimera/config"; app.get(path, handler);\n',
  });
  assert(findings.some((item) => item.rule === 'missing-route:get:/v1/chimera/config'), JSON.stringify(findings));
});

test('does not count a required route hidden in a dead branch', async () => {
  const findings = await result({
    'sources/app/chimera/publicConfig.ts': 'if (false) app.get("/v1/chimera/config", handler);\n',
  });
  assert(findings.some((item) => item.rule === 'missing-route:get:/v1/chimera/config'), JSON.stringify(findings));
});

for (const [path, routes] of Object.entries(requiredRoutes)) {
  for (const route of routes) {
    const [method, routePath] = route.split(' ', 2);
    test(`rejects removal of ${method} ${routePath}`, async () => {
      const source = defaults[path];
      const prefix = `app.${method.toLowerCase()}(`;
      const missing = source.replace(`${prefix}'${routePath}'`, `${prefix}'/removed'`).replace(`${prefix}\"${routePath}\"`, `${prefix}\"/removed\"`);
      const findings = await result({ [path]: missing });
      assert(findings.some((item) => item.rule === `missing-route:${method.toLowerCase()}:${routePath}`), JSON.stringify(findings));
    });
  }
}

for (const [name, overrides, rule] of [
  ['voice route restoration', { 'sources/app/api/api.ts': `${defaults['sources/app/api/api.ts']} voiceRoutes(typed);` }, 'disabled-route-registered'],
  ['legacy client challenge', { 'sources/app/api/routes/authRoutes.ts': `${defaults['sources/app/api/routes/authRoutes.ts']} const challenge = request.body.challenge;` }, 'legacy-auth-accepted'],
  ['raw account public key', { 'sources/app/chimera/accountPolicy.ts': 'return { id, publicKey, createdAt };' }, 'account-field-exposure'],
  ['public standalone binding', { 'sources/standalone.ts': "const host = '0.0.0.0';" }, 'required-loopback-standalone'],
  ['authorization header logging', { 'sources/app/api/utils/enableErrorHandlers.ts': 'log(JSON.stringify(request.headers));' }, 'secret-logging'],
  ['query-bearing request logs', { 'sources/utils/log.ts': 'const safeUrl = request.url;' }, 'required-log-url-redaction'],
  ['missing account control', { 'sources/app/chimera/adminRoutes.ts': "app.get('/chimera-control/api/invitations', handler);" }, 'missing-route:get:/chimera-control/api/accounts'],
  ['wildcard socket CORS', { 'sources/app/api/socket.ts': "const cors = { origin: '*' }; socket.use(guard);" }, 'required-socket-origin'],
]) test(`rejects ${name}`, async () => { const findings = await result(overrides); assert(findings.some((item) => item.rule === rule), JSON.stringify(findings)); });
