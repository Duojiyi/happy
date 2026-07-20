import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..', '..');
const productPath = path.join(root, 'brand/chimera/product.json');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const generatedFiles = [
  'packages/happy-app/sources/chimera/product.generated.ts', 'packages/happy-app/sources/chimera/product.generated.mjs',
  ...['icon.png', 'icon-adaptive.png', 'icon-monochrome.png', 'splash-android-light.png', 'splash-android-dark.png', 'favicon.png', 'logotype-light.png', 'logotype-dark.png'].map((file) => `packages/happy-app/sources/assets/images/${file}`),
].map((file) => path.join(root, file));

function isSemver(value) {
  const match = typeof value === 'string' && value.match(semver);
  return Boolean(match && (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))));
}

export function bumpProduct(product, upstreamAppVersion) {
  if (!isSemver(upstreamAppVersion)) throw new Error('upstreamAppVersion must be SemVer');
  const revision = product.upstreamAppVersion === upstreamAppVersion ? product.chimeraRevision + 1 : 1;
  return { ...product, upstreamAppVersion, chimeraRevision: revision, androidVersionCode: product.androidVersionCode + 1 };
}

export async function writeProductAtomically(file, product) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(product, null, 2)}\n`); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}

async function snapshot(files) { return Promise.all(files.map(async (file) => ({ file, contents: await readFile(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) }))); }
async function restore(entries) { await Promise.all(entries.map(({ file, contents }) => contents === null ? unlink(file).catch(() => {}) : writeFile(file, contents))); }

export async function bumpRelease({ upstreamAppVersion, productFile = productPath, generate, generatedFiles: files = generatedFiles } = {}) {
  const product = JSON.parse(await readFile(productFile, 'utf8'));
  const next = bumpProduct(product, upstreamAppVersion);
  const outputs = await snapshot(files);
  const generateOutputs = generate ?? ((value) => execFileAsync(process.execPath, ['scripts/generate-chimera-brand.mjs'], { cwd: root, env: { ...process.env, CHIMERA_PRODUCT_JSON: JSON.stringify(value) } }));
  try {
    await generateOutputs(next);
    await writeProductAtomically(productFile, next);
    return next;
  } catch (error) {
    await restore(outputs);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstreamAppVersion = process.argv[2];
  try { process.stdout.write(`${JSON.stringify(await bumpRelease({ upstreamAppVersion }))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
