$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Required([string]$RelativePath) {
    $path = Join-Path $PSScriptRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing deployment file: $RelativePath" }
    return Get-Content -LiteralPath $path -Raw
}
function Assert-Match([string]$Value, [string]$Pattern, [string]$Message) { if ($Value -notmatch $Pattern) { throw $Message } }
function Assert-NoMatch([string]$Value, [string]$Pattern, [string]$Message) { if ($Value -match $Pattern) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action; throw 'Expected action to throw' } catch {
        if ($_.Exception.Message -eq 'Expected action to throw' -or $_.Exception.Message -notmatch $Pattern) { throw }
    }
}

function Test-ChimeraReleaseHelperContract([hashtable]$Sources) {
    $install = $Sources.install
    Assert-Match $install 'user="chimera-\$role-deploy"' 'installer must derive a distinct role deployment user'
    Assert-Match $install '\.chimera-staging/\$role' 'installer must derive an isolated role staging tree'
    Assert-Match $install 'chimera-\$role-helper' 'installer must derive a role-specific forced command'
    foreach ($role in 'server', 'android', 'web') { Assert-Match $install "install_role $role" "missing isolated $role deployment user installation" }
    Assert-NoMatch $install '/var/lib/chimera-deploy(?:/|\s)|useradd[^\n]*\schimera-deploy(?:\s|$)' 'legacy shared deploy identity must not remain'
    Assert-Match $install 'install -d -m 0755 /opt/chimera' 'runtime targets must remain root-owned and writable only through helpers'

    $sudoers = $Sources.sudoers
    foreach ($role in 'server', 'android', 'web') {
        Assert-Match $sudoers "chimera-$role-deploy ALL=\(root\) NOPASSWD: /usr/local/libexec/chimera-$role-(?:deploy|activate)" "sudoers missing exact $role helper"
    }
    Assert-NoMatch $sudoers 'NOPASSWD:\s*(?:ALL|/bin/(?:ba)?sh|/usr/bin/env)|\*' 'sudoers grants arbitrary command execution'

    foreach ($role in 'server', 'android', 'web') {
        $forced = $Sources["forced_$role"]
        Assert-Match $forced 'SSH_ORIGINAL_COMMAND' "$role helper must be a forced-command gate"
        Assert-Match $forced '\^scp\\ -t\\ ' "$role helper must anchor its upload protocol"
        Assert-Match $forced "/usr/local/libexec/chimera-$role-(?:deploy|activate)" "$role helper must invoke only its privileged role"
        foreach ($other in @('server', 'android', 'web') | Where-Object { $_ -ne $role }) {
            Assert-NoMatch $forced "activate-$other|deploy-$other|\.chimera-staging/$other" "$role forced command crosses into $other"
        }
        Assert-NoMatch $forced 'eval|bash\s+-c|sh\s+-c' "$role helper permits shell fragments"
    }

    $android = $Sources.android
    foreach ($pattern in @(
        'openssl pkeyutl -verify', 'update-manifest-public\.pem', 'chimera-validate-android-release',
        'chimera-apk-inspect', 'EXPECTED_PACKAGE', 'EXPECTED_SIGNER', 'archive_version.*version', 'archive_name.*version_name',
        'sync_path.*chimera-update\.json', 'manifest is the activation pointer'
    )) { Assert-Match $android $pattern "Android server validation missing: $pattern" }
    Assert-Match $android 'install -m 0600 "\$apk" "\$work/candidate\.apk"[\s\S]*chimera-validate-android-release "\$manifest_frozen" "\$apk_frozen"' 'Android must validate root-frozen bytes, not mutable staging'
    Assert-Match $Sources.android_validator 'hashlib\.sha256\(\)' 'Android validator must hash the APK'
    Assert-Match $Sources.android_validator 'stream\.read\(1024 \* 1024\)' 'Android APK hashing must be streaming'
    Assert-NoMatch $Sources.android_validator 'read_bytes\(\)' 'Android APK hashing must not buffer the whole file'
    $inspector = $Sources.inspector
    Assert-Match $inspector 'build_tools=/opt/android-sdk/build-tools/35\.0\.0' 'Android build tools version is not pinned'
    Assert-Match $inspector 'aapt2="\$build_tools/aapt2"' 'APK package parser is not pinned'
    Assert-Match $inspector 'apksigner="\$build_tools/apksigner"' 'APK signature verifier is not pinned'
    Assert-Match $inspector "signer_lines\[@\].*eq 1|#signer_lines\[@\].*eq 1" 'APK must contain exactly one signer'

    $web = $Sources.web
    foreach ($pattern in @('chimera-validate-web-archive', 'representative=', 'https://39\.98\.68\.173/\$representative', 'web/previous', 'rollback-', 'kept <= 5')) {
        Assert-Match $web $pattern "Web activation missing: $pattern"
    }
    Assert-Match $web 'install -m 0600 "\$source" "\$frozen"[\s\S]*chimera-validate-web-archive "\$frozen"' 'Web must validate root-frozen bytes, not mutable staging'
    Assert-Match $web 'else[\s\S]*rm -f -- "\$ROOT/web/current"[\s\S]*rm -rf --one-file-system -- "\$target"' 'first Web activation health failure must remove failed current/target'
    foreach ($pattern in @('member\.issym\(\)', 'member\.islnk\(\)', 'normalized in seen', 'path\.is_absolute\(\)')) {
        Assert-Match $Sources.web_validator $pattern "Web archive validation missing: $pattern"
    }
    Assert-NoMatch $web '--insecure|-k(?:\s|$)' 'Web health must verify the public certificate'

    $server = $Sources.server
    foreach ($pattern in @(
        '\^deploy-server\\ ', '\^rollback-server\\ ', 'server-image\.oci', 'server-release-input\.json', 'server-archive-attestation\.jsonl',
        'gh attestation verify', '--bundle "\$incoming/server-archive-attestation\.jsonl"', 'skopeo copy --preserve-digests',
        'maintenance', 'pglite', 'snapshot', 'data_bytes \* 12 / 10', '15 \* 1024|16106127360', 'health',
        'rollback_failed_deploy', 'rollback_failed_rollback', '--network host', 'sync -f|fsync'
    )) { Assert-Match $server $pattern "Server deployment missing: $pattern" }
    Assert-NoMatch $server 'eval|bash\s+-c|sh\s+-c|docker build|Dockerfile\.server|deploy/chimera/docker-compose' 'Server deployment executes candidate source or shell fragments'
    Assert-Match $android 'if ! ln "\$release/\$filename" "\$downloads/\$filename"[\s\S]*cmp --silent' 'Android APK target must be immutable or byte-identical'

    Assert-Match $Sources.caddy 'tls /etc/chimera/config/tls/ip-cert\.pem /etc/chimera/config/tls/ip-key\.pem' 'Caddy must require a pre-provisioned public IP certificate'
    foreach ($pattern in @('-checkip 39\.98\.68\.173', 'verify_args=\(-purpose sslserver -CAfile', 'openssl verify "\$\{verify_args\[@\]\}"', '-checkend 172800', 'Certificate/private key mismatch')) {
        Assert-Match $Sources.tls $pattern "TLS provisioning missing: $pattern"
    }
    Assert-Match $Sources.update_key 'expected=ze6ngKGbk7dgWN5d6rXGO0YRE5y54hbLMULFoW5YTHc' 'update verifier key is not pinned'
    Assert-Match $Sources.update_key 'update-manifest-public\.pem' 'update verifier key is not installed to its fixed path'
    Assert-Match $Sources.compose '/data:/var/lib/chimera' 'relay data must use the snapshot-visible host /data bind'
    Assert-Match $Sources.compose '\./proxy-config:/etc/chimera/config:ro' 'proxy must receive only isolated public TLS/maintenance config'
    Assert-NoMatch $Sources.compose '\./config:/etc/chimera/config' 'proxy must not receive relay production secrets'
    Assert-Match $Sources.compose 'happy-server-self-host' 'relay compose command must target the actual self-host package'
    foreach ($pattern in @('\^\[a-f0-9\]\{40\}\$', 'path\.is_absolute\(\)', 'member\.issym\(\)', 'current-image\.next', 'curl.*127\.0\.0\.1:3000/health')) {
        Assert-Match $Sources.bootstrap $pattern "bootstrap deployment missing: $pattern"
    }
    return $true
}

