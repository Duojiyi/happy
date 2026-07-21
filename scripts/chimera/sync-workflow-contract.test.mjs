import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflowPath = new URL('../../.github/workflows/chimera-sync-upstream.yml', import.meta.url);
const securityPath = new URL('../../.github/workflows/chimera-sync-audit-security.yml', import.meta.url);
const maintainPath = new URL('../../.github/workflows/chimera-sync-audit-maintainability.yml', import.meta.url);
const syncScriptPath = new URL('./sync-upstream.ps1', import.meta.url);
const pinned = /^[^@\s]+@[0-9a-f]{40}$/;

function jobRun(job) {
  return (job.steps ?? []).map((step) => step.run ?? '').join('\n');
}

function validateSyncWorkflow(source) {
  const workflow = parse(source);
  const on = workflow.on ?? workflow.true;
  assert.equal(on.schedule[0].cron, '23 */6 * * *');
  assert.ok(on.workflow_dispatch !== undefined);
  assert.equal(workflow.concurrency.group, 'chimera-upstream-sync');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, { actions: 'read', contents: 'write', 'pull-requests': 'write' });
  assert.deepEqual(workflow.jobs.dispatch.permissions, { actions: 'write', contents: 'read' });

  const publishRun = jobRun(workflow.jobs.publish);
  assert.match(publishRun, /--force-with-lease="refs\/heads\/\$BRANCH:\$EXPECTED_REMOTE_SHA"/);
  assert.doesNotMatch(publishRun, /--force-with-lease(?:\s|$)/m);
  assert.match(publishRun, /EXPECTED_REMOTE_SHA=''/);
  assert.match(publishRun, /ls-remote origin "refs\/heads\/\$BRANCH"/);

  const postMerge = workflow.jobs['post-merge-build'];
  assert.ok(postMerge, 'post-merge-build job is required');
  assert.ok(postMerge['timeout-minutes'] > 120, 'post-merge verification must outlast the Android build timeout');
  assert.deepEqual(postMerge.needs, ['prepare', 'publish', 'dispatch', 'merge-docs', 'gate-executable']);
  const postMergeRun = jobRun(postMerge);
  assert.match(postMergeRun, /mergeCommit\.oid/);
  assert.match(postMergeRun, /RUN_BOUNDARY/);
  assert.match(postMergeRun, /\.id > \$boundary/);
  assert.match(postMergeRun, /gh workflow run chimera-build\.yml .* --ref main/);
  assert.match(postMergeRun, /\.event == "workflow_dispatch"/);
  assert.match(postMergeRun, /\.head_branch == "main"/);
  assert.match(postMergeRun, /\.head_sha == \$sha/);
  assert.match(postMergeRun, /\.path == "\.github\/workflows\/chimera-build\.yml"/);
  assert.match(postMergeRun, /test "\$CONCLUSION" = success/);
  assert.match(postMergeRun, /VERIFIED_RUN=\$\(jq -cr/);
  assert.doesNotMatch(postMergeRun, /VERIFIED_RUN=\$\(jq -er/);

  const blocked = workflow.jobs['blocked-issue'];
  const stages = ['prepare', 'publish', 'dispatch', 'merge-docs', 'gate-executable', 'post-merge-build'];
  assert.deepEqual(blocked.needs, stages);
  for (const stage of stages) {
    assert.match(blocked.if, new RegExp(`needs\\.${stage.replaceAll('-', '\\-')}\\.result == 'failure'`));
    assert.match(blocked.if, new RegExp(`needs\\.${stage.replaceAll('-', '\\-')}\\.result == 'cancelled'`));
  }
  const download = blocked.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download?.['continue-on-error'], true);
  const blockedRun = jobRun(blocked);
  assert.match(blockedRun, /git ls-remote --exit-code/);
  assert.match(blockedRun, /TITLE="Upstream sync blocked: \$SHA"/);
  assert.match(blockedRun, /gh api --paginate --slurp .*issues\?state=open&per_page=100/);
  assert.doesNotMatch(blockedRun, /gh api[^\n]*--slurp[^\n]*--jq|gh api[^\n]*--jq[^\n]*--slurp/);
  assert.match(blockedRun, /jq '\[\.\[\]\[\] \| select\(\.pull_request == null\) \| \{number,title\}\]'/);
  assert.match(blockedRun, /select\(\.pull_request == null\)/);
  assert.match(blockedRun, /select\(\.title == \$title\)/);
  assert.match(blockedRun, /duplicate blocked issues/);

  assert.match(JSON.stringify(workflow), /sync-upstream\.ps1/);
  assert.match(JSON.stringify(workflow), /verify-audit-checks\.mjs/);
  const gateRun = jobRun(workflow.jobs['gate-executable']);
  assert.match(gateRun, /CHIMERA_AUDIT_REPORT_PATHS_JSON/);
  assert.match(gateRun, /CHIMERA_TRUSTED_AUDIT_ACTORS_JSON/);
  assert.match(gateRun, /CHIMERA_TRUSTED_WORKFLOW_SHA/);
  assert.match(gateRun, /REPORT_DIR="reports\/content\/\$ARTIFACT_ID"/);
  assert.match(gateRun, /REPORT="\$REPORT_DIR\/unpacked\/\$FILE"/);
  assert.doesNotMatch(gateRun, /gh attestation verify|WORKFLOW_BLOB_SHA|actions\/runs\/\$RUN\/jobs/);
  assert.match(JSON.stringify(workflow), /--merge/);
  assert.doesNotMatch(JSON.stringify(workflow), /--squash|--rebase|secrets\.|\bPAT\b|personal.access/i);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses, pinned);
}

