# Chimera Infrastructure And Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and deploy backup server A as the Chimera relay/web host, maintain trusted public-IP HTTPS and consistent rollback, and operate a fail-closed six-hour upstream synchronization workflow with independent audits for executable changes.

**Architecture:** Keep public ingress in Nginx, bind the standalone relay only to loopback, and deploy versioned web/APK/server releases through restricted helpers. Prepare upstream merges in isolated worktrees, protect Chimera policy/workflows, preserve upstream Git ancestry, and separate read-only preparation from write-capable PR/dispatch jobs.

**Tech Stack:** Ubuntu 22.04, Docker Compose, Nginx, Certbot 5.4+, systemd, UFW/DOCKER-USER, Git/GitHub Actions, PowerShell/Bash, pnpm.

---

## Cross-Plan Execution Order

The four plans are one dependency graph and must not be executed independently in
document order. Use this exact sequence:

1. Distribution Task 0 bootstraps the sole signing identity source and commits
   only public metadata.
2. Complete all Client tasks, then all Server tasks; both consume that metadata.
3. Complete Distribution Tasks 1-7 as workflow/tooling implementation only; do
   not dispatch a production release yet.
4. Complete Infrastructure Tasks 1-4 to create/test host policy and three isolated
   deployment helpers without touching production.
5. Complete Distribution Task 9 to import the bootstrapped private identities,
   create three deployment keypairs, and configure protected Environments.
6. Run Infrastructure Task 5 to harden/provision the host, install those three
   public deployment keys, import the same manifest public key, and deploy the
   reviewed attested server digest.
7. Complete Distribution Tasks 8 and 10, then perform the first protected
   Android/Web production release and acceptance run.
8. Complete Infrastructure Tasks 6-9 for scheduled sync, audit gates, monitoring,
   and final end-to-end acceptance. Task 6 may use `bump-release.mjs` because
   Distribution Task 1 is already complete.

Every step that says “deploy”, “publish”, or “upload secret” has the preceding
numbered phase as a hard precondition. A failed precondition stops execution.

## File Map

- `deploy/chimera/docker-compose.yml`: version-pinned standalone relay.
- `deploy/chimera/nginx.conf`: HTTPS/web/API/socket/files/control/download routing.
- `deploy/chimera/systemd/`: certificate, disk, and service timers/units.
- `deploy/chimera/bin/chimera-*-helper`: three root-owned role-specific activation/deploy helpers.
- `deploy/chimera/harden-host.sh`: idempotent host baseline.
- `deploy/chimera/install-host.sh`: directory/users/packages/config installation.
- `deploy/chimera/deploy-server.sh`: maintenance/snapshot/migrate/health/rollback.
- `deploy/chimera/smoke.ps1`: external TLS/route/port checks.
- `scripts/chimera/sync-upstream.ps1`: isolated candidate preparation.
- `scripts/chimera/test-sync-upstream.ps1`: fixture/contract tests.
- `.github/workflows/chimera-sync-upstream.yml`: scheduled PR/issue orchestration.
- `.github/workflows/chimera-external-monitor.yml`: external certificate/endpoint checks.

### Task 1: Codify The Host Security Baseline

**Files:**
- Create: `deploy/chimera/harden-host.sh`
- Create: `deploy/chimera/test-harden-host.ps1`
- Create: `deploy/chimera/sshd_config.d/90-chimera.conf`

- [ ] **Step 1: Write a static/idempotency contract test**

The test runs against a disposable fixture root and asserts security upgrades,
dedicated `chimera`, `chimera-server-deploy`, `chimera-android-deploy`, and
`chimera-web-deploy` users, SSH key-only policy, root password
login disabled, rpcbind disabled/masked, UFW 22/80/443 only, fail2ban, logrotate,
Docker official repository, loopback expectations, no embedded credential/IP
password, and safe repeated execution.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File deploy/chimera/test-harden-host.ps1`

Expected: FAIL because hardening files do not exist.

- [ ] **Step 3: Implement idempotent hardening phases**

Script order must be:

1. Assert Ubuntu 22.04+, root, and expected public IP from metadata/explicit arg.
2. `apt-get update` and noninteractive security/full upgrade.
3. Create locked service/deploy users and directories with explicit modes.
4. Install and verify administrator/deploy SSH public keys before changing sshd.
5. Validate `sshd -t`, keep the current recovery session open, then reload sshd.
6. Disable/mask rpcbind services/sockets.
7. Configure UFW default deny incoming/allow outgoing and 22/80/443.
8. Configure fail2ban and logrotate.
9. Install Docker Engine/Compose from the signed official apt repository.
10. Configure a persistent `DOCKER-USER` ingress deny for non-loopback container
    ports while allowing established traffic.

No script accepts or writes the root password. After key login is verified,
rotate the exposed root password and disable password authentication.

- [ ] **Step 4: Run fixture tests and shell syntax checks**

Run: `pwsh -NoProfile -File deploy/chimera/test-harden-host.ps1; bash -n deploy/chimera/harden-host.sh`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/chimera/harden-host.sh deploy/chimera/test-harden-host.ps1 deploy/chimera/sshd_config.d/90-chimera.conf
git commit -m "ops: codify Chimera host hardening"
```

