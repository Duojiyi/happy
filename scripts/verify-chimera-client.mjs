import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const APP_ROOT = 'packages/happy-app';
const SOURCE_ROOTS = ['sources/app', 'sources/chimera'];
const WEB_EXPORT_ROOT = 'dist';
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html|css)$/i;

const RULES = [
  ['happy-logo', /happy[-_ ]?logo/i],
  ['happy-branding', /\b(?:title|name|appName)\s*[:=]\s*['"`]Happy(?:\s+Coder)?['"`]/],
  ['official-host', /(?:https?:\/\/)?(?:app\.|api\.)?happy\.(?:engineering|tools|engineer)\b/i],
  ['server-selector', /\b(?:ServerSelector|ServerSelection|setServer(?:Url|URL|Config)|customServer)\b/],
  ['voice-integration', /\b(?:VoiceButton|startVoice|useConversation|RealtimeVoiceSession|@elevenlabs\/|livekit)\b/i],
  ['push-integration', /\b(?:expo-notifications|registerForPush|pushRegistration|apiPush)\b/i],
  ['telemetry-or-purchases', /\b(?:new\s+PostHog|PostHog\.init|tracking\.(?:capture|identify)|RevenueCat\.configure|Purchases\.configure|configurePurchases)\b/i],
  ['removed-settings-or-route', /(?:['"`](?:voice|server)['"`]|\/(?:settings\/)?(?:voice|server)\b)/i],
];
const BUNDLE_RULES = RULES.filter(([rule]) => !['server-selector', 'removed-settings-or-route'].includes(rule));

function isExcluded(relativePath) {
  return /(?:^|\/)(?:__fixtures__|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(relativePath)
    || relativePath === 'sources/chimera/clientPolicy.ts'
    || relativePath.startsWith('sources/app/(app)/dev/');
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
  try {
    const source = await readFile(path, 'utf8');
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
  } catch {
    addFinding(findings, root, path, 'invalid-expo-config');
  }
}

export async function verifyChimeraClient({ root = fileURLToPath(new URL('../', import.meta.url)), requireWebExport = true } = {}) {
  const repositoryRoot = resolve(root);
  const findings = [];
  await scanExpoConfig(findings, repositoryRoot);

  const appRoot = join(repositoryRoot, APP_ROOT);
  const sourcePaths = (await Promise.all(SOURCE_ROOTS.map((sourceRoot) => filesUnder(join(appRoot, sourceRoot))))).flat()
    .filter((path) => TEXT_FILE.test(path));
  for (const path of sourcePaths) scanSource(findings, repositoryRoot, path, await readFile(path, 'utf8'));

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
  const findings = await verifyChimeraClient();
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.path}: ${finding.rule}`);
    process.exitCode = 1;
  } else {
    console.log('Chimera client policy verified');
  }
}
