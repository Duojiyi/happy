#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 2 ]] || { printf 'usage: %s <fullchain.pem> <private-key.pem>\n' "$0" >&2; exit 2; }
certificate="$1"
private_key="$2"
[[ -f "$certificate" && ! -L "$certificate" && -f "$private_key" && ! -L "$private_key" ]] || exit 1
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
python3 - "$certificate" "$work" <<'PY'
import pathlib,re,sys
source=pathlib.Path(sys.argv[1]).read_text("ascii")
blocks=re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", source, re.S)
if not blocks: raise SystemExit(1)
root=pathlib.Path(sys.argv[2])
root.joinpath("leaf.pem").write_text(blocks[0] + "\n", "ascii")
if len(blocks) > 1: root.joinpath("intermediates.pem").write_text("\n".join(blocks[1:]) + "\n", "ascii")
PY

openssl x509 -in "$work/leaf.pem" -noout -checkip 103.250.173.136 >/dev/null
openssl x509 -in "$work/leaf.pem" -noout -checkend 172800 >/dev/null
verify_args=(-purpose sslserver -CAfile /etc/ssl/certs/ca-certificates.crt)
[[ ! -f "$work/intermediates.pem" ]] || verify_args+=(-untrusted "$work/intermediates.pem")
openssl verify "${verify_args[@]}" "$work/leaf.pem" >/dev/null
cert_public="$(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
key_public="$(openssl pkey -in "$private_key" -pubout -outform DER | sha256sum | cut -d' ' -f1)"
[[ "$cert_public" == "$key_public" ]] || { printf 'Certificate/private key mismatch\n' >&2; exit 1; }

install -d -m 0700 -o root -g root /opt/chimera/proxy-config/tls
install -m 0644 -o root -g root "$certificate" /opt/chimera/proxy-config/tls/ip-cert.pem
install -m 0600 -o root -g root "$private_key" /opt/chimera/proxy-config/tls/ip-key.pem
