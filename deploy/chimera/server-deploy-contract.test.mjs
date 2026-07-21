import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const [source, forced, android, workflowSource, composeSource, installerSource, bootstrapSource] = await Promise.all([
  readFile(path.join(import.meta.dirname, 'deploy-server.sh'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'bin/chimera-server-helper'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'libexec/chimera-android-activate'), 'utf8'),
  readFile(path.join(root, '.github/workflows/chimera-server-release.yml'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'docker-compose.yml'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'install-deploy-user.sh'), 'utf8'),
  readFile(path.join(import.meta.dirname, 'deploy-standalone.sh'), 'utf8'),
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
    'chimera-server-deploy@103.250.173.136', 'deploy-server $REVIEWED_SHA $IMAGE_DIGEST',
  ]) assert.match(runs, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((runs.match(/\bscp -O\b/g) ?? []).length, 3);
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
    /index\.get\("manifests"/, /blobs\/sha256/, /calculated\.hexdigest\(\)/, /server-archive-attestation\.jsonl/, /gh attestation verify/, /--bundle "\$incoming\/server-archive-attestation\.jsonl"/, /--predicate-type 'https:\/\/slsa\.dev\/provenance\/v1'/, /import_verified_image/, /docker tag 'chimera-server:candidate' "chimera-relay:\$id"/,
  ]) assert.match(source, pattern);
  assert.ok(source.indexOf('install -m 0600 "$source_archive"') < source.indexOf('python3 - "$incoming/server-image.oci"'));
  assert.doesNotMatch(source, /docker build|Dockerfile\.server|tar --extract|RELEASE_ROOT|deploy\/chimera\/docker-compose/);
  assert.doesNotMatch(source, /--cert-identity|--cert-oidc-issuer|--signer-repo/);
  assert.match(source, /--signer-workflow 'Duojiyi\/happy\/\.github\/workflows\/chimera-server-release\.yml'/);
  assert.match(source, /--signer-digest "\$trusted_workflow_sha" --source-digest "\$id"/);
  const importer = body('import_verified_image', 'prepare_image');
  assert.match(importer, /io\.containerd\.image\.name/);
  assert.match(importer, /docker\.io\/library\/chimera-server:candidate/);
  assert.match(importer, /manifest\["config"\]\["digest"\]/);
  assert.match(importer, /expected_manifest" == "\$release_digest"/);
  assert.match(importer, /docker load --input "\$archive"/);
  assert.match(importer, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(importer, /actual_digest" == "\$expected_manifest" \|\| "\$actual_digest" == "\$expected_config"/);
  assert.doesNotMatch(importer, /skopeo|--preserve-digests/);
  assert.match(source, /cached_id" == "\$digest" \|\| "\$cached_id" == "\$expected_config"/);
  assert.match(source, /require_root_owned_file "\$COMPOSE_FILE"/);
});

test('candidate is reachable only on the host loopback port', () => {
  const candidate = body('start_candidate', 'verify_candidate');
  const verification = body('verify_candidate', 'write_marker');
  assert.match(candidate, /--network host/);
  assert.match(candidate, /--env PORT="\$CANDIDATE_PORT"/);
  assert.doesNotMatch(candidate, /--publish|0\.0\.0\.0/);
  assert.match(source, /CANDIDATE_URL=http:\/\/127\.0\.0\.1/);
  assert.match(verification, /\/v1\/updates\/\?EIO=4&transport=polling/);
  assert.doesNotMatch(verification, /\/socket\.io\//);
});

test('distroless runtime uses only compiled standalone entrypoints', () => {
  const compose = parse(composeSource);
  assert.deepEqual(compose.services.relay.command, ['dist/standalone.mjs', 'serve']);
  assert.deepEqual(compose.services.relay.healthcheck.test.slice(0, 2), ['CMD', '/nodejs/bin/node']);
  assert.equal(compose.services.relay.user, '65532:65532');
  for (const content of [composeSource, body('migrate_candidate', 'start_candidate')]) {
    assert.doesNotMatch(content, /\/bin\/sh|\bpnpm\b|\btsx\b/);
  }
  assert.doesNotMatch(source, /--entrypoint node\b/);
  assert.match(source, /--entrypoint \/nodejs\/bin\/node/);
  for (const name of ['open_test_path', 'migrate_candidate', 'start_candidate']) {
    assert.match(source.slice(source.indexOf(`${name}() {`), source.indexOf('\n}', source.indexOf(`${name}() {`))), /--user "\$RUNTIME_GID:\$RUNTIME_GID"/);
  }
  assert.match(body('migrate_candidate', 'start_candidate'), /dist\/standalone\.mjs migrate/);
  assert.match(bootstrapSource, /dist\/standalone\.mjs migrate/);
});

test('fresh host bootstraps rollback state from the verified OCI image before normal promotion', () => {
  const initial = body('bootstrap_verified_release', 'deploy_server');
  const deploy = body('deploy_server', 'rollback_server');
  const cleanup = body('cleanup_failed_bootstrap', 'bootstrap_verified_release');
  assert.match(initial, /find "\$DATA_ROOT" -mindepth 1 -maxdepth 1 -print -quit/);
  assert.match(initial, /find "\$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -print -quit/);
  assert.match(initial, /reference=chimera-relay:\*/);
  assert.ok(initial.indexOf('prepare_image') < initial.indexOf('migrate_candidate'));
  assert.match(initial, /legacy_id=.*chimera-bootstrap/);
  assert.match(initial, /docker tag "chimera-relay:\$id" "chimera-relay:\$legacy_id"/);
  assert.ok(initial.indexOf('verify_candidate') < initial.indexOf('docker compose --file "$COMPOSE_FILE" up'));
  assert.ok(initial.indexOf('verify_public_ready') < initial.indexOf('write_current_release'));
  assert.match(body('verify_public_ready', 'stop_runtime'), /for attempt in \{1\.\.90\}[\s\S]*sleep 2/);
  assert.ok(initial.indexOf('write_current_release') < initial.indexOf('mark_oci_retention_ready'));
  assert.doesNotMatch(initial, /maintenance_on|create_snapshot|old_image/);
  assert.match(deploy, /! -e "\$STATE_ROOT\/current-image"[\s\S]*! -e "\$STATE_ROOT\/current-digest"[\s\S]*bootstrap_verified_release/);
  assert.doesNotMatch(deploy, /bootstrap_verified_release[\s\S]{0,80}\breturn\b/);
  assert.match(cleanup, /docker compose .* down --remove-orphans/);
  assert.match(cleanup, /rm -f -- "\$STATE_ROOT\/current-image" "\$STATE_ROOT\/current-digest"/);
  assert.match(cleanup, /find "\$DATA_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf/);
});

test('root-owned data roots grant only the distroless runtime group write access', () => {
  for (const content of [installerSource, bootstrapSource]) {
    assert.match(content, /install -d -m 2770 -o root -g 65532 \/srv\/chimera-storage\/data/);
  }
  assert.match(source, /readonly RUNTIME_GID=65532/);
  assert.match(source, /stat -c '%g' "\$DATA_ROOT"/);
  assert.match(source, /install -d -m 2770 -o root -g "\$RUNTIME_GID" "\$temporary\/data"/);
  assert.match(source, /install -d -m 2770 -o root -g "\$RUNTIME_GID" "\$candidate"/);
});

test('deploy and rollback install recovery traps before maintenance mutation', () => {
  const deploy = body('deploy_server', 'rollback_server');
  assert.ok(deploy.indexOf("trap 'rollback_failed_deploy") < deploy.indexOf('maintenance_on'));
  const rollback = source.slice(source.indexOf('rollback_server() {'), source.indexOf('\nmain() {'));
  assert.ok(rollback.indexOf("trap 'rollback_failed_rollback") < rollback.indexOf('maintenance_on'));
  assert.match(rollback, /create_snapshot "\$rescue"/);
  assert.match(rollback, /chimera-rollback:/);
  assert.match(rollback, /rescue" =~ \^\[a-f0-9\]\{40\}\$/);
  assert.match(source, /if ! recover_release/);
});

test('snapshot restore is transactional and preserves original data until restored runtime health', () => {
  const restore = body('restore_snapshot', 'finish_restores');
  const finish = body('finish_restores', 'snapshot_markers');
  const recovery = body('recover_release', 'retain_verified_snapshots');
  const rollback = source.slice(source.indexOf('rollback_server() {'), source.indexOf('\nmain() {'));
  assert.ok(restore.indexOf('cp -a -- "$snapshot/data/." "$candidate/"') < restore.indexOf('mv -- "$DATA_ROOT" "$backup"'));
  assert.ok(restore.indexOf('open_test_path "$image" "$candidate"') < restore.indexOf('mv -- "$DATA_ROOT" "$backup"'));
  assert.match(restore, /if ! mv -- "\$candidate" "\$DATA_ROOT"/);
  assert.match(restore, /if ! mv -- "\$backup" "\$DATA_ROOT"/);
  assert.doesNotMatch(restore, /rm -rf -- "\$backup"/);
  assert.match(finish, /rm -rf -- "\$backup" \|\| return 1/);
  assert.match(source, /restore_pending_backup "\$image"/);
  assert.match(source, /open_test_path "\$image" "\$backup"/);
  assert.match(source, /RESTORE_BACKUPS=\("\$failed"\)/);
  assert.match(source, /cleanup_restore_candidates/);
  assert.ok(restore.indexOf('RESTORE_BACKUPS+=("$backup")') < restore.indexOf('mv -- "$candidate" "$DATA_ROOT"'));
  assert.match(restore, /rm -rf -- "\$candidate"/);
  assert.match(restore, /if ! mv -- "\$DATA_ROOT" "\$backup"; then[\s\S]*rm -rf -- "\$candidate"/);
  assert.ok(recovery.indexOf('verify_running_old || return 1') < recovery.indexOf('finish_restores || return 1'));
  assert.ok(rollback.indexOf('verify_running_old; finish_restores') > rollback.indexOf('docker compose --file "$COMPOSE_FILE" up'));
  assert.doesNotMatch(source, /set \+e/);
});

test('rollback handlers explicitly recover or force maintenance to remain enabled', () => {
  const failedDeploy = body('rollback_failed_deploy', 'rollback_failed_rollback');
  const failedRollback = body('rollback_failed_rollback', 'recover_release');
  const recovery = body('recover_release', 'retain_verified_snapshots');
  for (const handler of [failedDeploy, failedRollback]) {
    assert.match(handler, /if ! recover_release/);
    assert.match(handler, /if ! maintenance_on/);
  }
  for (const required of [
    /restore_snapshot .* \|\| return 1/, /write_current_release .* \|\| return 1/,
    /docker compose .* \|\| return 1/, /verify_running_old \|\| return 1/,
    /finish_restores \|\| return 1/, /verify_public \|\| return 1/,
  ]) assert.match(recovery, required);
});

function validateArtifactRetention(deploySource) {
  const start = deploySource.indexOf('retain_server_artifacts() {');
  const end = deploySource.indexOf('\ndeploy_server() {', start);
  const retain = deploySource.slice(start, end);
  assert.match(retain, /active_image="\$\(current_image\)"/);
  assert.match(retain, /image" != "\$active_image"/);
  assert.match(retain, /previous_input="\$INPUT_ROOT\/\$previous_id"/);
  assert.match(retain, /legacy_id="\$\(bootstrap_legacy_id\)"/);
  assert.match(retain, /"\$active_id" == "\$legacy_id"/);
  assert.match(retain, /"\$previous_id" != "\$legacy_id"/);
  assert.match(retain, /name" != "\$active_id" && "\$name" != "\$previous_id"/);
  assert.match(retain, /id" != "\$active_id" && "\$id" != "\$previous_id"/);
  assert.match(retain, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(retain, /! -L "\$entry" && -d "\$entry"/);
  assert.match(retain, /docker image rm "chimera-relay:\$id"/);
  assert.match(retain, /free_bytes > MIN_SYSTEM_FREE_BYTES/);
  assert.doesNotMatch(retain, /docker image prune|docker system prune/);
  return true;
}

test('deployment capacity covers the transactional peak on a dedicated data filesystem', () => {
  assert.match(source, /readonly STORAGE_ROOT=\/srv\/chimera-storage/);
  assert.match(source, /readonly MIN_STORAGE_FREE_BYTES=\$\(\(5 \* 1024 \* 1024 \* 1024\)\)/);
  const snapshot = body('check_snapshot_space', 'create_snapshot');
  assert.match(snapshot, /data_bytes \* 2 \+ MIN_STORAGE_FREE_BYTES/);
  assert.match(snapshot, /data_bytes \+ target_bytes \+ MIN_STORAGE_FREE_BYTES/);
  assert.match(body('deploy_server', 'rollback_server'), /assert_pglite_closed; check_snapshot_space\n/);
  assert.match(source.slice(source.indexOf('rollback_server() {'), source.indexOf('\nmain() {')), /check_snapshot_space "\$SNAPSHOT_ROOT\/\$id\/data"/);
  assert.match(source, /retain_verified_snapshots 1/);
  assert.match(source, /mountpoint -q "\$STORAGE_ROOT"/);
  assert.match(source, /stat -c '%d' "\$STORAGE_ROOT"/);
  assert.match(source, /MIN_STORAGE_CAPACITY_BYTES/);
  assert.match(source, /archive_bytes \* 2 \+ unpacked_bytes \+ MIN_SYSTEM_FREE_BYTES/);
  assert.match(source, /maximum = int\(sys\.argv\[2\]\)/);
  assert.match(source, /if total > maximum: raise SystemExit\(1\)/);
  assert.doesNotMatch(source, /\(\( unpacked_bytes <=/);
  assert.match(source, /application\/vnd\.oci\.image\.layer\.v1\.tar\+gzip/);
  assert.match(source, /cleanup_failed_release "\$id"/);
  assert.match(source, /rm -rf -- "\$SNAPSHOT_ROOT\/\.tmp-\$rescue" "\$SNAPSHOT_ROOT\/\$rescue"/);
});

function retainFixture({ active, previous, inputs, legacy }) {
  const inputSet = new Set(inputs);
  if (!inputSet.has(active) && active !== legacy) return null;
  if (previous && !inputSet.has(previous)) {
    if (legacy && previous !== legacy) return null;
    legacy ??= previous;
  }
  return { active, previous, inputs: [...inputSet].filter((id) => id === active || id === previous), legacy };
}

function deployFixture(state, next) {
  return retainFixture({ active: next, previous: state.active, inputs: [...state.inputs, next], legacy: state.legacy });
}

function rollbackFixture(state, target) {
  return retainFixture({ active: target, previous: state.active, inputs: state.inputs, legacy: state.legacy });
}

test('artifact retention keeps active and previous exact releases and enforces reserve space', () => {
  validateArtifactRetention(source);
  const deploy = body('deploy_server', 'rollback_server');
  const rollback = source.slice(source.indexOf('rollback_server() {'), source.indexOf('\nmain() {'));
  assert.ok(deploy.indexOf('retain_server_artifacts') < deploy.indexOf('maintenance_off'));
  assert.ok(rollback.indexOf('retain_server_artifacts') < rollback.indexOf('maintenance_off'));
  assert.ok(deploy.indexOf('retain_server_artifacts') < deploy.indexOf('retain_verified_snapshots'));
  assert.ok(rollback.indexOf('retain_server_artifacts') < rollback.indexOf('retain_verified_snapshots'));
});

test('bootstrap deploy to rollback state machine permits only its bound legacy image without an OCI input', () => {
  const legacy = 'a'.repeat(40);
  const firstOci = 'b'.repeat(40);
  const secondOci = 'c'.repeat(40);
  const initial = { active: legacy, previous: null, inputs: [], legacy: null };
  const firstDeploy = deployFixture(initial, firstOci);
  assert.deepEqual(firstDeploy, { active: firstOci, previous: legacy, inputs: [firstOci], legacy });
  const rollback = rollbackFixture(firstDeploy, legacy);
  assert.deepEqual(rollback, { active: legacy, previous: firstOci, inputs: [firstOci], legacy });
  const secondDeploy = deployFixture(rollback, secondOci);
  assert.deepEqual(secondDeploy, { active: secondOci, previous: legacy, inputs: [secondOci], legacy });
  assert.equal(retainFixture({ active: firstOci, previous: 'd'.repeat(40), inputs: [firstOci], legacy }), null);
  assert.match(source, /readonly OCI_RETENTION_READY="\$STATE_ROOT\/oci-retention-ready"/);
  assert.match(source, /mark_oci_retention_ready "\$legacy_id"/);
});

test('same-SHA deployment retry revalidates immutable inputs and reports only healthy matching state', () => {
  const deploy = body('deploy_server', 'rollback_server');
  const prepare = body('prepare_image', 'reload_proxy');
  const runningBase = body('verify_running_new', 'verify_running_release');
  const running = body('verify_running_release', 'remove_candidate_if_present');
  const idempotent = deploy.slice(deploy.indexOf('if [[ "$old_image" == "chimera-relay:$id" ]]'), deploy.indexOf('return', deploy.indexOf('if [[ "$old_image" == "chimera-relay:$id" ]]')) + 'return'.length);
  assert.match(idempotent, /\[\[ "\$old_digest" == "\$digest" \]\]/);
  assert.ok(idempotent.indexOf('[[ "$old_digest" == "$digest" ]]') < idempotent.indexOf('prepare_image "$id" "$digest"'));
  assert.match(idempotent, /verify_running_release "\$id" "\$digest"; verify_public/);
  for (const pair of [
    ['source_archive', 'server-image.oci'],
    ['source_metadata', 'server-release-input.json'],
    ['source_attestation', 'server-archive-attestation.jsonl'],
  ]) assert.match(prepare, new RegExp(`cmp -- "\\$${pair[0]}" "\\$accepted\\/${pair[1].replace('.', '\\.')}`));
  assert.match(runningBase, /docker inspect --format '\{\{\.Config\.Image\}\}'/);
  assert.match(running, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(running, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(running, /"\$tag_id" == "\$expected_config" && "\$container_id" == "\$expected_config"/);
  assert.match(deploy, /rm -f -- "\$STAGING_ROOT\/\$id\.oci\.partial" "\$STAGING_ROOT\/\$id\.json\.partial" "\$STAGING_ROOT\/\$id\.attestation\.partial"[\s\S]*printf 'deployed digest=%s\\nrunning digest=%s\\n'[\s\S]*return/);
});

test('retention contract rejects protected-release, path-safety, and reserve mutations', () => {
  for (const mutated of [
    source.replace('"$name" != "$active_id" && ', ''),
    source.replace('&& "$name" != "$previous_id"', ''),
    source.replace('"$id" != "$active_id" && ', ''),
    source.replace('&& "$id" != "$previous_id"', ''),
    source.replace('! -L "$entry" && ', ''),
    source.replace('"$active_id" == "$legacy_id"', 'false'),
    source.replace('"$previous_id" != "$legacy_id"', 'false'),
    source.replace('(( free_bytes > MIN_SYSTEM_FREE_BYTES ))', ':'),
  ]) assert.throws(() => validateArtifactRetention(mutated));
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
