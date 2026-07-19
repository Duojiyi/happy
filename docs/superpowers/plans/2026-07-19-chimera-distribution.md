# Chimera Android And Web Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce immutable, production-signed Chimera APK releases and atomically deployed web releases, with a signed same-origin Android update chain and no build-time secret exposure to repository code.

**Architecture:** Build unsigned APK/web artifacts in secretless jobs, bind them to commit/version provenance, then sign the APK and update manifest in a no-checkout protected job. Publish immutable GitHub assets and activate server mirrors/static web only after byte/package/version/signer and health validation.

**Tech Stack:** GitHub Actions, pnpm 10, Node 22, Expo prebuild/export, Gradle/Android SDK, `apksigner`, Ed25519, SHA-256, Nginx static releases.

---

## File Map

- `brand/chimera/product.json`: unique version/versionCode source.
- `scripts/chimera/resolve-release.mjs`: version/tag/commit/idempotency resolver.
- `scripts/chimera/bump-release.mjs`: reviewed revision/versionCode advancement.
- `scripts/chimera/inspect-apk.mjs`: package/version/signer inspection wrapper.
- `packages/happy-app/plugins/withChimeraUpdater.js`: FileProvider/install capability.
- `packages/happy-app/sources/chimera/updateManifest.ts`: canonical signed manifest schema.
- `packages/happy-app/sources/chimera/androidUpdater.ts`: verified update state machine.
- `packages/happy-app/modules/chimera-updater/`: local Expo APK inspection/install module.
- `.github/workflows/chimera-build.yml`: secretless PR/main build.
- `.github/workflows/chimera-release.yml`: protected signing/publication/deploy orchestration.
- `.github/workflows/chimera-server-release.yml`: attested OCI build/publication/deploy.
- `scripts/chimera/activate-android-release.ps1`: atomic mirror activation client.
- `scripts/chimera/activate-web-release.ps1`: atomic web activation client.

### Task 0: Bootstrap One Signing Identity Source

**Files:**
- Create: `scripts/chimera/bootstrap-signing-identities.ps1`
- Create: `scripts/chimera/test-bootstrap-signing-identities.ps1`
- Create: `brand/chimera/product.json`

- [ ] **Step 1: Write idempotency and public-metadata tests**

Use temporary keystores and backup directories. Assert one invocation creates a
4096-bit RSA Android signing key and Ed25519 manifest key, writes only the Ed25519
public key and uppercase colon-free certificate SHA-256 into exact product JSON
fields, sets restrictive ACLs on the encrypted private bundle, and prints no
secret. A second invocation must refuse to rotate identities unless an explicit
offline recovery/rotation mode is used. Reject mismatched existing public values.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File scripts/chimera/test-bootstrap-signing-identities.ps1`

Expected: FAIL because the bootstrap script does not exist.

- [ ] **Step 3: Implement the one-time bootstrap**

Accept store/key passwords through `SecureString` or protected input files, never
arguments. Generate the JKS and manifest keypair once, derive public metadata with
`keytool` and a pinned Ed25519 tool, atomically update `product.json`, and place the
encrypted private material in the user-selected restricted off-repository backup.
Emit a machine-readable inventory containing paths and public fingerprints only.
This is the sole task allowed to create update/signing identities.

- [ ] **Step 4: Run tests and commit public tooling/metadata**

Run: `pwsh -NoProfile -File scripts/chimera/test-bootstrap-signing-identities.ps1`

Expected: PASS; the real bootstrap run creates the complete product metadata source
with only public identity values in Git. Client Task 1 subsequently creates the
generator and verifies those values.

```bash
git add scripts/chimera/bootstrap-signing-identities.ps1 scripts/chimera/test-bootstrap-signing-identities.ps1 brand/chimera/product.json
git commit -m "build: bootstrap Chimera signing identities"
```

### Task 1: Make Release Version Resolution Deterministic

**Files:**
- Create: `scripts/chimera/resolve-release.mjs`
- Create: `scripts/chimera/resolve-release.test.mjs`
- Create: `scripts/chimera/bump-release.mjs`
- Modify: `scripts/generate-chimera-brand.mjs`
- Modify: `packages/happy-app/app.config.js`

- [ ] **Step 1: Write release resolver tests**

Cover first release, revision increment, upstream Expo version advance, package
version disagreement, occupied tag, duplicate commit, regressing/equal
versionCode, concurrent reservation response, invalid product JSON, app-relevant
path change, server-only path change, and combined protocol/client change.

Expected output contract:

```json
{
  "versionName": "1.7.0-chimera.1",
  "versionCode": 1,
  "tag": "app-v1.7.0-chimera.1",
  "commitSha": "40-hex-sha",
  "artifactBase": "Chimera-1.7.0-chimera.1-android-universal"
}
```

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/chimera/resolve-release.test.mjs`

