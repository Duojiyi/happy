# Chimera Server Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend standalone Happy Server with replay-safe account authentication, invitation-gated registration, a secure Chimera Control console, remote startup configuration, pseudonymous account controls, immediate token/socket revocation, and bounded attachment storage.

**Architecture:** Register one isolated `chimera` Fastify module and use the existing Prisma/PGlite database for transactional security state. Keep public config, administrator APIs, account admission, token enforcement, and quota reservation as separate services with strict Zod interfaces.

**Tech Stack:** TypeScript, Fastify 5, Prisma/PGlite, Socket.IO, Zod, Argon2id, Vitest, pnpm.

---

## File Map

- `packages/happy-server/prisma/schema.prisma`: Chimera models and account epoch/status.
- `packages/happy-server/sources/app/chimera/config.ts`: validated required environment.
- `packages/happy-server/sources/app/chimera/authChallenge.ts`: nonce issue/consume service.
- `packages/happy-server/sources/app/chimera/invitations.ts`: hashed invitation lifecycle.
- `packages/happy-server/sources/app/chimera/adminSessions.ts`: Argon2 login, session/CSRF state.
- `packages/happy-server/sources/app/chimera/accountPolicy.ts`: disable/restore/epoch/quota policy.
- `packages/happy-server/sources/app/chimera/routes.ts`: public and administrator HTTP routes.
- `packages/happy-server/sources/app/chimera/control/`: local static control UI.
- `packages/happy-server/sources/app/api/routes/authRoutes.ts`: v2 completion integration.
- `packages/happy-server/sources/app/auth/auth.ts`: token epoch claim/check.
- `packages/happy-server/sources/app/api/socket.ts`: status/epoch socket enforcement.
- `packages/happy-server/sources/app/api/routes/attachmentRoutes.ts`: quota reservation.

### Task 1: Add Chimera Security State To Prisma

**Files:**
- Modify: `packages/happy-server/prisma/schema.prisma`
- Create: `packages/happy-server/prisma/migrations/20260719000000_add_chimera_control/migration.sql`
- Create: `packages/happy-server/sources/app/chimera/schema.spec.ts`

- [ ] **Step 1: Write a schema behavior test**

Create a temporary standalone database, run migrations, and assert Prisma can
create an account with epoch/quota plus challenge, invitation, admin session, and
singleton configuration records. Assert unique digests reject duplicates.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/schema.spec.ts`

Expected: FAIL because the models/fields do not exist.

- [ ] **Step 3: Add account policy fields and focused models**

```prisma
model Account {
    // existing fields remain
    disabledAt              DateTime?
    tokenEpoch              Int       @default(0)
    attachmentQuotaBytes    BigInt    @default(5368709120)
    attachmentUsedBytes     BigInt    @default(0)
    attachmentReservedBytes BigInt    @default(0)
    chimeraReservations     ChimeraAttachmentReservation[]
}

model ChimeraAuthChallenge {
    id          String    @id @default(cuid())
    nonceDigest String    @unique
    publicKey   String
    origin      String
    purpose     String
    expiresAt   DateTime
    consumedAt  DateTime?
    createdAt   DateTime  @default(now())
    @@index([expiresAt])
}

model ChimeraInvitation {
    id         String    @id @default(cuid())
    codeDigest String    @unique
    label      String?
    maxUses    Int
    usedCount  Int       @default(0)
    expiresAt  DateTime
    revokedAt  DateTime?
    lastUsedAt DateTime?
    createdAt  DateTime  @default(now())
}

model ChimeraAdminSession {
    id              String    @id @default(cuid())
    sessionDigest   String    @unique
    csrfDigest      String
    lastSeenAt      DateTime
    expiresAt       DateTime
    revokedAt       DateTime?
    createdAt       DateTime  @default(now())
    @@index([expiresAt])
}

model ChimeraConfiguration {
    key       String   @id
    value     Json
    updatedAt DateTime @updatedAt
}

