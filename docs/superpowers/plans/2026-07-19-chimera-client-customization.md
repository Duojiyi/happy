# Chimera Client Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build branded Chimera Android/web clients that are locked to the private relay, require invitation-backed nonce authentication for new accounts, show a remotely configured startup announcement, and expose none of the disabled Happy integrations.

**Architecture:** Add one compile-time product policy and one generated brand metadata module, then make existing Happy integration points consume those boundaries. Keep network/auth helpers pure and tested; keep UI changes limited to route composition, settings, onboarding, and the existing modal system.

**Tech Stack:** TypeScript, React Native, Expo Router, Expo config plugins, Vitest, Zod, pnpm workspaces.

---

## File Map

- `brand/chimera/product.json`: single product/version/policy source.
- `brand/chimera/logo.svg`: source Chimera C artwork.
- `scripts/generate-chimera-brand.mjs`: deterministic metadata/assets generator.
- `scripts/verify-chimera-client.mjs`: fail-closed production policy scan.
- `packages/happy-app/sources/chimera/product.generated.ts`: generated constants only.
- `packages/happy-app/sources/chimera/policy.ts`: typed production capability decisions.
- `packages/happy-app/sources/chimera/config.ts`: public config schema/fetch helper.
- `packages/happy-app/sources/chimera/useStartupAnnouncement.ts`: once-per-runtime announcement orchestration.
- `packages/happy-app/sources/auth/authChallengeV2.ts`: domain-separated nonce payload.
- `packages/happy-app/sources/auth/authGetToken.ts`: two-step login/registration client.
- `packages/happy-app/sources/app/(app)/index.tsx`: invite-aware onboarding.
- `packages/happy-app/sources/components/SettingsView.tsx`: retained settings only.
- `packages/happy-app/app.config.js`: Chimera identity, schemes, permissions, no upstream OTA/push.

### Task 1: Establish Generated Product Metadata

**Files:**
- Modify: `brand/chimera/product.json`
- Create: `brand/chimera/logo.svg`
- Create: `scripts/generate-chimera-brand.mjs`
- Create: `scripts/generate-chimera-brand.test.mjs`
- Create: `packages/happy-app/sources/chimera/product.generated.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the generator contract test**

```js
// scripts/generate-chimera-brand.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateProductModule, validateProduct } from './generate-chimera-brand.mjs';

const product = JSON.parse(await readFile(new URL('../brand/chimera/product.json', import.meta.url)));
validateProduct(product);
const first = generateProductModule(product);
const second = generateProductModule(product);
assert.equal(first, second);
assert.match(first, /PRODUCT_NAME = 'Chimera'/);
assert.match(first, /ANDROID_APPLICATION_ID = 'org\.chimerahub\.chimera'/);
assert.match(first, /RELAY_ORIGIN = 'https:\/\/103\.250\.173\.136'/);
assert.match(first, /UPDATE_PUBLIC_KEY = '[A-Za-z0-9_-]{43}'/);
assert.match(first, /ANDROID_SIGNER_SHA256 = '[A-F0-9]{64}'/);
assert.deepEqual(product.deepLinkSchemes, ['chimera', 'happy']);
console.log('chimera brand generator contract: PASS');
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `node scripts/generate-chimera-brand.test.mjs`

Expected: FAIL because `brand/chimera/product.json` and the generator do not exist.

- [ ] **Step 3: Add the product source and strict generator**

```json
{
  "productName": "Chimera",
  "slug": "chimera",
  "androidApplicationId": "org.chimerahub.chimera",
  "deepLinkSchemes": ["chimera", "happy"],
  "relayOrigin": "https://103.250.173.136",
  "repository": "Duojiyi/happy",
  "upstreamAppVersion": "1.7.0",
  "chimeraRevision": 1,
  "androidVersionCode": 1
}
```

This excerpt shows the human-chosen fields. Distribution Task 0 runs first and
creates the same exact object with two additional required fields,
`updatePublicKey` and `androidSignerSha256`, populated from the generated identities;
this task preserves and validates those values rather than inventing defaults.

Implement `validateProduct()` with exact-key rejection, HTTPS/IP validation,
SemVer validation, positive integer checks, Ed25519 base64url public-key length,
64-hex signer fingerprint, and fixed repository/application ID checks. Implement
`generateProductModule()` as stable sorted output and a CLI
with `--check` that compares generated files byte-for-byte without rewriting.

- [ ] **Step 4: Draw the source C and generate required assets**

