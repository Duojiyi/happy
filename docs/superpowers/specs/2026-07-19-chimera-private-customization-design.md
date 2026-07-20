# Chimera Private Customization Design

## Purpose

Create a maintainable Chimera distribution of `slopus/happy` for Android and
web. The distribution uses a fixed self-hosted relay, removes upstream
commercial and telemetry integrations, gates account creation with invitations,
supports a remotely managed startup announcement, and continuously incorporates
safe upstream changes.

The implementation must remain a recognizable, reviewable customization layer.
It must not become a collection of fragile search-and-replace patches.

## Goals

- Publish a production-signed Android APK and a static web application branded
  as Chimera.
- Fix production Android and web to `https://103.250.173.136` with no server
  chooser or fallback to an upstream service.
- Preserve the Happy encrypted relay, account recovery, device linking, CLI
  pairing, sessions, machines, artifacts, and encrypted attachment behavior.
- Remove voice, push notifications, subscriptions, analytics, upstream OTA,
  upstream support links, connected-service settings, changelog, and about UI.
- Provide a secure Chimera Control page for startup announcements and
  invitation-code management.
- Require an invitation for every new account while leaving existing-account
  authentication, recovery, and device linking unaffected.
- Poll upstream every six hours, automatically merge only strictly allowlisted
  non-executable changes that pass all gates, and require two independent audits
  for executable changes.
- Deploy web releases atomically and publish immutable APK releases with a safe
  Android update path.
- Deploy and harden the relay on backup server A, then hand the running web app
  and APK to the user for acceptance testing.

## Non-Goals

- No iOS, Tauri desktop, app-store submission, Kubernetes, Redis, external
  PostgreSQL, MinIO, or multi-node scaling.
- No silent privileged Android installation. Android's system package installer
  confirmation remains mandatory.
- No custom Happy CLI build. The stock CLI is configured to use the Chimera
  relay.
- No rich HTML, Markdown, images, scheduling, audience segmentation, or
  analytics for startup announcements.
- No Firebase, Expo push, EAS Build, EAS Update, PostHog, RevenueCat, ElevenLabs,
  or upstream remote logging.
- No access to encrypted user content in Chimera Control. Account administration
  is limited to pseudonymous ID, creation time, storage usage/quota, token
  revocation, and disable/restore controls.
- No full disaster-recovery service until an off-host backup destination is
  provided. Local pre-deploy snapshots provide rollback, not machine-loss
  recovery.

## Product Decisions

### Identity

- Product name: `Chimera`.
- Android application ID: `org.chimerahub.chimera`.
- Primary deep-link scheme: `chimera://`.
- Compatibility deep-link scheme: `happy://`, retained because the stock Happy
  CLI emits Happy authentication URLs.
- Relay and web origin: `https://103.250.173.136`.
- Canonical source and releases: `Duojiyi/happy`.

### Visual Direction

The existing Happy mark is a custom geometric H composed of square blocks and
parallel circuit-like outlines. Chimera uses an original C drawn in the same
black-and-white visual language. The product does not reuse the green Chimera++
C+ mark.

One source SVG produces all required assets:

- Android launcher icon.
- Android adaptive foreground and monochrome icon.
- Splash assets for light and dark themes.
- Web favicon.
- Light and dark Chimera wordmarks.

The source asset, generated outputs, checksums, and product metadata live under
a dedicated `brand/chimera` directory. A deterministic generator creates raster
variants, and CI fails if committed assets do not match the source.

## Architecture

### Repository Customization Layer

Chimera-specific behavior is concentrated into four boundaries:

1. `brand/chimera`: product metadata, source artwork, generated assets, and
   generation/check scripts.
2. App configuration module: compile-time production capabilities, fixed relay,
   update manifest location, and product identity.
3. Server `chimera` module: public configuration, invitation enforcement,
   Chimera Control authentication, and admin APIs.
4. Deployment and CI: upstream sync gates, secretless builds, isolated signing,
   release publication, server deployment, and web rollback.