model ChimeraAttachmentReservation {
    id        String   @id @default(cuid())
    accountId String
    bytes     BigInt
    expiresAt DateTime
    createdAt DateTime @default(now())
    account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
    @@index([accountId, expiresAt])
}
```

Write explicit SQL for the migration and preserve all existing account rows with
epoch 0 and 5 GiB default quota. Do not use `prisma migrate dev`; this repository
requires hand-authored migration files plus `pnpm generate`.

- [ ] **Step 4: Generate client and run migration test**

Run: `pnpm --filter happy-server-self-host generate && pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/schema.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/prisma packages/happy-server/sources/app/chimera/schema.spec.ts
git commit -m "feat(server): add Chimera security state"
```

### Task 2: Validate Required Chimera Secrets At Startup

**Files:**
- Create: `packages/happy-server/sources/app/chimera/config.ts`
- Create: `packages/happy-server/sources/app/chimera/config.spec.ts`
- Modify: `packages/happy-server/sources/standalone.ts`

- [ ] **Step 1: Write fail-closed configuration tests**

Test missing/invalid `CHIMERA_ADMIN_PASSWORD_HASH`,
`CHIMERA_ADMIN_SESSION_SECRET`, `CHIMERA_INVITATION_PEPPER`, and
`CHIMERA_ACCOUNT_PSEUDONYM_KEY`, and `CHIMERA_UPDATE_PUBLIC_KEY`. Accept only an Argon2id PHC string using Argon2
version 19 with exactly `m=65536,t=3,p=1`; reject Argon2i/Argon2d, malformed PHC,
different versions, or any weaker/different cost. Accept only 32-byte-or-longer
base64url secrets, the fixed HTTPS relay origin, and a valid Ed25519 public key.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/config.spec.ts`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement one parsed immutable config**

```ts
export interface ChimeraServerConfig {
    relayOrigin: 'https://39.98.68.173';
    adminPasswordHash: string;
    adminSessionSecret: Uint8Array;
    invitationPepper: Uint8Array;
    accountPseudonymKey: Uint8Array;
    updatePublicKey: Uint8Array;
}
```

Export `loadChimeraServerConfig(env)` and call it before the API begins listening.
Never log values or partially parsed input.

- [ ] **Step 4: Run tests and server typecheck**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/config.spec.ts && pnpm --filter happy-server-self-host build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/chimera/config.ts packages/happy-server/sources/app/chimera/config.spec.ts packages/happy-server/sources/standalone.ts
git commit -m "feat(server): validate Chimera runtime secrets"
```

### Task 3: Replace Replayable Account Authentication

**Files:**
- Create: `packages/happy-server/sources/app/chimera/authChallenge.ts`
- Create: `packages/happy-server/sources/app/chimera/authChallenge.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/authRoutes.ts`

- [ ] **Step 1: Write nonce protocol tests**

Cover issue/success, wrong origin, wrong purpose, expired challenge, malformed
signature, replay, concurrent completion, and cross-server payload. Assert replay
creates no token/account/invitation mutation. Add deterministic-clock tests for
per-IP and per-public-key issue rate limits, pending caps, a global pending cap,
expired/consumed cleanup, and concurrent requests at every cap. Verify rejected
issuance cannot grow the challenge table.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/authChallenge.spec.ts`

Expected: FAIL because nonce issuance/consumption is absent.

- [ ] **Step 3: Implement canonical payload and challenge issuance**

```ts
export function createAuthPayload(input: AuthChallengePayload): Uint8Array {
    return new TextEncoder().encode([
        'chimera-auth-v2', input.origin, 'chimera-account-auth', input.challengeId,
        input.nonce, input.publicKey, input.expiresAt,
    ].join('\n'));
}
```

Generate 16 random bytes, return base64url nonce, store only HMAC digest plus
public key/origin/purpose/expiry, and cap TTL at two minutes. Before insertion,
delete consumed rows older than five minutes and expired rows in a bounded batch;
also run the same bounded cleanup from a single-process periodic timer. Enforce a
token-bucket issue limit per trusted client IP and per public key, at most three
unconsumed challenges for either identity, and a configurable global pending cap
with a conservative production default. Return the same `429` envelope for every
limit and never disclose whether a key already has an account.

- [ ] **Step 4: Add `/v1/auth/challenge` and replace `/v1/auth` body**

The challenge route accepts only a valid signing public key. The completion route
accepts challenge ID, signature, and optional invitation. Remove acceptance of a
client-chosen challenge. Keep terminal/app pairing routes unchanged.

- [ ] **Step 5: Consume nonce and issue token in retryable transaction**

Use existing `inTx()` with serializable semantics. Inside the transaction,
conditionally mark one unexpired unconsumed challenge consumed, perform the final
account lookup, then authenticate existing account or call invitation-backed
creation. A zero-row conditional update is a generic unauthorized response.

- [ ] **Step 6: Run auth tests and build**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/authChallenge.spec.ts && pnpm --filter happy-server-self-host build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-server/sources/app/chimera/authChallenge.ts packages/happy-server/sources/app/chimera/authChallenge.spec.ts packages/happy-server/sources/app/api/routes/authRoutes.ts
git commit -m "fix(server): bind account auth to server nonce"
```

### Task 4: Implement Invitation Lifecycle And Atomic Redemption

**Files:**
- Create: `packages/happy-server/sources/app/chimera/invitations.ts`
- Create: `packages/happy-server/sources/app/chimera/invitations.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/authRoutes.ts`

- [ ] **Step 1: Write invitation tests**

Cover 128-bit code generation, one-time plaintext return, digest-only persistence,
default one use/seven days, configurable limits, revoke, expire, exhaust,
concurrent final use, account-create rollback, and generic rejection shape.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/invitations.spec.ts`