Create a 512x512 SVG using the existing Happy block/parallel-line language but
with an open right side forming a C. Extend the generator to render launcher,
adaptive, monochrome, splash, favicon, and light/dark wordmark PNGs into
`packages/happy-app/sources/assets/images/`. Require exact dimensions and alpha
properties in `--check` mode.

- [ ] **Step 5: Run generation and contract checks**

Run: `node scripts/generate-chimera-brand.mjs && node scripts/generate-chimera-brand.mjs --check && node scripts/generate-chimera-brand.test.mjs`

Expected: all commands exit 0 and print `PASS`/`up to date`.

- [ ] **Step 6: Add pnpm scripts and commit**

```json
"chimera:brand": "node scripts/generate-chimera-brand.mjs",
"chimera:brand:check": "node scripts/generate-chimera-brand.mjs --check"
```

```bash
git add brand/chimera scripts/generate-chimera-brand.mjs scripts/generate-chimera-brand.test.mjs packages/happy-app/sources/chimera/product.generated.ts packages/happy-app/sources/assets/images package.json
git commit -m "feat(app): establish Chimera product identity"
```

### Task 2: Add A Fail-Closed Production Policy

**Files:**
- Create: `packages/happy-app/sources/chimera/policy.ts`
- Create: `packages/happy-app/sources/chimera/policy.test.ts`
- Modify: `packages/happy-app/sources/sync/serverConfig.ts`
- Create: `packages/happy-app/sources/sync/serverConfig.test.ts`

- [ ] **Step 1: Write failing policy and fixed-server tests**

```ts
import { describe, expect, it } from 'vitest';
import { CHIMERA_POLICY } from './policy';

describe('CHIMERA_POLICY', () => {
    it('fails closed for every removed integration', () => {
        expect(CHIMERA_POLICY).toEqual({
            voice: false,
            pushNotifications: false,
            analytics: false,
            purchases: false,
            upstreamOta: false,
            remoteLogging: false,
            connectedAccounts: false,
            upstreamLinks: false,
            serverSelection: false,
            startupAnnouncement: true,
            invitationRegistration: true,
            androidSelfUpdate: true,
        });
    });
});
```

Test `getServerUrl()` with MMKV/runtime/env values set to hostile alternatives;
production must still return `https://103.250.173.136`. A development-only helper
may accept localhost only when `__DEV__` is true.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/policy.test.ts sources/sync/serverConfig.test.ts`

Expected: FAIL because the policy module is absent and server overrides still win.

- [ ] **Step 3: Implement immutable policy and production relay**

```ts
export const CHIMERA_POLICY = Object.freeze({
    voice: false,
    pushNotifications: false,
    analytics: false,
    purchases: false,
    upstreamOta: false,
    remoteLogging: false,
    connectedAccounts: false,
    upstreamLinks: false,
    serverSelection: false,
    startupAnnouncement: true,
    invitationRegistration: true,
    androidSelfUpdate: true,
} as const);
```

Make production `getServerUrl()` return generated `RELAY_ORIGIN` before reading
storage/runtime/env input. Keep `setServerUrl()` usable only in development and
throw in production so hidden routes cannot mutate policy indirectly.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/policy.test.ts sources/sync/serverConfig.test.ts && pnpm --filter happy-app typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/chimera packages/happy-app/sources/sync/serverConfig.ts packages/happy-app/sources/sync/serverConfig.test.ts
git commit -m "feat(app): lock production policy and relay"
```

### Task 3: Convert Expo Configuration To Chimera

**Files:**
- Modify: `packages/happy-app/app.config.js`
- Modify: `packages/happy-app/package.json`
- Modify: `packages/happy-app/sources/app/_layout.tsx`
- Modify: `packages/happy-app/sources/hooks/useInboxHasContent.ts`
- Delete: `packages/happy-app/sources/hooks/useUpdates.ts`
- Delete: `packages/happy-app/sources/hooks/useNativeUpdate.ts`
- Delete: `packages/happy-app/sources/components/UpdateBanner.tsx`
- Modify: `packages/happy-app/sources/app/(app)/settings/language.tsx`
- Modify: `packages/happy-app/sources/sync/storage.ts`
- Modify: `packages/happy-app/sources/sync/sync.ts`
- Delete: `packages/happy-app/google-services.json`
- Create: `scripts/verify-chimera-expo.mjs`

- [ ] **Step 1: Write a config verification script that initially fails**

The script loads Expo config with `APP_ENV=production` and asserts:

```js
assert.equal(config.name, 'Chimera');
assert.equal(config.slug, 'chimera');
assert.equal(config.android.package, 'org.chimerahub.chimera');
assert.deepEqual(config.scheme, ['chimera', 'happy']);
assert.equal(config.updates.enabled, false);
assert.equal(config.android.googleServicesFile, undefined);
assert(!config.plugins.some((plugin) => JSON.stringify(plugin).includes('notification')));
assert(!config.android.permissions.includes('android.permission.RECORD_AUDIO'));
assert(!config.android.permissions.includes('android.permission.POST_NOTIFICATIONS'));
```

- [ ] **Step 2: Run and observe failure against Happy config**

Run: `node scripts/verify-chimera-expo.mjs`

Expected: FAIL on product name/application ID/upstream OTA.

- [ ] **Step 3: Update Expo config from generated metadata**

Remove upstream owner/project ID/update URL, Firebase file, push plugin,
microphone permissions, voice-only plugins, location/calendar permissions not
used by retained features, upstream associated domains, and iOS submission data.
Set `updates: { enabled: false }`, Chimera icons/splash/favicon, both schemes, and
generated Android identity/version. `app.config.js` reads
`../../brand/chimera/product.json` directly because Node cannot import the
generated TypeScript runtime module.

- [ ] **Step 4: Remove exclusively disabled packages after import scan**

Run before editing: `rg -n "livekit|revenuecat|posthog|expo-notifications|react-native-webrtc|expo-audio" packages/happy-app/sources packages/happy-app/package.json`

Delete a dependency only after all retained imports are removed. Run
`pnpm install --lockfile-only` after package changes; never use npm/yarn.

- [ ] **Step 5: Remove disabled root initialization**

In `_layout.tsx`, remove push registration, analytics screen tracking, native
update hooks tied to EAS, and voice initialization. Retain encryption,
navigation, storage, localization, and sync providers.

Remove the upstream `UpdateBanner`, `useUpdates`, and `useNativeUpdate` path;
remove update state from sync storage and server version polling; stop counting an
OTA update as inbox content. Replace language-change reload behavior with retained
local state/navigation behavior rather than calling Expo Updates. The verified
Chimera APK updater is added only by the distribution plan.

- [ ] **Step 6: Verify config and build graph**

Run: `node scripts/verify-chimera-expo.mjs && pnpm --filter happy-app typecheck && pnpm --filter happy-app exec vitest run`

Expected: config check, typecheck, and unit suite PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-app/app.config.js packages/happy-app/package.json packages/happy-app/sources/app/_layout.tsx packages/happy-app/sources/hooks/useInboxHasContent.ts 'packages/happy-app/sources/app/(app)/settings/language.tsx' packages/happy-app/sources/sync/storage.ts packages/happy-app/sources/sync/sync.ts scripts/verify-chimera-expo.mjs pnpm-lock.yaml
git add -u packages/happy-app/google-services.json packages/happy-app/sources/hooks/useUpdates.ts packages/happy-app/sources/hooks/useNativeUpdate.ts packages/happy-app/sources/components/UpdateBanner.tsx
git commit -m "feat(app): remove upstream native integrations"
```

### Task 4: Trim Settings And Runtime Entry Points

**Files:**
- Create: `packages/happy-app/sources/chimera/visibleSettings.ts`
- Create: `packages/happy-app/sources/chimera/visibleSettings.test.ts`
- Modify: `packages/happy-app/sources/components/SettingsView.tsx`
- Modify: `packages/happy-app/sources/components/AgentInput.tsx`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`
- Modify: `packages/happy-app/sources/app/(app)/_layout.tsx`
- Modify: `packages/happy-app/sources/app/(app)/dev/index.tsx`

- [ ] **Step 1: Write the retained settings contract**

```ts
expect(getVisibleSettingIds({ isDevelopment: false })).toEqual([
    'terminal-connect', 'machines', 'account', 'appearance', 'agent-defaults', 'features',
]);
expect(getVisibleSettingIds({ isDevelopment: false })).not.toEqual(
    expect.arrayContaining(['support', 'connected-accounts', 'voice', 'changelog', 'about', 'server']),
);
```