test('scheduled sync workflow is isolated and fail closed', async () => {
  validateSyncWorkflow(await readFile(workflowPath, 'utf8'));
});

test('sync script uses a strict text-document allowlist', async () => {
  const source = await readFile(syncScriptPath, 'utf8');
  assert.ok(source.includes("^(README|README\\.(md|mdx|txt)|docs/.+\\.(md|mdx|txt)|[^/]+\\.(md|mdx|txt))$"));
});

test('contract mutations fail closed', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const mutations = [
    ['publish issues permission', source.replace('      pull-requests: write\n', '      pull-requests: write\n      issues: write\n')],
    ['bare force-with-lease', source.replace('--force-with-lease="refs/heads/$BRANCH:$EXPECTED_REMOTE_SHA"', '--force-with-lease')],
    ['missing post-merge dispatch', source.replace("          gh workflow run chimera-build.yml --repo '${{ github.repository }}' --ref main\n", '')],
    ['missing exact head SHA', source.replaceAll(' and .head_sha == $sha', '')],
    ['missing blocked stage', source.replace('needs: [prepare, publish, dispatch, merge-docs, gate-executable, post-merge-build]', 'needs: [prepare, publish, dispatch, merge-docs, gate-executable]')],
    ['non-paginated issue lookup', source.replace('gh api --paginate --slurp', 'gh api')],
  ];
  for (const [name, mutation] of mutations) assert.throws(() => validateSyncWorkflow(mutation), name);
});

test('sync audits are distinct read-only workflows with attestation-only provenance', async () => {
  const [security, maintain] = await Promise.all([readFile(securityPath, 'utf8').then(parse), readFile(maintainPath, 'utf8').then(parse)]);
  for (const workflow of [security, maintain]) {
    assert.deepEqual(workflow.jobs.audit.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs.provenance.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
    const download = workflow.jobs.provenance.steps.find((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']);
    assert.equal(download?.with?.['merge-multiple'], true, 'sync audit provenance must merge immutable artifacts into the declared path');
    assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|contents":"write/);
  }
  assert.notEqual(security.name, maintain.name);
  assert.doesNotMatch(JSON.stringify(security), /sync-audit-maintainability/);
  assert.doesNotMatch(JSON.stringify(maintain), /sync-audit-security/);
});