### Task 2: Configure Public-IP HTTPS And Renewal

**Files:**
- Create: `deploy/chimera/certbot/issue-ip-certificate.sh`
- Create: `deploy/chimera/certbot/renew-ip-certificate.sh`
- Create: `deploy/chimera/systemd/chimera-cert-renew.service`
- Create: `deploy/chimera/systemd/chimera-cert-renew.timer`
- Create: `deploy/chimera/test-certbot-contract.ps1`

- [ ] **Step 1: Write certificate automation contract tests**

Require Certbot >=5.4, `--preferred-profile shortlived`, webroot, exact
`--ip-address 39.98.68.173`, staging-first path, production path, deploy hook
`nginx -t` then reload then public health, six-hour timer with randomized delay,
no HTTP fallback, and no HSTS assumption for IP literals.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File deploy/chimera/test-certbot-contract.ps1`

Expected: FAIL because certificate units/scripts are absent.

- [ ] **Step 3: Implement staging-first issuance**

Install Certbot in a dedicated root-owned Python venv at `/opt/chimera-certbot`
with a recorded version/hash. Serve ACME webroot from `/var/lib/chimera-acme`.
Issue staging certificate, verify SAN contains only `39.98.68.173`, then issue
trusted production certificate after explicit staging success.

- [ ] **Step 4: Implement renewal and fail-closed deploy hook**

Renew every six hours. Validate cert/key pair, IP SAN, trust, and remaining
lifetime; run `nginx -t`; reload; query public HTTPS config endpoint. Any failure
keeps the previous cert/config and exits nonzero. Port 80 serves challenge and
redirect only.

- [ ] **Step 5: Run tests/syntax and commit**

Run: `pwsh -NoProfile -File deploy/chimera/test-certbot-contract.ps1; bash -n deploy/chimera/certbot/*.sh`

Expected: PASS.

```bash
git add deploy/chimera/certbot deploy/chimera/systemd/chimera-cert-renew.* deploy/chimera/test-certbot-contract.ps1
git commit -m "ops: automate trusted IP certificates"
```

### Task 3: Define Relay And Nginx Runtime

**Files:**
- Create: `deploy/chimera/docker-compose.yml`
- Create: `deploy/chimera/nginx.conf`
- Create: `deploy/chimera/env.example`
- Create: `deploy/chimera/test-runtime-contract.ps1`
- Modify: `Dockerfile`

- [ ] **Step 1: Write runtime contract tests**

Assert image pinned by digest/version input, restart policy, read-only root where
supported, dropped capabilities, no-new-privileges, `/data` persistent mount,
`127.0.0.1:3005:3005`, no metrics/public database ports, healthcheck, exact
required secret names including independent `CHIMERA_ACCOUNT_PSEUDONYM_KEY`, and
Nginx routes `/`, `/v1`, Socket.IO paths, `/files`,
`/chimera-control`, `/downloads`, and ACME.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File deploy/chimera/test-runtime-contract.ps1`

Expected: FAIL because runtime files are absent.

- [ ] **Step 3: Implement Compose service**

Use standalone Happy Server with `/srv/chimera/data:/data`, environment loaded
from root-owned `/etc/chimera/server.env`, loopback port only, bounded logs,
health endpoint, init process, and resource ceilings that leave Nginx/system
headroom on 3.6 GiB RAM.

- [ ] **Step 4: Implement Nginx route/security policy**

Use trusted IP certificate, WebSocket upgrade map, request/body/timeouts by route,
`/files` content headers and no SPA fallback, control login/API rate limits,
registration/invite rate limits, CSP for control UI, immutable hashed web assets,
no-cache index/config/manifest, and downloads range support. Overwrite forwarded
headers and proxy only from Nginx loopback.

- [ ] **Step 5: Validate config and commit**

Run: `pwsh -NoProfile -File deploy/chimera/test-runtime-contract.ps1; docker compose -f deploy/chimera/docker-compose.yml config`

Expected: PASS with no secret values required for static Compose expansion.

```bash
git add deploy/chimera/docker-compose.yml deploy/chimera/nginx.conf deploy/chimera/env.example deploy/chimera/test-runtime-contract.ps1 Dockerfile
git commit -m "ops: define Chimera relay runtime"
```

### Task 4: Implement Restricted Activation And Server Rollback Helper

**Files:**
- Create: `deploy/chimera/bin/chimera-server-helper`
- Create: `deploy/chimera/bin/chimera-android-helper`
- Create: `deploy/chimera/bin/chimera-web-helper`
- Create: `deploy/chimera/test-release-helper.ps1`
- Create: `deploy/chimera/sudoers/chimera-deploy`
- Create: `deploy/chimera/deploy-server.sh`

- [ ] **Step 1: Write command allowlist/path-safety tests**

Fixture tests prove `chimera-server-deploy` accepts only `deploy-server` and
`rollback-server`, `chimera-android-deploy` only `activate-android`, and
`chimera-web-deploy` only `activate-web`. Reject every cross-role command,
arbitrary shell, traversal, unsafe IDs,
symlinks outside roots, unknown flags, mutable APK overwrite, manifest-before-APK,
world-readable secrets, and all three deploy users' access to `/data`. Prove each
user can write only its own staging root and the server identity cannot write Web
or APK staging.

- [ ] **Step 2: Write maintenance/snapshot rollback tests**

Simulate maintenance on, old container stop/PGlite close, free-space rejection,
snapshot outside `/data`, incomplete cleanup, restored snapshot open test, two
verified snapshot retention, loopback candidate health, migration failure restore,
and public traffic reopening only after old/new health success.

- [ ] **Step 3: Run and verify failures**

Run: `pwsh -NoProfile -File deploy/chimera/test-release-helper.ps1`

Expected: FAIL because helper/deploy script do not exist.

- [ ] **Step 4: Implement root-owned allowlisted helper**

Create three root-owned helpers that read command/arguments as fixed arrays,
validate IDs with anchored regex, resolve every path under the role's fixed root,
reject symlinks for staged inputs, and call internal functions without `eval`,
`bash -c`, or caller-provided command fragments. Provision locked users
`chimera-server-deploy`, `chimera-android-deploy`, and `chimera-web-deploy` with
separate staging directories and an `authorized_keys command=` forced command for
the matching helper. Sudoers grants each identity only its matching helper and
capability; no shared group grants staging or helper access.

- [ ] **Step 5: Implement consistent server deployment**

Enable root-owned Nginx maintenance include; stop container; ensure no process
holds `/data/pglite`; require free bytes > `1.2 * dataBytes + 15 GiB`; copy to
`/srv/chimera-snapshots/.tmp-$DeploymentId` then atomic rename; restore/open-test snapshot
with old image; start candidate loopback; migrate/health API, socket, config,
auth, and files; switch image marker and remove maintenance. On failure restore
snapshot/old image and verify before reopening.

- [ ] **Step 6: Run tests/syntax and commit**

Run: `pwsh -NoProfile -File deploy/chimera/test-release-helper.ps1; bash -n deploy/chimera/bin/chimera-server-helper deploy/chimera/bin/chimera-android-helper deploy/chimera/bin/chimera-web-helper deploy/chimera/deploy-server.sh`

Expected: PASS.

```bash
git add deploy/chimera/bin deploy/chimera/sudoers deploy/chimera/deploy-server.sh deploy/chimera/test-release-helper.ps1
git commit -m "ops: add atomic Chimera deployment helper"
```

### Task 5: Install And Smoke-Test Backup Server A

**Files:**
- Create: `deploy/chimera/install-host.sh`
- Create: `deploy/chimera/smoke.ps1`
- Create: `deploy/chimera/acceptance-checklist.md`

- [ ] **Step 1: Write external smoke checks before mutation**

`smoke.ps1` validates trusted IP TLS/SAN/expiry, HTTP redirect, web root/assets,
public config schema, API health/version, WebSocket upgrade, `/files` behavior,
control CSP/login rate limit, signed update manifest if present, and an external
TCP scan showing only 22/80/443. Output contains no cookie/token/secret.

- [ ] **Step 2: Run smoke against current empty host and record expected failure**

Run: `pwsh -NoProfile -File deploy/chimera/smoke.ps1 -HostIp 39.98.68.173`

Expected: FAIL on HTTPS/app endpoints; SSH inventory remains reachable.

- [ ] **Step 3: Establish key access without losing recovery**

Open the existing password SSH session, install a new administrator public key,
open and verify a second key-only session, then run hardening. Keep the original
session until `sshd -t`, UFW, Docker, and key login pass. Rotate password and
update the private credential document only after password auth is disabled.

- [ ] **Step 4: Reboot and re-inventory**

After security updates, reboot, reconnect by key, and verify 2 CPUs, >=3.5 GiB
RAM, >=90 GiB usable baseline, updated kernel, rpcbind inactive/masked, UFW active,
Docker active, and no unexpected listeners.

- [ ] **Step 5: Install runtime with generated secrets**

Generate independent random master/session/invitation-pepper/account-pseudonym
keys locally or on the host with restrictive umask. Import the manifest public key
from Distribution Task 0 and require equality with committed/generated metadata;
never generate an update identity on the host. Generate the Argon2id admin hash
from a user-provided test password without logging plaintext, using Argon2 version
19 and exactly `m=65536,t=3,p=1`; parse the resulting PHC and abort unless every
value exactly matches. Write root-owned env mode 600, install
Nginx/Compose/systemd/helper files, issue staging then production IP certificate,
and deploy the reviewed server image.

- [ ] **Step 6: Run external smoke and invitation flow**

Run: `pwsh -NoProfile -File deploy/chimera/smoke.ps1 -HostIp 39.98.68.173`

Expected: PASS. Log into Chimera Control, create one single-use seven-day test
invite, enable/disable an announcement, and verify public config changes.

- [ ] **Step 7: Commit deployment checklist only**

```bash
git add deploy/chimera/install-host.sh deploy/chimera/smoke.ps1 deploy/chimera/acceptance-checklist.md
git commit -m "ops: document Chimera production acceptance"
```

### Task 6: Implement Isolated Upstream Merge Preparation

**Files:**
- Create: `scripts/chimera/sync-upstream.ps1`
- Create: `scripts/chimera/test-sync-upstream.ps1`
- Create: `brand/chimera/upstream.json`

- [ ] **Step 1: Write fixture repository tests**

Cover no-op, new upstream SHA, exact origin/upstream URLs, blocked upstream push,
dirty main rejection, isolated worktree cleanup, normal merge commit, conflict
abort, `upstreamMergeCommitSha` first parent current main and second parent exact
upstream SHA, final `candidateTipSha` first-parent reachability to that merge,
protected-tree restore, executable path classification, docs-only allowlist,
translation TypeScript sensitivity, rename/delete/type/symlink/submodule/unknown
fail-closed, and machine-readable sanitized results.

- [ ] **Step 2: Run and verify failure**

Run: `pwsh -NoProfile -File scripts/chimera/test-sync-upstream.ps1`

Expected: FAIL because sync tooling does not exist.

- [ ] **Step 3: Implement read-only discovery and apply modes**

`-DryRun` uses `ls-remote` only and never writes inside repo. Apply fetches exact
SHA, creates `sync/upstream-<12hex>` from trusted `origin/main` in a temporary
worktree, merges with bot identity and `--no-ff --no-edit`, restores protected
paths from main, runs path classification and gates, commits policy restorations
if needed, verifies topology, writes both `upstreamMergeCommitSha` and the final
`candidateTipSha` to result JSON, and always removes
worktree on completion/failure.

- [ ] **Step 4: Preserve upstream baseline only through merged history**

`upstream.json` records last accepted SHA for reporting, but ancestry is source
of truth. The PR must use GitHub merge mode, never squash/rebase; after merge,
verify both candidate merge commit and upstream SHA are ancestors of `main`.

Protected-tree restoration and release bump may create ordinary single-parent
commits after the upstream merge. Verify the two-parent contract only on
`upstreamMergeCommitSha`; verify `candidateTipSha` reaches it through first-parent
history. PR head, both audit checks, build provenance, and release provenance bind
to the final `candidateTipSha`, while also recording the immutable merge SHA.

Before publishing the candidate branch, resolve and bump with:

```powershell
$upstreamAppVersion = node -e "import('./packages/happy-app/app.config.js').then(m => console.log(m.default.expo.version))"
node scripts/chimera/bump-release.mjs --upstream-app-version $upstreamAppVersion
```

The script, not the workflow, decides revision reset/increment and versionCode
increment, and the resulting product metadata is committed on the sync branch.

- [ ] **Step 5: Run fixture tests and dry run**

Run: `pwsh -NoProfile -File scripts/chimera/test-sync-upstream.ps1; pwsh -NoProfile -File scripts/chimera/sync-upstream.ps1 -DryRun`

Expected: fixture PASS and dry run reports current/new upstream without mutation.

- [ ] **Step 6: Commit**

```bash
git add scripts/chimera/sync-upstream.ps1 scripts/chimera/test-sync-upstream.ps1 brand/chimera/upstream.json
git commit -m "feat(sync): prepare ancestry-safe upstream merges"
```

### Task 7: Add Scheduled Sync, Dual Audit, And Blocked Issues

**Files:**
- Create: `.github/workflows/chimera-sync-upstream.yml`
- Create: `.github/workflows/chimera-audit-security.yml`
- Create: `.github/workflows/chimera-audit-maintainability.yml`
- Create: `scripts/chimera/sync-workflow-contract.test.mjs`
- Create: `scripts/chimera/verify-audit-checks.mjs`
- Create: `scripts/chimera/verify-audit-checks.test.mjs`

- [ ] **Step 1: Write workflow permission/schedule contract tests**

Require cron `23 */6 * * *`, manual dispatch, concurrency no-cancel, read-only
prepare job, artifact handoff, separate contents/PR write and actions-dispatch
jobs, pinned action SHAs, protected-tree verification before push, merge-mode-only,
deduplicated blocked Issue, no PAT/custom token, and no secrets in candidate jobs.
Require two separately named audit workflows with independent read-only jobs,
different check names and artifact names, no mutual workflow/artifact dependency,
no write permission, and attestation-only provenance jobs using the trusted workflow
definition from protected `main`.

- [ ] **Step 2: Write trusted dual-audit check tests**

Mock GitHub API and artifact-attestation responses. Require two distinct trusted
workflow/check identities for the exact candidate head SHA, each with a unique run
ID, approved GitHub Actions App/trigger actor, distinct trusted workflow path and
workflow file SHA from protected `main`, distinct check name and auditor ID,
reviewed upstream/candidate SHAs and diff digest, severity findings/resolutions,
and explicit PASS in an attested artifact. Reject candidate-tree report files,
same workflow path/check name/run/auditor ID, changed head, untrusted workflow SHA, unsigned/replayed
artifact, unresolved finding, placeholder, missing path category, or reports that
reference each other. The two audit workflows cannot call or consume each other.
They may share the repository's trusted GitHub Actions App and trigger actor; those
shared platform identities are allowlisted but are not treated as proof of audit
independence.

- [ ] **Step 3: Run and verify failure**

Run: `node scripts/chimera/sync-workflow-contract.test.mjs && node scripts/chimera/verify-audit-checks.test.mjs`

Expected: FAIL because workflow/audit verifier are absent.

- [ ] **Step 4: Implement scheduled workflow**

Prepare job runs sync and uploads a verified bundle/result. PR job imports exact
SHA, ensures protected workflow tree matches trusted main, pushes deterministic
branch, opens/updates PR, and requests build checks. A separate minimal
`actions:write` job dispatches build. Conflict/gate/audit failure upserts one
Issue per upstream SHA with sanitized file/reason only.

- [ ] **Step 5: Implement merge policy**

Docs-only allowlisted PR enables `gh pr merge --auto --merge`. Executable changes
receive `manual-review-required`; after two independent trusted audit check runs
are verified online plus protected Environment approval, merge mode is enabled.
The verifier obtains run/check metadata from GitHub, pins each artifact to its
attestation and head SHA, and never treats files committed by the candidate branch
as evidence of audit identity. The later release/signing workflows repeat this
online verification instead of trusting cached text. After
merge, verify upstream SHA is an ancestor of main. Never squash/rebase.

- [ ] **Step 6: Run contracts and commit**

Run: `pwsh -NoProfile -File scripts/chimera/test-sync-upstream.ps1; node scripts/chimera/sync-workflow-contract.test.mjs; node scripts/chimera/verify-audit-checks.test.mjs`

Expected: PASS.

```bash
git add .github/workflows/chimera-sync-upstream.yml .github/workflows/chimera-audit-security.yml .github/workflows/chimera-audit-maintainability.yml scripts/chimera/sync-workflow-contract.test.mjs scripts/chimera/verify-audit-checks.mjs scripts/chimera/verify-audit-checks.test.mjs
git commit -m "ci: gate scheduled Chimera upstream sync"
```

### Task 8: Add External Certificate, Endpoint, Disk, And Port Monitoring

**Files:**
- Create: `.github/workflows/chimera-external-monitor.yml`
- Create: `scripts/chimera/external-monitor.mjs`
- Create: `scripts/chimera/external-monitor.test.mjs`
- Create: `deploy/chimera/systemd/chimera-disk-check.service`
- Create: `deploy/chimera/systemd/chimera-disk-check.timer`

- [ ] **Step 1: Write monitor tests**

Cover trusted IP SAN, remaining certificate lifetime thresholds, TLS/HTTP/API/web/
manifest failure, port allowlist, disk warning/high-water, deduplicated Issue
title/body, recovery closure, sanitized diagnostics, and six-hour cron.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/chimera/external-monitor.test.mjs`