Expected: FAIL because invitation service is absent.

- [ ] **Step 3: Implement keyed digest and lifecycle**

```ts
function digestInvitation(code: string, pepper: Uint8Array): string {
    return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}
```

Generate 24 random bytes as grouped base64url text. Validate label <= 120,
`1 <= maxUses <= 1000`, and expiry from one hour through one year.

- [ ] **Step 4: Add atomic redemption to account creation**

Inside the nonce transaction, use a conditional `updateMany` requiring matching
digest, `revokedAt = null`, `expiresAt > now`, and `usedCount < maxUses`, then
create account. Require exactly one updated row. Roll back use count on any later
failure.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/invitations.spec.ts sources/app/chimera/authChallenge.spec.ts`

Expected: PASS.

```bash
git add packages/happy-server/sources/app/chimera/invitations.ts packages/happy-server/sources/app/chimera/invitations.spec.ts packages/happy-server/sources/app/api/routes/authRoutes.ts
git commit -m "feat(server): gate registration with invitations"
```

### Task 5: Add Stateful Administrator Sessions

**Files:**
- Create: `packages/happy-server/sources/app/chimera/adminSessions.ts`
- Create: `packages/happy-server/sources/app/chimera/adminSessions.spec.ts`
- Create: `packages/happy-server/sources/app/chimera/adminRoutes.ts`
- Modify: `packages/happy-server/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `Dockerfile`
- Create: `scripts/chimera/test-argon2-container.mjs`

- [ ] **Step 1: Write authentication/session/CSRF tests**

Cover Argon2id success/failure, constant public error, login rate limit, secure
cookie attributes, random session/CSRF digests, idle sliding, absolute expiry,
logout revocation, revoke-all, password/session-secret rotation, wrong Origin,
missing/incorrect CSRF, and no secret logging.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/adminSessions.spec.ts`

Expected: FAIL because administrator sessions do not exist.

- [ ] **Step 3: Implement stateful session primitives**

Use Argon2id verification against the PHC hash. Generate independent 32-byte
session and CSRF values; persist HMAC digests only. Use 30-minute idle and 8-hour
absolute expiry. Touch last-seen only after valid authenticated requests and
revoke the row on logout.

Add the maintained Argon2 implementation with pnpm:

Run: `pnpm --filter happy-server-self-host add --save-exact argon2@0.44.0`

Add `argon2` to root `pnpm.onlyBuiltDependencies` so pnpm 10 permits its native
install script. Expected: `packages/happy-server/package.json`, root `package.json`,
and `pnpm-lock.yaml` dependency/build-policy metadata change; no npm/yarn lockfile
appears. Add `scripts/chimera/test-argon2-container.mjs` to load `argon2`, hash
with version 19 and `m=65536,t=3,p=1`, verify the result, and assert the parsed PHC
parameters. The Dockerfile runs it in the final Node 20 image before the HTTP
health check.

- [ ] **Step 4: Add login/logout/session routes under control path**

Use `/chimera-control/api/session`. Cookie name `__Secure-chimera_admin` is
Secure, HttpOnly, SameSite=Strict, and Path `/chimera-control`. Mutations require header
`X-Chimera-CSRF` plus exact `Origin: https://39.98.68.173`.

- [ ] **Step 5: Add dual-layer rate-limit hooks**

Server limits login by trusted client IP and global concurrency. Nginx limits are
added in the deployment plan. Return the same 401 body and bounded timing for
unknown session/wrong password.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/adminSessions.spec.ts && pnpm --filter happy-server-self-host build && docker build --target chimera-runtime-smoke -t chimera-argon2-smoke .`

Expected: PASS.

```bash
git add packages/happy-server/sources/app/chimera/adminSessions.ts packages/happy-server/sources/app/chimera/adminSessions.spec.ts packages/happy-server/sources/app/chimera/adminRoutes.ts packages/happy-server/package.json package.json pnpm-lock.yaml Dockerfile scripts/chimera/test-argon2-container.mjs
git commit -m "feat(server): secure Chimera Control sessions"
```

### Task 6: Add Public Config And Announcement Administration

**Files:**
- Create: `packages/happy-server/sources/app/chimera/publicConfig.ts`
- Create: `packages/happy-server/sources/app/chimera/publicConfig.spec.ts`
- Modify: `packages/happy-server/sources/app/chimera/adminRoutes.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`

- [ ] **Step 1: Write strict public/admin schema tests**

Test disabled/enabled announcement, length/control-character validation, HTTPS-
only optional link, fixed `/downloads/chimera-update.json`, unknown-field
rejection, no secrets/account fields, authenticated update, and audit-safe logs.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/publicConfig.spec.ts`

