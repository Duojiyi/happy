import { pathToFileURL } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA = /^[0-9a-f]{40}$/i;

function invalid(message) { throw new Error(message); }
export function isSemver(value) {
  const match = typeof value === 'string' && value.match(SEMVER);
  return Boolean(match && (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))));
}

function validateProduct(product) {
  if (!product || typeof product !== 'object' || !isSemver(product.upstreamAppVersion)) invalid('Invalid product: upstreamAppVersion must be SemVer');
  for (const field of ['chimeraRevision', 'androidVersionCode']) {
    if (!Number.isSafeInteger(product[field]) || product[field] < 1) invalid(`Invalid product: ${field} must be a positive integer`);
  }
}

export function versionNameFor(product) { return `${product.upstreamAppVersion}-chimera.${product.chimeraRevision}`; }

export function classifyReleasePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 'server-only';
  const app = paths.some((path) => /^(?:packages\/happy-app\/|packages\/happy-wire\/|brand\/chimera\/|scripts\/generate-chimera-brand\.mjs)/.test(path));
  const server = paths.some((path) => /^(?:packages\/happy-server\/|Dockerfile\.server$)/.test(path));
  if (app && server) return 'combined';
  return app ? 'app-relevant' : 'server-only';
}

function releaseTag(release) { return release?.tag ?? release?.tagName; }
function releaseCommit(release) { return release?.commitSha ?? release?.targetCommitish ?? release?.target_commitish; }

export function resolveRelease(input) {
  if (!input || typeof input !== 'object') invalid('Release input must be an object');
  const { product, appConfigVersion, packageVersion, commitSha, tags = [], releases = [], reservation } = input;
  validateProduct(product);
  const versionName = versionNameFor(product);
  if (appConfigVersion !== versionName) invalid(`App config version must equal ${versionName}`);
  if (packageVersion !== versionName) invalid(`Package version must equal ${versionName}`);
  if (typeof commitSha !== 'string' || !SHA.test(commitSha)) invalid('commitSha must be a 40-character SHA');
  const tag = `app-v${versionName}`;
  const occupied = new Set([...tags, ...releases.map(releaseTag)].filter(Boolean));
  if (occupied.has(tag)) invalid(`Release tag is occupied: ${tag}`);
  if (releases.some((release) => releaseCommit(release) === commitSha)) invalid(`Commit is already released: ${commitSha}`);
  const priorCodes = releases.map((release) => release?.versionCode).filter(Number.isSafeInteger);
  const greatestCode = Math.max(0, ...priorCodes);
  if (product.androidVersionCode <= greatestCode) invalid(`androidVersionCode must be greater than released versionCode ${greatestCode}`);
  if (reservation && reservation.status !== 'reserved') invalid(`Release reservation conflict: ${reservation.tag ?? tag}`);
  const classification = classifyReleasePaths(input.changedPaths);
  const protocolClient = (input.changedPaths ?? []).some((path) => /^packages\/happy-wire\//.test(path));
  const serverChanged = (input.changedPaths ?? []).some((path) => /^(?:packages\/happy-server\/|Dockerfile\.server$)/.test(path));
  const clientReleaseRequired = classification !== 'server-only';
  return Object.freeze({ versionName, versionCode: product.androidVersionCode, tag, commitSha, artifactBase: `Chimera-${versionName}-android-universal`, clientReleaseRequired, serverDeployBeforeClient: clientReleaseRequired && (serverChanged || protocolClient) });
}

// Callers own network I/O. This keeps resolution deterministic and makes GitHub access injectable.
export async function resolveReleaseWithAdapters(input, adapters) {
  if (!adapters?.listTags || !adapters?.listReleases || !adapters?.reserveTag) invalid('Release adapters must provide listTags, listReleases, and reserveTag');
  const [tags, releases] = await Promise.all([adapters.listTags(), adapters.listReleases()]);
  // Validate every deterministic input before creating an externally visible reservation.
  const draft = resolveRelease({ ...input, tags, releases });
  const reservation = await adapters.reserveTag(draft);
  return resolveRelease({ ...input, tags, releases, reservation });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const text = await new Promise((resolve, reject) => { let value = ''; process.stdin.setEncoding('utf8').on('data', (chunk) => { value += chunk; }).on('end', () => resolve(value)).on('error', reject); });
    const input = JSON.parse(text);
    process.stdout.write(`${JSON.stringify(resolveRelease(input))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
