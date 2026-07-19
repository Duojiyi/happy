import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const SERVER = 'packages/happy-server';
const checks = [
  ['sources/app/api/api.ts', 'required-auth-routes', /authRoutes\(typed\)/],
  ['sources/app/api/api.ts', 'required-attachment-routes', /attachmentRoutes\(typed\)/],
  ['sources/app/api/api.ts', 'required-public-config', /registerPublicConfigRoute\(typed/],
  ['sources/app/api/api.ts', 'required-admin-control', /adminRoutes\(typed\)/],
  ['sources/app/api/routes/authRoutes.ts', 'required-server-challenge', /['"]\/v1\/auth\/challenge['"]/],
  ['sources/app/api/routes/authRoutes.ts', 'required-challenge-completion', /challengeId:\s*z\.string/],
  ['sources/app/chimera/adminRoutes.ts', 'required-invitation-control', /\/chimera-control\/api\/invitations/],
  ['sources/app/chimera/adminRoutes.ts', 'required-account-control', /\/chimera-control\/api\/accounts/],
  ['sources/app/chimera/publicConfig.ts', 'required-startup-config', /['"]\/v1\/chimera\/config['"]/],
  ['sources/app/api/socket.ts', 'required-socket-event-guard', /socket\.use\(/],
  ['sources/app/api/socket.ts', 'required-socket-origin', /origin:\s*['"]https:\/\/39\.98\.68\.173['"]/],
  ['sources/app/api/routes/attachmentRoutes.ts', 'required-quota-reservation', /quota\.reserve\(/],
  ['sources/app/api/routes/attachmentRoutes.ts', 'required-quota-claim', /quota\.claim\(/],
  ['sources/app/chimera/control/index.html', 'required-control-ui', /Chimera Control/],
  ['sources/app/chimera/control/control.js', 'required-csrf-client', /X-Chimera-CSRF/],
  ['sources/standalone.ts', 'required-loopback-standalone', /const host = ['"]127\.0\.0\.1['"]/],
  ['sources/app/api/api.ts', 'required-loopback-default', /opts\.host \?\? ['"]127\.0\.0\.1['"]/],
  ['sources/utils/log.ts', 'required-log-url-redaction', /request\.url\.split\(['"]\?['"]/],
];

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function source(root, relativePath) {
  const path = join(root, SERVER, relativePath);
  return await exists(path) ? readFile(path, 'utf8') : null;
}
function finding(root, path, rule) { return { path: relative(root, join(root, SERVER, path)).replace(/\\/g, '/'), rule }; }

export async function verifyChimeraServer({ root = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  const repositoryRoot = resolve(root);
  const findings = [];
  const cache = new Map();
  for (const [path, rule, pattern] of checks) {
    if (!cache.has(path)) cache.set(path, await source(repositoryRoot, path));
    const value = cache.get(path);
    if (value === null || !pattern.test(value)) findings.push(finding(repositoryRoot, path, rule));
  }

  const api = cache.get('sources/app/api/api.ts') ?? '';
  if (/\b(?:pushRoutes|voiceRoutes|connectRoutes|devRoutes)\s*\(\s*typed/.test(api)) findings.push(finding(repositoryRoot, 'sources/app/api/api.ts', 'disabled-route-registered'));

  const auth = cache.get('sources/app/api/routes/authRoutes.ts') ?? '';
  if (/challenge:\s*z\.string|clientChallenge|request\.body\.challenge\b/.test(auth)) findings.push(finding(repositoryRoot, 'sources/app/api/routes/authRoutes.ts', 'legacy-auth-accepted'));

  const accountPolicy = await source(repositoryRoot, 'sources/app/chimera/accountPolicy.ts') ?? '';
  if (/\b(?:publicKey|profile|session|machine|fileName|filePath|content)\b/.test(accountPolicy)) findings.push(finding(repositoryRoot, 'sources/app/chimera/accountPolicy.ts', 'account-field-exposure'));

  const standalone = cache.get('sources/standalone.ts') ?? '';
  if (/const host = ['"](?:0\.0\.0\.0|::)['"]/.test(standalone)) findings.push(finding(repositoryRoot, 'sources/standalone.ts', 'non-loopback-bind'));
  if (/opts\.host \?\? ['"](?:0\.0\.0\.0|::)['"]/.test(api)) findings.push(finding(repositoryRoot, 'sources/app/api/api.ts', 'non-loopback-bind'));

  const socket = cache.get('sources/app/api/socket.ts') ?? '';
  if (/origin:\s*['"]\*['"]|allowedHeaders:\s*\[\s*['"]\*['"]/.test(socket)) findings.push(finding(repositoryRoot, 'sources/app/api/socket.ts', 'wildcard-socket-origin'));

  const errorHandlers = await source(repositoryRoot, 'sources/app/api/utils/enableErrorHandlers.ts') ?? '';
  if (/JSON\.stringify\(request\.headers\)|\$\{\s*(?:token|authHeader|sessionId|csrf|request\.headers)/.test(errorHandlers)) findings.push(finding(repositoryRoot, 'sources/app/api/utils/enableErrorHandlers.ts', 'secret-logging'));
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await verifyChimeraServer();
  if (findings.length) {
    for (const item of findings) console.error(`${item.path}: ${item.rule}`);
    process.exitCode = 1;
  } else console.log('Chimera server policy verified');
}