Expected: FAIL because resolver does not exist.

- [ ] **Step 3: Implement exact-source resolver**

Read `brand/chimera/product.json`, parse `app.config.js` production config, query
GitHub releases/tags through injected adapters, and fail if generated Expo
version/versionCode differs. Expose pure `resolveRelease(input)` plus CLI JSON
output. Never mutate product metadata in a release job.

Classify changed paths against the last accepted release. Server-only changes
produce `clientReleaseRequired: false`; app/brand/native/shared-wire changes
produce `true`. Combined server/protocol/client changes set
`serverDeployBeforeClient: true`.

Implement `bump-release.mjs` as the only mutator: it accepts the reviewed
upstream Expo version and current product JSON, sets revision 1 when the upstream
version advances or increments the existing revision otherwise, always increments
`androidVersionCode` exactly once, writes atomically, then runs brand generation.

- [ ] **Step 4: Generate Expo version fields and verify**

Make brand generation emit `VERSION_NAME` and `ANDROID_VERSION_CODE`; app config
must consume them. Run: `node scripts/generate-chimera-brand.mjs --check && node scripts/chimera/resolve-release.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/chimera/resolve-release.mjs scripts/chimera/resolve-release.test.mjs scripts/chimera/bump-release.mjs scripts/generate-chimera-brand.mjs packages/happy-app/app.config.js brand/chimera/product.json
git commit -m "feat(release): resolve immutable Chimera versions"
```

### Task 2: Add The Protected Android Installer Module

**Files:**
- Create: `packages/happy-app/plugins/withChimeraUpdater.js`
- Create: `packages/happy-app/plugins/withChimeraUpdater.test.mjs`
- Create: `packages/happy-app/modules/chimera-updater/index.ts`
- Create: `packages/happy-app/modules/chimera-updater/expo-module.config.json`
- Create: `packages/happy-app/modules/chimera-updater/android/build.gradle`
- Create: `packages/happy-app/modules/chimera-updater/android/src/main/AndroidManifest.xml`
- Create: `packages/happy-app/modules/chimera-updater/android/src/main/java/org/chimerahub/chimera/updater/ChimeraUpdaterModule.kt`
- Create: `packages/happy-app/modules/chimera-updater/android/src/main/res/xml/chimera_update_paths.xml`
- Modify: `packages/happy-app/app.config.js`

- [ ] **Step 1: Write config-plugin mutation tests**

Apply the plugin to manifest fixtures and assert exactly one
`REQUEST_INSTALL_PACKAGES`, one non-exported FileProvider, authority
`${applicationId}.chimera.updates`, narrow cache-path XML, temporary URI grants,
and no broad external-storage path. Reapplying must be idempotent.

- [ ] **Step 2: Run and verify failure**

Run: `node --test packages/happy-app/plugins/withChimeraUpdater.test.mjs`

Expected: FAIL because plugin/module files are absent.

- [ ] **Step 3: Implement native archive inspection API**

```ts
export interface InspectedApk {
    packageName: string;
    versionCode: number;
    versionName: string;
    signerSha256: string;
}

export interface ChimeraUpdaterNative {
    inspectApk(fileUri: string): Promise<InspectedApk>;
    canRequestPackageInstalls(): Promise<boolean>;
    openInstallPermissionSettings(): Promise<void>;
    launchInstaller(fileUri: string): Promise<void>;
}
```

Kotlin uses `PackageManager.getPackageArchiveInfo(...GET_SIGNING_CERTIFICATES)`,
SHA-256 of the signer certificate, FileProvider content URI, and one-time read
grant. Reject non-file cache URIs and never expose the provider.

- [ ] **Step 4: Implement idempotent config plugin**

Register manifest entries and copy native source/XML during prebuild. Use
generated application ID; do not hard-code a Happy package. Add plugin to Expo
config only for Android.

- [ ] **Step 5: Prebuild and inspect generated manifest**

Run: `pnpm --filter happy-app exec expo prebuild --platform android --clean && node --test packages/happy-app/plugins/withChimeraUpdater.test.mjs`

Expected: prebuild succeeds and tests PASS. Inspect generated manifest with:
`rg -n "REQUEST_INSTALL_PACKAGES|chimera.updates|FileProvider" packages/happy-app/android/app/src/main/AndroidManifest.xml`.