Expected: FAIL because monitors are absent.

- [ ] **Step 3: Implement external monitor workflow**

Use `contents: read`, `issues: write`, pinned actions, no secrets, cron offset from
sync. Check from GitHub runner and upsert exact incident categories. Warn before
certificate has 72 hours remaining; critical before 48 hours.

- [ ] **Step 4: Implement local disk timer**

Check `/data`, snapshots, web releases, and download mirror. Log/health flag at
70%, reject new attachment writes at design thresholds, and prune only non-active
releases/verified snapshots under retention rules.

- [ ] **Step 5: Run tests and commit**

Run: `node scripts/chimera/external-monitor.test.mjs`

Expected: PASS.

```bash
git add .github/workflows/chimera-external-monitor.yml scripts/chimera/external-monitor.mjs scripts/chimera/external-monitor.test.mjs deploy/chimera/systemd/chimera-disk-check.*
git commit -m "ops: monitor Chimera public infrastructure"
```

### Task 9: Perform End-To-End Production Acceptance

**Files:**
- Modify: `deploy/chimera/acceptance-checklist.md`

- [ ] **Step 1: Run complete local gates**

Run: `pnpm chimera:brand:check && node scripts/verify-chimera-client.mjs && pnpm chimera:server:check && pwsh -NoProfile -File scripts/chimera/verify-distribution.ps1 && pwsh -NoProfile -File scripts/chimera/test-sync-upstream.ps1`

