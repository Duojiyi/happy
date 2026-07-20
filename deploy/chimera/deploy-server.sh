#!/usr/bin/env bash
set -euo pipefail
umask 027

readonly ROOT=/opt/chimera
readonly STORAGE_ROOT=/srv/chimera-storage
readonly DATA_ROOT="$STORAGE_ROOT/data"
readonly PGLITE_ROOT="$DATA_ROOT/pglite"
readonly STAGING_ROOT=/var/lib/chimera-server-deploy/.chimera-staging/server
readonly SNAPSHOT_ROOT="$STORAGE_ROOT/snapshots"
readonly INPUT_ROOT="$ROOT/server-inputs"
readonly STATE_ROOT="$ROOT/state"
readonly OCI_RETENTION_READY="$STATE_ROOT/oci-retention-ready"
readonly COMPOSE_FILE="$ROOT/docker-compose.yml"
readonly MAINTENANCE_FILE="$ROOT/proxy-config/maintenance.caddy"
readonly CANDIDATE_NAME=chimera-server-candidate
readonly CANDIDATE_PORT=13005
readonly LOCAL_HEALTH_URL=http://127.0.0.1:3000/health
readonly CANDIDATE_URL=http://127.0.0.1:${CANDIDATE_PORT}
readonly PUBLIC_HEALTH_URL=https://103.250.173.136/health
readonly MIN_STORAGE_FREE_BYTES=$((5 * 1024 * 1024 * 1024))
readonly MIN_SYSTEM_FREE_BYTES=$((3 * 1024 * 1024 * 1024))
readonly MIN_STORAGE_CAPACITY_BYTES=$((29 * 1024 * 1024 * 1024))
readonly MAX_UNPACKED_IMAGE_BYTES=$((8 * 1024 * 1024 * 1024))
declare -a RESTORE_BACKUPS=()