Existing Happy files contain only small, explicit integration points. Product
policy must not be duplicated across individual screens.

### Runtime Topology

The production host has 1 vCPU, 1 GiB RAM plus 2 GiB swap, a 20 GiB system
disk, and a dedicated 30 GiB Chimera data disk. It runs:

- Caddy on ports 80 and 443 with automatic Let's Encrypt short-lived IP
  certificates.
- One standalone Happy Server container.
- Versioned static web release directories.
- A persistent data directory for PGlite, encrypted attachment blobs, Chimera
  configuration, plus a separate snapshot directory on the same dedicated data
  filesystem for transactional local rollback.

Caddy routing:

- `/` serves the current Chimera web release.
- `/v1/*` and Socket.IO/WebSocket paths proxy to Happy Server.
- `/files/*` proxies Happy local-file responses with explicit size, cache, and
  content-security headers rather than falling through to the web SPA.
- `/chimera-control/*` proxies to the Chimera Control module.
- `/downloads/*` serves the current and previous signed Android APK plus update
  manifests.
- `/.well-known/acme-challenge/*` serves Certbot webroot challenges.

The standalone server uses PGlite, local file storage, and its in-memory event
bus. No external Postgres, Redis, or S3 service is introduced at this scale.

## Fixed Relay Behavior

Production Android returns the compile-time relay URL and ignores persisted,
runtime, query-string, and environment overrides. Production web uses the same
origin and rejects a different runtime server URL. The server settings route,
developer server selector, and reset-to-default behavior are absent from
production navigation.

Development builds retain an explicit development-only override so local tests
can use `http://localhost:3005`. CI verifies that this code path is unreachable
in a production bundle.

There is no upstream default URL and no failure fallback. A relay outage produces
a normal offline state rather than moving credentials or traffic to another
server.

The stock CLI is configured once with the Chimera server URL. Because the CLI is
not customized, a user can technically change that configuration later; the
hard lock applies to Chimera Android and web. Keeping the `happy://` scheme
preserves QR and manual pairing compatibility without a custom CLI package.

## Client Feature Policy

### Settings

The settings page keeps:

- Chimera identity and version/build details.
- Terminal connection controls on native platforms.
- Machine list.
- Account management and recovery.
- Appearance.
- Agent defaults.
- Experiments/features that do not depend on disabled services.
- Developer tools in development builds only.

The settings page removes:

- Support us.
- Connected accounts, including Claude and GitHub account linking.
- Voice assistant.
- What's new/changelog.
- About footer, upstream repository link, and upstream issue-report link.

CI scans production navigation and visible copy so upstream merges cannot
silently restore these entries.

### Disabled Integrations

Production policy sets all of the following to disabled:

- Voice UI, voice routes, microphone permissions, LiveKit/ElevenLabs client
  initialization, and RevenueCat voice gating.
- Push-token registration, Firebase configuration, Expo notification plugin,
  and notification permissions.
- PostHog initialization and tracking calls.
- RevenueCat purchases and paywall calls.
- EAS Update and the upstream Expo project ID.
- Remote console upload and upstream debugging endpoints.
- Official support, social, repository, issue, marketing, and changelog links.

Tracking functions become local no-ops where keeping their call sites reduces
upstream merge conflicts. Native plugins and permissions are removed when they
are exclusively used by disabled features. CI checks both visible entry points
and network/configuration touchpoints.

## Startup Announcement

### Public Configuration

`GET /v1/chimera/config` is public and returns only non-sensitive product data:

```json
{
  "announcement": {
    "enabled": true,
    "title": "Service notice",
    "body": "Plain text with optional line breaks.",
    "primaryButtonLabel": "Got it",
    "linkButtonLabel": null,
    "linkUrl": null
  },
  "androidUpdateManifestPath": "/downloads/chimera-update.json"
}
```