Expected: FAIL because routes/service do not exist.

- [ ] **Step 3: Implement singleton configuration service**

Store key `startup-announcement` with validated JSON. Default is disabled with
empty safe strings. Public response is a newly constructed allowlisted object,
not the raw database JSON.

- [ ] **Step 4: Register routes**

Register `GET /v1/chimera/config` without auth and control mutations behind the
admin session/CSRF hooks. Set public config `Cache-Control: no-store`; never
include the signed update manifest body in database configuration.

Configure Fastify to trust only loopback proxy addresses and configure CORS for
exact origin `https://39.98.68.173`, required methods/headers, and credentials
policy. Remove production registration of `pushRoutes`, `voiceRoutes`,
`connectRoutes`, and `devRoutes`; keep core auth/session/machine/artifact/file/
access-key routes. Standalone production receives `host: '127.0.0.1'`; the
Compose port binding remains a second independent control.

- [ ] **Step 5: Run tests/build and commit**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/publicConfig.spec.ts && pnpm --filter happy-server-self-host build`

Expected: PASS.

```bash
git add packages/happy-server/sources/app/chimera packages/happy-server/sources/app/api/api.ts
git commit -m "feat(server): serve managed Chimera announcements"
```

### Task 7: Add Pseudonymous Account Controls And Token Epochs

**Files:**
- Create: `packages/happy-server/sources/app/chimera/accountPolicy.ts`
- Create: `packages/happy-server/sources/app/chimera/accountPolicy.spec.ts`
- Modify: `packages/happy-server/sources/app/chimera/adminRoutes.ts`
- Modify: `packages/happy-server/sources/app/auth/auth.ts`
- Modify: `packages/happy-server/sources/app/api/utils/enableAuthentication.ts`
- Modify: `packages/happy-server/sources/app/api/socket.ts`
- Modify: `packages/happy-server/sources/app/api/socket/accessKeyHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/artifactUpdateHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/machineUpdateHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/pingHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/rpcHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
- Modify: `packages/happy-server/sources/app/api/socket/usageHandler.ts`

- [ ] **Step 1: Write response allowlist and revocation tests**

Assert account admin response contains exactly pseudonymous ID, createdAt,
disabled, attachment bytes, and quota bytes. Assert it contains no public key,
profile, token, session, machine, file path/name, or content. Test disable,
restore, epoch increment, stale REST token, stale socket, and live socket forced
disconnect.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/accountPolicy.spec.ts`

Expected: FAIL because status/epoch policy is absent.

- [ ] **Step 3: Add epoch to token issuance and authentication**

```ts
interface ChimeraTokenClaims {
    accountId: string;
    tokenEpoch: number;
}
```

Read epoch when issuing. REST auth loads account and rejects disabled/stale epoch.
Do not trust an epoch without a current database comparison.

- [ ] **Step 4: Disconnect and recheck sockets**

Bind account ID/epoch to socket data after handshake. Disable/epoch mutation
enumerates and disconnects matching sockets. Before every side-effecting handler,
call one shared `assertSocketAccountActive()` and disconnect/reject on stale state.

- [ ] **Step 5: Add strict admin endpoints**

Expose list, disable, restore, revoke-tokens, and set-quota. Use pseudonymous ID
derived with an admin-only HMAC key, not public key prefixes. Validate quota from
100 MiB through 50 GiB.

- [ ] **Step 6: Run tests/build and commit**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/accountPolicy.spec.ts && pnpm --filter happy-server-self-host build`

Expected: PASS.

```bash
git add packages/happy-server/sources/app/chimera packages/happy-server/sources/app/auth/auth.ts packages/happy-server/sources/app/api/utils/enableAuthentication.ts packages/happy-server/sources/app/api/socket.ts packages/happy-server/sources/app/api/socket
git commit -m "feat(server): add account revocation controls"
```

### Task 8: Enforce Attachment Quotas And Disk High-Water

**Files:**
- Create: `packages/happy-server/sources/app/chimera/attachmentQuota.ts`
- Create: `packages/happy-server/sources/app/chimera/attachmentQuota.spec.ts`
- Modify: `packages/happy-server/sources/app/api/routes/attachmentRoutes.ts`
- Modify: `packages/happy-server/sources/storage/files.ts`

