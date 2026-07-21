import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const releasePath = path.join(root, '.github/workflows/chimera-release.yml');
const serverPath = path.join(root, '.github/workflows/chimera-server-release.yml');
const securityAuditPath = path.join(root, '.github/workflows/chimera-audit-security.yml');
const maintainabilityAuditPath = path.join(root, '.github/workflows/chimera-audit-maintainability.yml');
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;

const steps = (job) => (job?.steps ?? []).filter((step) => step && typeof step === 'object');
const runs = (job) => steps(job).map((step) => step.run ?? '').join('\n');
const serialized = (job) => JSON.stringify(job);

function assertPinned(workflow) {
  for (const step of Object.values(workflow.jobs ?? {}).flatMap(steps)) {
    if (step.uses) assert.match(step.uses, PINNED_ACTION, `action must use a full commit SHA: ${step.uses}`);
  }
}

function assertNoDirectUntrustedShellExpressions(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of steps(job)) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|steps|needs)\./, `${jobName} run must receive untrusted expressions through env`);
    }
  }
}

function assertNoCheckout(job, name) {
  assert.equal(steps(job).some((step) => step.uses?.startsWith('actions/checkout@')), false, `${name} must not checkout repository source`);
  assert.doesNotMatch(runs(job), /(?:node|pnpm|npm|pwsh)\s+(?:\.\/)?scripts\//, `${name} must not execute repository scripts`);
}

function assertContains(text, patterns, name) {
  for (const pattern of patterns) assert.match(text, pattern, `${name} missing ${pattern}`);
}

function assertFlatArtifactDownloads(workflow, name) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of steps(job).filter((item) => item.uses?.startsWith('actions/download-artifact@') && item.with?.['artifact-ids'])) {
      assert.equal(step.with?.['merge-multiple'], true, `${name} ${jobName} immutable artifact downloads must merge into the declared path`);
    }
  }
}