- [ ] **Step 6: Commit source/plugin, not generated Android tree**

```bash
git add packages/happy-app/plugins/withChimeraUpdater.js packages/happy-app/plugins/withChimeraUpdater.test.mjs packages/happy-app/modules/chimera-updater packages/happy-app/app.config.js
git commit -m "feat(android): add verified APK installer bridge"
```

### Task 3: Define And Verify Signed Update Manifests

**Files:**
- Create: `packages/happy-app/sources/chimera/updateManifest.ts`
- Create: `packages/happy-app/sources/chimera/updateManifest.test.ts`
- Create: `scripts/chimera/sign-update-manifest.mjs`
- Create: `scripts/chimera/sign-update-manifest.test.mjs`

- [ ] **Step 1: Write canonicalization/signature tests**

Test stable key order/UTF-8 bytes, valid Ed25519 signature, changed byte failure,
unknown field failure, wrong package, non-increasing version, non-same-origin or
mutable path, malformed hash/fingerprint, and expiry/commit mismatch.

```ts
export interface AndroidUpdatePayload {
    schemaVersion: 1;
    packageName: 'org.chimerahub.chimera';
    versionName: string;
    versionCode: number;
    apkPath: `/downloads/chimera-${string}.apk`;
    size: number;
    sha256: string;
    signerSha256: string;
    commitSha: string;
    publishedAt: string;
}
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/updateManifest.test.ts && node scripts/chimera/sign-update-manifest.test.mjs`

Expected: FAIL because manifest modules are absent.

- [ ] **Step 3: Implement one canonical JSON algorithm**

Use recursively sorted object keys, no insignificant whitespace, UTF-8, and
base64url Ed25519 signatures. The client receives `{ payload, signature }`,
validates strict schema first, canonicalizes payload, then verifies with pinned
generated public key.

- [ ] **Step 4: Implement CLI signing helper with stdin/files only**

The helper accepts payload path, PKCS#8 private key path, and output path. It
prints only output digest/size. It has no network access and never prints key
material. Self-test uses disposable fixture keys.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/updateManifest.test.ts && node scripts/chimera/sign-update-manifest.test.mjs`

Expected: PASS.

```bash
git add packages/happy-app/sources/chimera/updateManifest.ts packages/happy-app/sources/chimera/updateManifest.test.ts scripts/chimera/sign-update-manifest.mjs scripts/chimera/sign-update-manifest.test.mjs
git commit -m "feat(update): verify signed Android manifests"
```

### Task 4: Implement The Android Update State Machine

**Files:**
- Create: `packages/happy-app/sources/chimera/androidUpdater.ts`
- Create: `packages/happy-app/sources/chimera/androidUpdater.test.ts`
- Create: `packages/happy-app/sources/chimera/useAndroidUpdater.ts`
- Modify: `packages/happy-app/sources/app/_layout.tsx`

- [ ] **Step 1: Write state-machine tests**

Cover web/no-op, same/older version, valid newer manifest, signature failure,
path failure, download timeout, size/hash mismatch, archive package/version/signer
mismatch, permission not granted, permission grant return, announcement-active
sequencing, one active download, retry on later start, and partial cleanup.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/androidUpdater.test.ts`

Expected: FAIL because updater does not exist.

- [ ] **Step 3: Implement injectable updater phases**

```ts
export type AndroidUpdateState =
    | { phase: 'idle' }
    | { phase: 'downloading'; versionCode: number }
    | { phase: 'waiting-for-announcement'; fileUri: string }
    | { phase: 'waiting-for-permission'; fileUri: string }
    | { phase: 'launching-installer'; fileUri: string }
    | { phase: 'failed'; retryOnNextStart: true };
```

Fetch only the fixed manifest path, verify signature before download, stream to a
`.partial` app-cache file, check bytes/hash, rename, inspect native metadata, then
wait for announcement dismissal before permission/installer. Never downgrade or
loop retries in one run.

- [ ] **Step 4: Mount hook after announcement orchestration**

Expose announcement-dismissed state from the startup hook and pass it to Android
updater. Web returns immediately. Errors are locally logged without a custom
update modal.

