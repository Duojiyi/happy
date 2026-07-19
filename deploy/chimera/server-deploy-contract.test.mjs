import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const [source, forced, android, workflowSource] = await Promise.all([
  readFile(path.join(import.meta.dirname, 'deploy-server.sh'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'bin/chimera-server-helper'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'libexec/chimera-android-activate'), 'utf8'),
  readFile(path.join(root, '.github/workflows/chimera-server-release.yml'), 'utf8'),
]);

function body(name, next) {
  return source.slice(source.indexOf(`${name}() {`), source.indexOf(`\n${next}() {`, source.indexOf(`${name}() {`)));
}

export function validateServerDeployProtocol(workflow, forcedSource = forced, deploySource = source) {
  const deploy = workflow.jobs.deploy;
  const steps = deploy.steps ?? [];
  const runs = steps.map((step) => step.run ?? '').join('\n');
  assert.ok(steps.some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids'] === '${{ needs.build.outputs.artifact-id }}'));
  for (const expected of [
    'deploy-input/server-image.tar', 'deploy-input/server-release-input.json', 'gh attestation verify deploy-input/server-image.tar',
    '.chimera-staging/server/$REVIEWED_SHA.oci.partial', '.chimera-staging/server/$REVIEWED_SHA.json.partial', '.chimera-staging/server/$REVIEWED_SHA.attestation.partial',
    'server-archive-attestation.jsonl', '--bundle deploy-input/server-archive-attestation.jsonl',
    'chimera-server-deploy@39.98.68.173', 'deploy-server $REVIEWED_SHA $IMAGE_DIGEST',
  ]) assert.match(runs, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(runs, /chimera-deploy@|docker build|Dockerfile\.server/);
  assert.ok(forcedSource.includes('\\.chimera-staging/server/[a-f0-9]{40}\\.(oci|json|attestation)\\.partial'));
  assert.match(forcedSource, /\^deploy-server\\ \(\[a-f0-9\]\{40\}\)\\ \(sha256:\[a-f0-9\]\{64\}\)\$/);
  assert.match(deploySource, /\^deploy-server\\ \(\[a-f0-9\]\{40\}\)\\ \(sha256:\[a-f0-9\]\{64\}\)\$/);
  return true;
}

test('workflow, forced command, and privileged helper share one immutable OCI protocol', () => {
  validateServerDeployProtocol(parse(workflowSource));
});

test('server imports only root-frozen OCI bytes bound to commit digest and metadata', () => {
  for (const pattern of [
    /server-image\.oci/, /server-release-input\.json/, /imageArchiveSha256/, /archive_hash=hashlib\.sha256/, /stream\.read\(1024\*1024\)/,
    /index\.get\("manifests"/, /blobs\/sha256/, /calculated\.hexdigest\(\)/, /server-archive-attestation\.jsonl/, /gh attestation verify/, /--bundle "\$incoming\/server-archive-attestation\.jsonl"/, /skopeo copy --preserve-digests/, /docker-daemon:chimera-relay:\$id/,
  ]) assert.match(source, pattern);
  assert.ok(source.indexOf('install -m 0600 "$source_archive"') < source.indexOf('python3 - "$incoming/server-image.oci"'));
  assert.doesNotMatch(source, /docker build|Dockerfile\.server|tar --extract|RELEASE_ROOT|deploy\/chimera\/docker-compose/);
  assert.match(source, /require_root_owned_file "\$COMPOSE_FILE"/);
});

test('candidate is reachable only on the host loopback port', () => {
  const candidate = body('start_candidate', 'verify_candidate');
  assert.match(candidate, /--network host/);
  assert.match(candidate, /--env PORT="\$CANDIDATE_PORT"/);
  assert.doesNotMatch(candidate, /--publish|0\.0\.0\.0/);
  assert.match(source, /CANDIDATE_URL=http:\/\/127\.0\.0\.1/);
});

test('deploy and rollback install recovery traps before maintenance mutation', () => {
  const deploy = body('deploy_server', 'rollback_server');
  assert.ok(deploy.indexOf("trap 'rollback_failed_deploy") < deploy.indexOf('maintenance_on'));
  const rollback = source.slice(source.indexOf('rollback_server() {'), source.indexOf('\nmain() {'));
  assert.ok(rollback.indexOf("trap 'rollback_failed_rollback") < rollback.indexOf('maintenance_on'));
  assert.match(rollback, /create_snapshot "\$rescue"/);
  assert.match(source, /if verify_running_old; then maintenance_off && verify_public; fi/);
});

test('Android APK target is immutable while the manifest remains the final pointer', () => {
  assert.match(android, /if ! ln "\$release\/\$filename" "\$downloads\/\$filename"/);
  assert.match(android, /cmp --silent "\$release\/\$filename" "\$downloads\/\$filename"/);
  assert.doesNotMatch(android, /mv -f -- "\$downloads\/\.\$filename\.next"/);
  assert.ok(android.indexOf('ln "$release/$filename"') < android.indexOf('mv -f -- "$downloads/.chimera-update.json.next"'));
});

test('protocol mutation cannot switch back to the shared identity', () => {
  const workflow = parse(workflowSource);
  const transfer = workflow.jobs.deploy.steps.find((step) => step.run?.includes('chimera-server-deploy@'));
  transfer.run = transfer.run.replaceAll('chimera-server-deploy@', 'chimera-deploy@');
  assert.throws(() => validateServerDeployProtocol(workflow), /chimera-server-deploy/);
});
