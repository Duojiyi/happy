$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'activate-android-release.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Missing activation script: $scriptPath" }
. $scriptPath

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action; throw 'Expected action to throw' } catch {
        if ($_.Exception.Message -eq 'Expected action to throw' -or $_.Exception.Message -notmatch $Pattern) { throw }
    }
}

$workspace = Join-Path ([System.IO.Path]::GetTempPath()) "chimera-android-activate-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $workspace | Out-Null
try {
    $apk = Join-Path $workspace 'chimera-1.7.0-chimera.2-deadbeef.apk'
    [System.IO.File]::WriteAllBytes($apk, [byte[]](1..64))
    $sha = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    $commit = 'b' * 40
    $payload = [ordered]@{
        schemaVersion = 1; packageName = 'org.chimerahub.chimera'; versionName = '1.7.0-chimera.2'; versionCode = 2
        apkPath = "/downloads/$([IO.Path]::GetFileName($apk))"; size = 64; sha256 = $sha
        signerSha256 = '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93'
        commitSha = $commit; publishedAt = '2026-07-20T00:00:00.000Z'
    }
    $privateKey = Join-Path $workspace 'private.pem'
    $publicKey = Join-Path $workspace 'public.pem'
    $node = 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
    $canonical = ConvertTo-ChimeraCanonicalJson $payload
    $payloadFile = Join-Path $workspace 'payload.json'
    $signatureFile = Join-Path $workspace 'signature.bin'
    [IO.File]::WriteAllText($payloadFile, $canonical, [Text.UTF8Encoding]::new($false))
    $generator = Join-Path $workspace 'generate-signature.mjs'
    [IO.File]::WriteAllText($generator, @'
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [payload, signature, privateKey, publicKey] = process.argv.slice(2);
const keys = generateKeyPairSync('ed25519');
writeFileSync(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
writeFileSync(signature, sign(null, readFileSync(payload), keys.privateKey));
'@, [Text.UTF8Encoding]::new($false))
    & $node $generator $payloadFile $signatureFile $privateKey $publicKey
    if ($LASTEXITCODE -ne 0) { throw 'Node Ed25519 fixture signing failed' }
    $signature = [Convert]::ToBase64String([IO.File]::ReadAllBytes($signatureFile)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $manifest = Join-Path $workspace 'chimera-update.json'
    [IO.File]::WriteAllText($manifest, (@{ payload = $payload; signature = $signature } | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))
    $roundTripCanonical = ConvertTo-ChimeraCanonicalJson ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -DateKind String).payload)
    Assert-True ($roundTripCanonical -ceq $canonical) "manifest canonical round-trip changed: $roundTripCanonical"

    $events = [Collections.Generic.List[string]]::new()
    $upload = { param($Local, $Remote) $events.Add("upload:$Remote") }
    $remote = { param($Verb, $Id) $events.Add("remote:$Verb`:$Id") }
    $health = { param($Url, $Range) $events.Add("health:$Url`:$Range"); $true }
    $releaseId = "$commit-v2"
    Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health

    Assert-True ($events[0] -eq "upload:.chimera-staging/android/$releaseId.apk.partial") 'APK must upload to its isolated partial name first'
    Assert-True ($events[1] -eq "upload:.chimera-staging/android/$releaseId.manifest.partial") 'manifest must upload only after the APK partial'
    Assert-True ($events[2] -eq "remote:activate-android:$releaseId") 'remote command must contain only the allowlisted verb and safe ID'
    Assert-True (($events -join "`n") -match 'health:https://39\.98\.68\.173/downloads/chimera-update\.json:False') 'must health-check the active manifest'
    Assert-True (($events -join "`n") -match [regex]::Escape("health:https://39.98.68.173$($payload.apkPath):True")) 'must range-check the active APK'

    $events.Clear()
    $failingUpload = { param($Local, $Remote) $events.Add("upload:$Remote"); if ($Remote -like '*.manifest.partial') { throw 'partial upload interrupted' } }
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $failingUpload -RemoteOperation $remote -HealthOperation $health } 'partial upload interrupted'
    Assert-True (-not (($events -join "`n") -match 'remote:')) 'partial upload failure must leave the old manifest active'

    $events.Clear()
    $rejectRemote = { param($Verb, $Id) $events.Add("remote:$Verb`:$Id"); throw 'server validation failed' }
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $rejectRemote -HealthOperation $health } 'server validation failed'
    Assert-True (-not (($events -join "`n") -match 'health:')) 'server rejection must not be mistaken for an activated release'

    $events.Clear()
    $badSignatureManifest = Join-Path $workspace 'bad-signature.json'
    $badEnvelope = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -DateKind String
    $badEnvelope.signature = "$(if ($badEnvelope.signature.StartsWith('A')) { 'B' } else { 'A' })$($badEnvelope.signature.Substring(1))"
    [IO.File]::WriteAllText($badSignatureManifest, ($badEnvelope | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $badSignatureManifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'signature verification'
    Assert-True ($events.Count -eq 0) 'invalid signature must fail before any upload'

    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId "$commit-v3" -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'commit/version'

    $events.Clear()
    $badHealth = { param($Url, $Range) $events.Add("health:$Url`:$Range"); $false }
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $badHealth } 'health'
    Assert-True (($events -join "`n") -match 'remote:activate-android') 'health runs only after server activation succeeds'

    [IO.File]::WriteAllBytes($apk, [byte[]](2..65))
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId $releaseId -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'sha256|size'
    Assert-Throws { Invoke-ChimeraAndroidActivation -ApkPath $apk -ManifestPath $manifest -ManifestPublicKeyPath $publicKey -HostName 'deploy@39.98.68.173' -ReleaseId '../escape-v2' -HealthOrigin 'https://39.98.68.173' -NodePath $node -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'ReleaseId'

    Write-Output 'Android activation client tests passed.'
} finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