- [ ] **Step 1: Write quota/reservation/reconciliation tests**

Cover default/custom quota, concurrent reservations, disk >=80%, free disk <15
GiB, temporary write failure, atomic rename, released reservation, expired
reservation cleanup, crash reconciliation, retained reads, and disabled account.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/attachmentQuota.spec.ts`

Expected: FAIL because no quota service exists.

- [ ] **Step 3: Implement transactional reservation**

Reserve bytes in a retryable transaction only when account reserved+stored+new
bytes <= quota and global high-water checks pass. Return opaque reservation ID.
Write to a same-filesystem `.partial` path, fsync, rename atomically, finalize
usage, and delete/release on failure.

- [ ] **Step 4: Add startup reconciliation and safe rejection**

Expire stale reservations, remove stale partials, compare database accounting to
actual encrypted blob sizes, and correct drift. Upload rejection is 507/429 with
a generic message; download/read routes remain available.

- [ ] **Step 5: Run focused and existing attachment tests**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/attachmentQuota.spec.ts sources/app/api/routes/attachmentRoutes.spec.ts && pnpm --filter happy-server-self-host build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources/app/chimera packages/happy-server/sources/app/api/routes/attachmentRoutes.ts packages/happy-server/sources/storage/files.ts
git commit -m "feat(server): enforce encrypted attachment quotas"
```

### Task 9: Build Chimera Control UI Without Third Parties

**Files:**
- Create: `packages/happy-server/sources/app/chimera/control/index.html`
- Create: `packages/happy-server/sources/app/chimera/control/control.js`
- Create: `packages/happy-server/sources/app/chimera/control/control.css`
- Create: `packages/happy-server/sources/app/chimera/control/control.spec.ts`
- Modify: `packages/happy-server/sources/app/chimera/adminRoutes.ts`

- [ ] **Step 1: Write static/UI contract tests**

Parse HTML and assert local-only CSS/JS, no external resources/inline secrets,
three navigation sections, password autocomplete, invitation plaintext shown once,
announcement fields, strict account field rendering, CSRF header use, and
`textContent` rather than unsafe HTML insertion.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/control/control.spec.ts`

Expected: FAIL because the UI does not exist.

- [ ] **Step 3: Implement a restrained responsive control surface**

Use semantic forms, compact tables, accessible labels/focus, 8px-or-less radii,
no nested cards, no remote fonts/icons, and clear loading/error/empty states.
Only render API allowlisted fields. Copy invite plaintext via explicit button and
remove it from DOM after navigation/refresh.

- [ ] **Step 4: Serve assets with security headers**

Set CSP `default-src 'self'; script-src 'self'; style-src 'self'; connect-src
'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, no-store for
HTML/session data, and immutable hashes for static assets when fingerprinted.

- [ ] **Step 5: Run all control/server tests**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera && pnpm --filter happy-server-self-host build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources/app/chimera/control packages/happy-server/sources/app/chimera/adminRoutes.ts
git commit -m "feat(server): add Chimera Control console"
```

### Task 10: Add Server Integration And Security Gates

**Files:**
- Create: `packages/happy-server/sources/app/chimera/integration.spec.ts`
- Create: `scripts/verify-chimera-server.mjs`
- Create: `scripts/verify-chimera-server.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write end-to-end server tests**

Start standalone server on a random loopback port and test invite creation,
nonce registration, replay rejection, existing login without invite, admin
session/CSRF, announcement update/public read, account disable/live socket close,
quota rejection/read retention, and absence of voice/push routes.

- [ ] **Step 2: Write policy-gate mutation tests**

The gate must fail if a fixture restores voice/push routes, accepts legacy auth,
exposes account fields, binds standalone production to non-loopback through deploy
config, logs secrets, or omits required Chimera routes.

- [ ] **Step 3: Run and verify failures**

Run: `pnpm --filter happy-server-self-host exec vitest run sources/app/chimera/integration.spec.ts && node scripts/verify-chimera-server.test.mjs`

Expected: FAIL until integration/gate implementation is complete.

- [ ] **Step 4: Implement gate and root scripts**

Add `chimera:server:check` to run schema/integration tests, build, and structured
source/route scans. The scanner prints rule/path only.

- [ ] **Step 5: Run complete server verification**

Run: `pnpm chimera:server:check && pnpm --filter happy-server-self-host test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-server/sources/app/chimera/integration.spec.ts scripts/verify-chimera-server.mjs scripts/verify-chimera-server.test.mjs package.json
git commit -m "test(server): gate Chimera control plane"
```
