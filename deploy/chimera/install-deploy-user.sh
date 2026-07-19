#!/usr/bin/env bash
set -euo pipefail

public_key_file="${1:?public key file required}"
[[ -f "$public_key_file" ]] || exit 1

if ! id chimera-deploy >/dev/null 2>&1; then
  useradd --create-home --home-dir /var/lib/chimera-deploy --shell /bin/bash chimera-deploy
fi
install -d -m 0700 -o chimera-deploy -g chimera-deploy /var/lib/chimera-deploy/.ssh
install -d -m 0750 -o chimera-deploy -g chimera-deploy /var/lib/chimera-deploy/.chimera-staging/android
install -d -m 0750 -o chimera-deploy -g chimera-deploy /var/lib/chimera-deploy/.chimera-staging/web
install -m 0755 deploy/chimera/bin/chimera-activate /usr/local/sbin/chimera-activate

key="$(tr -d '\r\n' < "$public_key_file")"
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ [A-Za-z0-9._@-]+$ ]] || exit 1
printf 'command="/usr/local/sbin/chimera-activate",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty %s\n' "$key" \
  > /var/lib/chimera-deploy/.ssh/authorized_keys
chown chimera-deploy:chimera-deploy /var/lib/chimera-deploy/.ssh/authorized_keys
chmod 0600 /var/lib/chimera-deploy/.ssh/authorized_keys
