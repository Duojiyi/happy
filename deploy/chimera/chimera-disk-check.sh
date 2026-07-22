#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ "${EUID:-$(id -u)}" == 0 ]] || { echo 'disk monitor must run as root' >&2; exit 1; }
mountpoint -q /srv/chimera-storage || { echo 'dedicated Chimera storage is not mounted' >&2; exit 1; }

percent_used() {
  local value
  value=$(df --output=pcent "$1" | tail -n 1 | tr -cd '0-9')
  [[ "$value" =~ ^[0-9]+$ && "$value" -le 100 ]] || return 1
  printf '%s' "$value"
}

directory_bytes() {
  if [[ -d "$1" && ! -L "$1" ]]; then du -s -B1 "$1" | cut -f1; else printf '0'; fi
}

ROOT_USED=$(percent_used /)
STORAGE_USED=$(percent_used /srv/chimera-storage)
SNAPSHOT_BYTES=$(directory_bytes /srv/chimera-storage/snapshots)
WEB_BYTES=$(directory_bytes /opt/chimera/web/releases)
DOWNLOAD_BYTES=$(directory_bytes /opt/chimera/downloads)
DOCKER_BYTES=$(directory_bytes /var/lib/docker)
for value in "$SNAPSHOT_BYTES" "$WEB_BYTES" "$DOWNLOAD_BYTES" "$DOCKER_BYTES"; do [[ "$value" =~ ^[0-9]+$ ]]; done

STATUS=ok
if (( ROOT_USED >= 70 || STORAGE_USED >= 70 )); then STATUS=critical; fi
install -d -m 0750 -o root -g root /opt/chimera/state
TMP=$(mktemp /opt/chimera/state/.disk-monitor.XXXXXX)
trap 'rm -f -- "$TMP"' EXIT
printf '{"schemaVersion":1,"status":"%s","checkedAt":"%s","rootUsedPercent":%s,"storageUsedPercent":%s,"snapshotBytes":%s,"webReleaseBytes":%s,"downloadBytes":%s,"dockerBytes":%s}\n' \
  "$STATUS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ROOT_USED" "$STORAGE_USED" "$SNAPSHOT_BYTES" "$WEB_BYTES" "$DOWNLOAD_BYTES" "$DOCKER_BYTES" > "$TMP"
chmod 0640 "$TMP"
mv -f -- "$TMP" /opt/chimera/state/disk-monitor.json
trap - EXIT
logger -t chimera-disk-check "status=$STATUS root_used=$ROOT_USED storage_used=$STORAGE_USED"
test "$STATUS" = ok
