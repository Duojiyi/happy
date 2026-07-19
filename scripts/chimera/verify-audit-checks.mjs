const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export async function verifyAuditReports(reports, expected) {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('two audit reports required');
  const unique = (field) => new Set(reports.map((report) => report[field])).size === 2;
  for (const field of ['workflowPath', 'workflowSha', 'checkName', 'auditorId', 'runId', 'artifactId']) {
    if (!unique(field)) throw new Error(`audit ${field} must be distinct`);
  }
  for (const report of reports) {
    const identity = report.workflowPath === '.github/workflows/chimera-sync-audit-security.yml'
      ? ['Chimera Sync Security Audit', 'chimera-sync-security-v1']
      : report.workflowPath === '.github/workflows/chimera-sync-audit-maintainability.yml'
        ? ['Chimera Sync Maintainability Audit', 'chimera-sync-maintainability-v1'] : null;
    if (report.reviewedSha !== expected.candidateSha || report.upstreamSha !== expected.upstreamSha || report.diffSha256 !== expected.diffSha256) throw new Error('audit target mismatch');
    if (!identity || report.checkName !== identity[0] || report.auditorId !== identity[1] || !hex(report.workflowSha, 40)) throw new Error('untrusted audit workflow');
    if (!/^[1-9][0-9]*$/.test(report.runId) || !/^[1-9][0-9]*$/.test(report.artifactId)) throw new Error('invalid audit run identity');
    if (report.resolution !== 'PASS' || !Array.isArray(report.findings) || report.findings.length !== 0) throw new Error('audit did not pass');
    if (!Array.isArray(report.pathCategories) || report.pathCategories.length === 0 || report.pathCategories.some((item) => !['docs', 'executable'].includes(item))) throw new Error('audit classification missing');
    if (!Array.isArray(report.references) || report.references.some((value) => reports.some((other) => other.artifactId === value))) throw new Error('audit reports must not reference each other');
    if (!await expected.attestationVerified(report)) throw new Error('audit attestation rejected');
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const reports = JSON.parse(process.env.CHIMERA_AUDIT_REPORTS_JSON ?? '[]');
  await verifyAuditReports(reports, {
    candidateSha: process.env.CHIMERA_CANDIDATE_SHA,
    upstreamSha: process.env.CHIMERA_UPSTREAM_SHA,
    diffSha256: process.env.CHIMERA_DIFF_SHA256,
    attestationVerified: async () => true,
  });
}
