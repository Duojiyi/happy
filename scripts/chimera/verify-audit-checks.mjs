import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const decimalId = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);

const identities = Object.freeze({
  '.github/workflows/chimera-sync-audit-security.yml': Object.freeze({
    checkName: 'Chimera Sync Security Audit',
    auditorId: 'chimera-sync-security-v1',
    artifactName: 'chimera-sync-security-report',
  }),
  '.github/workflows/chimera-sync-audit-maintainability.yml': Object.freeze({
    checkName: 'Chimera Sync Maintainability Audit',
    auditorId: 'chimera-sync-maintainability-v1',
    artifactName: 'chimera-sync-maintainability-report',
  }),
});

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} schema mismatch`);
}

async function defaultGh(args) {
  const { stdout } = await execFile('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export function createGithubAuditVerifier({ repo, trustedWorkflowSha, reportPaths, trustedActors, runGh = defaultGh }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid GitHub repository');
  if (!hex(trustedWorkflowSha, 40)) throw new Error('invalid trusted workflow SHA');
  if (!reportPaths || typeof reportPaths !== 'object' || Array.isArray(reportPaths)) throw new Error('audit report paths required');
  if (!Array.isArray(trustedActors) || trustedActors.length === 0 || trustedActors.some((actor) => typeof actor !== 'string' || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(actor))) throw new Error('trusted audit actors required');
  const actorSet = new Set(trustedActors);
  const apiJson = async (endpoint) => JSON.parse(await runGh(['api', `repos/${repo}/${endpoint}`]));

  return async (report) => {
    const identity = identities[report.workflowPath];
    const reportPath = reportPaths[report.artifactId];
    if (!identity || typeof reportPath !== 'string' || reportPath.length === 0) return false;

    const run = await apiJson(`actions/runs/${report.runId}`);
    if (String(run.id) !== report.runId || run.event !== 'workflow_dispatch' || run.head_sha !== trustedWorkflowSha || run.head_branch !== 'main' || run.conclusion !== 'success' || run.path !== report.workflowPath || !actorSet.has(run.actor?.login) || !actorSet.has(run.triggering_actor?.login)) return false;

    const jobs = await apiJson(`actions/runs/${report.runId}/jobs?filter=latest&per_page=100`);
    const trustedJobs = (jobs.jobs ?? []).filter((job) => job.name === identity.checkName && job.conclusion === 'success');
    if (trustedJobs.length !== 1) return false;

    const artifact = await apiJson(`actions/artifacts/${report.artifactId}`);
    if (String(artifact.id) !== report.artifactId || String(artifact.workflow_run?.id) !== report.runId || artifact.name !== identity.artifactName || artifact.expired !== false) return false;

    const workflow = await apiJson(`contents/${report.workflowPath}?ref=${trustedWorkflowSha}`);
    if (workflow.type !== 'file' || workflow.sha !== report.workflowSha) return false;

    await runGh([
      'attestation', 'verify', reportPath,
      '--repo', repo,
      '--cert-identity', `https://github.com/${repo}/${report.workflowPath}@refs/heads/main`,
      '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
      '--signer-workflow', `${repo}/${report.workflowPath}`,
      '--signer-digest', trustedWorkflowSha,
      '--source-digest', trustedWorkflowSha,
      '--source-ref', 'refs/heads/main',
      '--deny-self-hosted-runners',
    ]);
    return true;
  };
}

export async function verifyAuditReports(reports, expected) {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('two audit reports required');
  if (!hex(expected?.candidateSha, 40) || !hex(expected?.upstreamSha, 40) || !hex(expected?.diffSha256, 64) || typeof expected?.attestationVerified !== 'function') throw new Error('invalid expected audit context');
  const unique = (field) => new Set(reports.map((report) => report[field])).size === 2;
  for (const field of ['workflowPath', 'workflowSha', 'checkName', 'auditorId', 'runId', 'artifactId']) {
    if (!unique(field)) throw new Error(`audit ${field} must be distinct`);
  }
  for (const report of reports) {
    exactKeys(report, ['artifactId', 'auditorId', 'checkName', 'diffSha256', 'findings', 'pathCategories', 'references', 'resolution', 'reviewedSha', 'runId', 'upstreamSha', 'workflowPath', 'workflowSha'], 'audit report');
    const identity = identities[report.workflowPath];
    if (report.reviewedSha !== expected.candidateSha || report.upstreamSha !== expected.upstreamSha || report.diffSha256 !== expected.diffSha256) throw new Error('audit target mismatch');
    if (!identity || report.checkName !== identity.checkName || report.auditorId !== identity.auditorId || !hex(report.workflowSha, 40)) throw new Error('untrusted audit workflow');
    if (!decimalId(report.runId) || !decimalId(report.artifactId)) throw new Error('invalid audit run identity');
    if (report.resolution !== 'PASS' || !Array.isArray(report.findings) || report.findings.length !== 0) throw new Error('audit did not pass');
    if (!Array.isArray(report.pathCategories) || report.pathCategories.length === 0 || report.pathCategories.some((item) => !['docs', 'executable'].includes(item))) throw new Error('audit classification missing');
    if (!Array.isArray(report.references) || report.references.some((value) => reports.some((other) => other.artifactId === value))) throw new Error('audit reports must not reference each other');
    if (!await expected.attestationVerified(report)) throw new Error('audit online trust rejected');
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const reports = JSON.parse(process.env.CHIMERA_AUDIT_REPORTS_JSON ?? '[]');
  const reportPaths = JSON.parse(process.env.CHIMERA_AUDIT_REPORT_PATHS_JSON ?? '{}');
  const trustedActors = JSON.parse(process.env.CHIMERA_TRUSTED_AUDIT_ACTORS_JSON ?? '[]');
  const attestationVerified = createGithubAuditVerifier({
    repo: process.env.GITHUB_REPOSITORY,
    trustedWorkflowSha: process.env.CHIMERA_TRUSTED_WORKFLOW_SHA,
    reportPaths,
    trustedActors,
  });
  await verifyAuditReports(reports, {
    candidateSha: process.env.CHIMERA_CANDIDATE_SHA,
    upstreamSha: process.env.CHIMERA_UPSTREAM_SHA,
    diffSha256: process.env.CHIMERA_DIFF_SHA256,
    attestationVerified,
  });
}