The actual schema uses strict length limits. Announcement text is plain text,
not HTML or Markdown. The optional link must be HTTPS. The Android manifest path
is a fixed same-origin path, not an administrator-controlled URL. Unknown fields
are discarded, and control characters other than line breaks are rejected.

### Client Behavior

- Fetch once after the root navigation tree is ready on every Android cold start
  and every web page load.
- Use a short timeout and never block the first usable screen.
- Fail silently on timeout, non-2xx response, invalid schema, or offline state.
- Show at most once during a single running app/page instance.
- When enabled, show on every new start; there is no per-device dismissal
  persistence.
- Use the existing cross-platform modal system with plain text rendering.
- A primary button dismisses the modal. The optional link button opens the
  validated HTTPS URL externally.

Android update checking may run in parallel, but the system package installer is
not opened until the startup announcement has been dismissed. This prevents two
startup surfaces from competing.

## Chimera Control

### Scope

The control page has three sections:

- Startup announcement editor and enable switch.
- Invitation creation, status list, and revocation controls.
- Pseudonymous account status, quota, disable/restore, and token-revocation
  controls.

The account API may return only a server-generated pseudonymous account ID,
creation time, enabled/disabled status, encrypted attachment byte count, and
quota byte count. Its response schema rejects usernames, display names, avatars,
public keys, token material, sessions, messages, machines, artifacts, attachment
names/paths, encryption keys, and encrypted or decrypted content.

### Authentication

- The administrator password is hashed with Argon2id using documented memory,
  iteration, and parallelism parameters and supplied as
  `CHIMERA_ADMIN_PASSWORD_HASH`; plaintext is never stored in configuration.
- Missing or invalid password-hash, session-secret, invitation-pepper, or
  update-verification configuration makes the server fail closed at startup.
- `ChimeraAdminSession` stores only a random session ID digest, last-seen time,
  absolute expiry, revocation time, and a separately generated CSRF-token digest.
- The browser cookie contains only the random session ID. It is `Secure`,
  `HttpOnly`, `SameSite=Strict`, path-scoped to `/chimera-control`, and checked
  against the server-side session on every request.
- Sensitive requests slide the idle timeout up to the absolute maximum and
  rotate the CSRF token after authentication. Logout revokes that individual
  session immediately.
- Mutations require the session-bound CSRF token and valid same-origin
  `Origin`/`Referer` headers.
- The server rate-limits login attempts before password verification.
- Authentication failures use constant-shape responses and do not reveal
  whether a password prefix was correct.
- Rotating the session secret or running the explicit revoke-all action
  invalidates every active admin session.

The control UI is a small first-party static bundle served by the server module.
It uses same-origin JSON APIs, no CDN resources, no third-party fonts, and no
inline secret-bearing configuration.

## Invitation-Gated Registration

### Data Model

`ChimeraInvitation` is stored in the same Prisma/PGlite database as accounts so
redemption and account creation can share a transaction. It contains:

- ID.
- HMAC-SHA-256 code digest using a server-side invitation pepper.
- Optional administrator label.
- Maximum uses and current uses.
- Creation, expiry, last-use, and revocation timestamps.

Invitation codes contain at least 128 bits of cryptographic randomness. The
plaintext code is returned only once at creation. The default is one use and
seven days, while the administrator can configure both limits.

### Challenge-Bound Authentication

The upstream single-request `/v1/auth` proof is not retained because its
client-chosen challenge can be replayed. Chimera Android and web use a two-step
protocol:

1. The client sends its public key to `/v1/auth/challenge`.
2. The server returns a cryptographically random 128-bit nonce, opaque challenge
   ID, server origin, protocol version, purpose domain, and expiry no more than
   two minutes in the future.
3. The client signs a canonical, domain-separated payload containing all of
   those fields and its public key.
4. The completion request includes the challenge ID, signature, and invitation
   only when creating a new account.
5. The server verifies origin, domain, expiry, signature, and single-use nonce.
   Nonce consumption is committed in the same transaction as login or account
   creation.

