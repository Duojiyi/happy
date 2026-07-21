#!/usr/bin/env bash
set -euo pipefail
umask 027

ROOT=/opt/chimera
[[ "${EUID:-$(id -u)}" == 0 && "$#" -eq 2 && "$1" =~ ^[a-f0-9]{40}$ ]] || { printf 'usage: %s <40-char-commit> <release.tar>\n' "$0" >&2; exit 2; }
id="$1"
archive="$2"
[[ -f "$archive" && ! -L "$archive" ]] || exit 1
exec 9>/run/lock/chimera-production.lock
flock -n 9 || exit 1

mountpoint -q /srv/chimera-storage || exit 1
[[ -d /srv/chimera-storage && ! -L /srv/chimera-storage && "$(stat -c '%u' /srv/chimera-storage)" == 0 ]] || exit 1
[[ "$(stat -c '%d' /srv/chimera-storage)" != "$(stat -c '%d' /)" ]] || exit 1
(( $(df --output=size -B1 /srv/chimera-storage | tail -n 1 | tr -d ' ') >= 29 * 1024 * 1024 * 1024 )) || exit 1
for path in /srv/chimera-storage/data /srv/chimera-storage/snapshots; do
  [[ ! -e "$path" && ! -L "$path" ]] || [[ -d "$path" && ! -L "$path" && "$(stat -c '%u' "$path")" == 0 ]] || exit 1
done
install -d -m 0755 "$ROOT/releases" "$ROOT/state" "$ROOT/downloads" "$ROOT/downloads/releases" "$ROOT/web" "$ROOT/web/releases" "$ROOT/config" "$ROOT/proxy-config"
install -d -m 2770 -o root -g 65532 /srv/chimera-storage/data
install -d -m 0750 -o root -g root /srv/chimera-storage/snapshots
frozen="$ROOT/releases/.incoming-$id.tar"
incoming="$ROOT/releases/.incoming-$id"
release="$ROOT/releases/$id"
[[ ! -e "$frozen" && ! -e "$incoming" && ! -e "$release" ]] || exit 1
install -m 0600 "$archive" "$frozen"
trap 'rm -rf -- "$frozen" "$incoming"' EXIT
python3 - "$frozen" <<'PY'
import pathlib,sys,tarfile
seen=set()
with tarfile.open(sys.argv[1], "r:*") as bundle:
    for member in bundle.getmembers():
        path=pathlib.PurePosixPath(member.name.replace("\\", "/"))
        normalized=str(path).removeprefix("./")
        if not normalized or path.is_absolute() or ".." in path.parts or normalized in seen: raise SystemExit(1)
        if not (member.isfile() or member.isdir()) or member.issym() or member.islnk() or member.isdev(): raise SystemExit(1)
        seen.add(normalized)
required={"Dockerfile.server","deploy/chimera/docker-compose.yml","deploy/chimera/Caddyfile"}
if not required.issubset(seen): raise SystemExit(1)
PY
install -d -m 0750 "$incoming"
tar --extract --file "$frozen" --directory "$incoming" --no-same-owner --no-same-permissions
find "$incoming" -type d -exec chmod 0750 {} +
find "$incoming" -type f -exec chmod 0640 {} +
mv -- "$incoming" "$release"
sync -f "$ROOT/releases"

[[ -s "$ROOT/config/production.env" && -s "$ROOT/config/update-manifest-public.pem" ]] || exit 1
[[ -f "$ROOT/web/current/index.html" ]] || exit 1
chmod 0600 "$ROOT/config/production.env"
install -m 0640 "$release/deploy/chimera/docker-compose.yml" "$ROOT/docker-compose.yml"
install -m 0644 "$release/deploy/chimera/Caddyfile" "$ROOT/Caddyfile"
[[ -f "$ROOT/proxy-config/maintenance.caddy" ]] || printf '# writes enabled\n' > "$ROOT/proxy-config/maintenance.caddy"
chmod 0644 "$ROOT/proxy-config/maintenance.caddy"

legacy_id="$(printf 'chimera-bootstrap:%s' "$id" | sha1sum | cut -d ' ' -f 1)"
[[ "$legacy_id" =~ ^[a-f0-9]{40}$ && "$legacy_id" != "$id" ]] || exit 1
docker build --pull --tag "chimera-relay:$legacy_id" --file "$release/Dockerfile.server" "$release"
docker run --rm --network none --env NODE_ENV=production --env DB_PROVIDER=pglite \
  --env PGLITE_DIR=/var/lib/chimera/pglite --env DATA_DIR=/var/lib/chimera \
  --volume /srv/chimera-storage/data:/var/lib/chimera --entrypoint /nodejs/bin/node \
  "chimera-relay:$legacy_id" dist/standalone.mjs migrate
CHIMERA_IMAGE="chimera-relay:$legacy_id" docker compose --file "$ROOT/docker-compose.yml" config >/dev/null
CHIMERA_IMAGE="chimera-relay:$legacy_id" docker compose --file "$ROOT/docker-compose.yml" up -d --remove-orphans
healthy=0
for attempt in {1..60}; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >/dev/null; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" -eq 1 ]] || exit 1
tls_healthy=0
for attempt in {1..90}; do
  if curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 5 https://103.250.173.136/health >/dev/null; then tls_healthy=1; break; fi
  sleep 2
done
[[ "$tls_healthy" -eq 1 ]] || exit 1
printf 'chimera-relay:%s\n' "$legacy_id" > "$ROOT/state/current-image.next"
docker image inspect --format '{{.Id}}' "chimera-relay:$legacy_id" > "$ROOT/state/current-digest.next"
sync -f "$ROOT/state/current-image.next"
sync -f "$ROOT/state/current-digest.next"
mv -f -- "$ROOT/state/current-image.next" "$ROOT/state/current-image"
mv -f -- "$ROOT/state/current-digest.next" "$ROOT/state/current-digest"
sync -f "$ROOT/state"
rm -f -- "$frozen"
trap - EXIT
