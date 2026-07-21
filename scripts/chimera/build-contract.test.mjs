import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/chimera-build.yml');
const maintainabilityWorkflowPath = path.join(root, '.github/workflows/chimera-audit-maintainability.yml');
const serverReleaseWorkflowPath = path.join(root, '.github/workflows/chimera-server-release.yml');
const cliSmokeWorkflowPath = path.join(root, '.github/workflows/cli-smoke-test.yml');
const typecheckWorkflowPath = path.join(root, '.github/workflows/typecheck.yml');
const standaloneDockerfilePath = path.join(root, 'Dockerfile');
const serverDockerfilePath = path.join(root, 'Dockerfile.server');
const serverRuntimeBuildPath = path.join(root, 'packages/happy-server/scripts/build-runtime.cjs');

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
  assert.ok(allSteps(job).some((step) => step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] === false), `${name} checkout must not persist credentials`);
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
  for (const trigger of ['pull_request', 'push']) {
    for (const requiredPath of ['.npmrc', 'pnpm-workspace.yaml', 'patches/**', 'packages/happy-server/**']) {
      assert.ok(triggers?.[trigger]?.paths?.includes(requiredPath), `${trigger} paths must include ${requiredPath}`);
    }
  }

  const jobs = workflow.jobs;
  assert.ok(jobs, 'jobs are required');
  assertBuildJob(jobs.android, 'android', [
    /pnpm\s+(?:chimera:brand:check|run\s+chimera:brand:check)/,
    /pnpm\s+(?:chimera:client:test|run\s+chimera:client:test)/,
    /pnpm\s+(?:chimera:client:check|run\s+chimera:client:check)/,
    /expo\s+prebuild\s+--platform\s+android\s+--clean/,
    /signingConfig null/,
    /gradlew\s+assembleRelease/,
    /(?:apksigner|APKSIGNER)[\s\S]*?verify/i,
    /(?:aapt2|AAPT2)[\s\S]*?dump\s+badging/i,
    /release-input\.json/,
  ], 'chimera-android-unsigned');
  assertBuildJob(jobs.web, 'web', [
    /pnpm\s+(?:chimera:brand:check|run\s+chimera:brand:check)/,
    /pnpm\s+(?:chimera:client:test|run\s+chimera:client:test)/,
    /pnpm\s+(?:chimera:client:check|run\s+chimera:client:check)/,
    /expo\s+export\s+--platform\s+web\s+--output-dir\s+\.\.\/\.\.\/dist\/chimera-web-site/,
    /release-input\.json/,
  ], 'chimera-web-unsigned');

  const androidAssemble = allSteps(jobs.android).find((step) => step.name === 'Assemble unsigned release APK');
  assert.ok(androidAssemble, 'android assemble step is required');
  assert.equal(androidAssemble.env?.GRADLE_OPTS, '-Dorg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8 -Dkotlin.daemon.jvm.options=-Xmx2g', 'android Gradle heap must be bounded at 4 GB');
  assert.equal(androidAssemble.env?.JAVA_TOOL_OPTIONS, '-Xmx4g', 'android Java heap must be bounded at 4 GB');
  assert.match(androidAssemble.run ?? '', /--max-workers=2/, 'android Gradle concurrency must be bounded');

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
  for (const step of allSteps(provenance).filter((item) => item.uses?.startsWith('actions/download-artifact@') && item.with?.['artifact-ids'])) {
    assert.equal(step.with?.['merge-multiple'], true, 'immutable artifact downloads must merge into the declared path');
  }
  assert.match(runText(provenance), /sha256sum|sha256/i, 'provenance must verify artifact digests');
  assert.match(runText(provenance), /find provenance\/android -type f \| wc -l/, 'provenance must reject extra Android files');
  assert.match(runText(provenance), /find provenance\/web -type f \| wc -l/, 'provenance must reject extra Web files');
  const attestations = allSteps(provenance).filter((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(attestations.length, 2, 'provenance must attest APK and Web artifacts separately');
  assert.deepEqual(attestations.map((step) => step.with?.['subject-path']).sort(), [
    'provenance/android/Chimera-unsigned.apk',
    'provenance/web/Chimera-web.tar.gz',
  ], 'attestations must bind the exact files verified above');

  const steps = Object.values(jobs).flatMap(allSteps);
  for (const step of steps) {
    if (step.uses) assert.match(step.uses, PINNED_ACTION, `action must be pinned to a full commit SHA: ${step.uses}`);
  }
  return true;
}

const source = await readFile(workflowPath, 'utf8').catch(() => null);
const maintainabilitySource = await readFile(maintainabilityWorkflowPath, 'utf8').catch(() => null);
const serverReleaseSource = await readFile(serverReleaseWorkflowPath, 'utf8').catch(() => null);
const cliSmokeSource = await readFile(cliSmokeWorkflowPath, 'utf8').catch(() => null);
const typecheckSource = await readFile(typecheckWorkflowPath, 'utf8').catch(() => null);
const standaloneDockerfile = await readFile(standaloneDockerfilePath, 'utf8').catch(() => null);
const serverDockerfile = await readFile(serverDockerfilePath, 'utf8').catch(() => null);
const serverRuntimeBuild = await readFile(serverRuntimeBuildPath, 'utf8').catch(() => null);
if (!source) {
  test('Chimera build workflow contract', () => {
    assert.fail(`missing ${path.relative(root, workflowPath)}`);
  });
} else {
  test('server release build environments pin the required Bun toolchain', () => {
    assert.ok(maintainabilitySource, `missing ${path.relative(root, maintainabilityWorkflowPath)}`);
    assert.ok(serverReleaseSource, `missing ${path.relative(root, serverReleaseWorkflowPath)}`);
    assert.ok(standaloneDockerfile, `missing ${path.relative(root, standaloneDockerfilePath)}`);
    assert.ok(serverDockerfile, `missing ${path.relative(root, serverDockerfilePath)}`);
    assert.ok(serverRuntimeBuild, `missing ${path.relative(root, serverRuntimeBuildPath)}`);
    for (const [name, workflow, job] of [
      ['maintainability audit', parse(maintainabilitySource), 'audit'],
      ['server release', parse(serverReleaseSource), 'build'],
    ]) {
      const setupBun = allSteps(workflow.jobs?.[job]).find((step) => step.name === 'Setup Bun');
      assert.equal(setupBun?.uses, 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', `${name} must pin setup-bun`);
      assert.equal(String(setupBun?.with?.['bun-version']), '1.3.14', `${name} must pin Bun 1.3.14`);
    }
    assert.match(standaloneDockerfile, /^RUN npm install --global bun@1\.3\.14$/m);
    assert.match(serverDockerfile, /^FROM node:22-trixie-slim AS deps$/m, 'server builder must use the supported Node 22 runtime ABI');
    assert.match(serverDockerfile, /^RUN npm install --global bun@1\.3\.14$/m);
    assert.match(standaloneDockerfile, /^COPY packages\/happy-app \.\/packages\/happy-app$/m, 'standalone server builder must include app schema sources');
    assert.match(serverDockerfile, /^COPY packages\/happy-app \.\/packages\/happy-app$/m, 'server builder must include app schema sources');
    assert.match(serverDockerfile, /^COPY packages\/happy-server\/scripts\/generate-prisma-if-available\.cjs packages\/happy-server\/scripts\/$/m, 'server dependency layer must include its lifecycle script');
    const serverBuild = serverDockerfile.indexOf('RUN pnpm --filter happy-server-self-host build');
    const dependencyCleanup = serverDockerfile.indexOf('RUN rm -rf node_modules packages/*/node_modules');
    const productionInstall = serverDockerfile.indexOf('RUN pnpm install --prod --ignore-scripts --frozen-lockfile');
    const productionDeploy = serverDockerfile.indexOf('RUN pnpm --filter happy-server-self-host deploy --prod --ignore-scripts --legacy /tmp/chimera-server');
    assert.ok(serverBuild >= 0 && serverBuild < dependencyCleanup, 'server must build before removing development dependencies');
    assert.ok(dependencyCleanup < productionInstall && productionInstall < productionDeploy, 'server must deploy only pruned production dependencies after cleanup');
    assert.match(serverDockerfile, /COPY --from=builder --chown=65532:65532 \/tmp\/chimera-server\//, 'runtime must copy the pruned pnpm deploy output as the unprivileged runtime user');
    assert.match(serverDockerfile, /^USER 65532:65532$/m, 'runtime must explicitly pin its unprivileged uid and gid');
    assert.match(serverDockerfile, /RUN rm -rf \/tmp\/chimera-server\/node_modules\/prisma[\s\S]*?node_modules\/@prisma\/config[\s\S]*?node_modules\/effect/, 'runtime deploy must remove build-only Prisma CLI dependencies');
    assert.match(serverDockerfile, /^FROM gcr\.io\/distroless\/nodejs22-debian13@sha256:[a-f0-9]{64} AS runner$/m, 'runtime must use a digest-pinned minimal Node image');
    assert.match(serverDockerfile, /CMD \["dist\/standalone\.mjs", "serve"\]/, 'runtime must start the built standalone server directly');
    assert.match(serverRuntimeBuild, /bundledDependencies[\s\S]*?'@prisma\/client'/, 'runtime build must bundle the Prisma CommonJS interop boundary');
    const releaseBuild = parse(serverReleaseSource).jobs?.build;
    const runtimeSmoke = allSteps(releaseBuild).find((step) => step.name === 'Run the exact distroless server archive');
    assert.ok(runtimeSmoke, 'server release must run the exact OCI archive before scanning and attestation');
    for (const pattern of [
      /skopeo copy oci-archive:dist\/server-image\.tar docker-daemon:chimera-server:candidate/,
      /Config\.User\}\}' chimera-server:candidate\)" = 65532:65532/,
      /dist\/standalone\.mjs migrate/,
      /dist\/standalone\.mjs serve/,
      /127\.0\.0\.1:13005\/health/,
      /127\.0\.0\.1:13005\/v1\/chimera\/config/,
      /v1\/account\/profile.*401/,
    ]) assert.match(runtimeSmoke.run ?? '', pattern, `server archive runtime smoke missing ${pattern}`);
    for (const name of ['CHIMERA_ADMIN_SESSION_SECRET', 'CHIMERA_INVITATION_PEPPER', 'CHIMERA_ACCOUNT_PSEUDONYM_KEY', 'CHIMERA_UPDATE_PUBLIC_KEY']) {
      const value = (runtimeSmoke.run ?? '').match(new RegExp(`--env ${name}=([A-Za-z0-9_-]+)`))?.[1];
      assert.ok(value, `server archive runtime smoke missing ${name}`);
      const decoded = Buffer.from(value, 'base64url');
      assert.equal(decoded.length, 32, `${name} smoke fixture must decode to 32 bytes`);
      assert.equal(decoded.toString('base64url'), value, `${name} smoke fixture must be canonical base64url`);
    }
  });

  test('release toolchain changes trigger client evidence and manual typecheck remains available', () => {
    const workflow = parse(source);
    const triggers = workflow.on ?? workflow.true;
    for (const trigger of ['pull_request', 'push']) {
      for (const requiredPath of [
        'packages/happy-server/**',
        '.github/workflows/chimera-audit-maintainability.yml',
        '.github/workflows/chimera-server-release.yml',
        'Dockerfile',
        'Dockerfile.server',
      ]) assert.ok(triggers?.[trigger]?.paths?.includes(requiredPath), `${trigger} paths must include ${requiredPath}`);
    }
    assert.ok(typecheckSource, `missing ${path.relative(root, typecheckWorkflowPath)}`);
    const typecheck = parse(typecheckSource);
    assert.ok((typecheck.on ?? typecheck.true)?.workflow_dispatch !== undefined, 'typecheck manual dispatch is required');
    const typecheckTriggers = typecheck.on ?? typecheck.true;
    for (const trigger of ['pull_request', 'push']) {
      for (const requiredPath of ['Dockerfile', 'Dockerfile.server', 'scripts/chimera/**', '.github/workflows/chimera-*.yml']) {
        assert.ok(typecheckTriggers?.[trigger]?.paths?.includes(requiredPath), `typecheck ${trigger} paths must include ${requiredPath}`);
      }
    }
    assert.ok(cliSmokeSource, `missing ${path.relative(root, cliSmokeWorkflowPath)}`);
    const cliSmoke = parse(cliSmokeSource);
    const cliTriggers = cliSmoke.on ?? cliSmoke.true;
    for (const trigger of ['pull_request', 'push']) {
      for (const requiredPath of [
        '.github/workflows/chimera-audit-maintainability.yml',
        '.github/workflows/chimera-server-release.yml',
        'Dockerfile',
        'Dockerfile.server',
      ]) assert.ok(cliTriggers?.[trigger]?.paths?.includes(requiredPath), `CLI ${trigger} paths must include ${requiredPath}`);
    }
  });

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

  test('contract rejects a broader attestation glob', () => {
    const workflow = parse(source);
    const step = workflow.jobs.provenance.steps.find((item) => item.with?.['subject-path'] === 'provenance/android/Chimera-unsigned.apk');
    step.with['subject-path'] = 'provenance/android/**/*.apk';
    assert.throws(() => validateBuildWorkflow(workflow), /exact files verified/);
  });

  test('contract rejects persisted checkout credentials', () => {
    const workflow = parse(source);
    const checkout = workflow.jobs.web.steps.find((item) => item.uses?.startsWith('actions/checkout@'));
    checkout.with['persist-credentials'] = true;
    assert.throws(() => validateBuildWorkflow(workflow), /checkout must not persist credentials/);
  });

  test('contract rejects missing dependency path inputs', () => {
    const workflow = parse(source);
    workflow.on.push.paths = workflow.on.push.paths.filter((item) => item !== 'patches/**');
    assert.throws(() => validateBuildWorkflow(workflow), /push paths must include patches/);
  });

  test('contract rejects a package-relative Web output directory', () => {
    const workflow = parse(source);
    const exportStep = workflow.jobs.web.steps.find((item) => item.run?.includes('expo export'));
    exportStep.run = exportStep.run.replace('../../dist/chimera-web-site', 'dist/chimera-web-site');
    assert.throws(() => validateBuildWorkflow(workflow), /web missing/);
  });
}