Only a nonce digest is stored. A nonce cannot be consumed twice, reused after
expiry, or replayed against another server or authentication purpose. The legacy
replayable direct-login shape is disabled in Chimera production. Stock CLI
pairing remains compatible because it uses the separate authenticated
`/v1/auth/request` approval flow.

### Registration Flow

1. The unauthenticated client asks for an invitation before generating a new
   account.
2. The client generates the existing local account secret and completes the
   challenge-bound authentication protocol.
3. The completion request includes the invitation only for new-account creation.
4. The server verifies the challenge and signature before doing invitation work.
5. Inside the serializable/retryable transaction, the server performs the final
   public-key lookup. Existing accounts authenticate normally without an
   invitation.
6. For a new public key, that transaction atomically verifies an active,
   unexpired invitation with remaining uses, increments its use count, records
   last use, consumes the nonce, and creates the account.
7. Invalid, expired, exhausted, or revoked invitations return the same public
   error class. Rate limiting prevents online guessing.

An atomic conditional update prevents concurrent redemption from exceeding the
maximum use count. If account creation fails, the invitation use rolls back.

Account recovery, app-to-app linking, terminal authorization, and adding another
device to an existing account do not consume invitations.

### Minimal Account Controls And Quotas

An invitation controls admission but not post-registration abuse. Chimera
Control therefore lists only a pseudonymous account identifier, creation time,
status, encrypted attachment usage, and configured quota. It supports:

- Disable/restore, enforced by REST authentication and every WebSocket
  connection/re-authentication. Disabling an account or changing its token epoch
  immediately enumerates and disconnects all sockets bound to that account.
- Every side-effecting socket event rechecks the connection-bound account status
  and token epoch before mutation, closing the race between an admin disable and
  an in-flight event.
- Token revocation through a monotonically increasing token epoch embedded in
  newly issued tokens and checked against the account record.
- A default encrypted-attachment quota of 5 GiB per account, configurable by the
  administrator without exposing attachment names or contents.
- Per-account and global upload/request limits.

New file writes stop when an account quota is exhausted, disk usage reaches 80%,
or available disk falls below 5 GiB. Aggregate attachment allocations across
all accounts are capped at 5 GiB. Attachment admission also stops when the
complete data tree reaches 6 GiB or would consume space reserved for the next
deploy and rollback. Reads and account recovery remain
available. Uploads reserve quota in the database before writing to a temporary
file, atomically rename the completed blob, then finalize the reservation;
failure releases the reservation. Reconciliation detects and corrects drift
after crashes.

## Android Packaging And Update

### Build And Signing

- CI runs Expo prebuild and Gradle on an Ubuntu GitHub runner to produce one
  universal release APK. EAS Build is not used.
- The build job has no signing key, deployment key, admin secret, or server
  credential.
- An isolated signing job does not check out repository source and does not run
  repository scripts. It downloads the unsigned artifact and invokes the pinned
  Android SDK `apksigner` with the keystore from GitHub Actions secrets.
- Before signing, CI parses the unsigned APK and requires package name
  `org.chimerahub.chimera`, the expected version name/code, expected file digest
  and build provenance, and confirms that it is unsigned. It separately verifies
  that the protected signing Environment declares the expected public signer
  fingerprint.
- After signing, CI rechecks package name and version, records the new digest,
  and requires the actual signing-certificate fingerprint to equal the pinned
  fingerprint.
- The signing job verifies that the reviewed commit SHA, unsigned artifact
  digest, build provenance, signed artifact digest, and release version form one
  immutable attestation chain.
- The signing job records SHA-256 and size and emits a canonical update manifest
  signed with a separate Ed25519 release-manifest key. The corresponding public
  key is pinned in the client.
- Tags and releases are immutable. Rerunning an existing release is idempotent
  and must not replace an asset with different bytes.

