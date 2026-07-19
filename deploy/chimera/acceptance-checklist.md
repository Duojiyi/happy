# Chimera Production Acceptance

This file records non-secret deployment evidence only. Never add passwords,
cookies, invitations, private keys, or master secrets.

## Release identity

- Commit: pending
- Version: pending
- Android APK SHA-256: pending
- Android signer SHA-256: `58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93`
- Web release: pending

## Public endpoints

- Relay/Web: `https://39.98.68.173`
- Control panel: `https://39.98.68.173/chimera-control/`
- Update manifest: `https://39.98.68.173/downloads/chimera-update.json`

## Required acceptance

- [ ] TLS certificate is valid for IP SAN `39.98.68.173`.
- [ ] Caddy obtained and automatically renews a Let's Encrypt short-lived IP certificate; no internal/self-signed fallback is enabled.
- [ ] Only SSH, HTTP, and HTTPS are publicly reachable.
- [ ] Health, WebSocket, Web, control panel, and update routes pass smoke checks.
- [ ] Invitation create/use/expire/revoke flows pass.
- [ ] Android and Web registration require an invitation.
- [ ] Announcement enable/disable and every-start presentation pass.
- [ ] Disabled accounts lose REST and live socket access.
- [ ] Attachment quota, cleanup, and restart reconciliation pass.
- [ ] Signed APK installs with Android system confirmation only.
- [ ] Android update downgrade, hash, signer, package, and version failures are rejected.
- [ ] The pinned Ed25519 public key and Android Build Tools 35.0.0 were provisioned before enabling the Android deploy identity.
- [ ] Web and server rollback procedures pass.
- [ ] Backup identifier, certificate expiry, and automatic renewal evidence are recorded below.

## Evidence

- Certificate expiry: pending
- Certificate renewal: pending
- Backup identifier: pending
- Rollback release: pending
- Local gate result: pending
- External smoke result: pending
- Final audit result: pending
