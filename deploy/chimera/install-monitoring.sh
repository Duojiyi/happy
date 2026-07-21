#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ "${EUID:-$(id -u)}" == 0 && "$#" -eq 1 ]] || { echo 'usage: install-monitoring.sh <status-monitor-public-key>' >&2; exit 2; }
STATUS_KEY_FILE="$1"
[[ -f "$STATUS_KEY_FILE" && ! -L "$STATUS_KEY_FILE" ]] || { echo 'status monitor public key is missing' >&2; exit 1; }
for file in \
  deploy/chimera/chimera-disk-check.sh \
  deploy/chimera/chimera-disk-status \
  deploy/chimera/bin/chimera-status-helper \
  deploy/chimera/sudoers/chimera-deploy \
  deploy/chimera/systemd/chimera-disk-check.service \
  deploy/chimera/systemd/chimera-disk-check.timer; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "missing reviewed bootstrap file: $file" >&2; exit 1; }
done
mountpoint -q /srv/chimera-storage || { echo 'dedicated Chimera storage is not mounted' >&2; exit 1; }

SUDOERS_TMP=$(mktemp /etc/sudoers.d/.chimera-deploy.XXXXXX)
trap 'rm -f -- "$SUDOERS_TMP"' EXIT
install -m 0440 deploy/chimera/sudoers/chimera-deploy "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null
mv -f -- "$SUDOERS_TMP" /etc/sudoers.d/chimera-deploy
trap - EXIT
install -m 0755 deploy/chimera/bin/chimera-status-helper /usr/local/bin/chimera-status-helper
install -m 0755 deploy/chimera/chimera-disk-check.sh /usr/local/libexec/chimera-disk-check
install -m 0755 deploy/chimera/chimera-disk-status /usr/local/libexec/chimera-disk-status
install -m 0644 deploy/chimera/systemd/chimera-disk-check.service /etc/systemd/system/chimera-disk-check.service
install -m 0644 deploy/chimera/systemd/chimera-disk-check.timer /etc/systemd/system/chimera-disk-check.timer
install -d -m 0755 -o root -g root /opt/chimera/state
STATUS_USER=chimera-status-monitor
STATUS_HOME=/var/lib/chimera-status-monitor
if ! id "$STATUS_USER" >/dev/null 2>&1; then useradd --create-home --home-dir "$STATUS_HOME" --shell /bin/bash "$STATUS_USER"; fi
install -d -m 0700 -o "$STATUS_USER" -g "$STATUS_USER" "$STATUS_HOME/.ssh"
STATUS_KEY="$(tr -d '\r\n' < "$STATUS_KEY_FILE")"
[[ "$STATUS_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+([[:space:]][A-Za-z0-9._@-]+)?$ ]] || { echo 'invalid status monitor public key' >&2; exit 1; }
printf 'command="/usr/local/bin/chimera-status-helper",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty %s\n' "$STATUS_KEY" > "$STATUS_HOME/.ssh/authorized_keys"
chown "$STATUS_USER:$STATUS_USER" "$STATUS_HOME/.ssh/authorized_keys"
chmod 0600 "$STATUS_HOME/.ssh/authorized_keys"
systemctl daemon-reload
systemctl start chimera-disk-check.service
systemctl enable --now chimera-disk-check.timer
/usr/local/bin/chimera-status-helper </dev/null 2>/dev/null && exit 1 || true
/usr/local/libexec/chimera-disk-status | grep -Fx ok >/dev/null
echo 'Chimera monitoring bootstrap installed and healthy.'