`brand/chimera/product.json` is the only writable version source and generates
Expo `version`, Android `versionCode`, artifact names, and release tags. Version
format is `<upstream-app-version>-chimera.<revision>`, where the upstream app
version is explicitly imported from Expo `app.config.js`, not the unrelated app
package version. Android `versionCode` is monotonically increasing. A repository-
wide release concurrency lock and a final pre-sign check reject an occupied tag,
version code, or commit/version mismatch.

### Distribution And Update

- GitHub Release is the canonical release history and contains the signed APK,
  SHA-256 file, signed JSON manifest, and build attestation.
- The release workflow mirrors immutable versioned APKs and the current signed
  manifest to the Chimera server. It uploads an APK under a temporary name,
  verifies bytes/package/version/signer on the server, then atomically renames it
  to `/downloads/chimera-<version>-<sha256-prefix>.apk`. Only after that succeeds
  does it atomically replace `chimera-update.json` as the final activation step.
  An interrupted upload leaves the old manifest untouched. The previous active
  APK is retained only after the new manifest is live. The app downloads from
  its fixed HTTPS origin instead of depending on GitHub reachability.
- Android fetches only `/downloads/chimera-update.json`, verifies its Ed25519
  signature with the pinned public key, and rejects any download path outside
  the fixed same-origin `/downloads/` prefix.
- A newer version downloads in the background to app-private storage.
- Before invoking the installer, a protected Chimera native module parses the
  APK and verifies expected length, SHA-256, package name, increasing version
  code, and the pinned signing-certificate fingerprint.
- A Chimera Expo config plugin declares `REQUEST_INSTALL_PACKAGES`, a
  non-exported `FileProvider`, narrow provider paths, and temporary read grants.
  CI inspects the prebuilt manifest and provider configuration.
- Android additionally enforces that an update to the installed package is
  signed by the same application certificate.
- The user may need to grant “install unknown apps” once, and Android always
  shows its system installation confirmation. Chimera shows no additional update
  prompt.
- Failed downloads are discarded and retried with bounded backoff on a later
  start. There is no downgrade and no install attempt while another update is
  active.

## Web Release

- CI exports a production static web bundle in a secretless job.
- `index.html` is served with no-cache headers; content-hashed assets are served
  immutable.
- A deploy job with no source checkout downloads the validated web artifact and
  uploads it using a dedicated non-root SSH deploy account.
- Files are extracted into `/srv/chimera-web/releases/<commit-sha>`.
- The Web runtime's `current` symlink changes only after file validation.
- Health checks load the root document and a representative hashed asset.
- Failure restores the previous symlink. A retention job keeps several recent
  web releases and never removes the active or rollback target.

The deploy account cannot run arbitrary root commands, read relay data, or alter
proxy configuration. A root-owned deployment helper exposes only validated
release activation and rollback operations.

## Server Deployment

The initial deployment is performed after host hardening and verified before any
client release points at it. The standalone server runs from a version-pinned
container image with a persistent `/data` mount.

Future server deployment is path-sensitive:

- App-only, brand-only, and web-only changes do not restart the server.
- Changes under Happy Server, Happy Wire/protocol, Prisma migrations, container
  build inputs, or the Chimera server module require a server release gate.
- A server candidate is built without production secrets and scanned/tested in
  CI.
- Deployment first places Caddy in maintenance mode, blocks external writes,
  stops the old container cleanly, and confirms PGlite is closed. It then
  snapshots the entire `/data` tree to
  `/srv/chimera-storage/snapshots/<deployment-id>` while no database or attachment writes
  are possible. Snapshot directories are never inside or bind-mounted beneath
  `/data`.
- Before a deploy, free space must exceed twice current `/data` usage plus the
  5 GiB operational reserve, covering the new snapshot and a transactional
  restore candidate at peak. Rollback measures both the current data tree and
  selected target snapshot. It retains the newest
  verified snapshots, removes incomplete temporary snapshots on failure, and
  never deletes the current rollback target before a replacement is verified.
- Every snapshot is restored into a temporary directory and opened by the old
  image before it is accepted as a rollback point.
