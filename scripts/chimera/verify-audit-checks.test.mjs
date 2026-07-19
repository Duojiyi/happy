import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAuditReports } from './verify-audit-checks.mjs';

const sha = 'a'.repeat(40);
const upstream = 'b'.repeat(40);
const diff = 'c'.repeat(64);
const reports = [
  { reviewedSha: sha, upstreamSha: upstream, diffSha256: diff, workflowPath: '.github/workflows/chimera-sync-audit-security.yml', workflowSha: 'd'.repeat(40), checkName: 'Chimera Sync Security Audit', auditorId: 'chimera-sync-security-v1', runId: '11', artifactId: '21', resolution: 'PASS', findings: [], pathCategories: ['executable'], references: [] },
  { reviewedSha: sha, upstreamSha: upstream, diffSha256: diff, workflowPath: '.github/workflows/chimera-sync-audit-maintainability.yml', workflowSha: 'e'.repeat(40), checkName: 'Chimera Sync Maintainability Audit', auditorId: 'chimera-sync-maintainability-v1', runId: '12', artifactId: '22', resolution: 'PASS', findings: [], pathCategories: ['executable'], references: [] },
];

test('accepts two independent attested PASS reports for the exact candidate', async () => {
  await assert.doesNotReject(() => verifyAuditReports(reports, { candidateSha: sha, upstreamSha: upstream, diffSha256: diff, attestationVerified: () => true }));
});

test('rejects replay, coupling, unresolved findings, and missing classification', async () => {
  for (const mutate of [
    (copy) => { copy[1].runId = copy[0].runId; },
    (copy) => { copy[1].reviewedSha = 'f'.repeat(40); },
    (copy) => { copy[0].findings = [{ severity: 'high' }]; },
    (copy) => { copy[0].pathCategories = []; },
    (copy) => { copy[0].references = [copy[1].artifactId]; },
  ]) {
    const copy = structuredClone(reports); mutate(copy);
    await assert.rejects(() => verifyAuditReports(copy, { candidateSha: sha, upstreamSha: upstream, diffSha256: diff, attestationVerified: () => true }));
  }
});