- [ ] **Step 2: Verify the contract fails**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/visibleSettings.test.ts`

Expected: FAIL because no declarative setting IDs exist.

- [ ] **Step 3: Drive SettingsView from the retained list**

Extract row IDs/content into focused render helpers. Remove support, connected
accounts, voice, changelog, about, upstream links, and production developer/server
selection. Keep logo/build details, terminal pairing, machines, account,
appearance, agent defaults, and retained features.

- [ ] **Step 4: Remove voice entry points outside settings**

Guard/remove microphone buttons and session voice lifecycle calls from
`AgentInput.tsx` and `SessionView.tsx`. Remove voice routes from authenticated
layout so direct navigation cannot render them. Remove the production server
route and developer server controls.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/visibleSettings.test.ts && pnpm --filter happy-app typecheck`

Expected: PASS with no unreachable route/import errors.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/chimera/visibleSettings.ts packages/happy-app/sources/chimera/visibleSettings.test.ts packages/happy-app/sources/components/SettingsView.tsx packages/happy-app/sources/components/AgentInput.tsx packages/happy-app/sources/-session/SessionView.tsx 'packages/happy-app/sources/app/(app)/_layout.tsx' 'packages/happy-app/sources/app/(app)/dev/index.tsx'
git commit -m "feat(app): expose only Chimera client features"
```

### Task 5: Make Telemetry, Purchases, Push, And Remote Logs Inert

**Files:**
- Modify: `packages/happy-app/sources/track/index.ts`
- Modify: `packages/happy-app/sources/track/tracking.ts`
- Modify: `packages/happy-app/sources/track/useTrackScreens.ts`
- Modify: `packages/happy-app/sources/auth/AuthContext.tsx`
- Modify: `packages/happy-app/sources/sync/sync.ts`
- Modify: `packages/happy-app/sources/utils/consoleLogging.ts`
- Create: `packages/happy-app/sources/chimera/noOfficialTraffic.test.ts`

- [ ] **Step 1: Write module-level no-traffic tests**

Mock `fetch`, Axios, PostHog, RevenueCat, push registration, and remote logger;
import/execute production initialization and logout. Assert none of the disabled
clients initialize or send a request while normal sync cleanup still runs.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/noOfficialTraffic.test.ts`

Expected: FAIL because current initialization reaches tracking/push/purchase code.

- [ ] **Step 3: Replace tracking exports with typed no-ops**

Keep exported function signatures so upstream call sites merge cleanly, but make
their implementation synchronous no-ops. Remove SDK construction and environment
key reads.

- [ ] **Step 4: Remove push/OTA logout behavior and remote logging**

Logout clears local persistence and credentials only. It must not unregister a
push token or call Expo Updates. `consoleLogging.ts` writes locally only and
rejects production remote log URLs.

- [ ] **Step 5: Run tests, typecheck, and host scan**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/noOfficialTraffic.test.ts && pnpm --filter happy-app typecheck && rg -n "cluster-fluster|happy\.engineering|slopus\.com|posthog|revenuecat|elevenlabs|u\.expo\.dev" packages/happy-app/sources packages/happy-app/app.config.js`

Expected: tests/typecheck PASS; scan output contains only test fixtures or explicit
denylist constants, never a production endpoint/config.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/track packages/happy-app/sources/auth/AuthContext.tsx packages/happy-app/sources/sync/sync.ts packages/happy-app/sources/utils/consoleLogging.ts packages/happy-app/sources/chimera/noOfficialTraffic.test.ts
git commit -m "feat(app): disable official telemetry and services"
```

### Task 6: Implement Challenge-Bound Authentication And Invitations

**Files:**
- Create: `packages/happy-app/sources/auth/authChallengeV2.ts`
- Create: `packages/happy-app/sources/auth/authChallengeV2.test.ts`
- Modify: `packages/happy-app/sources/auth/authGetToken.ts`
- Modify: `packages/happy-app/sources/app/(app)/index.tsx`
- Create: `packages/happy-app/sources/app/(app)/register.tsx`

- [ ] **Step 1: Write canonical-payload tests**

```ts
expect(createAuthPayload({
    version: 2,
    origin: 'https://103.250.173.136',
    purpose: 'chimera-account-auth',
    challengeId: 'challenge-id',
    nonce: 'base64url-nonce',
    publicKey: 'base64-public-key',
    expiresAt: '2026-07-19T10:00:00.000Z',
})).toBe('chimera-auth-v2\nhttps://103.250.173.136\nchimera-account-auth\nchallenge-id\nbase64url-nonce\nbase64-public-key\n2026-07-19T10:00:00.000Z');
```