- [ ] **Step 5: Run tests/typecheck and commit**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/androidUpdater.test.ts && pnpm --filter happy-app typecheck`

Expected: PASS.

```bash
git add packages/happy-app/sources/chimera/androidUpdater.ts packages/happy-app/sources/chimera/androidUpdater.test.ts packages/happy-app/sources/chimera/useAndroidUpdater.ts packages/happy-app/sources/app/_layout.tsx
git commit -m "feat(android): add verified background updates"
```

### Task 5: Build Unsigned APK And Web Artifacts Without Secrets

**Files:**
- Create: `.github/workflows/chimera-build.yml`
- Create: `scripts/chimera/build-contract.test.mjs`
- Modify: `packages/happy-app/plugins/withChimeraUpdater.js`

- [ ] **Step 1: Write workflow contract tests**

Parse workflow YAML and assert pinned action SHAs, Node 22, pnpm 10.11.0,
build-job `permissions: contents: read`, no secret/environment references, full
policy gates, web export, Android clean prebuild, release assemble, artifact
digest metadata, and separate artifact names. Require a separate provenance job
that never executes candidate repository code, has only `contents: read`,
`id-token: write`, and `attestations: write`, downloads the completed APK/Web
artifacts by immutable run/artifact ID, verifies their recorded digests, and uses
a full-commit-SHA-pinned official GitHub artifact-attestation action. Mutation
fixtures must fail each contract.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/chimera/build-contract.test.mjs`

Expected: FAIL because workflow is absent.

- [ ] **Step 3: Ensure release Gradle output is unsigned**

Implement the updater as a standard local Expo module discovered through
`expo-module.config.json`; do not copy Kotlin sources into generated Android
directories. Extend the config plugin so release build has no signingConfig. Add a post-build
check using `apksigner verify` that must fail with “DOES NOT VERIFY” for the
candidate while `aapt2 dump badging` reports the expected package/version.

- [ ] **Step 4: Add secretless build jobs**

Both build jobs checkout candidate, install with frozen lockfile, run brand/client
gates, and build. Android uses `expo prebuild --platform android --clean` then
`./gradlew assembleRelease`; web uses `expo export --platform web`. Emit a small
`release-input.json` containing commit, version, unsigned SHA-256, expected
package, and build run ID. Upload with pinned artifact action.

Set up Temurin JDK 17 and pinned Android command-line/build tools before prebuild/
Gradle. After both build jobs succeed, the provenance job downloads artifacts
without checking out the repository, verifies `release-input.json` against the
workflow event SHA and artifact bytes, then emits GitHub artifact attestations
for the unsigned APK and immutable Web archive digests.

- [ ] **Step 5: Run local contracts and representative builds**

Run: `node scripts/chimera/build-contract.test.mjs && pnpm --filter happy-app exec expo export --platform web && pnpm --filter happy-app exec expo prebuild --platform android --clean`

Expected: contract PASS; web export/prebuild complete. Gradle release build is
verified on Linux CI if unavailable locally.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/chimera-build.yml scripts/chimera/build-contract.test.mjs packages/happy-app/plugins/withChimeraUpdater.js
git commit -m "ci: build secretless Chimera artifacts"
```

### Task 6: Isolate APK Signing And Manifest Signing

**Files:**
- Create: `.github/workflows/chimera-release.yml`
- Create: `.github/workflows/chimera-server-release.yml`
- Create: `scripts/chimera/release-contract.test.mjs`

- [ ] **Step 1: Write signing-job contract tests**

Require protected `android-signing` Environment, no repository checkout, only
downloaded GitHub-attested artifacts whose subject digest, workflow identity,
trusted workflow SHA, run ID, repository, and head SHA are verified, fixed Android
build-tools version, expected public
fingerprint input, base64 keystore secret, manifest private key secret, pre-sign
unsigned/package/version checks, post-sign fingerprint checks, artifact digest
binding, no repository script execution, and minimal permissions.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/chimera/release-contract.test.mjs`

Expected: FAIL because release workflow is absent.

- [ ] **Step 3: Add protected signing job**

The workflow downloads the unsigned APK and `release-input.json`, verifies GitHub
artifact attestations and two trusted independent audit check run IDs, decodes secrets into
runner temp with mode 600, verifies unsigned metadata, runs pinned `apksigner`,
verifies signer/package/version, builds canonical manifest using inline trusted
workflow code, signs with Ed25519, then securely deletes temp key files.

- [ ] **Step 4: Add release concurrency/idempotency gate**

Use repository-wide `concurrency: chimera-production-release` with no cancellation.
Before signing and before publication, query tag/release/versionCode. Existing
identical release is a no-op; occupied metadata with different bytes is failure.

- [ ] **Step 5: Add dedicated attested server image release workflow**

