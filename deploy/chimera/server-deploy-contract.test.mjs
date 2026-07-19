import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.join(import.meta.dirname, 'deploy-server.sh');
const source = await readFile(scriptPath, 'utf8').catch(() => '');

test('server deploy entrypoint has a closed command and release-id grammar', () => {
  assert.match(source, /\^deploy-server\\ \(\[a-f0-9\]\{40\}\)\$/);
  assert.match(source, /\^rollback-server\\ \(\[a-f0-9\]\{40\}\)\$/);
  assert.match(source, /IFS= read -r command/);
  assert.match(source, /if IFS= read -r extra; then die; fi/);
  assert.doesNotMatch(source, /\beval\b|bash\s+-c|sh\s+-c/);
});

test('server deploy validates fixed-root staged OCI bytes before use', () => {
  assert.match(source, /STAGING_ROOT=.*chimera-server-deploy.*server/);
  assert.match(source, /\.tar\.partial/);
  assert.match(source, /path\.is_absolute\(\)/);
  assert.match(source, /\.\." in path\.parts/);
  assert.match(source, /member\.issym\(\)|member\.islnk\(\)|member\.isdev\(\)/);
  assert.match(source, /archive\.resolve\(strict=True\)/);
  assert.match(source, /staging\.resolve\(strict=True\)/);
  assert.match(source, /docker build.*chimera-relay:\$id/);
});

test('server deploy orders maintenance, snapshot, candidate checks, and rollback', () => {
  const ordered = [
    'verify_running_old',
    'maintenance_on',
    'stop_runtime',
    'assert_pglite_closed',
    'check_snapshot_space',
    'create_snapshot',
    'open_test_snapshot',
    'migrate_candidate',
    'start_candidate',
    'verify_candidate',
    'promote_candidate',
    'verify_running_new',
    'maintenance_off',
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = source.indexOf(`${marker} \"$id\"`, cursor + 1);
    assert.ok(next > cursor, `${marker} must appear in the deployment transaction order`);
    cursor = next;
  }
  assert.match(source, /data_bytes \* 12 \/ 10 \+ 15 \* 1024 \* 1024 \* 1024/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /\/v1\/chimera\/config/);
  assert.match(source, /\/v1\/account\/profile/);
  assert.match(source, /socket\.io\/\?EIO=4&transport=polling/);
  assert.match(source, /trap 'rollback_failed_deploy/);
  assert.match(source, /retain_verified_snapshots 2/);
});

test('rollback restores a verified snapshot and health-checks before reopening traffic', () => {
  assert.match(source, /test -f \"\$snapshot\/.verified\"/);
  assert.match(source, /restore_snapshot/);
  assert.match(source, /open_test_data/);
  assert.match(source, /verify_running_old/);
  assert.match(source, /maintenance_off/);
});