export function validateClientReleaseWorkflow(workflow) {
  assert.ok(workflow?.on?.workflow_dispatch ?? workflow?.true?.workflow_dispatch, 'client release must be workflow_dispatch only');
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'], 'client release must have no automatic trigger');
  assert.equal(workflow.concurrency?.group, 'chimera-production-release', 'client release must use repository-wide concurrency');
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'production release must never cancel in progress');
  assertPinned(workflow);
  assertFlatArtifactDownloads(workflow, 'client release');
  assertNoDirectUntrustedShellExpressions(workflow);

  const classify = workflow.jobs?.classify;
  assert.ok(classify, 'authoritative diff classification job is required');
  assertNoCheckout(classify, 'classification');
  assert.deepEqual(classify.permissions, { contents: 'read' });
  assertContains(runs(classify), [/releases\?per_page/, /compare\/\$BASE_SHA\.\.\.\$REVIEWED_SHA/, /packages\/happy-app/, /packages\/happy-server/, /packages\/happy-wire/, /pnpm-lock/, /client-required/, /server-required/], 'classification');
  const dispatchInputs = (workflow.on ?? workflow.true).workflow_dispatch.inputs;
  assert.equal('client_release_required' in dispatchInputs, false, 'client requirement must not be supplied by dispatch');
  assert.equal('server_deploy_required' in dispatchInputs, false, 'server requirement must not be supplied by dispatch');

  const signing = workflow.jobs?.signing;
  assert.ok(signing, 'signing job is required');
  assert.equal(signing.environment, 'android-signing', 'signing must use protected android-signing Environment');
  assert.deepEqual(signing.permissions, { actions: 'read', attestations: 'read', checks: 'read', contents: 'read' }, 'signing permissions must be minimal and allow check-run verification');
  assertNoCheckout(signing, 'signing');
  const sign = runs(signing);
  assertContains(sign, [
    /artifact-ids|artifact_id/i,
    /BUILD_RUN_ID/,
    /TRUSTED_BUILD_WORKFLOW_SHA/,
    /github\.repository|repository\.full_name/,
    /head_sha/,
    /gh attestation verify/,
    /signer-workflow/,
    /signer-digest/,
    /source-digest/,
    /source-ref/,
    /subject.*digest|sha256sum/,
    /find candidate\/android -type f \| wc -l/,
    /SECURITY_AUDIT_RUN_ID/,
    /MAINTAINABILITY_AUDIT_RUN_ID/,
    /check-runs/,
    /chimera-audit-security\.yml/,
    /chimera-audit-maintainability\.yml/,
    /chimera-security-audit-report/,
    /chimera-maintainability-audit-report/,
    /diffSha256/,
    /35\.0\.0/,
    /EXPECTED_SIGNER_SHA256/,
    /CHIMERA_ANDROID_KEYSTORE_BASE64/,
    /CHIMERA_MANIFEST_PRIVATE_KEY_PKCS8_BASE64/,
    /chmod 600/,
    /shred/,
    /apksigner.*verify/is,
    /aapt2.*dump badging/is,
    /apksigner.*sign/is,
    /signer.*SHA-256|certificate SHA-256/i,
    /release-input\.json/,
    /canonical|Object\.keys\([^)]*\)\.sort/,
    /ed25519|createPrivateKey|crypto\.sign/i,
    /ze6ngKGbk7dgWN5d6rXGO0YRE5y54hbLMULFoW5YTHc/,
    /versionCode/,
    /existing.*release|releases\/tags/i,
    /gh release download[\s\S]*--dir \/tmp\/existing/,
    /cmp \/tmp\/expected-apk\.sha256/,
    /cmp "\$EXISTING_WEB" candidate\/web\/Chimera-web\.tar\.gz/,
    /cmp \/tmp\/expected-web\.sha256/,
  ], 'signing job');
  assert.ok(steps(signing).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']), 'signing must download by immutable artifact ID');
  assert.ok(steps(signing).some((step) => step.uses?.startsWith('actions/upload-artifact@')), 'signing must hand off signed bytes as an artifact');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'signing') assert.doesNotMatch(serialized(job), /\$\{\{\s*secrets\./, `${name} must not receive release secrets`);
  }

  const signedProvenance = workflow.jobs?.['signed-provenance'];
  assert.ok(signedProvenance, 'signed artifact provenance job is required');
  assertNoCheckout(signedProvenance, 'signed provenance');
  assert.deepEqual(signedProvenance.permissions, { actions: 'read', contents: 'read', 'id-token': 'write', attestations: 'write' }, 'signed provenance permissions must be minimal');
  assert.match(runs(signedProvenance), /find signed-attest -type f \| wc -l/);
  const signedSubjects = steps(signedProvenance).filter((step) => step.uses?.startsWith('actions/attest-build-provenance@')).map((step) => step.with?.['subject-path']).sort();
  assert.deepEqual(signedSubjects, ['signed-attest/Chimera.apk', 'signed-attest/chimera-update.json'], 'signed provenance must attest the exact verified APK and manifest');

  const publication = workflow.jobs?.publication;
  assert.ok(publication, 'publication job is required');
  assert.equal(publication.environment, 'production-release', 'publication must use a protected Environment');
  assert.deepEqual(publication.permissions, { actions: 'read', attestations: 'read', contents: 'write' }, 'publication permissions must be minimal');
  assertNoCheckout(publication, 'publication');
  const publish = runs(publication);
  assertContains(publish, [
    /sha256sum/,
    /releases\/tags|release view/,
    /git\/refs\/tags|git\/ref\/tags/,
    /REVIEWED_SHA/,
    /versionCode/,
    /release create|releases/,
    /release create[\s\S]*Chimera-/,
    /chimera-update\.json/,
    /\.sha256/,
    /chimera-release\.yml/,
  ], 'publication job');
  assert.doesNotMatch(publish, /--clobber|release delete|git push.*--force/i, 'publication must never replace immutable assets');
  assert.match(serialized(workflow), /server_release_run_id/);
  return true;
}