- The new image starts only on the loopback interface while public traffic
  remains in maintenance mode. It applies supported migrations and checks HTTP,
  WebSocket, authentication, config, and attachment paths against the migrated
  data.
- Success removes maintenance mode. Failure stops the candidate, restores the
  verified pre-deploy snapshot and previous image, rechecks health, and only then
  restores public traffic. This single-node process intentionally accepts a
  short maintenance window to guarantee consistency.

Sensitive server/protocol/dependency changes do not auto-merge merely because
unit tests pass. They require the protected `server-release` GitHub Environment
approval. This is the intentional human boundary in the semi-automatic model.

## Upstream Synchronization

### Detection And Candidate Preparation

- A scheduled workflow runs every six hours and supports manual dispatch.
- It compares the recorded upstream baseline with `slopus/happy/main`.
- No change is a successful no-op.
- A new SHA is merged with a normal merge commit in an isolated worktree into a
  deterministic sync branch.
- The candidate records the exact upstream SHA; it does not infer a false app
  release tag from Happy's CLI-focused GitHub Releases.
- The trusted Chimera workflow tree, brand policy, audit policy, signing policy,
  and deployment helpers are restored from current `origin/main` before the
  candidate is gated.
- The sync PR is merged with its merge commit, never squash-merged or rebased.
  CI verifies that the merge commit's second parent is the exact recorded
  upstream SHA so future merges retain the correct Git ancestor.

### Gates

Every sync candidate runs:

- Chimera brand generation and drift checks.
- Prohibited Happy asset, visible-copy, official-host, telemetry, voice, push,
  OTA, and server-selector scans.
- Unit tests for production feature policy, fixed relay, invitation redemption,
  admin auth, startup config parsing, and update manifests.
- App and server type checks.
- Production web export.
- Unsigned production Android build.
- Server build and tests when server-relevant paths change.
- Workflow contract tests that verify schedule, permissions, protected paths,
  branch naming, idempotency, and fail-closed behavior.
- Native delivery tests that inspect the prebuilt Android manifest,
  `FileProvider`, requested permissions, package identity, and signer policy.

### Merge And Audit Policy

- Automatic merge is limited to a strict allowlist of non-executable Markdown
  documentation and test fixtures proven absent from the production dependency
  graph after content gates pass. Translations in this repository are executable
  TypeScript and always require both audits. Any `.ts`, `.tsx`, `.js`, `.mjs`,
  `.cjs`, native, config, asset, or package metadata change is not auto-mergeable.
- Any upstream executable application or server change requires two independent
  diff audits. The reviewers/agents receive the same candidate independently,
  do not exchange findings, and publish separate required status checks. A
  maintainer resolves both reports before merge.
- Production signing requires the reviewed commit SHA and both audit check IDs;
  auto-merge alone never grants access to the signing environment.
- Conflicts or failed gates abort, leave `main` untouched, and create or update a
  deduplicated GitHub Issue with sanitized diagnostics.
- Changes to network, authentication, encryption, local credential storage,
  deep links, WebView, updates, native bridges, server, protocol/wire types,
  Prisma, dependency locks, native plugins, signing/build configuration,
  deployment, or protected CI paths receive a `manual-review-required` label
  and require protected-environment approval after the two audits.
- Protected paths explicitly include `.github/**`, `scripts/**`, every
  `package.json`, all lockfiles and package-manager configuration, `patches/**`,
  Expo/Babel/Metro configuration, Dockerfiles, native config plugins, Android
  project inputs, brand/audit/signing policy, and deployment helpers. Unknown
  executable paths fail closed.
- Classification uses merge-base `git diff --name-status` and rejects unhandled
  rename, delete, type-change, symlink, submodule, or unknown statuses.
- Pull requests created with the built-in token explicitly dispatch their checks;
  the automation does not rely on recursive workflow events.
- Upstream push is blocked by remote configuration and workflow checks.