Expected: all PASS.

- [ ] **Step 2: Run two independent final diff audits**

Give both auditors the same reviewed commit and spec, keep reports independent,
resolve every high/medium finding, rerun affected tests, then require both final
PASS reports before production Environment approval.

- [ ] **Step 3: Deploy server/web and publish signed APK**

Run protected server deployment, secretless builds, isolated signing, immutable
GitHub publication, APK mirror activation, then web activation. Each stage must
pass health before the next.

- [ ] **Step 4: Test real user flows**

Create/reuse/expire/revoke invitations; register Android and web; replay auth;
pair stock CLI; sync encrypted session/attachment; enable/disable announcement;
disable account and confirm live socket closes; exhaust quota; publish a test
update and verify only Android system confirmation; test web/server rollback.

- [ ] **Step 5: Run external infrastructure acceptance**

Run: `pwsh -NoProfile -File deploy/chimera/smoke.ps1 -HostIp 39.98.68.173`

Expected: PASS for TLS, routes, WebSocket, signed manifest/APK, and port allowlist.

- [ ] **Step 6: Record non-secret handoff and commit**

Record web/control/Release URLs, version, commit, APK SHA-256, signer fingerprint,
certificate expiry, backup ID, rollback version, and test results. Never record
passwords, session cookies, invitations, private keys, or master secrets.

```bash
git add deploy/chimera/acceptance-checklist.md
git commit -m "docs: record Chimera production acceptance"
```
