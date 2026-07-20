#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 3 ]] || { printf 'usage: %s <server-key> <android-key> <web-key>\n' "$0" >&2; exit 2; }
server_key_file="$1"
android_key_file="$2"
web_key_file="$3"
[[ "${EUID:-$(id -u)}" == 0 ]] || { printf 'installer must run as root\n' >&2; exit 1; }
for tool in python3 openssl docker skopeo gh curl flock fuser sync java findmnt mountpoint; do command -v "$tool" >/dev/null 2>&1 || { printf 'missing required host tool: %s\n' "$tool" >&2; exit 1; }; done
docker compose version >/dev/null 2>&1 || { printf 'Docker Compose plugin is required\n' >&2; exit 1; }
[[ -x /opt/android-sdk/build-tools/35.0.0/aapt2 && -x /opt/android-sdk/build-tools/35.0.0/apksigner ]] || { printf 'Android Build Tools 35.0.0 must be provisioned first\n' >&2; exit 1; }
mountpoint -q /srv/chimera-storage || { printf 'dedicated Chimera data filesystem is required\n' >&2; exit 1; }
[[ -d /srv/chimera-storage && ! -L /srv/chimera-storage && "$(stat -c '%u' /srv/chimera-storage)" == 0 ]] || exit 1
[[ "$(stat -c '%d' /srv/chimera-storage)" != "$(stat -c '%d' /)" ]] || exit 1
(( $(df --output=size -B1 /srv/chimera-storage | tail -n 1 | tr -d ' ') >= 29 * 1024 * 1024 * 1024 )) || exit 1
for path in /srv/chimera-storage/data /srv/chimera-storage/snapshots; do
  [[ ! -e "$path" && ! -L "$path" ]] || [[ -d "$path" && ! -L "$path" && "$(stat -c '%u' "$path")" == 0 ]] || exit 1
done

install_role() {
  local role="$1" key_file="$2"
  local user="chimera-$role-deploy"
  local home="/var/lib/$user"
  local helper="/usr/local/bin/chimera-$role-helper"
  [[ -f "$key_file" ]] || exit 1
  if ! id "$user" >/dev/null 2>&1; then
    useradd --create-home --home-dir "$home" --shell /bin/bash "$user"
  fi
  install -d -m 0700 -o "$user" -g "$user" "$home/.ssh"
  install -d -m 0750 -o "$user" -g "$user" "$home/.chimera-staging/$role"
  local key
  key="$(tr -d '\r\n' < "$key_file")"
  [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+([[:space:]][A-Za-z0-9._@-]+)?$ ]] || exit 1
  printf 'command="%s",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty %s\n' "$helper" "$key" > "$home/.ssh/authorized_keys"
  chown "$user:$user" "$home/.ssh/authorized_keys"
  chmod 0600 "$home/.ssh/authorized_keys"
}

install -d -m 0755 /usr/local/bin /usr/local/libexec
install -m 0755 deploy/chimera/bin/chimera-server-helper /usr/local/bin/chimera-server-helper
install -m 0755 deploy/chimera/bin/chimera-android-helper /usr/local/bin/chimera-android-helper
install -m 0755 deploy/chimera/bin/chimera-web-helper /usr/local/bin/chimera-web-helper
install -m 0755 deploy/chimera/deploy-server.sh /usr/local/libexec/chimera-server-deploy
install -m 0755 deploy/chimera/libexec/chimera-android-activate /usr/local/libexec/chimera-android-activate
install -m 0755 deploy/chimera/libexec/chimera-apk-inspect /usr/local/libexec/chimera-apk-inspect
install -m 0755 deploy/chimera/libexec/chimera-validate-android-release /usr/local/libexec/chimera-validate-android-release
install -m 0755 deploy/chimera/libexec/chimera-web-activate /usr/local/libexec/chimera-web-activate
install -m 0755 deploy/chimera/libexec/chimera-validate-web-archive /usr/local/libexec/chimera-validate-web-archive
install -m 0440 deploy/chimera/sudoers/chimera-deploy /etc/sudoers.d/chimera-deploy
visudo -cf /etc/sudoers.d/chimera-deploy >/dev/null

install_role server "$server_key_file"
install_role android "$android_key_file"
install_role web "$web_key_file"

# Runtime targets stay root-owned. Deploy identities can write only their own
# staging tree; their exact sudo helper performs validated activation.
install -d -m 0755 /opt/chimera /opt/chimera/downloads /opt/chimera/downloads/releases /opt/chimera/web /opt/chimera/web/releases /opt/chimera/config /opt/chimera/proxy-config
install -d -m 0750 /srv/chimera-storage/data /srv/chimera-storage/snapshots
install -d -m 0755 /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/srv/chimera-storage\n' > /etc/systemd/system/docker.service.d/chimera-storage.conf
chmod 0644 /etc/systemd/system/docker.service.d/chimera-storage.conf
systemctl daemon-reload
if [[ ! -e /opt/chimera/proxy-config/maintenance.caddy ]]; then
  printf '# writes enabled\n' > /opt/chimera/proxy-config/maintenance.caddy
  chmod 0644 /opt/chimera/proxy-config/maintenance.caddy
fi
