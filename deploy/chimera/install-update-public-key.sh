#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 && -f "$1" && ! -L "$1" ]] || { printf 'usage: %s <Ed25519-public.pem>\n' "$0" >&2; exit 2; }
public_key="$1"
expected=ze6ngKGbk7dgWN5d6rXGO0YRE5y54hbLMULFoW5YTHc
der="$(mktemp)"
trap 'rm -f -- "$der"' EXIT
openssl pkey -pubin -in "$public_key" -outform DER -out "$der"
actual="$(python3 - "$der" <<'PY'
import base64,pathlib,sys
der=pathlib.Path(sys.argv[1]).read_bytes()
if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"): raise SystemExit(1)
print(base64.urlsafe_b64encode(der[-32:]).decode().rstrip("="))
PY
)"
[[ "$actual" == "$expected" ]] || { printf 'Unexpected Chimera update public key\n' >&2; exit 1; }
install -d -m 0755 -o root -g root /opt/chimera/config
install -m 0644 -o root -g root "$public_key" /opt/chimera/config/update-manifest-public.pem
