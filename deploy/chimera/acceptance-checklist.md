# Chimera Production Acceptance

This file records non-secret deployment evidence only. Never add passwords,
cookies, invitations, private keys, or master secrets.

## Release identity

- Commit: `df295602cb1ef33c845bd2e571ff2b6c7000d296`
- Version: `1.7.0-chimera.4` (`versionCode` 4)
- Android APK SHA-256: `1ab5f9d46e50e1ed068b99a158d3706b67a83327b7a1621b3d90a35e4875c383`
- Android signer SHA-256: `58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93`
- Web release: `app-v1.7.0-chimera.4`

## Public endpoints

- Relay/Web: `https://103.250.173.136`
- Control panel: `https://103.250.173.136/chimera-control/`
- Update manifest: `https://103.250.173.136/downloads/chimera-update.json`

## Required acceptance

- [x] TLS certificate is valid for IP SAN `103.250.173.136`.
- [x] Caddy obtained and automatically renews a Let's Encrypt short-lived IP certificate; no internal/self-signed fallback is enabled.
- [x] Only SSH, HTTP, and HTTPS are publicly reachable.
- [x] Health, WebSocket, Web, control panel, and update routes pass smoke checks.
- [x] Invitation create/use/expire/revoke flows pass.
- [x] Android and Web registration require an invitation.
- [ ] Announcement enable/disable passes; every-start presentation remains a physical-device check.
- [x] Disabled accounts lose REST and live socket access.
- [x] Attachment quota, cleanup, and restart reconciliation pass.
- [ ] Signed APK installs with Android system confirmation only.
- [x] Android update downgrade, hash, signer, package, and version failures are rejected by the focused test suite; updater UI remains a physical-device check.
- [x] The pinned Ed25519 public key and Android Build Tools 35.0.0 were provisioned before enabling the Android deploy identity.
- [x] Web and server rollback procedures pass.
- [x] Backup identifier, certificate expiry, and automatic renewal evidence are recorded below.

## Evidence

- Certificate expiry: `2026-07-28T05:35:39Z`; Let's Encrypt `YE1`; SAN `103.250.173.136`.
- Certificate renewal: Caddy ACME maintenance recorded renewal information and a selected renewal window; no static or internal TLS fallback is configured.
- Backup identifier: server snapshot `9f6bc54e449fb31cd36cb94ed6f2ccbc9909c538`; the six-hour disk timer is enabled and active.
- Rollback release: Web `previous` points to `9f6bc54e449fb31cd36cb94ed6f2ccbc9909c538`; server image `chimera-relay:9f6bc54e449fb31cd36cb94ed6f2ccbc9909c538` is retained with its snapshot.
- Local gate result: focused font/config/auth tests 18/18; brand generation, `happy-wire`, app typecheck, and production API acceptance 10/10 passed.
- Build and provenance: build run `29913477335`; Android artifact `8527848446`; Web artifact `8526951842`.
- Release and public hash: protected release run `29916099233`; public check `88915558962`; APK `206` range total `297953435` bytes.
- External smoke result: monitor run `29918195611`; public and status-only disk probes passed.
- Final audit result: security check `88901823041` and maintainability check `88901833089` passed with no findings.
- Browser evidence: desktop and 390 x 844 mobile sessions rendered the Chimera login and registration UI after the 12-second font timeout boundary with no page errors.

## Physical-device acceptance pending

- Install the signed APK through Android system confirmation.
- Register with a control-panel invitation and pair with a real CLI session.
- Verify the configured announcement appears on every cold start and can be disabled centrally.
- Verify the in-app updater installs a later signed Chimera build and rejects downgrade or tampered inputs.