die() { printf 'Chimera server deployment rejected\n' >&2; exit 1; }
require_root_owned_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%u' "$file")" == 0 ]] || die
  (( (8#$(stat -c '%a' "$file") & 8#022) == 0 )) || die
}

prepare_image() {
  local id="$1" digest="$2"
  local source_archive="$STAGING_ROOT/$id.oci.partial"
  local source_metadata="$STAGING_ROOT/$id.json.partial"
  local source_attestation="$STAGING_ROOT/$id.attestation.partial"
  local incoming="$INPUT_ROOT/.incoming-$id"
  local accepted="$INPUT_ROOT/$id"
  [[ -f "$source_archive" && ! -L "$source_archive" && -f "$source_metadata" && ! -L "$source_metadata" && -f "$source_attestation" && ! -L "$source_attestation" ]] || die
  [[ "$(stat -c '%s' "$source_archive")" -le 4294967296 && "$(stat -c '%s' "$source_metadata")" -le 65536 && "$(stat -c '%s' "$source_attestation")" -le 10485760 ]] || die
  local archive_bytes unpacked_bytes system_free required_system_free
  archive_bytes="$(stat -c '%s' "$source_archive")"
  unpacked_bytes="$(python3 - "$source_archive" "$MAX_UNPACKED_IMAGE_BYTES" <<'PY'
import json, pathlib, sys, tarfile
archive = pathlib.Path(sys.argv[1])
maximum = int(sys.argv[2])
with tarfile.open(archive, "r:*") as outer:
    index = json.load(outer.extractfile("index.json"))
    manifests = index.get("manifests", [])
    if len(manifests) != 1: raise SystemExit(1)
    manifest_digest = manifests[0].get("digest", "")
    if not manifest_digest.startswith("sha256:"): raise SystemExit(1)
    manifest = json.load(outer.extractfile(f"blobs/sha256/{manifest_digest[7:]}"))
    total = 0
    for layer in manifest.get("layers", []):
        if layer.get("mediaType") != "application/vnd.oci.image.layer.v1.tar+gzip": raise SystemExit(1)
        digest = layer.get("digest", "")
        if not digest.startswith("sha256:"): raise SystemExit(1)
        stream = outer.extractfile(f"blobs/sha256/{digest[7:]}")
        with tarfile.open(fileobj=stream, mode="r|gz") as contents:
            for member in contents:
                if member.isfile():
                    total += member.size
                    if total > maximum: raise SystemExit(1)
    print(total)
PY
)"
  [[ "$unpacked_bytes" =~ ^[0-9]+$ ]]
  system_free="$(df --output=avail -B1 "$ROOT" | tail -n 1 | tr -d ' ')"
  required_system_free=$(( archive_bytes * 2 + unpacked_bytes + MIN_SYSTEM_FREE_BYTES ))
  (( system_free > required_system_free )) || die
  [[ ! -e "$incoming" ]] || die
  if [[ -d "$accepted" && -f "$accepted/server-release-input.json" ]]; then
    python3 - "$accepted/server-release-input.json" "$id" "$digest" <<'PY' || exit 1
import json,pathlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8"))
if m.get("commitSha") != sys.argv[2] or m.get("imageDigest") != sys.argv[3]: raise SystemExit(1)
PY
    if ! docker image inspect "chimera-relay:$id" >/dev/null 2>&1; then
      [[ -f "$accepted/server-image.oci" ]] || die
      skopeo copy --preserve-digests "oci-archive:$accepted/server-image.oci" "docker-daemon:chimera-relay:$id"
    fi
    return
  fi
  [[ ! -e "$accepted" ]] || die
  python3 - "$source_archive" "$source_metadata" "$source_attestation" "$STAGING_ROOT" <<'PY' || exit 1
import pathlib,sys
root=pathlib.Path(sys.argv[4]).resolve(strict=True)
for raw in sys.argv[1:4]:
    item=pathlib.Path(raw)
    if item.is_symlink() or item.resolve(strict=True).parent != root: raise SystemExit(1)
PY
  install -d -m 0750 "$incoming"
  install -m 0600 "$source_archive" "$incoming/server-image.oci"
  install -m 0600 "$source_metadata" "$incoming/server-release-input.json"
  install -m 0600 "$source_attestation" "$incoming/server-archive-attestation.jsonl"
  sync -f "$incoming/server-image.oci"
  sync -f "$incoming/server-release-input.json"
  sync -f "$incoming/server-archive-attestation.jsonl"
  python3 - "$incoming/server-image.oci" "$incoming/server-release-input.json" "$id" "$digest" <<'PY' || exit 1
import hashlib,json,pathlib,re,sys,tarfile
archive_path,metadata_path,commit,digest=sys.argv[1:]
metadata=json.loads(pathlib.Path(metadata_path).read_text("utf-8"))
required={"schemaVersion","repository","commitSha","trustedWorkflowSha","buildRunId","imageDigest","imageArchiveSha256","sbomSha256"}
if not isinstance(metadata,dict) or set(metadata) != required: raise SystemExit(1)
if metadata["schemaVersion"] != 1 or metadata["repository"] != "Duojiyi/happy": raise SystemExit(1)
if metadata["commitSha"] != commit or metadata["imageDigest"] != digest: raise SystemExit(1)
if not re.fullmatch(r"[a-f0-9]{40}",metadata["trustedWorkflowSha"]): raise SystemExit(1)
if not re.fullmatch(r"[1-9][0-9]*",metadata["buildRunId"]): raise SystemExit(1)
if not re.fullmatch(r"[a-f0-9]{64}",metadata["imageArchiveSha256"]): raise SystemExit(1)
if not re.fullmatch(r"[a-f0-9]{64}",metadata["sbomSha256"]): raise SystemExit(1)
archive_hash=hashlib.sha256()
with open(archive_path,"rb") as stream:
    while chunk := stream.read(1024*1024): archive_hash.update(chunk)
if archive_hash.hexdigest() != metadata["imageArchiveSha256"]: raise SystemExit(1)
seen={}
with tarfile.open(archive_path,"r:*") as bundle:
    for member in bundle.getmembers():
        path=pathlib.PurePosixPath(member.name.replace("\\","/"))
        name=str(path).removeprefix("./")
        if not name or path.is_absolute() or ".." in path.parts or name in seen: raise SystemExit(1)
        if not (member.isfile() or member.isdir()) or member.issym() or member.islnk() or member.isdev(): raise SystemExit(1)
        seen[name]=member
    if "index.json" not in seen: raise SystemExit(1)
    index=json.load(bundle.extractfile(seen["index.json"]))
    manifests=index.get("manifests",[])
    if len(manifests) != 1 or manifests[0].get("digest") != digest: raise SystemExit(1)
    for name,member in seen.items():
        match=re.fullmatch(r"blobs/sha256/([a-f0-9]{64})",name)
        if not match: continue
        calculated=hashlib.sha256()
        stream=bundle.extractfile(member)
        while chunk := stream.read(1024*1024): calculated.update(chunk)
        if calculated.hexdigest() != match.group(1): raise SystemExit(1)
    manifest_name=f"blobs/sha256/{digest.removeprefix('sha256:')}"
    if manifest_name not in seen: raise SystemExit(1)
PY
  trusted_workflow_sha="$(python3 - "$incoming/server-release-input.json" <<'PY'
import json,pathlib,sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8"))["trustedWorkflowSha"])
PY
)"
  [[ "$trusted_workflow_sha" =~ ^[a-f0-9]{40}$ ]]
  [[ "$(stat -c '%s' "$incoming/server-archive-attestation.jsonl")" -le 10485760 ]] || die
  gh attestation verify "$incoming/server-image.oci" --repo 'Duojiyi/happy' \
    --bundle "$incoming/server-archive-attestation.jsonl" \
    --predicate-type 'https://slsa.dev/provenance/v1' \
    --cert-identity 'https://github.com/Duojiyi/happy/.github/workflows/chimera-server-release.yml@refs/heads/main' \
    --cert-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --signer-repo 'Duojiyi/happy' --signer-workflow 'Duojiyi/happy/.github/workflows/chimera-server-release.yml' \
    --signer-digest "$trusted_workflow_sha" --source-digest "$id" --source-ref 'refs/heads/main' \
    --deny-self-hosted-runners
  mv -- "$incoming" "$accepted"
  sync -f "$INPUT_ROOT"
  skopeo copy --preserve-digests "oci-archive:$accepted/server-image.oci" "docker-daemon:chimera-relay:$id"
  sync -f "$accepted"
}