Also reject a different origin, purpose, malformed base64, or expiry outside the
server response schema.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/auth/authChallengeV2.test.ts`

Expected: FAIL because the v2 helper does not exist.

- [ ] **Step 3: Implement the two-step client**

Define strict Zod response schemas. `authGetToken(secret, inviteCode?)` derives
the public key, posts it to `/v1/auth/challenge`, validates fixed origin/purpose,
signs the canonical bytes, then completes `/v1/auth` with challenge ID/signature
and optional invite. Do not retain the upstream client-selected challenge path.

- [ ] **Step 4: Add invite-aware registration UI**

Replace direct “Create account” with `/register`. The screen contains one invite
input, submit/cancel, loading state, and a single generic invalid/expired/used
  error. On submit, generate the account secret in memory, use it to derive the
  public key and complete the challenge/invitation transaction, and persist the
  secret plus token only after success. On any failure, zero the temporary bytes
  where supported and discard them; never log or persist the invitation.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter happy-app exec vitest run sources/auth/authChallengeV2.test.ts && pnpm --filter happy-app typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/auth packages/happy-app/sources/app/'(app)'/index.tsx packages/happy-app/sources/app/'(app)'/register.tsx
git commit -m "feat(app): require invite-backed nonce authentication"
```

### Task 7: Fetch And Show Startup Announcements

**Files:**
- Create: `packages/happy-app/sources/chimera/config.ts`
- Create: `packages/happy-app/sources/chimera/config.test.ts`
- Create: `packages/happy-app/sources/chimera/useStartupAnnouncement.ts`
- Create: `packages/happy-app/sources/chimera/useStartupAnnouncement.test.ts`
- Modify: `packages/happy-app/sources/app/_layout.tsx`

- [ ] **Step 1: Write schema and orchestration tests**

Test enabled/disabled configs, max lengths, control-character rejection, HTTPS-
only links, fixed update manifest path, 1500 ms timeout, invalid JSON, once per
mounted runtime, and a fresh display after remount/new page load.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/config.test.ts sources/chimera/useStartupAnnouncement.test.ts`

Expected: FAIL because config/announcement helpers do not exist.

- [ ] **Step 3: Implement strict config fetch**

```ts
export const ChimeraConfigSchema = z.object({
    announcement: z.object({
        enabled: z.boolean(),
        title: z.string().max(120),
        body: z.string().max(4000),
        primaryButtonLabel: z.string().max(40),
        linkButtonLabel: z.string().max(40).nullable(),
        linkUrl: z.string().url().refine((value) => value.startsWith('https://')).nullable(),
    }),
    androidUpdateManifestPath: z.literal('/downloads/chimera-update.json'),
}).strict();
```

Use `AbortController` with 1500 ms timeout and return `null` for any network,
status, parse, or validation failure.

- [ ] **Step 4: Implement modal sequencing**

Mount the hook once after root navigation is ready. Use the existing `Modal.alert`
or a focused custom modal for primary/optional link buttons. Store only an
in-memory shown flag. Never block initial navigation and never persist dismissal.

- [ ] **Step 5: Run tests and full app verification**

Run: `pnpm --filter happy-app exec vitest run sources/chimera/config.test.ts sources/chimera/useStartupAnnouncement.test.ts && pnpm --filter happy-app typecheck && pnpm --filter happy-app exec expo export --platform web`

Expected: tests/typecheck PASS and web export completes.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/chimera packages/happy-app/sources/app/_layout.tsx
git commit -m "feat(app): add remote startup announcement"
```

### Task 8: Add A Production Policy Gate

**Files:**
- Create: `scripts/verify-chimera-client.mjs`
- Create: `scripts/verify-chimera-client.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write mutation tests for the gate**

Fixtures must prove the checker fails when a production file adds a Happy logo,
official host, server selector, voice button, push plugin, PostHog/RevenueCat/
ElevenLabs initialization, Expo project ID, or removed settings ID. It must pass
denylist constants and explicit test fixtures.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/verify-chimera-client.test.mjs`

Expected: FAIL because the checker does not exist.

- [ ] **Step 3: Implement structured and bundle scans**

Parse JSON/JS config through Node/Expo APIs where possible. Scan source and
production web export with explicit include/exclude roots and fail on unknown
matches. Print only path/rule, never matched secret-like values.

- [ ] **Step 4: Run all client gates**

Run: `pnpm chimera:brand:check && node scripts/verify-chimera-expo.mjs && node scripts/verify-chimera-client.test.mjs && node scripts/verify-chimera-client.mjs && pnpm --filter happy-app typecheck && pnpm --filter happy-app exec vitest run`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-chimera-client.mjs scripts/verify-chimera-client.test.mjs package.json
git commit -m "test(app): gate Chimera production policy"
```