export function validateServerReleaseWorkflow(workflow) {
  assert.ok(workflow?.on?.workflow_dispatch ?? workflow?.true?.workflow_dispatch, 'server release must be workflow_dispatch only');
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'], 'server release must have no automatic trigger');
  assert.equal(workflow.concurrency?.group, 'chimera-production-release', 'server release must share production concurrency');
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'server release must never cancel in progress');
  assertPinned(workflow);
  assertFlatArtifactDownloads(workflow, 'server release');
  assertNoDirectUntrustedShellExpressions(workflow);

  const classify = workflow.jobs?.classify;
  assert.ok(classify, 'server authoritative diff classification job is required');
  assertNoCheckout(classify, 'server classification');
  assert.deepEqual(classify.permissions, { contents: 'read' });
  assertContains(runs(classify), [/releases\?per_page/, /compare\/\$BASE_SHA\.\.\.\$REVIEWED_SHA/, /packages\/happy-server/, /packages\/happy-wire/, /server-required/], 'server classification');

  const build = workflow.jobs?.build;
  assert.ok(build, 'server build job is required');
  assert.deepEqual(build.permissions, { contents: 'read' }, 'server build must be read-only');
  assert.doesNotMatch(serialized(build), /\bsecrets\b|\benvironment\s*:/i, 'server build must be secretless');
  assert.ok(steps(build).some((step) => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ inputs.reviewed_commit_sha }}' && step.with?.['persist-credentials'] === false), 'server build must checkout only the reviewed SHA without credentials');
  const buildRun = runs(build);
  assertContains(buildRun, [
    /REVIEWED_SHA/,
    /pnpm install --frozen-lockfile/,
    /chimera:server:check/,
    /happy-wire.*test/,
    /migration|migrate/i,
    /server-image\.tar/,
    /imageDigest|image-digest|sha256:/,
  ], 'server build');
  assert.ok(steps(build).some((step) => /build-push-action/.test(step.uses ?? '') && step.with?.file === 'Dockerfile.server' && /type=oci/.test(step.with?.outputs ?? '')), 'server build must build Dockerfile.server as OCI');
  const scannerInstall = steps(build).find((step) => step.name === 'Install verified Trivy scanner');
  assert.ok(scannerInstall, 'server build must install a verified image scanner');
  assert.match(String(scannerInstall.env?.TRIVY_VERSION), /^\d+\.\d+\.\d+$/);
  assert.match(String(scannerInstall.env?.TRIVY_ARCHIVE_SHA256), /^[0-9a-f]{64}$/);
  assertContains(String(scannerInstall.run), [/github\.com\/aquasecurity\/trivy\/releases\/download/, /sha256sum --check --strict/], 'scanner install');
  assert.doesNotMatch(serialized(scannerInstall), /github-token|github-pat|token-setup-trivy/i, 'candidate scanner must not receive a GitHub token');
  const scanner = steps(build).find((step) => step.name === 'Scan image at checked-in fail threshold');
  assert.ok(scanner, 'server build must scan the reviewed OCI archive');
  assertContains(String(scanner.run), [/tar -xf dist\/server-image\.tar/, /trivy image/, /--input "\$OCI_LAYOUT"/, /--exit-code 1/, /--severity HIGH,CRITICAL/], 'scanner threshold');
  assert.ok(steps(build).some((step) => /sbom-action/.test(step.uses ?? '') && /spdx/i.test(stringify(step.with))), 'server build must emit SPDX SBOM');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'deploy') assert.doesNotMatch(serialized(job), /\$\{\{\s*secrets\./, `${name} must not receive deployment secrets`);
  }

  const provenance = workflow.jobs?.provenance;
  assert.ok(provenance, 'server provenance job is required');
  assert.deepEqual(provenance.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' }, 'server provenance permissions must be attestation-only');
  assertNoCheckout(provenance, 'server provenance');
  assert.ok(steps(provenance).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']), 'server provenance must download by artifact ID');
  assert.equal(steps(provenance).filter((step) => /^actions\/attest-(?:build-provenance|sbom)@/.test(step.uses ?? '')).length >= 2, true, 'server provenance must attest OCI digest and SBOM');
  assertContains(runs(provenance), [/sha256sum/, /imageDigest|image-digest|sha256:/, /server-image\.tar/, /spdx/i], 'server provenance');
  assert.match(runs(provenance), /tar -xOf attest\/server-image\.tar index\.json/, 'server provenance must derive the OCI digest from the archive');
  const archiveAttestation = steps(provenance).find((step) => step.with?.['subject-path']);
  assert.equal(archiveAttestation?.with?.['subject-path'], 'attest/server-image.tar', 'server archive attestation must bind the exact verified file');
  assert.ok(steps(provenance).some((step) => step.with?.['subject-digest'] === '${{ needs.build.outputs.image-digest }}'), 'server provenance must attest the exact OCI digest');

  const publication = workflow.jobs?.publication;
  assert.ok(publication, 'server publication job is required');
  assert.equal(publication.environment, 'server-release', 'server publication must be protected');
  assertNoCheckout(publication, 'server publication');
  assert.deepEqual(publication.permissions, { actions: 'read', attestations: 'read', contents: 'read', packages: 'write' }, 'server publication permissions must be minimal');
  assert.ok(steps(publication).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']), 'server publication must download by immutable artifact ID');
  const publish = runs(publication);
  assertContains(publish, [
    /github\.repository|repository\.full_name/,
    /head_sha|REVIEWED_SHA/,
    /TRUSTED_WORKFLOW_SHA|trustedWorkflowSha/,
    /github\.run_id|run_id/,
    /gh attestation verify/,
    /signer-workflow/,
    /signer-digest/,
    /source-digest/,
    /source-ref/,
    /--bundle \/tmp\/oci-attestations\.jsonl/,
    /https:\/\/slsa\.dev\/provenance\/v1/,
    /https:\/\/spdx\.dev\/Document\/v2\.3/,
    /blobs\/sha256\/\$DIGEST_HEX/,
    /ghcr\.io\/duojiyi\/chimera-happy-server@\$IMAGE_DIGEST/,
    /skopeo.*copy/is,
    /--preserve-digests/,
  ], 'server publication');
  assert.doesNotMatch(publish, /(?:docker|skopeo).*:(?:latest|main|production)\b/i, 'server publication must not publish mutable tags');

  const deploy = workflow.jobs?.deploy;
  assert.ok(deploy, 'server deployment job is required');
  assert.equal(deploy.environment, 'server-release', 'server deployment must be protected');
  assert.deepEqual(deploy.permissions, { actions: 'read', attestations: 'read', checks: 'read', contents: 'read', packages: 'read' }, 'server deployment permissions must allow check-run and attestation verification only');
  assertNoCheckout(deploy, 'server deployment');
  const deployRun = runs(deploy);
  assertContains(deployRun, [/gh attestation verify/, /SECURITY_AUDIT_RUN_ID/, /MAINTAINABILITY_AUDIT_RUN_ID/, /check-runs/, /chimera-audit-security\.yml/, /chimera-audit-maintainability\.yml/, /chimera-security-audit-report/, /chimera-maintainability-audit-report/, /diffSha256/, /server-image\.tar/, /server-release-input\.json/, /server-archive-attestation\.jsonl/, /attestations\/sha256:/, /--bundle deploy-input\/server-archive-attestation\.jsonl/, /--predicate-type 'https:\/\/slsa\.dev\/provenance\/v1'/, /imageArchiveSha256/, /scp/, /chimera-server-deploy@103\.250\.173\.136/, /deploy-server \$REVIEWED_SHA \$IMAGE_DIGEST/, /sha256:/, /running.*digest|deployed.*digest/i], 'server deployment');
  assert.ok(steps(deploy).some((step) => step.uses?.startsWith('docker/login-action@')), 'server deployment must authenticate before OCI attestation verification');
  assert.ok(steps(deploy).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids'] === '${{ needs.build.outputs.artifact-id }}'), 'server deployment must download the exact attested OCI artifact by immutable ID');
  assert.equal((deployRun.match(/\bscp -O\b/g) ?? []).length, 3, 'all server transfers must force legacy SCP for the forced scp -t helper');
  assert.doesNotMatch(deployRun, /chimera-deploy@|\.tar\.partial|docker build|Dockerfile\.server/, 'server deployment must use only the isolated OCI import protocol');
  assert.doesNotMatch(deployRun, /ghcr\.io\/[^\s"']+:(?:latest|main|production)/i, 'deployment must receive only an immutable digest');
  return true;
}

export function validateAuditWorkflows(security, maintainability) {
  const definitions = [
    [security, 'Chimera Security Audit', 'chimera-security-audit-report', 'audit-security-attest/security-report.json'],
    [maintainability, 'Chimera Maintainability Audit', 'chimera-maintainability-audit-report', 'audit-maintainability-attest/maintainability-report.json'],
  ];
  for (const [workflow, checkName, artifactName, subjectPath] of definitions) {
    assert.deepEqual(Object.keys(workflow.on ?? workflow.true), ['workflow_dispatch'], `${checkName} must be explicitly dispatched`);
    assertPinned(workflow);
    assertFlatArtifactDownloads(workflow, checkName);
    assertNoDirectUntrustedShellExpressions(workflow);
    assert.doesNotMatch(serialized(workflow), /\$\{\{\s*secrets\.|\bcontents\s*:\s*write|pull-requests\s*:\s*write/i, `${checkName} must be read-only and secretless`);
    const audit = workflow.jobs?.audit;
    assert.equal(audit?.name, checkName);
    assert.deepEqual(audit?.permissions, { contents: 'read' });
    assert.equal('base_commit_sha' in (workflow.on ?? workflow.true).workflow_dispatch.inputs, false, `${checkName} base must not be caller-controlled`);
    assert.match(runs(audit), /releases\?per_page=100/, `${checkName} must derive accepted base from GitHub Releases`);
    assert.ok(steps(audit).some((step) => step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] === false), `${checkName} checkout must not persist credentials`);
    assert.ok(steps(audit).some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === artifactName), `${checkName} artifact identity`);
    const provenance = workflow.jobs?.provenance;
    assertNoCheckout(provenance, `${checkName} provenance`);
    assert.deepEqual(provenance?.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
    assert.ok(steps(provenance).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']), `${checkName} provenance must download by artifact ID`);
    assert.ok(steps(provenance).some((step) => step.uses?.startsWith('actions/attest-build-provenance@') && step.with?.['subject-path'] === subjectPath), `${checkName} must attest exact report`);
  }
  assert.doesNotMatch(serialized(security), /chimera-audit-maintainability|maintainability-report/i, 'security audit must not depend on maintainability audit');
  assert.doesNotMatch(serialized(maintainability), /chimera-audit-security|security-report/i, 'maintainability audit must not depend on security audit');
  return true;
}

function stringify(value) {
  return JSON.stringify(value);
}

const [releaseSource, serverSource, securityAuditSource, maintainabilityAuditSource] = await Promise.all([
  readFile(releasePath, 'utf8').catch(() => null),
  readFile(serverPath, 'utf8').catch(() => null),
  readFile(securityAuditPath, 'utf8').catch(() => null),
  readFile(maintainabilityAuditPath, 'utf8').catch(() => null),
]);

test('Chimera client release workflow contract', () => {
  assert.ok(releaseSource, `missing ${path.relative(root, releasePath)}`);
  validateClientReleaseWorkflow(parse(releaseSource));
});

test('Chimera server release workflow contract', () => {
  assert.ok(serverSource, `missing ${path.relative(root, serverPath)}`);
  validateServerReleaseWorkflow(parse(serverSource));
});

test('Chimera independent audit workflow contracts', () => {
  assert.ok(securityAuditSource, `missing ${path.relative(root, securityAuditPath)}`);
  assert.ok(maintainabilityAuditSource, `missing ${path.relative(root, maintainabilityAuditPath)}`);
  validateAuditWorkflows(parse(securityAuditSource), parse(maintainabilityAuditSource));
});

if (releaseSource && serverSource) {
  test('rejects checkout in protected signing', () => {
    const workflow = parse(releaseSource);
    workflow.jobs.signing.steps.unshift({ uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683' });
    assert.throws(() => validateClientReleaseWorkflow(workflow), /must not checkout/);
  });

  test('rejects repository script execution in publication', () => {
    const workflow = parse(releaseSource);
    workflow.jobs.publication.steps.push({ run: 'node scripts/chimera/publish.mjs' });
    assert.throws(() => validateClientReleaseWorkflow(workflow), /must not execute repository scripts/);
  });

  test('rejects wrong signing Environment', () => {
    const workflow = parse(releaseSource);
    workflow.jobs.signing.environment = 'unprotected';
    assert.throws(() => validateClientReleaseWorkflow(workflow), /android-signing/);
  });

  test('rejects secrets in candidate server build', () => {
    const workflow = parse(serverSource);
    workflow.jobs.build.env = { TOKEN: '${{ secrets.TOKEN }}' };
    assert.throws(() => validateServerReleaseWorkflow(workflow), /secretless/);
  });

  test('rejects mutable server image references', () => {
    const workflow = parse(serverSource);
    workflow.jobs.publication.steps.push({ run: 'docker push ghcr.io/duojiyi/chimera-happy-server:latest' });
    assert.throws(() => validateServerReleaseWorkflow(workflow), /mutable tags/);
  });

  test('rejects an unverified scanner archive', () => {
    const workflow = parse(serverSource);
    const scannerInstall = workflow.jobs.build.steps.find((step) => step.name === 'Install verified Trivy scanner');
    scannerInstall.run = scannerInstall.run.replace('sha256sum --check --strict', 'true');
    assert.throws(() => validateServerReleaseWorkflow(workflow), /scanner install/);
  });

  test('rejects a broader server archive attestation glob', () => {
    const workflow = parse(serverSource);
    const attestation = workflow.jobs.provenance.steps.find((step) => step.with?.['subject-path']);
    attestation.with['subject-path'] = 'attest/*.tar';
    assert.throws(() => validateServerReleaseWorkflow(workflow), /exact verified file/);
  });

  test('rejects a broader signed APK attestation glob', () => {
    const workflow = parse(releaseSource);
    const attestation = workflow.jobs['signed-provenance'].steps.find((step) => step.with?.['subject-path'] === 'signed-attest/Chimera.apk');
    attestation.with['subject-path'] = 'signed-attest/*.apk';
    assert.throws(() => validateClientReleaseWorkflow(workflow), /exact verified APK and manifest/);
  });

  test('rejects direct untrusted expressions in protected shell scripts', () => {
    const workflow = parse(releaseSource);
    workflow.jobs.signing.steps.push({ run: "echo '${{ inputs.reviewed_commit_sha }}'" });
    assert.throws(() => validateClientReleaseWorkflow(workflow), /through env/);
  });

  test('rejects direct upstream job outputs in deployment shell scripts', () => {
    const workflow = parse(serverSource);
    workflow.jobs.deploy.steps.push({ run: "echo '${{ needs.publication.outputs.image-digest }}'" });
    assert.throws(() => validateServerReleaseWorkflow(workflow), /through env/);
  });

  test('rejects direct step outputs in signing shell scripts', () => {
    const workflow = parse(releaseSource);
    workflow.jobs.signing.steps.push({ run: "echo '${{ steps.metadata.outputs.tag }}'" });
    assert.throws(() => validateClientReleaseWorkflow(workflow), /through env/);
  });

  test('rejects no-op paths that do not compare existing Web bytes', () => {
    const workflow = parse(releaseSource);
    const step = workflow.jobs.signing.steps.find((item) => item.id === 'preflight');
    step.run = step.run.replace('cmp "$EXISTING_WEB" candidate/web/Chimera-web.tar.gz', 'test -f "$EXISTING_WEB"');
    assert.throws(() => validateClientReleaseWorkflow(workflow), /signing job missing/);
  });

  test('rejects caller-controlled release classification', () => {
    const workflow = parse(releaseSource);
    workflow.on.workflow_dispatch.inputs.client_release_required = { type: 'boolean', required: true };
    assert.throws(() => validateClientReleaseWorkflow(workflow), /must not be supplied/);
  });

  test('rejects publication without verified SPDX attestation', () => {
    const workflow = parse(serverSource);
    const step = workflow.jobs.publication.steps.find((item) => item.run?.includes('oci-attestations.jsonl'));
    step.run = step.run.replace('https://spdx.dev/Document/v2.3', 'https://example.invalid/unchecked');
    assert.throws(() => validateServerReleaseWorkflow(workflow), /server publication missing/);
  });

  test('rejects audit workflow coupling', () => {
    const security = parse(securityAuditSource);
    security.jobs.audit.steps.push({ run: 'echo chimera-audit-maintainability.yml' });
    assert.throws(() => validateAuditWorkflows(security, parse(maintainabilityAuditSource)), /must not depend/);
  });

  test('rejects signing without check-run read permission', () => {
    const workflow = parse(releaseSource);
    delete workflow.jobs.signing.permissions.checks;
    assert.throws(() => validateClientReleaseWorkflow(workflow), /check-run verification/);
  });

  test('rejects server deployment without check-run read permission', () => {
    const workflow = parse(serverSource);
    delete workflow.jobs.deploy.permissions.checks;
    assert.throws(() => validateServerReleaseWorkflow(workflow), /check-run and attestation/);
  });
}