reload_proxy() {
  docker compose --file "$COMPOSE_FILE" exec -T proxy caddy validate --config /etc/caddy/Caddyfile
  docker compose --file "$COMPOSE_FILE" exec -T proxy caddy reload --config /etc/caddy/Caddyfile
}
maintenance_on() {
  require_root_owned_file "$MAINTENANCE_FILE"
  printf '@mutations method POST PUT PATCH DELETE\nrespond @mutations 503\n' > "$MAINTENANCE_FILE.next"
  chmod 0644 "$MAINTENANCE_FILE.next"; sync -f "$MAINTENANCE_FILE.next"
  mv -f -- "$MAINTENANCE_FILE.next" "$MAINTENANCE_FILE"; sync -f "$ROOT/proxy-config"
  reload_proxy
}
maintenance_off() {
  printf '# writes enabled\n' > "$MAINTENANCE_FILE.next"
  chmod 0644 "$MAINTENANCE_FILE.next"; sync -f "$MAINTENANCE_FILE.next"
  mv -f -- "$MAINTENANCE_FILE.next" "$MAINTENANCE_FILE"; sync -f "$ROOT/proxy-config"
  reload_proxy
}

read_marker() {
  local file="$1" pattern="$2"
  [[ -s "$file" ]] || die
  local value; IFS= read -r value < "$file"
  [[ "$value" =~ $pattern ]] || die
  printf '%s\n' "$value"
}
current_image() { read_marker "$STATE_ROOT/current-image" '^chimera-relay:[a-f0-9]{40}$'; }
current_digest() { read_marker "$STATE_ROOT/current-digest" '^sha256:[a-f0-9]{64}$'; }
verify_url() {
  local url="$1"
  for attempt in {1..30}; do curl --fail --silent --show-error --max-time 5 "$url" >/dev/null && return 0; sleep 1; done
  return 1
}
verify_running_old() { verify_url "$LOCAL_HEALTH_URL"; }
verify_public() { curl --fail --silent --show-error --max-time 5 "$PUBLIC_HEALTH_URL" >/dev/null; }
stop_runtime() { docker compose --file "$COMPOSE_FILE" stop relay; }
assert_pglite_closed() {
  command -v fuser >/dev/null 2>&1 || die
  ! fuser -m "$PGLITE_ROOT" >/dev/null 2>&1
}
check_snapshot_space() {
  local target_data="${1:-}" data_bytes target_bytes=0 free_bytes required_bytes
  data_bytes="$(du -sb "$DATA_ROOT" | awk '{print $1}')"
  if [[ -n "$target_data" ]]; then
    [[ -d "$target_data" && ! -L "$target_data" ]] || return 1
    target_bytes="$(du -sb "$target_data" | awk '{print $1}')"
  fi
  free_bytes="$(df --output=avail -B1 "$SNAPSHOT_ROOT" | tail -n 1 | tr -d ' ')"
  if [[ -n "$target_data" ]]; then
    required_bytes=$(( data_bytes + target_bytes + MIN_STORAGE_FREE_BYTES ))
  else
    required_bytes=$(( data_bytes * 2 + MIN_STORAGE_FREE_BYTES ))
  fi
  (( free_bytes > required_bytes ))
}
create_snapshot() {
  local id="$1" old_image="$2" old_digest="$3"
  local temporary="$SNAPSHOT_ROOT/.tmp-$id" snapshot="$SNAPSHOT_ROOT/$id"
  [[ ! -e "$temporary" && ! -e "$snapshot" ]] || die
  install -d -m 0750 "$temporary/data"
  cp -a -- "$DATA_ROOT/." "$temporary/data/"
  install -m 0640 "$COMPOSE_FILE" "$temporary/docker-compose.yml"
  printf '%s\n' "$old_image" > "$temporary/old-image"
  printf '%s\n' "$old_digest" > "$temporary/old-digest"
  find "$temporary/data" -type f -exec sync -f {} +
  sync -f "$temporary/old-image"; sync -f "$temporary/old-digest"; sync -f "$temporary/data"
  mv -- "$temporary" "$snapshot"; sync -f "$SNAPSHOT_ROOT"
}
open_test_path() {
  local image="$1" data="$2"
  docker run --rm --network none --volume "$data:/data" --entrypoint node "$image" -e '
    import("@electric-sql/pglite").then(async ({ PGlite }) => { const db=new PGlite("/data/pglite"); await db.query("select 1"); await db.close(); }).catch(()=>process.exit(1));'
}
open_test_snapshot() {
  local id="$1" image="$2"
  open_test_path "$image" "$SNAPSHOT_ROOT/$id/data"
  install -m 0640 /dev/null "$SNAPSHOT_ROOT/$id/.verified"; sync -f "$SNAPSHOT_ROOT/$id/.verified"
}
open_test_data() { open_test_path "$2" "$DATA_ROOT"; }
migrate_candidate() {
  local id="$1"
  docker run --rm --network none --env NODE_ENV=production --env DB_PROVIDER=pglite --env PGLITE_DIR=/data/pglite --env DATA_DIR=/data \
    --volume "$DATA_ROOT:/data" "chimera-relay:$id" pnpm --filter happy-server-self-host exec tsx ./sources/standalone.ts migrate
}
start_candidate() {
  local id="$1"
  docker rm --force "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  docker run --detach --name "$CANDIDATE_NAME" --network host \
    --env-file "$ROOT/config/production.env" --env NODE_ENV=production --env PORT="$CANDIDATE_PORT" \
    --env DB_PROVIDER=pglite --env PGLITE_DIR=/data/pglite --env DATA_DIR=/data \
    --volume "$DATA_ROOT:/data" "chimera-relay:$id" >/dev/null
}
verify_candidate() {
  local id="$1" status socket_handshake file_probe="chimera-deploy-health-$1.txt"
  verify_url "$CANDIDATE_URL/health"
  curl --fail --silent --show-error --max-time 5 --output /dev/null "$CANDIDATE_URL/v1/chimera/config"
  status="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "$CANDIDATE_URL/v1/account/profile")"
  [[ "$status" == 401 ]]
  install -d -m 0750 "$DATA_ROOT/files"; printf '%s\n' "$id" > "$DATA_ROOT/files/$file_probe"
  [[ "$(curl --fail --silent --show-error --max-time 5 "$CANDIDATE_URL/files/$file_probe")" == "$id" ]]
  rm -f -- "$DATA_ROOT/files/$file_probe"
  socket_handshake="$(curl --fail --silent --show-error --max-time 5 "$CANDIDATE_URL/socket.io/?EIO=4&transport=polling")"
  [[ "$socket_handshake" == *'"sid"'* ]]
}
write_marker() {
  local name="$1" value="$2"
  printf '%s\n' "$value" > "$STATE_ROOT/$name.next"; sync -f "$STATE_ROOT/$name.next"
  mv -f -- "$STATE_ROOT/$name.next" "$STATE_ROOT/$name"; sync -f "$STATE_ROOT"
}
write_current_release() { write_marker current-image "$1"; write_marker current-digest "$2"; }
bootstrap_legacy_id() {
  if [[ -e "$OCI_RETENTION_READY" || -L "$OCI_RETENTION_READY" ]]; then
    require_root_owned_file "$OCI_RETENTION_READY"
    read_marker "$OCI_RETENTION_READY" '^[a-f0-9]{40}$'
    return
  fi
  return 1
}
mark_oci_retention_ready() {
  local legacy_id="$1"
  [[ "$legacy_id" =~ ^[a-f0-9]{40}$ ]] || return 1
  printf '%s\n' "$legacy_id" > "$OCI_RETENTION_READY.next" || return 1
  chmod 0600 "$OCI_RETENTION_READY.next" || return 1
  sync -f "$OCI_RETENTION_READY.next" || return 1
  mv -f -- "$OCI_RETENTION_READY.next" "$OCI_RETENTION_READY" || return 1
  sync -f "$STATE_ROOT" || return 1
}
promote_candidate() {
  local id="$1" digest="$2"
  docker rm --force "$CANDIDATE_NAME" >/dev/null
  write_current_release "chimera-relay:$id" "$digest"
  CHIMERA_IMAGE="chimera-relay:$id" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans
}
verify_running_new() {
  local id="$1"
  verify_url "$LOCAL_HEALTH_URL"
  container="$(docker compose --file "$COMPOSE_FILE" ps -q relay)"
  [[ -n "$container" && "$(docker inspect --format '{{.Config.Image}}' "$container")" == "chimera-relay:$id" ]]
}
remove_candidate_if_present() {
  if docker container inspect "$CANDIDATE_NAME" >/dev/null 2>&1; then
    docker rm --force "$CANDIDATE_NAME" >/dev/null
  fi
}
cleanup_restore_candidates() {
  local candidate
  while IFS= read -r -d '' candidate; do
    [[ -d "$candidate" && ! -L "$candidate" && "$candidate" =~ ^/srv/chimera-storage/data\.restore-[a-z0-9-]+-[0-9]+-[0-9]+$ ]] || return 1
    rm -rf -- "$candidate" || return 1
  done < <(find "$STORAGE_ROOT" -mindepth 1 -maxdepth 1 -name 'data.restore-*' -print0)
}
restore_snapshot() {
  local id="$1" image="$2" snapshot="$SNAPSHOT_ROOT/$1"
  local transaction="$1-$$-${RANDOM}" candidate="$DATA_ROOT.restore-$transaction" backup="$DATA_ROOT.failed-$transaction"
  local parent; parent="$(dirname "$DATA_ROOT")"
  [[ -f "$snapshot/.verified" && ! -L "$snapshot/.verified" && -d "$snapshot/data" && ! -L "$snapshot/data" ]] || return 1
  [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" && ! -e "$candidate" && ! -e "$backup" && "${#RESTORE_BACKUPS[@]}" == 0 ]] || return 1
  remove_candidate_if_present || return 1
  docker compose --file "$COMPOSE_FILE" stop relay >/dev/null || return 1
  install -d -m 0750 "$candidate" || return 1
  if ! cp -a -- "$snapshot/data/." "$candidate/" \
      || ! find "$candidate" -type f -exec sync -f {} + \
      || ! sync -f "$candidate" \
      || ! open_test_path "$image" "$candidate"; then
    rm -rf -- "$candidate"
    return 1
  fi
  if ! mv -- "$DATA_ROOT" "$backup"; then
    rm -rf -- "$candidate"
    return 1
  fi
  RESTORE_BACKUPS+=("$backup")
  sync -f "$parent" || return 1
  if ! mv -- "$candidate" "$DATA_ROOT"; then
    if mv -- "$backup" "$DATA_ROOT"; then
      RESTORE_BACKUPS=()
      rm -rf -- "$candidate"
    else
      printf 'Chimera restore swap failed; original data remains at %s\n' "$backup" >&2
    fi
    sync -f "$parent"
    return 1
  fi
  sync -f "$parent" || return 1
}
restore_pending_backup() {
  local image="$1" count="${#RESTORE_BACKUPS[@]}" backup failed parent
  (( count == 1 )) || return 1
  backup="${RESTORE_BACKUPS[0]}"
  [[ "$backup" =~ ^/srv/chimera-storage/data\.failed-[a-z0-9-]+-[0-9]+-[0-9]+$ && -d "$backup" && ! -L "$backup" ]] || return 1
  failed="$DATA_ROOT.failed-recovery-$$-${RANDOM}"
  parent="$(dirname "$DATA_ROOT")"
  [[ ! -L "$DATA_ROOT" && ! -e "$failed" ]] || return 1
  remove_candidate_if_present || return 1
  docker compose --file "$COMPOSE_FILE" stop relay >/dev/null || return 1
  open_test_path "$image" "$backup" || return 1
  cleanup_restore_candidates || return 1
  if [[ ! -e "$DATA_ROOT" ]]; then
    mv -- "$backup" "$DATA_ROOT" || return 1
    sync -f "$parent" || return 1
    RESTORE_BACKUPS=()
    return 0
  fi
  [[ -d "$DATA_ROOT" ]] || return 1
  mv -- "$DATA_ROOT" "$failed" || return 1
  sync -f "$parent" || return 1
  if ! mv -- "$backup" "$DATA_ROOT"; then
    mv -- "$failed" "$DATA_ROOT" || true
    sync -f "$parent"
    return 1
  fi
  sync -f "$parent" || return 1
  RESTORE_BACKUPS=("$failed")
}
finish_restores() {
  local backup
  for backup in "${RESTORE_BACKUPS[@]}"; do
    [[ "$backup" =~ ^/srv/chimera-storage/data\.failed-[a-z0-9-]+-[0-9]+-[0-9]+$ && -d "$backup" && ! -L "$backup" ]] || return 1
    rm -rf -- "$backup" || return 1
  done
  sync -f "$(dirname "$DATA_ROOT")" || return 1
  RESTORE_BACKUPS=()
}
snapshot_markers() {
  local id="$1" image digest
  image="$(read_marker "$SNAPSHOT_ROOT/$id/old-image" '^chimera-relay:[a-f0-9]{40}$')"
  digest="$(read_marker "$SNAPSHOT_ROOT/$id/old-digest" '^sha256:[a-f0-9]{64}$')"
  printf '%s\t%s\n' "$image" "$digest"
}
rollback_failed_deploy() {
  local id="$1" old_image="$2" old_digest="$3"
  trap - ERR EXIT
  if ! recover_release "$id" "$old_image" "$old_digest" || ! cleanup_failed_release "$id"; then
    if ! maintenance_on; then printf 'Chimera recovery failed and maintenance reload also failed\n' >&2; fi
  fi
  exit 1
}
rollback_failed_rollback() {
  local rescue="$1" image="$2" digest="$3"
  trap - ERR EXIT
  if ! recover_release "$rescue" "$image" "$digest" || ! cleanup_failed_rollback "$rescue"; then
    if ! maintenance_on; then printf 'Chimera rollback recovery failed and maintenance reload also failed\n' >&2; fi
  fi
  exit 1
}
recover_release() {
  local snapshot_id="$1" image="$2" digest="$3"
  if (( ${#RESTORE_BACKUPS[@]} > 0 )); then
    restore_pending_backup "$image" || return 1
  elif [[ -f "$SNAPSHOT_ROOT/$snapshot_id/.verified" && ! -L "$SNAPSHOT_ROOT/$snapshot_id/.verified" ]]; then
    restore_snapshot "$snapshot_id" "$image" || return 1
  else
    remove_candidate_if_present || return 1
  fi
  write_current_release "$image" "$digest" || return 1
  CHIMERA_IMAGE="$image" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans || return 1
  verify_running_old || return 1
  finish_restores || return 1
  verify_public || return 1
  maintenance_off || return 1
  if ! verify_public; then
    maintenance_on || return 1
    return 1
  fi
}
cleanup_failed_release() {
  local id="$1"
  [[ "$id" =~ ^[a-f0-9]{40}$ ]] || return 1
  remove_candidate_if_present || return 1
  cleanup_restore_candidates || return 1
  rm -rf -- "$INPUT_ROOT/$id" || return 1
  docker image rm "chimera-relay:$id" >/dev/null 2>&1 || true
  rm -f -- "$STAGING_ROOT/$id.oci.partial" "$STAGING_ROOT/$id.json.partial" "$STAGING_ROOT/$id.attestation.partial" || return 1
  retain_verified_snapshots 1 || return 1
  sync -f "$INPUT_ROOT" || return 1
}
cleanup_failed_rollback() {
  local rescue="$1"
  [[ "$rescue" =~ ^[a-f0-9]{40}$ ]] || return 1
  cleanup_restore_candidates || return 1
  rm -rf -- "$SNAPSHOT_ROOT/.tmp-$rescue" "$SNAPSHOT_ROOT/$rescue" || return 1
  retain_verified_snapshots 1 || return 1
  sync -f "$SNAPSHOT_ROOT" || return 1
}
retain_verified_snapshots() {
  local keep="$1"
  mapfile -t snapshots < <(find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -exec test -f '{}/.verified' \; -printf '%T@ %p\n' | sort -nr | cut -d ' ' -f 2-)
  for (( index=keep; index<${#snapshots[@]}; index++ )); do rm -rf -- "${snapshots[$index]}"; done
}
retain_server_artifacts() {
  local active_image active_id previous_id='' previous_input legacy_id='' snapshot snapshot_name image entry name tags tag id free_bytes
  local -a input_entries=() image_ids=()
  active_image="$(current_image)" || return 1
  active_id="${active_image#chimera-relay:}"
  mapfile -t snapshots < <(find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/.verified' \; -printf '%T@ %p\n' | sort -nr | cut -d ' ' -f 2-)
  for snapshot in "${snapshots[@]}"; do
    snapshot_name="${snapshot##*/}"
    [[ ! -L "$snapshot" && "$snapshot_name" =~ ^([a-f0-9]{40}|rollback-[a-f0-9]{40}-[0-9]+)$ ]] || return 1
    [[ -f "$snapshot/old-image" && ! -L "$snapshot/old-image" ]] || return 1
    image="$(read_marker "$snapshot/old-image" '^chimera-relay:[a-f0-9]{40}$')" || return 1
    if [[ "$image" != "$active_image" ]]; then previous_id="${image#chimera-relay:}"; break; fi
  done
  if [[ -e "$OCI_RETENTION_READY" || -L "$OCI_RETENTION_READY" ]]; then legacy_id="$(bootstrap_legacy_id)" || return 1; fi
  if [[ -e "$INPUT_ROOT/$active_id" || -L "$INPUT_ROOT/$active_id" ]]; then
    [[ -d "$INPUT_ROOT/$active_id" && ! -L "$INPUT_ROOT/$active_id" ]] || return 1
  else
    [[ -n "$legacy_id" && "$active_id" == "$legacy_id" ]] || return 1
  fi
  if [[ -n "$previous_id" ]]; then
    previous_input="$INPUT_ROOT/$previous_id"
    if [[ -e "$previous_input" || -L "$previous_input" ]]; then
      [[ -d "$previous_input" && ! -L "$previous_input" ]] || return 1
    else
      if [[ -z "$legacy_id" ]]; then legacy_id="$previous_id"; elif [[ "$previous_id" != "$legacy_id" ]]; then return 1; fi
    fi
  fi
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    [[ ! -L "$entry" && -d "$entry" && "$name" =~ ^[a-f0-9]{40}$ ]] || return 1
    input_entries+=("$entry")
  done < <(find "$INPUT_ROOT" -mindepth 1 -maxdepth 1 -print0)
  tags="$(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=chimera-relay:*')" || return 1
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    [[ "$tag" =~ ^chimera-relay:([a-f0-9]{40})$ ]] || return 1
    image_ids+=("${BASH_REMATCH[1]}")
  done <<< "$tags"
  docker image inspect "$active_image" >/dev/null || return 1
  if [[ -n "$previous_id" ]]; then docker image inspect "chimera-relay:$previous_id" >/dev/null || return 1; fi
  for entry in "${input_entries[@]}"; do
    name="${entry##*/}"
    if [[ "$name" != "$active_id" && "$name" != "$previous_id" ]]; then rm -rf -- "$entry" || return 1; fi
  done
  for id in "${image_ids[@]}"; do
    if [[ "$id" != "$active_id" && "$id" != "$previous_id" ]]; then docker image rm "chimera-relay:$id" >/dev/null || return 1; fi
  done
  free_bytes="$(df --output=avail -B1 "$ROOT" | tail -n 1 | tr -d ' ')" || return 1
  [[ "$free_bytes" =~ ^[0-9]+$ ]] || return 1
  (( free_bytes > MIN_SYSTEM_FREE_BYTES ))
  if [[ ! -e "$OCI_RETENTION_READY" && ! -L "$OCI_RETENTION_READY" ]]; then mark_oci_retention_ready "$legacy_id"; fi
}
deploy_server() {
  local id="$1" digest="$2" old_image old_digest
  old_image="$(current_image)"; old_digest="$(current_digest)"
  if [[ "$old_image" == "chimera-relay:$id" ]]; then
    rm -f -- "$STAGING_ROOT/$id.oci.partial" "$STAGING_ROOT/$id.json.partial" "$STAGING_ROOT/$id.attestation.partial"
    die
  fi
  prepare_image "$id" "$digest"
  verify_running_old; verify_public
  trap 'rollback_failed_deploy "$id" "$old_image" "$old_digest"' ERR EXIT
  maintenance_on
  stop_runtime; assert_pglite_closed; check_snapshot_space
  create_snapshot "$id" "$old_image" "$old_digest"; open_test_snapshot "$id" "$old_image"
  migrate_candidate "$id"; start_candidate "$id"; verify_candidate "$id"
  promote_candidate "$id" "$digest"; verify_running_new "$id"
  retain_server_artifacts; retain_verified_snapshots 1
  maintenance_off; verify_public
  trap - ERR EXIT
  rm -f -- "$STAGING_ROOT/$id.oci.partial" "$STAGING_ROOT/$id.json.partial" "$STAGING_ROOT/$id.attestation.partial"
  printf 'deployed digest=%s\nrunning digest=%s\n' "$digest" "$(current_digest)"
}
rollback_server() {
  local id="$1" rescue current_image_value current_digest_value target_image target_digest
  rescue="$(printf 'chimera-rollback:%s:%s:%s' "$id" "$(date +%s%N)" "$RANDOM" | sha1sum | cut -d ' ' -f 1)"
  [[ "$rescue" =~ ^[a-f0-9]{40}$ && "$rescue" != "$id" ]] || die
  [[ -f "$SNAPSHOT_ROOT/$id/.verified" && ! -e "$SNAPSHOT_ROOT/$rescue" ]] || die
  current_image_value="$(current_image)"; current_digest_value="$(current_digest)"
  IFS=$'\t' read -r target_image target_digest < <(snapshot_markers "$id")
  trap 'rollback_failed_rollback "$rescue" "$current_image_value" "$current_digest_value"' ERR EXIT
  maintenance_on
  stop_runtime; assert_pglite_closed; check_snapshot_space "$SNAPSHOT_ROOT/$id/data"
  create_snapshot "$rescue" "$current_image_value" "$current_digest_value"; open_test_snapshot "$rescue" "$current_image_value"
  restore_snapshot "$id" "$target_image"
  write_current_release "$target_image" "$target_digest"
  CHIMERA_IMAGE="$target_image" docker compose --file "$COMPOSE_FILE" up -d --remove-orphans
  verify_running_old; finish_restores
  retain_server_artifacts; retain_verified_snapshots 1
  maintenance_off; verify_public
  trap - ERR EXIT
  printf 'rolled back digest=%s\nrunning digest=%s\n' "$target_digest" "$(current_digest)"
}
main() {
  [[ "${EUID:-$(id -u)}" == 0 ]] || die
  for tool in docker skopeo gh python3 curl fuser flock sync findmnt mountpoint; do command -v "$tool" >/dev/null 2>&1 || die; done
  require_root_owned_file "$COMPOSE_FILE"
  mountpoint -q "$STORAGE_ROOT" || die
  [[ "$(stat -c '%d' "$STORAGE_ROOT")" != "$(stat -c '%d' /)" ]] || die
  (( $(df --output=size -B1 "$STORAGE_ROOT" | tail -n 1 | tr -d ' ') >= MIN_STORAGE_CAPACITY_BYTES )) || die
  for path in "$STORAGE_ROOT" "$DATA_ROOT" "$SNAPSHOT_ROOT"; do
    [[ -d "$path" && ! -L "$path" && "$(stat -c '%u' "$path")" == 0 ]] || die
  done
  install -d -m 0750 "$INPUT_ROOT" "$STATE_ROOT"
  exec 9>/run/lock/chimera-production.lock; flock -n 9 || die
  find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.tmp-*' -exec rm -rf -- {} +
  find "$INPUT_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -exec rm -rf -- {} +
  local command extra
  IFS= read -r command || die
  if IFS= read -r extra; then die; fi
  if [[ "$command" =~ ^deploy-server\ ([a-f0-9]{40})\ (sha256:[a-f0-9]{64})$ ]]; then deploy_server "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  elif [[ "$command" =~ ^rollback-server\ ([a-f0-9]{40})$ ]]; then rollback_server "${BASH_REMATCH[1]}"
  else die; fi
}
main "$@"
