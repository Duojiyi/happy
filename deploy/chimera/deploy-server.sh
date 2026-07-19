#!/usr/bin/env bash
set -euo pipefail
umask 027

readonly ROOT=/opt/chimera
readonly DATA_ROOT=/data
readonly PGLITE_ROOT="$DATA_ROOT/pglite"
readonly STAGING_ROOT=/var/lib/chimera-server-deploy/.chimera-staging/server
readonly SNAPSHOT_ROOT=/srv/chimera-snapshots
readonly RELEASE_ROOT="$ROOT/releases"
readonly STATE_ROOT="$ROOT/state"
readonly COMPOSE_FILE="$ROOT/docker-compose.yml"
readonly MAINTENANCE_FILE="$ROOT/proxy-config/maintenance.caddy"
readonly CANDIDATE_NAME=chimera-server-candidate
readonly CANDIDATE_PORT=13005
readonly LOCAL_HEALTH_URL=http://127.0.0.1:3000/health
readonly CANDIDATE_URL=http://127.0.0.1:${CANDIDATE_PORT}
readonly PUBLIC_HEALTH_URL=https://39.98.68.173/health

die() {
  printf 'Chimera server deployment rejected\n' >&2
  exit 1
}

require_root_owned_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || die
  [[ "$(stat -c '%u' "$file")" == 0 ]] || die
  (( (8#$(stat -c '%a' "$file") & 8#022) == 0 )) || die
}

validate_archive() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import pathlib, sys, tarfile

archive = pathlib.Path(sys.argv[1])
resolved_archive = archive.resolve(strict=True)
if archive.is_symlink():
    raise SystemExit(1)

files = set()
with tarfile.open(resolved_archive, "r:*") as bundle:
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(1)
        if member.issym() or member.islnk() or member.isdev() or not (member.isfile() or member.isdir()):
            raise SystemExit(1)
        normalized = str(path).removeprefix("./")
        if normalized in files:
            raise SystemExit(1)
        files.add(normalized)
if "Dockerfile.server" not in files or "deploy/chimera/docker-compose.yml" not in files:
    raise SystemExit(1)
PY
}

validate_staged_path() {
  local archive="$1"
  python3 - "$archive" "$STAGING_ROOT" <<'PY'
import pathlib, sys
archive = pathlib.Path(sys.argv[1])
staging = pathlib.Path(sys.argv[2])
if staging.is_symlink() or archive.is_symlink():
    raise SystemExit(1)
if archive.resolve(strict=True).parent != staging.resolve(strict=True):
    raise SystemExit(1)
PY
}

prepare_release() {
  local id="$1"
  local archive="$STAGING_ROOT/$id.tar.partial"
  local frozen="$RELEASE_ROOT/.incoming-$id.tar"
  local incoming="$RELEASE_ROOT/.incoming-$id"
  local release="$RELEASE_ROOT/$id"
  [[ -f "$archive" && ! -L "$archive" && ! -e "$release" ]] || die
  validate_staged_path "$archive"
  install -m 0600 "$archive" "$frozen"
  validate_archive "$frozen"
  rm -rf -- "$incoming"
  install -d -m 0750 "$incoming"
  tar --extract --file "$frozen" --directory "$incoming" --no-same-owner --no-same-permissions
  find "$incoming" -type d -exec chmod 0750 {} +
  find "$incoming" -type f -exec chmod 0640 {} +
  mv -- "$incoming" "$release"
  rm -f -- "$frozen"
  sync -f "$RELEASE_ROOT"
  docker build --pull --tag "chimera-relay:$id" --file "$release/Dockerfile.server" "$release"
}

reload_proxy() {
  docker compose --file "$COMPOSE_FILE" exec -T proxy caddy validate --config /etc/caddy/Caddyfile
  docker compose --file "$COMPOSE_FILE" exec -T proxy caddy reload --config /etc/caddy/Caddyfile
}

maintenance_on() {
  local _id="$1"
  require_root_owned_file "$MAINTENANCE_FILE"
  printf '@mutations method POST PUT PATCH DELETE\nrespond @mutations 503\n' > "$MAINTENANCE_FILE.next"
  chmod 0644 "$MAINTENANCE_FILE.next"
  sync -f "$MAINTENANCE_FILE.next"
  mv -f -- "$MAINTENANCE_FILE.next" "$MAINTENANCE_FILE"
  sync -f "$ROOT/proxy-config"
  reload_proxy
}

maintenance_off() {
  local _id="$1"
  printf '# writes enabled\n' > "$MAINTENANCE_FILE.next"
  chmod 0644 "$MAINTENANCE_FILE.next"
  sync -f "$MAINTENANCE_FILE.next"
  mv -f -- "$MAINTENANCE_FILE.next" "$MAINTENANCE_FILE"
  sync -f "$ROOT/proxy-config"
  reload_proxy
}

current_image() {
  [[ -s "$STATE_ROOT/current-image" ]] || die
  local image
  IFS= read -r image < "$STATE_ROOT/current-image"
  [[ "$image" =~ ^chimera-relay:[a-f0-9]{40}$ ]] || die
  printf '%s\n' "$image"
}

verify_url() {
  local url="$1"
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

verify_running_old() {
  local _id="$1"
  verify_url "$LOCAL_HEALTH_URL"
}

verify_public() {
  curl --fail --silent --show-error --max-time 5 "$PUBLIC_HEALTH_URL" >/dev/null
}

stop_runtime() {
  local _id="$1"
  docker compose --file "$COMPOSE_FILE" stop relay
}

assert_pglite_closed() {
  local _id="$1"
  command -v fuser >/dev/null 2>&1 || die
  if fuser -m "$PGLITE_ROOT" >/dev/null 2>&1; then
    return 1
  fi
}

check_snapshot_space() {
  local _id="$1"
  local data_bytes free_bytes required_bytes
  data_bytes="$(du -sb "$DATA_ROOT" | awk '{print $1}')"
  free_bytes="$(df --output=avail -B1 "$SNAPSHOT_ROOT" | tail -n 1 | tr -d ' ')"
  required_bytes=$(( data_bytes * 12 / 10 + 15 * 1024 * 1024 * 1024 ))
  (( free_bytes > required_bytes ))
}

create_snapshot() {
  local id="$1"
  local old_image="$2"
  local temporary="$SNAPSHOT_ROOT/.tmp-$id"
  local snapshot="$SNAPSHOT_ROOT/$id"
  [[ ! -e "$temporary" && ! -e "$snapshot" ]] || die
  install -d -m 0750 "$temporary/data"
  cp -a -- "$DATA_ROOT/." "$temporary/data/"
  install -m 0640 "$COMPOSE_FILE" "$temporary/docker-compose.yml"
  printf '%s\n' "$old_image" > "$temporary/old-image"
  sync -f "$temporary/old-image"
  find "$temporary/data" -type f -exec sync -f {} +
  sync -f "$temporary/data"
  mv -- "$temporary" "$snapshot"
  sync -f "$SNAPSHOT_ROOT"
}

open_test_path() {
  local image="$1"
  local data="$2"
  docker run --rm --network none --volume "$data:/data" --entrypoint node "$image" -e '
    import("@electric-sql/pglite").then(async ({ PGlite }) => {
      const db = new PGlite("/data/pglite");
      await db.query("select 1");
      await db.close();
    }).catch(() => process.exit(1));'
}

open_test_snapshot() {
  local id="$1"
  local old_image="$2"
  open_test_path "$old_image" "$SNAPSHOT_ROOT/$id/data"
  install -m 0640 /dev/null "$SNAPSHOT_ROOT/$id/.verified"
  sync -f "$SNAPSHOT_ROOT/$id/.verified"
}

open_test_data() {
  local id="$1"
  local image="$2"
  open_test_path "$image" "$DATA_ROOT"
}

migrate_candidate() {
  local id="$1"
  docker run --rm --network none --env NODE_ENV=production --env DB_PROVIDER=pglite \
    --env PGLITE_DIR=/data/pglite --env DATA_DIR=/data --volume "$DATA_ROOT:/data" \
    "chimera-relay:$id" pnpm --filter happy-server-self-host exec tsx ./sources/standalone.ts migrate
}

start_candidate() {
  local id="$1"
  docker rm --force "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  docker run --detach --name "$CANDIDATE_NAME" --publish "127.0.0.1:${CANDIDATE_PORT}:3000" \
    --env-file "$ROOT/config/production.env" --env NODE_ENV=production --env PORT=3000 \
    --env DB_PROVIDER=pglite --env PGLITE_DIR=/data/pglite --env DATA_DIR=/data \
    --volume "$DATA_ROOT:/data" "chimera-relay:$id" >/dev/null
}

verify_candidate() {
  local id="$1"
  local status socket_handshake file_probe
  file_probe="chimera-deploy-health-$id.txt"
  verify_url "$CANDIDATE_URL/health"
  curl --fail --silent --show-error --max-time 5 --output /dev/null "$CANDIDATE_URL/v1/chimera/config"
  status="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "$CANDIDATE_URL/v1/account/profile")"
  [[ "$status" == 401 ]]
  install -d -m 0750 "$DATA_ROOT/files"
  printf '%s\n' "$id" > "$DATA_ROOT/files/$file_probe"
  [[ "$(curl --fail --silent --show-error --max-time 5 "$CANDIDATE_URL/files/$file_probe")" == "$id" ]]
  rm -f -- "$DATA_ROOT/files/$file_probe"
  socket_handshake="$(curl --fail --silent --show-error --max-time 5 "$CANDIDATE_URL/socket.io/?EIO=4&transport=polling")"
  [[ "$socket_handshake" == *'"sid"'* ]]
  python3 - "$CANDIDATE_PORT" <<'PY'
import socket, sys
with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5):
    pass
PY
}

write_current_image() {
  local image="$1"
  printf '%s\n' "$image" > "$STATE_ROOT/current-image.next"
  sync -f "$STATE_ROOT/current-image.next"
  mv -f -- "$STATE_ROOT/current-image.next" "$STATE_ROOT/current-image"
  sync -f "$STATE_ROOT"
}

promote_candidate() {
  local id="$1"
  docker rm --force "$CANDIDATE_NAME" >/dev/null
  install -m 0640 "$RELEASE_ROOT/$id/deploy/chimera/docker-compose.yml" "$COMPOSE_FILE.next"
  mv -f -- "$COMPOSE_FILE.next" "$COMPOSE_FILE"
  write_current_image "chimera-relay:$id"
  CHIMERA_IMAGE="chimera-relay:$id" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans
}

verify_running_new() {
  local _id="$1"
  verify_url "$LOCAL_HEALTH_URL"
}

restore_snapshot() {
  local id="$1"
  local snapshot="$SNAPSHOT_ROOT/$id"
  local failed="$ROOT/.failed-data-$id"
  test -f "$snapshot/.verified"
  docker rm --force "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  docker compose --file "$COMPOSE_FILE" stop relay >/dev/null 2>&1 || true
  [[ ! -e "$failed" && ! -e "$DATA_ROOT.restore" ]] || die
  install -d -m 0750 "$DATA_ROOT.restore"
  cp -a -- "$snapshot/data/." "$DATA_ROOT.restore/"
  find "$DATA_ROOT.restore" -type f -exec sync -f {} +
  sync -f "$DATA_ROOT.restore"
  mv -- "$DATA_ROOT" "$failed"
  mv -- "$DATA_ROOT.restore" "$DATA_ROOT"
  install -m 0640 "$snapshot/docker-compose.yml" "$COMPOSE_FILE.next"
  mv -f -- "$COMPOSE_FILE.next" "$COMPOSE_FILE"
}

rollback_failed_deploy() {
  local id="$1"
  local old_image="$2"
  trap - ERR EXIT
  set +e
  if [[ -f "$SNAPSHOT_ROOT/$id/.verified" ]]; then
    restore_snapshot "$id"
    open_test_data "$id" "$old_image"
  else
    docker rm --force "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  fi
  write_current_image "$old_image"
  CHIMERA_IMAGE="$old_image" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans
  verify_running_old "$id"
  local healthy=$?
  if (( healthy == 0 )); then
    maintenance_off "$id" && verify_public
    rm -rf -- "$ROOT/.failed-data-$id"
  fi
  exit 1
}

retain_verified_snapshots() {
  local keep="$1"
  mapfile -t snapshots < <(find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -exec test -f '{}/.verified' \; -printf '%T@ %p\n' | sort -nr | cut -d ' ' -f 2-)
  local index
  for (( index=keep; index<${#snapshots[@]}; index++ )); do rm -rf -- "${snapshots[$index]}"; done
}

deploy_server() {
  local id="$1"
  local old_image
  old_image="$(current_image)"
  prepare_release "$id"
  verify_running_old "$id"
  verify_public
  maintenance_on "$id"
  trap 'rollback_failed_deploy "$id" "$old_image"' ERR EXIT
  stop_runtime "$id"
  assert_pglite_closed "$id"
  check_snapshot_space "$id"
  create_snapshot "$id" "$old_image"
  open_test_snapshot "$id" "$old_image"
  migrate_candidate "$id"
  start_candidate "$id"
  verify_candidate "$id"
  promote_candidate "$id"
  verify_running_new "$id"
  maintenance_off "$id"
  verify_public
  trap - ERR EXIT
  rm -f -- "$STAGING_ROOT/$id.tar.partial"
  retain_verified_snapshots 2
  printf 'deployed release=%s\n' "$id"
}

rollback_server() {
  local id="$1"
  local snapshot="$SNAPSHOT_ROOT/$id"
  local old_image
  test -f "$snapshot/.verified"
  IFS= read -r old_image < "$snapshot/old-image"
  [[ "$old_image" =~ ^chimera-relay:[a-f0-9]{40}$ ]] || die
  maintenance_on "$id"
  restore_snapshot "$id"
  open_test_data "$id" "$old_image"
  write_current_image "$old_image"
  CHIMERA_IMAGE="$old_image" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans
  verify_running_old "$id"
  maintenance_off "$id"
  verify_public
  rm -rf -- "$ROOT/.failed-data-$id"
  printf 'rolled back release=%s\n' "$id"
}

main() {
  [[ "${EUID:-$(id -u)}" == 0 ]] || die
  exec 9>/run/lock/chimera-production.lock
  flock -n 9 || die
  install -d -m 0750 "$RELEASE_ROOT" "$STATE_ROOT" "$SNAPSHOT_ROOT"
  find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.tmp-*' -exec rm -rf -- {} +
  find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -exec rm -rf -- {} +
  find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.incoming-*.tar' -delete

  local command extra id
  IFS= read -r command || die
  if IFS= read -r extra; then die; fi
  if [[ "$command" =~ ^deploy-server\ ([a-f0-9]{40})$ ]]; then
    id="${BASH_REMATCH[1]}"
    deploy_server "$id"
  elif [[ "$command" =~ ^rollback-server\ ([a-f0-9]{40})$ ]]; then
    id="${BASH_REMATCH[1]}"
    rollback_server "$id"
  else
    die
  fi
}

main "$@"