The preparation job is read-only. Separate short-lived least-privilege jobs
import the gated artifact, verify its SHA and protected tree, push the branch,
open the PR, and dispatch checks. `actions:write` is never combined in one job
with contents/issues write permissions. Actions are pinned by commit SHA.

## Release Orchestration

A trusted `main` workflow resolves whether a new client release is required and
is idempotent for an already published version. Executable-code releases require
the two independent audit checks and the production signing Environment gate.
The order is:

1. Run final policy and test gates.
2. If required, deploy and health-check the server through its protected gate.
3. Build unsigned APK and web artifacts without secrets.
4. Sign and verify the APK in the isolated signing job.
5. Publish an immutable GitHub Release.
6. Mirror the signed APK and manifests to the server.
7. Atomically deploy and health-check web.
8. Smoke-test public config, web, APK download, API, and WebSocket endpoints.

A failed stage does not advance later stages. The previous web release, APK
manifest, and server image remain available for rollback.

## TLS And Host Hardening

### Public IP TLS

Let's Encrypt IP certificates are generally available and must use the
`shortlived` profile. Certbot 5.4 or newer obtains the certificate with webroot
validation and `--ip-address 103.250.173.136`. Certificates are valid for 160 hours.

- A systemd timer runs renewal checks every six hours with randomized delay.
- Caddy renews the short-lived certificate automatically and public smoke tests
  validate its chain, IP SAN, and expiry.
- A scheduled GitHub workflow independently checks the public certificate and
  endpoint every six hours and opens/updates an Issue before the remaining
  lifetime becomes unsafe. Renewal failure never causes an HTTP downgrade.
- Port 80 serves only ACME challenges and redirects all other traffic to HTTPS.
- Delivery instructions always use the full `https://` URL. HSTS is not treated
  as a security control because browsers do not reliably establish HSTS state
  for an IP literal.

### Server Baseline

Before application deployment:

- Apply Ubuntu security updates and reboot into the updated kernel.
- Create dedicated service and deployment users.
- Install SSH keys, disable root password login, and retain a verified recovery
  session before closing the original session.
- Disable and mask unused RPC services exposing port 111.
- Enable UFW with only SSH, 80, and 443 allowed; apply equivalent Alibaba Cloud
  security-group rules.
- Bind the relay container only as `127.0.0.1:3005:3005`, publish no metrics
  port, and add a `DOCKER-USER` default-deny rule so Docker cannot bypass UFW.
- Verify the public port surface from an external GitHub runner, not only from
  local firewall output.
- Install fail2ban or equivalent SSH login throttling.
- Install Docker Engine/Compose from a pinned supported source.
- Configure log rotation, disk alerts, container restart policy, and a
  non-world-readable secrets file.
- Generate independent master, admin-session, invitation-pepper, and password
  hash secrets. Do not reuse SSH or GitHub credentials.
- Configure Fastify to trust only the loopback Caddy proxy. Caddy overwrites
  forwarding headers; the application rejects untrusted forwarded identity and
  applies separate limits by client IP, invitation digest, account, and global
  concurrency.

No secret appears in repository files, Actions artifacts, command output,
release manifests, health endpoints, or client bundles.

## Error Handling

- Relay unavailable: clients remain offline and never fall back upstream.
- Config unavailable/invalid: skip announcement and update for that start.
- Announcement link invalid: omit the link button rather than relaxing URL
  validation.
- Invitation invalid/expired/revoked/exhausted: return one generic rejection and
  do not create an account or increment usage.
- Authentication nonce replayed, expired, cross-origin, or wrong-purpose: reject,
  issue no token, and make no invitation/account mutation.
- Admin authentication or CSRF invalid: reject without mutation and log only
  sanitized metadata.
- APK manifest signature, path, hash, length, package, version, or signer mismatch:
  delete the file and never open the installer.
- Disabled account or stale token epoch: reject REST and WebSocket access while
  retaining administrator recovery controls.