$sources = @{
    install = Read-Required 'install-deploy-user.sh'
    sudoers = Read-Required 'sudoers/chimera-deploy'
    forced_server = Read-Required 'bin/chimera-server-helper'
    forced_android = Read-Required 'bin/chimera-android-helper'
    forced_web = Read-Required 'bin/chimera-web-helper'
    android = Read-Required 'libexec/chimera-android-activate'
    android_validator = Read-Required 'libexec/chimera-validate-android-release'
    inspector = Read-Required 'libexec/chimera-apk-inspect'
    web = Read-Required 'libexec/chimera-web-activate'
    web_validator = Read-Required 'libexec/chimera-validate-web-archive'
    server = Read-Required 'deploy-server.sh'
    caddy = Read-Required 'Caddyfile'
    tls = Read-Required 'install-tls-certificate.sh'
    update_key = Read-Required 'install-update-public-key.sh'
    compose = Read-Required 'docker-compose.yml'
    bootstrap = Read-Required 'deploy-standalone.sh'
}

Test-ChimeraReleaseHelperContract $sources | Out-Null

$mutated = $sources.Clone()
$mutated.forced_android = $sources.forced_android + "`nactivate-web deadbeef"
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'crosses into web'
$mutated = $sources.Clone()
$mutated.android = $sources.android.Replace('openssl pkeyutl -verify', 'true # signature bypass')
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'Android server validation'
$mutated = $sources.Clone()
$mutated.web = $sources.web.Replace('https://39.98.68.173/$representative', 'https://39.98.68.173/')
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'Web activation'
$mutated = $sources.Clone()
$mutated.sudoers = $sources.sudoers + "`nchimera-web-deploy ALL=(root) NOPASSWD: ALL"
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'arbitrary command'

Write-Output 'Chimera release helper contract and mutation tests passed.'
