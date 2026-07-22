#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/libexec/chimera-status-ssh-policy"
ROOT=$(mktemp -d)
trap 'rm -rf -- "$ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/config"
ALLOWLIST="$ROOT/allowlist"
SSHD_COUNT="$ROOT/sshd-count"
SYSTEMCTL_COUNT="$ROOT/systemctl-count"
export ALLOWLIST SSHD_COUNT SYSTEMCTL_COUNT

cat > "$ROOT/bin/sshd" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -T ]]; then cat "$ALLOWLIST"; exit 0; fi
[[ "$1" == -t ]]
count=$(($(cat "$SSHD_COUNT" 2>/dev/null || echo 0) + 1))
printf '%s\n' "$count" > "$SSHD_COUNT"
[[ "${FAIL_SSHD_ONCE:-0}" == 1 && "$count" == 1 ]] && exit 1
exit 0
MOCK
cat > "$ROOT/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == reload && "$2" == ssh ]]
count=$(($(cat "$SYSTEMCTL_COUNT" 2>/dev/null || echo 0) + 1))
printf '%s\n' "$count" > "$SYSTEMCTL_COUNT"
[[ "${FAIL_RELOAD_ONCE:-0}" == 1 && "$count" == 1 ]] && exit 1
exit 0
MOCK
chmod 0755 "$ROOT/bin/sshd" "$ROOT/bin/systemctl"

assert_content() { [[ "$(cat "$1")" == "$2" ]] || { echo "unexpected content: $1" >&2; exit 1; }; }
reset_counts() { rm -f -- "$SSHD_COUNT" "$SYSTEMCTL_COUNT"; }
printf '' > "$ALLOWLIST"
if activate_status_ssh_policy "$ROOT/config" chimera-status-monitor "$ROOT/bin/sshd" "$ROOT/bin/systemctl"; then
  echo 'empty baseline allowlist was accepted' >&2
  exit 1
fi
[[ ! -e "$ROOT/config/99-chimera-status-monitor.conf" && ! -e "$SYSTEMCTL_COUNT" ]]

printf '%s\n' 'allowusers root' 'allowusers chimera-server-deploy' 'allowusers chimera-android-deploy' 'allowusers chimera-web-deploy' > "$ALLOWLIST"
activate_status_ssh_policy "$ROOT/config" chimera-status-monitor "$ROOT/bin/sshd" "$ROOT/bin/systemctl"
assert_content "$ROOT/config/99-chimera-status-monitor.conf" 'AllowUsers chimera-status-monitor'
activate_status_ssh_policy "$ROOT/config" chimera-status-monitor "$ROOT/bin/sshd" "$ROOT/bin/systemctl"
assert_content "$ROOT/config/99-chimera-status-monitor.conf" 'AllowUsers chimera-status-monitor'
[[ "$(cat "$SYSTEMCTL_COUNT")" == 2 ]]

printf '%s\n' 'AllowUsers previous-monitor' > "$ROOT/config/99-chimera-status-monitor.conf"
reset_counts
export FAIL_SSHD_ONCE=1
if activate_status_ssh_policy "$ROOT/config" chimera-status-monitor "$ROOT/bin/sshd" "$ROOT/bin/systemctl"; then exit 1; fi
unset FAIL_SSHD_ONCE
assert_content "$ROOT/config/99-chimera-status-monitor.conf" 'AllowUsers previous-monitor'
[[ "$(cat "$SYSTEMCTL_COUNT")" == 1 ]]

reset_counts
export FAIL_RELOAD_ONCE=1
if activate_status_ssh_policy "$ROOT/config" chimera-status-monitor "$ROOT/bin/sshd" "$ROOT/bin/systemctl"; then exit 1; fi
unset FAIL_RELOAD_ONCE
assert_content "$ROOT/config/99-chimera-status-monitor.conf" 'AllowUsers previous-monitor'
[[ "$(cat "$SYSTEMCTL_COUNT")" == 2 ]]
echo 'Chimera status SSH policy fixture passed.'
