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
    Assert-Match $install 'RequiresMountsFor=/srv/chimera-storage' 'Docker must not start without the dedicated data filesystem'

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
        Assert-Match $forced 'exec /usr/bin/sudo -n /usr/local/libexec/.+ <<< ' "$role helper must replace the forced-command process when invoking its privileged role"
        foreach ($other in @('server', 'android', 'web') | Where-Object { $_ -ne $role }) {
            Assert-NoMatch $forced "activate-$other|deploy-$other|\.chimera-staging/$other" "$role forced command crosses into $other"
        }
        Assert-NoMatch $forced 'eval|bash\s+-c|sh\s+-c|\|\s*exec' "$role helper permits shell fragments or a subshell-only exec"
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
    Assert-NoMatch $web "`r" 'Web activation helper must be stored with LF line endings for its Bash shebang'
    foreach ($pattern in @('chimera-validate-web-archive', 'representative=', 'https://103\.250\.173\.136/\$representative', 'web/previous', 'rollback-', 'kept <= 5')) {
        Assert-Match $web $pattern "Web activation missing: $pattern"
    }
    Assert-Match $web 'install -m 0600 "\$source" "\$frozen"[\s\S]*chimera-validate-web-archive "\$frozen"' 'Web must validate root-frozen bytes, not mutable staging'
    Assert-Match $web 'previous" == "\$bootstrap"[\s\S]*! -L "\$bootstrap"[\s\S]*stat -c.*%u:%a.*0:755' 'First Web activation must trust only the fixed root-owned bootstrap directory'
    Assert-Match $web 'else[\s\S]*previous" == "\$releases/"\*[\s\S]*-d "\$previous"' 'Subsequent Web activations must keep previous inside immutable releases'
    Assert-Match $web 'if \[\[ -e "\$target" \|\| -L "\$target"[\s\S]*previous" == "\$bootstrap"[\s\S]*stat -c.*%u:%a.*target.*0:755[\s\S]*rm -rf --one-file-system -- "\$target"' 'Only a root-owned stale first-activation target may be removed for retry'
    Assert-Match $web 'previous=[\s\S]*install -m 0600 "\$source"' 'Previous target validation must happen before archive extraction creates a release target'
    Assert-Match $web 'else[\s\S]*rm -f -- "\$ROOT/web/current"[\s\S]*rm -rf --one-file-system -- "\$target"' 'first Web activation health failure must remove failed current/target'
    foreach ($pattern in @('member\.issym\(\)', 'member\.islnk\(\)', 'normalized in seen', 'path\.is_absolute\(\)')) {
        Assert-Match $Sources.web_validator $pattern "Web archive validation missing: $pattern"
    }
    Assert-NoMatch $web '--insecure|-k(?:\s|$)' 'Web health must verify the public certificate'

    $server = $Sources.server
    foreach ($pattern in @(
        '\^deploy-server\\ ', '\^rollback-server\\ ', 'server-image\.oci', 'server-release-input\.json', 'server-archive-attestation\.jsonl',
        'gh attestation verify', '--bundle "\$incoming/server-archive-attestation\.jsonl"', 'docker load --input "\$archive"',
        'maintenance', 'pglite', 'snapshot', 'data_bytes \* 2', 'data_bytes \+ target_bytes', '5 \* 1024|5368709120',
        'MIN_SYSTEM_FREE_BYTES', 'unpacked_bytes', 'MAX_UNPACKED_IMAGE_BYTES', 'stat -c ''%d''', '29 \* 1024',
        'restore_pending_backup', 'cleanup_restore_candidates', 'cleanup_failed_release', 'cleanup_failed_rollback', 'health',
        'rollback_failed_deploy', 'rollback_failed_rollback', '--network host', 'sync -f|fsync'
    )) { Assert-Match $server $pattern "Server deployment missing: $pattern" }
    Assert-NoMatch $server 'eval|bash\s+-c|sh\s+-c|docker build|Dockerfile\.server|deploy/chimera/docker-compose' 'Server deployment executes candidate source or shell fragments'
    Assert-Match $android 'if ! ln "\$release/\$filename" "\$downloads/\$filename"[\s\S]*cmp --silent' 'Android APK target must be immutable or byte-identical'

    foreach ($pattern in @('default_sni 103\.250\.173\.136', 'issuer acme', 'acme-v02\.api\.letsencrypt\.org/directory', 'profile shortlived', 'protocols tls1\.2 tls1\.3')) {
        Assert-Match $Sources.caddy $pattern "Caddy automatic trusted IP certificate configuration missing: $pattern"
    }
    Assert-NoMatch $Sources.caddy 'tls\s+[^\r\n]*ip-(?:cert|key)\.pem|tls\s+internal' 'Caddy must not depend on a static or self-signed IP certificate'
    foreach ($pattern in @('-checkip 103\.250\.173\.136', 'verify_args=\(-purpose sslserver -CAfile', 'openssl verify "\$\{verify_args\[@\]\}"', '-checkend 172800', 'Certificate/private key mismatch')) {
        Assert-Match $Sources.tls $pattern "TLS provisioning missing: $pattern"
    }
    Assert-Match $Sources.update_key 'expected=ze6ngKGbk7dgWN5d6rXGO0YRE5y54hbLMULFoW5YTHc' 'update verifier key is not pinned'
    Assert-Match $Sources.update_key 'update-manifest-public\.pem' 'update verifier key is not installed to its fixed path'
    Assert-Match $Sources.compose '/srv/chimera-storage/data:/var/lib/chimera' 'relay data must use the dedicated snapshot-visible data filesystem'
    Assert-Match $Sources.compose '\./proxy-config:/etc/chimera/config:ro' 'proxy must receive only isolated public TLS/maintenance config'
    Assert-NoMatch $Sources.compose '\./config:/etc/chimera/config' 'proxy must not receive relay production secrets'
    Assert-NoMatch $Sources.compose '/bin/sh|\bpnpm\b|\btsx\b' 'distroless relay compose must not invoke unavailable shell or package-manager tools'
    Assert-Match $Sources.compose 'test:\s*\["CMD",\s*"/nodejs/bin/node",\s*"-e"' 'distroless relay healthcheck must use the absolute Node runtime'
    Assert-Match $Sources.server 'dist/standalone\.mjs migrate' 'server deployment must use the compiled migration entrypoint'
    Assert-Match $Sources.bootstrap 'dist/standalone\.mjs migrate' 'bootstrap deployment must use the compiled migration entrypoint'
    foreach ($pattern in @('\^\[a-f0-9\]\{40\}\$', 'path\.is_absolute\(\)', 'member\.issym\(\)', 'current-image\.next', 'curl.*127\.0\.0\.1:3000/health')) {
        Assert-Match $Sources.bootstrap $pattern "bootstrap deployment missing: $pattern"
    }
    Assert-Match $Sources.bootstrap 'tls_healthy=0[\s\S]*for attempt in \{1\.\.90\}[\s\S]*curl.*--proto ''=https''[\s\S]*https://103\.250\.173\.136/health[\s\S]*\[\[ "\$tls_healthy" -eq 1 \]\]' 'bootstrap must wait with a bounded retry for initial ACME certificate readiness'
    Assert-Match $Sources.bootstrap 'legacy_id=.*chimera-bootstrap' 'bootstrap image identity must differ from the first attested release commit'
    Assert-NoMatch $Sources.bootstrap 'ip-(?:cert|key)\.pem' 'bootstrap must let Caddy provision and renew the IP certificate automatically'
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
$mutated.web = $sources.web.Replace('https://103.250.173.136/$representative', 'https://103.250.173.136/')
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'Web activation'
$mutated = $sources.Clone()
$mutated.sudoers = $sources.sudoers + "`nchimera-web-deploy ALL=(root) NOPASSWD: ALL"
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'arbitrary command'
$mutated = $sources.Clone()
$mutated.caddy = $sources.caddy.Replace('profile shortlived', 'tls internal')
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'automatic trusted IP certificate'
$mutated = $sources.Clone()
$mutated.bootstrap = $sources.bootstrap.Replace('for attempt in {1..90}', 'for attempt in {1..1}')
Assert-Throws { Test-ChimeraReleaseHelperContract $mutated } 'ACME certificate readiness'

Write-Output 'Chimera release helper contract and mutation tests passed.'
