#!/usr/bin/env bash
set -euo pipefail

host="${1:-39.98.68.173}"
base="https://${host}"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$base/health" >/dev/null
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$base/v1/chimera/config" >/dev/null
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$base/downloads/chimera-update.json" >/dev/null
printf 'Chimera smoke checks passed for %s\n' "$host"
