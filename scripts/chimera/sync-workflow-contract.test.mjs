import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflowPath = new URL('../../.github/workflows/chimera-sync-upstream.yml', import.meta.url);
const securityPath = new URL('../../.github/workflows/chimera-sync-audit-security.yml', import.meta.url);
const maintainPath = new URL('../../.github/workflows/chimera-sync-audit-maintainability.yml', import.meta.url);
const pinned = /^[^@\s]+@[0-9a-f]{40}$/;

test('scheduled sync workflow is isolated and fail closed', async () => {
  const workflow = parse(await readFile(workflowPath, 'utf8'));
  const on = workflow.on ?? workflow.true;
  assert.equal(on.schedule[0].cron, '23 */6 * * *');
  assert.ok(on.workflow_dispatch !== undefined);
  assert.equal(workflow.concurrency.group, 'chimera-upstream-sync');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, { actions: 'read', contents: 'write', 'pull-requests': 'write', issues: 'write' });
  assert.deepEqual(workflow.jobs.dispatch.permissions, { actions: 'write', contents: 'read' });
  assert.match(JSON.stringify(workflow), /sync-upstream\.ps1/);
  assert.match(JSON.stringify(workflow), /verify-audit-checks\.mjs/);
  assert.match(JSON.stringify(workflow), /--merge/);
  assert.doesNotMatch(JSON.stringify(workflow), /--squash|--rebase|secrets\.|\bPAT\b|personal.access/i);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses, pinned);
});

test('sync audits are distinct read-only workflows with attestation-only provenance', async () => {
  const [security, maintain] = await Promise.all([readFile(securityPath, 'utf8').then(parse), readFile(maintainPath, 'utf8').then(parse)]);
  for (const workflow of [security, maintain]) {
    assert.deepEqual(workflow.jobs.audit.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs.provenance.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
    assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|contents":"write/);
  }
  assert.notEqual(security.name, maintain.name);
  assert.doesNotMatch(JSON.stringify(security), /sync-audit-maintainability/);
  assert.doesNotMatch(JSON.stringify(maintain), /sync-audit-security/);
});
