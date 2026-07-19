import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SERVER = 'packages/happy-server';
const checks = [
  ['sources/app/api/api.ts', 'required-auth-routes', /authRoutes\(typed\)/],
  ['sources/app/api/api.ts', 'required-attachment-routes', /attachmentRoutes\(typed\)/],
  ['sources/app/api/api.ts', 'required-public-config', /registerPublicConfigRoute\(typed/],
  ['sources/app/api/api.ts', 'required-admin-control', /adminRoutes\(typed\)/],
  ['sources/app/api/routes/authRoutes.ts', 'required-challenge-completion', /challengeId:\s*z\.string/],
  ['sources/app/api/socket.ts', 'required-socket-event-guard', /socket\.use\(/],
  ['sources/app/api/socket.ts', 'required-socket-origin', /origin:\s*['"]https:\/\/39\.98\.68\.173['"]/],
  ['sources/app/chimera/control/index.html', 'required-control-ui', /Chimera Control/],
  ['sources/app/chimera/control/control.js', 'required-csrf-client', /X-Chimera-CSRF/],
  ['sources/standalone.ts', 'required-loopback-standalone', /const host = ['"]127\.0\.0\.1['"]/],
  ['sources/app/api/api.ts', 'required-loopback-default', /opts\.host \?\? ['"]127\.0\.0\.1['"]/],
  ['sources/utils/log.ts', 'required-log-url-redaction', /request\.url\.split\(['"]\?['"]/],
];

// This is intentionally a method/path manifest, rather than a text search.  It
// makes comments, dead strings and computed paths unable to satisfy policy.
export const requiredRoutes = {
  'sources/app/api/routes/authRoutes.ts': [
    'POST /v1/auth/challenge', 'POST /v1/auth', 'POST /v1/auth/request', 'GET /v1/auth/request/status',
    'POST /v1/auth/response', 'POST /v1/auth/account/request', 'POST /v1/auth/account/response',
  ],
  'sources/app/chimera/publicConfig.ts': ['GET /v1/chimera/config', 'GET /chimera-control/api/config', 'PUT /chimera-control/api/config'],
  'sources/app/chimera/adminRoutes.ts': [
    'GET /chimera-control', 'GET /chimera-control/', 'GET /chimera-control/control.css', 'GET /chimera-control/control.js',
    'POST /chimera-control/api/session', 'GET /chimera-control/api/session', 'DELETE /chimera-control/api/session', 'POST /chimera-control/api/session/revoke-all',
    'GET /chimera-control/api/invitations', 'POST /chimera-control/api/invitations', 'POST /chimera-control/api/invitations/:id/revoke',
    'GET /chimera-control/api/accounts', 'POST /chimera-control/api/accounts/:id/disable', 'POST /chimera-control/api/accounts/:id/restore',
    'POST /chimera-control/api/accounts/:id/revoke-tokens', 'PUT /chimera-control/api/accounts/:id/quota',
  ],
  'sources/app/api/routes/attachmentRoutes.ts': [
    'POST /v1/sessions/:sessionId/attachments/request-upload', 'PUT /v1/sessions/:sessionId/attachments/:attachmentFile',
    'POST /v1/sessions/:sessionId/attachments/request-download', 'GET /v1/sessions/:sessionId/attachments/:attachmentFile',
  ],
};

function staticRoutes(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const routes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
      && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) routes.push(`${node.expression.name.text.toUpperCase()} ${argument.text}`);
    }
  };
  const statements = (block) => {
    for (const statement of block.statements) {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      if (ts.isExpressionStatement(statement)) visit(statement.expression);
      // Route registrations in conditional, nested or uncalled functions are
      // intentionally not live policy evidence. Try/catch remains executable.
      if (ts.isTryStatement(statement)) { statements(statement.tryBlock); if (statement.catchClause) statements(statement.catchClause.block); if (statement.finallyBlock) statements(statement.finallyBlock); }
    }
  };
  for (const declaration of sourceFile.statements) {
    if (ts.isFunctionDeclaration(declaration) && declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && declaration.body) statements(declaration.body);
  }
  return routes;
}

function attachmentPolicyFindings(sourceText) {
  const sourceFile = ts.createSourceFile('attachmentRoutes.ts', sourceText, ts.ScriptTarget.Latest, true);
  let putHandler, requestUploadHandler;
  const calls = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && ['newPostPolicy', 'presignedPostPolicy'].includes(node.expression.text))
      || (ts.isPropertyAccessExpression(node.expression) && ['newPostPolicy', 'presignedPostPolicy'].includes(node.expression.name.text)))) calls.add('presigned');
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : '';
      calls.add(`${owner}.${node.expression.name.text}`);
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
        && node.expression.name.text === 'put' && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === '/v1/sessions/:sessionId/attachments/:attachmentFile') {
        const candidate = node.arguments.at(-1);
        if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) putHandler = candidate;
      }
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
        && node.expression.name.text === 'post' && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === '/v1/sessions/:sessionId/attachments/request-upload') {
        const candidate = node.arguments.at(-1);
        if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) requestUploadHandler = candidate;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const findings = [];
  if (calls.has('presigned')) findings.push('attachment-presigned-post');
  const callName = (node) => {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) return `${node.expression.expression.text}.${node.expression.name.text}`;
    return '';
  };
  const isLocalStorageCall = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'isLocalStorage';
  // Policy evidence must dominate the handler outcome. Calls under ordinary
  // conditions, short-circuits, and ternaries are deliberately not evidence.
  const directCalls = (expression) => {
    const calls = new Set();
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isConditionalExpression(node)
        || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind))) return;
      if (ts.isCallExpression(node)) calls.add(callName(node));
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return calls;
  };
  const handlerEvidence = (handler) => {
    const calls = new Set();
    const selectors = [];
    const statement = (node) => {
      if (ts.isExpressionStatement(node)) for (const call of directCalls(node.expression)) calls.add(call);
      if (ts.isIfStatement(node) && isLocalStorageCall(node.expression)) selectors.push(node);
      if (ts.isTryStatement(node)) { block(node.tryBlock); if (node.catchClause) block(node.catchClause.block); if (node.finallyBlock) block(node.finallyBlock); }
    };
    const block = (node) => { for (const item of node.statements) { statement(item); if (ts.isReturnStatement(item) || ts.isThrowStatement(item)) break; } };
    if (handler.body && ts.isBlock(handler.body)) block(handler.body); else if (handler.body) for (const call of directCalls(handler.body)) calls.add(call);
    return { calls, selectors };
  };
  const branchCalls = (node) => {
    if (ts.isBlock(node)) {
      const calls = new Set();
      for (const item of node.statements) {
        if (ts.isExpressionStatement(item)) for (const call of directCalls(item.expression)) calls.add(call);
        if (ts.isReturnStatement(item) || ts.isThrowStatement(item)) break;
      }
      return calls;
    }
    return ts.isExpressionStatement(node) ? directCalls(node.expression) : new Set();
  };
  if (!requestUploadHandler || !handlerEvidence(requestUploadHandler).calls.has('quota.reserve')) findings.push('attachment-request-upload-missing-reserve');
  if (!putHandler) return findings;
  const { calls: handlerCalls, selectors } = handlerEvidence(putHandler);
  const selector = selectors.filter((node) => isLocalStorageCall(node.expression));
  const isValidSelector = selector.length === 1 && selector[0].elseStatement
    && branchCalls(selector[0].thenStatement).has('putLocalFileAtomic')
    && branchCalls(selector[0].elseStatement).has('s3client.putObject');
  const allIsLocalCalls = [];
  const inspect = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (isLocalStorageCall(node)) allIsLocalCalls.push(node);
    ts.forEachChild(node, inspect);
  };
  if (putHandler.body) inspect(putHandler.body);
  if (!isValidSelector || allIsLocalCalls.length !== 1) findings.push('attachment-put-s3-bypass');
  for (const [call, rule] of [
    ['quota.claim', 'attachment-put-missing-claim'], ['quota.finalize', 'attachment-put-missing-finalize'],
    ['quota.rollback', 'attachment-put-missing-rollback'], ['deleteAttachmentObject', 'attachment-put-missing-delete'],
  ]) {
    const present = call.includes('.') ? handlerCalls.has(call) : handlerCalls.has(call);
    if (!present) findings.push(rule);
  }
  if (!isValidSelector || !branchCalls(selector[0].thenStatement).has('putLocalFileAtomic')) findings.push('attachment-put-missing-local-write');
  if (!isValidSelector || !branchCalls(selector[0].elseStatement).has('s3client.putObject')) findings.push('attachment-put-missing-s3-write');
  return findings;
}

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

  for (const [path, required] of Object.entries(requiredRoutes)) {
    if (!cache.has(path)) cache.set(path, await source(repositoryRoot, path));
    const value = cache.get(path);
    // Fixtures used by this verifier deliberately omit unrelated files.
    if (value === null) continue;
    const actual = staticRoutes(value, path);
    const counts = new Map(actual.map((route) => [route, actual.filter((item) => item === route).length]));
    for (const route of required) {
      const [method, routePath] = route.split(' ', 2);
      if (!counts.has(route)) findings.push(finding(repositoryRoot, path, `missing-route:${method.toLowerCase()}:${routePath}`));
      else if (counts.get(route) !== 1) findings.push(finding(repositoryRoot, path, `duplicate-route:${method.toLowerCase()}:${routePath}`));
    }
    for (const route of counts.keys()) {
      if (!required.includes(route)) {
        const [method, routePath] = route.split(' ', 2);
        findings.push(finding(repositoryRoot, path, `unexpected-route:${method.toLowerCase()}:${routePath}`));
      }
    }
  }

  const api = cache.get('sources/app/api/api.ts') ?? '';
  if (/\b(?:pushRoutes|voiceRoutes|connectRoutes|devRoutes)\s*\(\s*typed/.test(api)) findings.push(finding(repositoryRoot, 'sources/app/api/api.ts', 'disabled-route-registered'));

  const auth = cache.get('sources/app/api/routes/authRoutes.ts') ?? '';
  if (/challenge:\s*z\.string|clientChallenge|request\.body\.challenge\b/.test(auth)) findings.push(finding(repositoryRoot, 'sources/app/api/routes/authRoutes.ts', 'legacy-auth-accepted'));

  const accountPolicy = await source(repositoryRoot, 'sources/app/chimera/accountPolicy.ts') ?? '';
  if (/\b(?:publicKey|profile|session|machine|fileName|filePath|content)\b/.test(accountPolicy)) findings.push(finding(repositoryRoot, 'sources/app/chimera/accountPolicy.ts', 'account-field-exposure'));

  const attachments = cache.get('sources/app/api/routes/attachmentRoutes.ts') ?? '';
  for (const rule of attachmentPolicyFindings(attachments)) findings.push(finding(repositoryRoot, 'sources/app/api/routes/attachmentRoutes.ts', rule));

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
