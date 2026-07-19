import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/chimera-build.yml');

const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;

function stringify(value) {
  return JSON.stringify(value);
}

function allSteps(job) {
  return (job?.steps ?? []).filter((step) => step && typeof step === 'object');
}

function runText(job) {
  return allSteps(job).map((step) => step.run ?? '').join('\n');
}

function assertNoCandidateCredentials(job, name) {
  const serialized = stringify(job);
  assert.doesNotMatch(serialized, /\bsecrets\b/i, `${name} must not reference secrets`);
  assert.doesNotMatch(serialized, /\benvironment\s*:/i, `${name} must not use a protected environment`);
}

function assertBuildJob(job, name, requiredCommands, artifactName) {
  assert.ok(job, `${name} job is required`);
  assert.deepEqual(job.permissions, { contents: 'read' }, `${name} permissions must be read-only`);
  assertNoCandidateCredentials(job, name);
  assert.ok(allSteps(job).some((step) => step.uses?.startsWith('actions/checkout@')), `${name} must checkout candidate source`);
  assert.ok(allSteps(job).some((step) => step.uses?.startsWith('pnpm/action-setup@') && step.with?.version === '10.11.0'), `${name} must pin pnpm 10.11.0`);
  assert.ok(allSteps(job).some((step) => step.uses?.startsWith('actions/setup-node@') && String(step.with?.['node-version']) === '22'), `${name} must use Node 22`);
  const text = runText(job);
  for (const command of requiredCommands) assert.match(text, command, `${name} missing ${command}`);
  assert.ok(allSteps(job).some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === artifactName), `${name} must upload ${artifactName}`);
}

export function validateBuildWorkflow(workflow) {
  assert.ok(workflow && typeof workflow === 'object', 'workflow must be an object');
  const triggers = workflow.on ?? workflow.true;
  assert.ok(triggers?.pull_request, 'pull_request trigger is required');
  assert.ok(triggers?.push?.branches?.includes('main'), 'main push trigger is required');
  assert.ok(triggers?.workflow_dispatch !== undefined, 'manual dispatch trigger is required');

  const jobs = workflow.jobs;
  assert.ok(jobs, 'jobs are required');
  assertBuildJob(jobs.android, 'android', [
    /pnpm\s+(?:chimera:brand:check|run\s+chimera:brand:check)/,
    /pnpm\s+(?:chimera:client:test|run\s+chimera:client:test)/,
    /pnpm\s+(?:chimera:client:check|run\s+chimera:client:check)/,
    /expo\s+prebuild\s+--platform\s+android\s+--clean/,
    /gradlew\s+assembleRelease/,
    /(?:apksigner|APKSIGNER)[\s\S]*?verify/i,
    /(?:aapt2|AAPT2)[\s\S]*?dump\s+badging/i,
    /release-input\.json/,
  ], 'chimera-android-unsigned');
  assertBuildJob(jobs.web, 'web', [
    /pnpm\s+(?:chimera:brand:check|run\s+chimera:brand:check)/,
    /pnpm\s+(?:chimera:client:test|run\s+chimera:client:test)/,
    /pnpm\s+(?:chimera:client:check|run\s+chimera:client:check)/,
    /expo\s+export\s+--platform\s+web/,
    /release-input\.json/,
  ], 'chimera-web-unsigned');

  const provenance = jobs.provenance;
  assert.ok(provenance, 'provenance job is required');
  assert.deepEqual(provenance.permissions, {
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  }, 'provenance permissions must be minimal and attestation-only');
  assert.deepEqual(provenance.needs?.slice?.().sort(), ['android', 'web'], 'provenance must wait for both builds');
  assert.equal(allSteps(provenance).some((step) => step.uses?.startsWith('actions/checkout@')), false, 'provenance must not checkout candidate source');
  assert.doesNotMatch(runText(provenance), /pnpm\s+install|npm\s+install|node\s+scripts\//, 'provenance must not execute candidate code');
  assert.ok(allSteps(provenance).some((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.['artifact-ids']), 'provenance must download immutable build artifacts');
  assert.match(runText(provenance), /sha256sum|sha256/i, 'provenance must verify artifact digests');
  const attestations = allSteps(provenance).filter((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(attestations.length, 2, 'provenance must attest APK and Web artifacts separately');
  for (const step of attestations) assert.ok(step.with?.['subject-path'], 'attestation must bind a subject path');

  const steps = Object.values(jobs).flatMap(allSteps);
  for (const step of steps) {
    if (step.uses) assert.match(step.uses, PINNED_ACTION, `action must be pinned to a full commit SHA: ${step.uses}`);
  }
  return true;
}

const source = await readFile(workflowPath, 'utf8').catch(() => null);
if (!source) {
  test('Chimera build workflow contract', () => {
    assert.fail(`missing ${path.relative(root, workflowPath)}`);
  });
} else {
  test('Chimera build workflow satisfies secretless artifact contract', () => {
    validateBuildWorkflow(parse(source));
  });

  test('contract rejects an unpinned action', () => {
    const workflow = parse(source);
    workflow.jobs.android.steps.push({ uses: 'actions/checkout@v4' });
    assert.throws(() => validateBuildWorkflow(workflow), /full commit SHA/);
  });

  test('contract rejects candidate secrets', () => {
    const workflow = parse(source);
    workflow.jobs.web.env = { RELEASE_KEY: '${{ secrets.RELEASE_KEY }}' };
    assert.throws(() => validateBuildWorkflow(workflow), /must not reference secrets/);
  });

  test('contract rejects a provenance checkout', () => {
    const workflow = parse(source);
    workflow.jobs.provenance.steps.unshift({ uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683' });
    assert.throws(() => validateBuildWorkflow(workflow), /must not checkout/);
  });

  test('contract rejects missing Android policy gate', () => {
    const workflow = parse(source);
    const step = workflow.jobs.android.steps.find((item) => item.run?.includes('chimera:client:check'));
    step.run = step.run.replace(/pnpm\s+(?:chimera:client:check|run\s+chimera:client:check)/, 'echo skipped');
    assert.throws(() => validateBuildWorkflow(workflow), /android missing/);
  });
}