Create `.github/workflows/chimera-server-release.yml`, triggered only by an
explicit dispatch for the reviewed full commit SHA. Its secretless/read-only build
job checks out that SHA, builds the server Dockerfile, runs migration, server,
protocol, and security tests, scans the image with a full-SHA-pinned scanner under
a checked-in fail threshold, and generates SPDX SBOM plus image digest. A separate
provenance job executes no candidate code and has only `contents: read`,
`id-token: write`, and `attestations: write`; it downloads by immutable artifact
ID and uses a pinned official action to attest the OCI digest and SBOM.

A no-checkout publication job verifies repository, head SHA, trusted workflow SHA,
run ID, subject digest, and attestation signer before publishing that exact image
as immutable `ghcr.io/duojiyi/chimera-happy-server@sha256:<digest>`. The protected
`server-release` deployment job re-verifies the attestation and two trusted audit
check runs online, then passes only the digest (never a mutable tag) to the server
deployment identity. It confirms the running container digest afterward. Client
release waits for this deployment when the reviewed change touches server, Prisma,
wire/protocol, Dockerfile, or Chimera server modules. A server-only change stops
after verified deployment and creates no APK/Web release.

- [ ] **Step 6: Run contract tests and commit**

Run: `node scripts/chimera/release-contract.test.mjs`

Expected: PASS.

```bash
git add .github/workflows/chimera-release.yml .github/workflows/chimera-server-release.yml scripts/chimera/release-contract.test.mjs
git commit -m "ci: isolate Chimera APK signing"
```

### Task 7: Publish Immutable GitHub Releases

**Files:**
- Modify: `.github/workflows/chimera-release.yml`
- Create: `scripts/chimera/release-manifest.test.mjs`

- [ ] **Step 1: Add immutable release fixture tests**

Test new release, exact rerun no-op, missing asset failure, duplicate asset
failure, digest/size mismatch failure, tag target mismatch, and anonymous asset
range download smoke.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/chimera/release-manifest.test.mjs`

Expected: FAIL until publication contract is implemented.

- [ ] **Step 3: Add no-checkout publication job**

Download signed APK/manifest/attestation, verify digests, create immutable tag at
reviewed commit, create Release, upload versioned APK, `.sha256`, signed manifest,
and attestation. Never delete/replace an existing differing asset.

- [ ] **Step 4: Add anonymous release smoke test**

After publication, fetch Release API asset metadata, compare digest/size, download
manifest and first APK range without auth, and verify tag target.

- [ ] **Step 5: Run tests and commit**

Run: `node scripts/chimera/release-manifest.test.mjs && node scripts/chimera/release-contract.test.mjs`

Expected: PASS.

```bash
git add .github/workflows/chimera-release.yml scripts/chimera/release-manifest.test.mjs
git commit -m "ci: publish immutable Chimera APK releases"
```

### Task 8: Activate APK Mirror And Web Atomically

**Files:**
- Create: `scripts/chimera/activate-android-release.ps1`
- Create: `scripts/chimera/test-activate-android-release.ps1`
- Create: `scripts/chimera/activate-web-release.ps1`
- Create: `scripts/chimera/test-activate-web-release.ps1`
- Modify: `.github/workflows/chimera-release.yml`

- [ ] **Step 1: Write filesystem fixture tests**

Android fixtures test partial upload, server validation failure, atomic immutable
rename, manifest-last activation, old manifest preservation, and previous retention.
Web fixtures test version directory validation, current symlink switch, root/asset
health failure rollback, active/previous retention, and traversal rejection.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File scripts/chimera/test-activate-android-release.ps1; pwsh -NoProfile -File scripts/chimera/test-activate-web-release.ps1`

Expected: FAIL because activation scripts do not exist.

- [ ] **Step 3: Implement restricted activation clients**

Scripts accept explicit local artifact/manifest/host inputs, upload only to the
matching Android or Web role's isolated staging names, invoke that SSH identity's
forced helper command with safe IDs only, and poll
HTTPS health. They never interpolate arbitrary remote shell fragments.

- [ ] **Step 4: Add deploy jobs with isolated credentials**

`android-mirror` and `web-production` Environments use separate restricted SSH
keys. Jobs do not checkout source; they download validated artifacts and trusted
activation tools packaged from protected workflow inputs. APK activates before
manifest; web activates after root/asset preflight. Failures retain old state.

- [ ] **Step 5: Run fixture/contract tests**

