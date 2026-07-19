#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/chimera
RELEASE_DIR="$ROOT/releases/${1:?release archive required}"

install -d -m 0750 "$RELEASE_DIR" "$ROOT/config" "$ROOT/backups" "$ROOT/web/releases" "$ROOT/downloads"
tar --extract --file "${2:?archive path required}" --directory "$RELEASE_DIR"
install -m 0640 "$RELEASE_DIR/deploy/chimera/docker-compose.yml" "$ROOT/docker-compose.yml"
install -m 0640 "$RELEASE_DIR/deploy/chimera/Caddyfile" "$ROOT/Caddyfile"

test -s "$ROOT/config/production.env"
test -f "$ROOT/web/current/index.html"
chmod 0600 "$ROOT/config/production.env"

docker build --pull -t "chimera-relay:${1}" -f "$RELEASE_DIR/Dockerfile.server" "$RELEASE_DIR"
export CHIMERA_IMAGE="chimera-relay:${1}"
docker compose -f "$ROOT/docker-compose.yml" config >/dev/null
docker compose -f "$ROOT/docker-compose.yml" up -d --remove-orphans
docker compose -f "$ROOT/docker-compose.yml" ps
