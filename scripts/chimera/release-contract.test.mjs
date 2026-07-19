import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const releasePath = path.join(root, '.github/workflows/chimera-release.yml');
const serverPath = path.join(root, '.github/workflows/chimera-server-release.yml');
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;

const steps = (job) => (job?.steps ?? []).filter((step) => step && typeof step === 'object');
const runs = (job) => steps(job).map((step) => step.run ?? '').join('\n');
const serialized = (job) => JSON.stringify(job);

function assertPinned(workflow) {
  for (const step of Object.values(workflow.jobs ?? {}).flatMap(steps)) {
    if (step.uses) assert.match(step.uses, PINNED_ACTION, `action must use a full commit SHA: ${step.uses}`);
  }
}

function assertNoCheckout(job, name) {
  assert.equal(steps(job).some((step) => step.uses?.startsWith('actions/checkout@')), false, `${name} must not checkout repository source`);
  assert.doesNotMatch(runs(job), /(?:node|pnpm|npm|pwsh)\s+(?:\.\/)?scripts\//, `${name} must not execute repository scripts`);
}

function assertContains(text, patterns, name) {
  for (const pattern of patterns) assert.match(text, pattern, `${name} missing ${pattern}`);
}

export function validateClientReleaseWorkflow(workflow) {
  assert.ok(workflow?.on?.workflow_dispatch ?? workflow?.true?.workflow_dispatch, 'client release must be workflow_dispatch only');
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'], 'client release must have no automatic trigger');
  assert.equal(workflow.concurrency?.group, 'chimera-production-release', 'client release must use repository-wide concurrency');
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'production release must never cancel in progress');
  assertPinned(workflow);

  const signing = workflow.jobs?.signing;
  assert.ok(signing, 'signing job is required');
  assert.equal(signing.environment, 'android-signing', 'signing must use protected android-signing Environment');
  assert.deepEqual(signing.permissions, { actions: 'read', attestations: 'read', contents: 'read' }, 'signing permissions must be minimal');
  assertNoCheckout(signing, 'signing');
  const sign = runs(signing);
  assertContains(sign, [
    /artifact-ids|artifact_id/i,
    /build_run_id/,
    /trusted_build_workflow_sha/,
    /github\.repository|repository\.full_name/,
    /head_sha/,
    /gh attestation verify/,
    /cert-identity/,
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
    /35\.0\.0/,
    /expected_signer_sha256/,
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
    /reviewed_commit_sha/,
    /versionCode/,
    /release create|releases/,
    /release create[\s\S]*Chimera-/,
    /chimera-update\.json/,
    /\.sha256/,
    /chimera-release\.yml/,
  ], 'publication job');
  assert.doesNotMatch(publish, /--clobber|release delete|git push.*--force/i, 'publication must never replace immutable assets');
  assert.match(serialized(workflow), /server_deploy_required/);
  assert.match(serialized(workflow), /server_release_run_id/);
  assert.match(serialized(workflow), /client_release_required/);
  return true;
}

export function validateServerReleaseWorkflow(workflow) {
  assert.ok(workflow?.on?.workflow_dispatch ?? workflow?.true?.workflow_dispatch, 'server release must be workflow_dispatch only');
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'], 'server release must have no automatic trigger');
  assert.equal(workflow.concurrency?.group, 'chimera-production-release', 'server release must share production concurrency');
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'server release must never cancel in progress');
  assertPinned(workflow);

  const build = workflow.jobs?.build;
  assert.ok(build, 'server build job is required');
  assert.deepEqual(build.permissions, { contents: 'read' }, 'server build must be read-only');
  assert.doesNotMatch(serialized(build), /\bsecrets\b|\benvironment\s*:/i, 'server build must be secretless');
  assert.ok(steps(build).some((step) => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ inputs.reviewed_commit_sha }}' && step.with?.['persist-credentials'] === false), 'server build must checkout only the reviewed SHA without credentials');
  const buildRun = runs(build);
  assertContains(buildRun, [
    /reviewed_commit_sha/,
    /pnpm install --frozen-lockfile/,
    /chimera:server:check/,
    /happy-wire.*test/,
    /migration|migrate/i,
    /server-image\.tar/,
    /imageDigest|image-digest|sha256:/,
  ], 'server build');
  assert.ok(steps(build).some((step) => /build-push-action/.test(step.uses ?? '') && step.with?.file === 'Dockerfile.server' && /type=oci/.test(step.with?.outputs ?? '')), 'server build must build Dockerfile.server as OCI');
  const scanner = steps(build).find((step) => /trivy-action/.test(step.uses ?? ''));
  assert.ok(scanner, 'server build must use a pinned image scanner');
  assert.equal(String(scanner.with?.['exit-code']), '1', 'scanner must fail the build at its threshold');
  assert.match(String(scanner.with?.severity), /HIGH/);
  assert.match(String(scanner.with?.severity), /CRITICAL/);
  assert.equal(scanner.with?.['token-setup-trivy'], '', 'candidate scanner must not receive a GitHub token');
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
    /head_sha|reviewed_commit_sha/,
    /trusted_workflow_sha/,
    /github\.run_id|run_id/,
    /gh attestation verify/,
    /cert-identity/,
    /signer-digest/,
    /source-digest/,
    /source-ref/,
    /ghcr\.io\/duojiyi\/chimera-happy-server@\$IMAGE_DIGEST/,
    /skopeo.*copy/is,
    /--preserve-digests/,
  ], 'server publication');
  assert.doesNotMatch(publish, /(?:docker|skopeo).*:(?:latest|main|production)\b/i, 'server publication must not publish mutable tags');

  const deploy = workflow.jobs?.deploy;
  assert.ok(deploy, 'server deployment job is required');
  assert.equal(deploy.environment, 'server-release', 'server deployment must be protected');
  assertNoCheckout(deploy, 'server deployment');
  const deployRun = runs(deploy);
  assertContains(deployRun, [/gh attestation verify/, /security_audit_run_id/, /maintainability_audit_run_id/, /check-runs/, /chimera-audit-security\.yml/, /chimera-audit-maintainability\.yml/, /ssh/, /sha256:/, /running.*digest|deployed.*digest/i], 'server deployment');
  assert.ok(steps(deploy).some((step) => step.uses?.startsWith('docker/login-action@')), 'server deployment must authenticate before OCI attestation verification');
  assert.doesNotMatch(deployRun, /ghcr\.io\/[^\s"']+:(?:latest|main|production)/i, 'deployment must receive only an immutable digest');
  return true;
}

function stringify(value) {
  return JSON.stringify(value);
}

const [releaseSource, serverSource] = await Promise.all([
  readFile(releasePath, 'utf8').catch(() => null),
  readFile(serverPath, 'utf8').catch(() => null),
]);

test('Chimera client release workflow contract', () => {
  assert.ok(releaseSource, `missing ${path.relative(root, releasePath)}`);
  validateClientReleaseWorkflow(parse(releaseSource));
});

test('Chimera server release workflow contract', () => {
  assert.ok(serverSource, `missing ${path.relative(root, serverPath)}`);
  validateServerReleaseWorkflow(parse(serverSource));
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

  test('rejects unpinned scanner actions', () => {
    const workflow = parse(serverSource);
    const scanner = workflow.jobs.build.steps.find((step) => /trivy-action/.test(step.uses ?? ''));
    scanner.uses = 'aquasecurity/trivy-action@master';
    assert.throws(() => validateServerReleaseWorkflow(workflow), /full commit SHA/);
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
}
