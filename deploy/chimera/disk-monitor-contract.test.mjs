import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const [script, status, forcedServer, forcedStatus, sudoers, service, timer, installer, bootstrap] = await Promise.all([
  readFile(new URL('chimera-disk-check.sh', root), 'utf8'),
  readFile(new URL('chimera-disk-status', root), 'utf8'),
  readFile(new URL('bin/chimera-server-helper', root), 'utf8'),
  readFile(new URL('bin/chimera-status-helper', root), 'utf8'),
  readFile(new URL('sudoers/chimera-deploy', root), 'utf8'),
  readFile(new URL('systemd/chimera-disk-check.service', root), 'utf8'),
  readFile(new URL('systemd/chimera-disk-check.timer', root), 'utf8'),
  readFile(new URL('install-deploy-user.sh', root), 'utf8'),
  readFile(new URL('install-monitoring.sh', root), 'utf8'),
]);

test('disk monitor checks both filesystems and bounded storage categories', () => {
  for (const expected of ['mountpoint -q /srv/chimera-storage', 'percent_used /', 'percent_used /srv/chimera-storage', '/srv/chimera-storage/snapshots', '/opt/chimera/web/releases', '/opt/chimera/downloads', '/var/lib/docker']) assert.match(script, new RegExp(expected.replaceAll('/', '\\/')));
  assert.match(script, /ROOT_USED >= 70 \|\| STORAGE_USED >= 70/);
  assert.match(script, /mv -f.*disk-monitor\.json/);
});

test('root-owned systemd monitor is isolated and scheduled every six hours', () => {
  assert.match(service, /User=root/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=\/opt\/chimera\/state/);
  assert.match(timer, /OnUnitActiveSec=6h/);
  assert.match(timer, /Persistent=true/);
  assert.match(installer, /systemctl enable --now chimera-disk-check\.timer/);
  assert.ok(installer.indexOf('systemctl start chimera-disk-check.service') < installer.indexOf('systemctl enable --now chimera-disk-check.timer'), 'installer must seed a passing status before enabling scheduled probes');
});

test('forced SSH status exposes only aggregate health', () => {
  assert.doesNotMatch(forcedServer, /status-server|chimera-disk-status/);
  assert.match(forcedStatus, /SSH_ORIGINAL_COMMAND:-}" == status-server/);
  assert.match(forcedStatus, /sudo -n \/usr\/local\/libexec\/chimera-disk-status/);
  assert.doesNotMatch(forcedStatus, /scp|deploy-server|rollback-server/);
  assert.match(sudoers, /chimera-status-monitor ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/chimera-disk-status/);
  assert.doesNotMatch(sudoers, /chimera-server-deploy ALL=.*chimera-disk-status/);
  assert.match(status, /timedelta\(hours=8\)/);
  assert.match(status, /print\('ok'\)/);
  assert.doesNotMatch(status, /print\(data|json\.dumps/);
});

test('one-time production bootstrap validates host policy before activation', () => {
  assert.match(bootstrap, /visudo -cf "\$SUDOERS_TMP"/);
  assert.ok(bootstrap.indexOf('visudo -cf "$SUDOERS_TMP"') < bootstrap.indexOf('mv -f -- "$SUDOERS_TMP" /etc/sudoers.d/chimera-deploy'));
  assert.ok(bootstrap.indexOf('systemctl start chimera-disk-check.service') < bootstrap.indexOf('systemctl enable --now chimera-disk-check.timer'));
  assert.match(bootstrap, /chimera-disk-status \| grep -Fx ok/);
  assert.match(bootstrap, /chimera-status-monitor/);
  assert.match(bootstrap, /status-monitor-public-key/);
  assert.doesNotMatch(bootstrap, /private.key|production\.env|chimera-server-deploy/);
  assert.match(installer, /<status-key>/);
});