Run: `pwsh -NoProfile -File scripts/chimera/test-activate-android-release.ps1; pwsh -NoProfile -File scripts/chimera/test-activate-web-release.ps1; node scripts/chimera/release-contract.test.mjs`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/chimera/activate-android-release.ps1 scripts/chimera/test-activate-android-release.ps1 scripts/chimera/activate-web-release.ps1 scripts/chimera/test-activate-web-release.ps1 .github/workflows/chimera-release.yml
git commit -m "ci: deploy Chimera APK and web atomically"
```

### Task 9: Configure Protected GitHub Release Environments

**Files:**
- Create: `scripts/chimera/configure-release-environments.ps1`
- Create: `scripts/chimera/test-release-environments.ps1`

- [ ] **Step 1: Write repository-configuration contract tests**

Require environments `android-signing`, `server-release`, `android-mirror`, and
`web-production`; required reviewer `Duojiyi`; branch/tag restrictions; expected
secret names; production workflow required checks; and merge method policy that
keeps merge commits and disables squash for sync PRs. Tests use mocked `gh api`
responses and never read secret values.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File scripts/chimera/test-release-environments.ps1`

Expected: FAIL because configuration tooling does not exist.

- [ ] **Step 3: Import bootstrapped signing identities without logging secrets**

Read the encrypted JKS, Ed25519 private key, passwords, and public inventory created
by Task 0 through protected files/secure input. Re-derive the signer fingerprint
and manifest public key and require byte-for-byte equality with product JSON and
generated client metadata before uploading secrets. Never create or rotate keys in
this environment-configuration task.

Generate three independent Ed25519 SSH keypairs for `server-release`,
`android-mirror`, and `web-production`. Install them for three distinct locked OS
users, each with a forced command and isolated non-writable-by-peers staging root.
Their private keys are uploaded only to the matching Environment. Never authorize
more than one key or deployment capability for an OS user.

- [ ] **Step 4: Configure environments and secrets**

Use `gh api` for environments/protection rules and `gh secret set --env` for:

```text
android-signing: CHIMERA_ANDROID_KEYSTORE_B64, CHIMERA_ANDROID_STORE_PASSWORD,
CHIMERA_ANDROID_KEY_ALIAS, CHIMERA_ANDROID_KEY_PASSWORD,
CHIMERA_ANDROID_SIGNER_SHA256, CHIMERA_UPDATE_PRIVATE_KEY_PEM
server-release: CHIMERA_SERVER_DEPLOY_KEY, CHIMERA_DEPLOY_HOST,
CHIMERA_SERVER_DEPLOY_USER
android-mirror: CHIMERA_ANDROID_DEPLOY_KEY, CHIMERA_DEPLOY_HOST,
CHIMERA_ANDROID_DEPLOY_USER
web-production: CHIMERA_WEB_DEPLOY_KEY, CHIMERA_DEPLOY_HOST,
CHIMERA_WEB_DEPLOY_USER
```

The script accepts secret values through secure process input/files, never CLI
arguments, and deletes temporary plaintext after successful upload.

- [ ] **Step 5: Verify configuration and commit tooling**

Run: `pwsh -NoProfile -File scripts/chimera/test-release-environments.ps1; pwsh -NoProfile -File scripts/chimera/configure-release-environments.ps1 -VerifyOnly`

Expected: tests PASS and live verification lists required names/rules without values.

```bash
git add scripts/chimera/configure-release-environments.ps1 scripts/chimera/test-release-environments.ps1
git commit -m "ops: configure protected Chimera releases"
```

### Task 10: Run Distribution Gate And Dry Release

**Files:**
- Create: `scripts/chimera/verify-distribution.ps1`
- Modify: `package.json`

- [ ] **Step 1: Add aggregate gate**

Run all brand/config/client/server/workflow/plugin/manifest/activation tests, app
and server typechecks, web export, and unsigned APK metadata checks. Produce a
sanitized summary with commit/version/digests only.

- [ ] **Step 2: Run local aggregate verification**

Run: `pwsh -NoProfile -File scripts/chimera/verify-distribution.ps1`

Expected: PASS; no production secret required.

- [ ] **Step 3: Push a non-production dry-run branch and dispatch build**

Run: `gh workflow run chimera-build.yml --ref codex/chimera-release-dry-run` after pushing the
reviewed branch. Expected: web and unsigned APK artifacts complete with matching
release-input provenance; no signing/deploy jobs run.

- [ ] **Step 4: Commit**

```bash
git add scripts/chimera/verify-distribution.ps1 package.json
git commit -m "test(release): gate Chimera distribution"
```