- Quota/high-water threshold reached: preserve reads but reject new file writes.
- Web deploy health failure: restore the previous symlink.
- Server deploy/migration health failure: restore image and pre-deploy snapshot.
- Upstream conflict or gate failure: abort candidate, preserve `main`, and upsert
  one actionable Issue per upstream SHA.

## Testing

### Automated

- Brand generator determinism and asset dimension/transparency tests.
- Production feature-policy tests proving disabled entry points and integrations
  cannot initialize.
- Fixed-server tests across native and web config sources.
- Official-host and upstream-brand scans against production bundles.
- Invitation tests for valid, invalid, expired, revoked, exhausted, concurrent,
  existing-account, rollback, and rate-limit cases.
- Challenge tests for replay, expiry, single consumption, cross-origin,
  cross-purpose, malformed signature, and transaction rollback.
- Account-disable, token-epoch, per-account quota, global high-water, and usage
  reconciliation tests across REST and WebSocket paths.
- Admin password, cookie, timeout, CSRF, authorization, validation, and logout
  tests.
- Announcement schema, timeout, once-per-run, every-new-start, URL validation,
  and modal sequencing tests.
- Android update signed-manifest, fixed path, package, version, signer, hash,
  retry, no-downgrade, FileProvider, and installer sequencing tests.
- Web cache-header, artifact validation, activation, rollback, and retention
  tests.
- Sync contract tests and fixture repositories for no-op, merge-parent retention,
  allowlisted auto-merge, dual-audit gate, rename/type/symlink rejection,
  conflict, sensitive-path, gate-failure, resume, and idempotency behavior.
- Server migration, maintenance-mode, closed-database snapshot, restore-open,
  health, and rollback tests.

### Release Smoke Tests

- Install the APK on a clean Android device and create an account with a valid
  invitation.
- Verify invalid and reused invitations fail without creating accounts.
- Capture and replay a completed account-auth request and verify it is rejected.
- Restore the account and pair the stock Happy CLI through the compatibility
  scheme and fixed relay.
- Verify Android and web see the same encrypted sessions and attachments.
- Verify every new start shows an enabled announcement and disabling it takes
  effect without a rebuild.
- Verify no voice, push, telemetry, subscription, official links, server chooser,
  changelog, connected accounts, or about content is reachable.
- Publish a test update, verify background download/hash checking, and verify the
  Android system installer is the only update prompt.
- Verify web atomic rollout and rollback.
- Verify TLS trust, renewal dry run, API health, WebSocket upgrade, and no public
  ports other than SSH/80/443.
- Disable a test account and verify existing REST tokens and WebSocket sessions
  stop working; restore it and issue a fresh token.
- Fill a test quota and verify reads continue while new encrypted uploads fail.

## Rollout

1. Implement and gate the Chimera customization layer locally.
2. Provision GitHub environments/secrets and validate unsigned CI builds.
3. Harden backup server A and establish public-IP HTTPS.
4. Deploy and initialize the standalone relay and Chimera Control.
5. Create the first administrator password hash and one test invitation.
6. Deploy web and run browser smoke tests.
7. Build, isolate-sign, publish, mirror, and install the first APK.
8. Pair the stock CLI and complete encrypted end-to-end tests.
9. Enable scheduled upstream synchronization only after sync fixture tests and a
   manual dry run against the current upstream SHA pass.
10. Hand the IP URL, Chimera Control URL, APK Release URL, signer fingerprint,
    and acceptance checklist to the user.

## Residual Risks

- A public IP is less portable than a domain. Changing the server IP requires a
  new client build and certificate configuration.
- Six-day IP certificates make renewal monitoring operationally critical.
- Local PGlite and local files are appropriate for this scale but provide no
  high availability.
- Pre-deploy snapshots on the same machine support rollback but not recovery from
  total disk or host loss.
- Automatically incorporating any upstream code retains supply-chain risk.
  Secretless builds, protected workflows, sensitive-path manual gates, isolated
  signing, and independent audits reduce but cannot eliminate it.
- APK side-loading always retains Android's system confirmation and may require a
  one-time “install unknown apps” grant.
