import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubAuditVerifier, verifyAuditReports } from './verify-audit-checks.mjs';

const sha = 'a'.repeat(40);
const upstream = 'b'.repeat(40);
const diff = 'c'.repeat(64);
const trusted = 'd'.repeat(40);
const repo = 'Duojiyi/happy';
const reports = [
  { reviewedSha: sha, upstreamSha: upstream, diffSha256: diff, workflowPath: '.github/workflows/chimera-sync-audit-security.yml', workflowSha: 'e'.repeat(40), checkName: 'Chimera Sync Security Audit', auditorId: 'chimera-sync-security-v1', runId: '11', artifactId: '21', resolution: 'PASS', findings: [], pathCategories: ['executable'], references: [] },
  { reviewedSha: sha, upstreamSha: upstream, diffSha256: diff, workflowPath: '.github/workflows/chimera-sync-audit-maintainability.yml', workflowSha: 'f'.repeat(40), checkName: 'Chimera Sync Maintainability Audit', auditorId: 'chimera-sync-maintainability-v1', runId: '12', artifactId: '22', resolution: 'PASS', findings: [], pathCategories: ['executable'], references: [] },
];

function onlineFixture(overrides = {}) {
  const state = { attested: [] };
  const runGh = async (args) => {
    if (args[0] === 'attestation') { state.attested.push(args); if (overrides.attestationFailure) throw new Error('unsigned'); return '{}'; }
    const endpoint = args[1];
    const runMatch = endpoint.match(/actions\/runs\/(11|12)$/);
    if (runMatch) {
      const id = runMatch[1]; const report = reports[id === '11' ? 0 : 1];
      return JSON.stringify({ id: Number(id), event: 'workflow_dispatch', head_sha: trusted, head_branch: 'main', conclusion: 'success', path: report.workflowPath, actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'Duojiyi' }, ...overrides.run });
    }
    const jobsMatch = endpoint.match(/actions\/runs\/(11|12)\/jobs/);
    if (jobsMatch) { const report = reports[jobsMatch[1] === '11' ? 0 : 1]; return JSON.stringify({ jobs: [{ id: 30, name: report.checkName, conclusion: 'success' }], ...overrides.jobs }); }
    const artifactMatch = endpoint.match(/actions\/artifacts\/(21|22)$/);
    if (artifactMatch) { const security = artifactMatch[1] === '21'; return JSON.stringify({ id: Number(artifactMatch[1]), workflow_run: { id: security ? 11 : 12 }, name: security ? 'chimera-sync-security-report' : 'chimera-sync-maintainability-report', expired: false, ...overrides.artifact }); }
    const content = reports.find((report) => endpoint.includes(report.workflowPath));
    if (content) return JSON.stringify({ type: 'file', sha: content.workflowSha, ...overrides.workflow });
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const verifier = createGithubAuditVerifier({ repo, trustedWorkflowSha: trusted, reportPaths: { 21: '/tmp/security-report.json', 22: '/tmp/maintainability-report.json' }, trustedActors: ['github-actions[bot]', 'Duojiyi'], runGh });
  return { verifier, state };
}

test('accepts two independent online-attested PASS reports for the exact candidate', async () => {
  const { verifier, state } = onlineFixture();
  await assert.doesNotReject(() => verifyAuditReports(reports, { candidateSha: sha, upstreamSha: upstream, diffSha256: diff, attestationVerified: verifier }));
  assert.equal(state.attested.length, 2);
  assert.ok(state.attested.every((args) => args.includes('--deny-self-hosted-runners') && args.includes('--signer-digest')));
});

test('rejects replay, coupling, unresolved findings, malformed schema, and missing classification', async () => {
  for (const mutate of [
    (copy) => { copy[1].runId = copy[0].runId; },
    (copy) => { copy[1].reviewedSha = '0'.repeat(40); },
    (copy) => { copy[0].findings = [{ severity: 'high' }]; },
    (copy) => { copy[0].pathCategories = []; },
    (copy) => { copy[0].references = [copy[1].artifactId]; },
    (copy) => { copy[0].placeholder = true; },
    (copy) => { copy[0].checkName = 'lookalike'; },
    (copy) => { copy[0].workflowSha = 'not-a-sha'; },
  ]) {
    const copy = structuredClone(reports); mutate(copy);
    await assert.rejects(() => verifyAuditReports(copy, { candidateSha: sha, upstreamSha: upstream, diffSha256: diff, attestationVerified: onlineFixture().verifier }));
  }
});

test('rejects untrusted online run, workflow, job, artifact, actor, and unsigned report', async () => {
  for (const overrides of [
    { run: { head_sha: '0'.repeat(40) } },
    { run: { actor: { login: 'mallory' } } },
    { run: { event: 'push' } },
    { run: { conclusion: 'failure' } },
    { jobs: { jobs: [] } },
    { artifact: { expired: true } },
    { artifact: { workflow_run: { id: 999 } } },
    { workflow: { sha: '0'.repeat(40) } },
    { attestationFailure: true },
  ]) {
    const { verifier } = onlineFixture(overrides);
    await assert.rejects(() => verifyAuditReports(reports, { candidateSha: sha, upstreamSha: upstream, diffSha256: diff, attestationVerified: verifier }));
  }
});
