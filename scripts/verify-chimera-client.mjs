import { access, readdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative, resolve } from 'node:path';

const APP_ROOT = 'packages/happy-app';
const SOURCE_ROOTS = ['sources'];
const WEB_EXPORT_ROOT = 'dist';
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html|css)$/i;
const BLOCKED_ANDROID_STORE_PERMISSIONS = [
  'com.android.vending.BILLING',
  'com.android.vending.CHECK_LICENSE',
];

const RULES = [
  ['happy-logo', /happy[-_ ]?logo/i],
  ['happy-branding', /\b(?:title|name|appName)\s*[:=]\s*['"`]Happy(?:\s+Coder)?['"`]/],
  ['official-host', /(?:https?:\/\/)?(?:app\.|api\.)?happy\.(?:engineering|tools|engineer)\b/i],
  ['server-selector', /\b(?:ServerSelector|ServerSelection)\b|(?:router\.(?:push|navigate|replace)|href)\s*=?\s*\(?\s*['"`]\/server/],
  ['voice-integration', /\b(?:VoiceButton|startVoice|useConversation|RealtimeVoiceSession|@elevenlabs\/|livekit)\b/i],
  ['push-integration', /\b(?:expo-notifications|registerForPush|pushRegistration|apiPush)\b/i],
  ['telemetry-or-purchases', /\b(?:new\s+PostHog|PostHog\.init|tracking\.(?:capture|identify)|RevenueCat\.configure|Purchases\.configure|configurePurchases)\b/i],
  ['removed-settings-or-route', /\bid\s*:\s*['"`](?:voice|connected-accounts|changelog|about|server)['"`]|(?:router\.(?:push|navigate|replace)|href)\s*=?\s*\(?\s*['"`]\/(?:settings\/(?:voice|connect(?:\/[^'"`]+)?)|dev\/purchases|changelog)/],
  ['legacy-visible-branding', /logo-black\.png|\bOpen Happy\b|t\(\s*['"`]sidebar\.sessionsTitle['"`]\s*\)/],
  ['disabled-integration-ui', /settings(?:Features|Account)\.(?:disableAnalytics|analytics(?:Disabled|Enabled)?)/],
];
const BUNDLE_RULES = RULES.filter(([rule]) => ![
  'server-selector', 'removed-settings-or-route', 'legacy-visible-branding', 'disabled-integration-ui',
].includes(rule));

// These legacy modules are intentionally retained for upstream mergeability but are
// unreachable from the Chimera route graph. Tests and fixtures are excluded below.
const DORMANT_SOURCE_PREFIXES = [
  'sources/realtime/',
  'sources/components/Voice',
  'sources/sync/revenueCat/',
  'sources/text/',
  'sources/changelog/',
  'sources/docs/',
];
const DORMANT_SOURCE_FILES = new Set([
  'sources/constants/Languages.ts',
  'sources/sync/purchases.ts',
  'sources/utils/microphonePermissions.ts',
  'sources/voiceConfig.ts',
]);
const FORBIDDEN_ROUTE_FILES = new Set([
  'sources/app/(app)/dev/purchases.tsx',
  'sources/app/(app)/settings/connect/claude.tsx',
]);

function isExcluded(relativePath) {
  return /(?:^|\/)(?:__fixtures__|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(relativePath)
    || relativePath === 'sources/chimera/clientPolicy.ts'
    || DORMANT_SOURCE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
    || DORMANT_SOURCE_FILES.has(relativePath);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function filesUnder(root) {
  if (!await exists(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : (entry.isFile() ? [path] : []);
  }));
  return nested.flat();
}

function addFinding(findings, root, path, rule) {
  findings.push({ path: relative(root, path).replaceAll('\\', '/'), rule });
}

function scanSource(findings, root, path, source, rules = RULES) {
  const appRelative = relative(join(root, APP_ROOT), path).replaceAll('\\', '/');
  if (isExcluded(appRelative)) return;
  for (const [rule, expression] of rules) {
    if (expression.test(source)) addFinding(findings, root, path, rule);
  }
}

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function hasProjectId(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'projectId')) return true;
  return Object.values(value).some(hasProjectId);
}

async function scanExpoConfig(findings, root) {
  const path = join(root, APP_ROOT, 'app.config.js');
  if (!await exists(path)) {
    addFinding(findings, root, path, 'missing-expo-config');
    return;
  }
  const previousAppEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'production';
    const module = await import(`${pathToFileURL(path).href}?chimeraPolicy=${Date.now()}`);
    const config = module.default?.expo;
    if (!config || typeof config !== 'object') {
      addFinding(findings, root, path, 'invalid-expo-config');
      return;
    }
    if (hasProjectId(config)) addFinding(findings, root, path, 'expo-project-id');
    if (config.updates?.enabled !== false || config.updates?.url || config.runtimeVersion && config.updates?.enabled !== false) {
      addFinding(findings, root, path, 'expo-ota');
    }
    if ((config.plugins ?? []).some((plugin) => /(?:expo-notifications|expo-updates)/i.test(String(pluginName(plugin))))) {
      addFinding(findings, root, path, 'push-integration');
    }
    const blockedPermissions = new Set(config.android?.blockedPermissions ?? []);
    if (BLOCKED_ANDROID_STORE_PERMISSIONS.some((permission) => !blockedPermissions.has(permission))) {
      addFinding(findings, root, path, 'android-store-permissions');
    }
  } catch {
    addFinding(findings, root, path, 'invalid-expo-config');
  } finally {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
  }
}

async function exportProductionWeb(root) {
  const appRoot = join(root, APP_ROOT);
  await rm(join(appRoot, WEB_EXPORT_ROOT), { recursive: true, force: true });
  await new Promise((resolveExport, rejectExport) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
      isWindows
        ? ['/d', '/s', '/c', 'pnpm --filter happy-app exec expo export --platform web --output-dir dist']
        : ['--filter', 'happy-app', 'exec', 'expo', 'export', '--platform', 'web', '--output-dir', WEB_EXPORT_ROOT],
      {
        cwd: root,
        env: { ...process.env, APP_ENV: 'production' },
        stdio: 'ignore',
      },
    );
    child.once('error', rejectExport);
    child.once('exit', (code) => code === 0 ? resolveExport() : rejectExport(new Error(`web export exited ${code}`)));
  });
}

export async function verifyChimeraClient({ root = fileURLToPath(new URL('../', import.meta.url)), requireWebExport = true } = {}) {
  const repositoryRoot = resolve(root);
  const findings = [];
  await scanExpoConfig(findings, repositoryRoot);

  const appRoot = join(repositoryRoot, APP_ROOT);
  const sourcePaths = (await Promise.all(SOURCE_ROOTS.map((sourceRoot) => filesUnder(join(appRoot, sourceRoot))))).flat()
    .filter((path) => TEXT_FILE.test(path));
  for (const path of sourcePaths) {
    const appRelative = relative(appRoot, path).replaceAll('\\', '/');
    if (FORBIDDEN_ROUTE_FILES.has(appRelative)) addFinding(findings, repositoryRoot, path, 'forbidden-route-file');
    scanSource(findings, repositoryRoot, path, await readFile(path, 'utf8'));
  }

  const webRoot = join(appRoot, WEB_EXPORT_ROOT);
  if (!await exists(webRoot)) {
    if (requireWebExport) addFinding(findings, repositoryRoot, webRoot, 'missing-production-web-export');
  } else {
    for (const path of (await filesUnder(webRoot)).filter((path) => TEXT_FILE.test(path))) {
      scanSource(findings, repositoryRoot, path, await readFile(path, 'utf8'), BUNDLE_RULES);
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let findings;
  try {
    await exportProductionWeb(root);
    findings = await verifyChimeraClient({ root });
  } catch {
    findings = [{ path: `${APP_ROOT}/${WEB_EXPORT_ROOT}`, rule: 'production-web-export-failed' }];
  }
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.path}: ${finding.rule}`);
    process.exitCode = 1;
  } else {
    console.log('Chimera client policy verified');
  }
}
