param(
    [string]$ApkPath,
    [string]$ManifestPath,
    [string]$ManifestPublicKeyPath,
    [string]$HostName,
    [string]$ReleaseId,
    [string]$HealthOrigin,
    [string]$NodePath = 'node'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedPackage = 'org.chimerahub.chimera'
$ExpectedSigner = '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93'

function ConvertTo-ChimeraCanonicalValue([object]$Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [bool] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $ordered[$key] = ConvertTo-ChimeraCanonicalValue $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-ChimeraCanonicalValue $_ })
    }
    $object = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name -CaseSensitive)) {
        $object[$property.Name] = ConvertTo-ChimeraCanonicalValue $property.Value
    }
    return $object
}

function ConvertTo-ChimeraCanonicalJson([object]$Value) {
    return (ConvertTo-ChimeraCanonicalValue $Value | ConvertTo-Json -Compress -Depth 20)
}

function Assert-ChimeraExactProperties([object]$Value, [string[]]$Expected, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is missing" }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($wanted -join "`n")) { throw "$Name contains unknown or missing fields" }
}

function ConvertFrom-ChimeraBase64Url([string]$Value) {
    if ($Value -notmatch '^[A-Za-z0-9_-]{86}$') { throw 'Manifest signature is not canonical base64url Ed25519 data' }
    $base64 = $Value.Replace('-', '+').Replace('_', '/')
    $base64 += '=' * ((4 - ($base64.Length % 4)) % 4)
    return [Convert]::FromBase64String($base64)
}

function Test-ChimeraEd25519Signature([object]$Payload, [string]$Signature, [string]$PublicKeyPath, [string]$Node) {
    if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) { throw 'Manifest public key does not exist' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) "chimera-manifest-verify-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $payloadFile = Join-Path $temporary 'payload.json'
        $signatureFile = Join-Path $temporary 'signature.bin'
        $verifierFile = Join-Path $temporary 'verify.mjs'
        [IO.File]::WriteAllText($payloadFile, (ConvertTo-ChimeraCanonicalJson $Payload), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllBytes($signatureFile, (ConvertFrom-ChimeraBase64Url $Signature))
        [IO.File]::WriteAllText($verifierFile, @'
import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';
const [payload, signature, publicKey] = process.argv.slice(2);
if (!verify(null, readFileSync(payload), readFileSync(publicKey), readFileSync(signature))) process.exit(1);
'@, [Text.UTF8Encoding]::new($false))
        & $Node $verifierFile $payloadFile $signatureFile $PublicKeyPath 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Manifest Ed25519 signature verification failed' }
    } finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-ChimeraAndroidActivation {
    param(
        [Parameter(Mandatory)][string]$ApkPath,
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$ManifestPublicKeyPath,
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][string]$ReleaseId,
        [Parameter(Mandatory)][string]$HealthOrigin,
        [string]$NodePath = 'node',
        [scriptblock]$UploadOperation,
        [scriptblock]$RemoteOperation,
        [scriptblock]$HealthOperation
    )
    if ($ReleaseId -notmatch '^(?<commit>[a-f0-9]{40})-v(?<version>[1-9][0-9]*)$') { throw 'ReleaseId must be <40-char-commit>-v<versionCode>' }
    $releaseCommit = $Matches.commit
    $releaseVersion = [int64]$Matches.version
    if ($HostName -notmatch '^[A-Za-z0-9_.@-]+$') { throw 'HostName contains unsafe characters' }
    $origin = [Uri]$HealthOrigin
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -cne 'https' -or $origin.AbsolutePath -ne '/') { throw 'HealthOrigin must be an HTTPS origin' }
    foreach ($file in @($ApkPath, $ManifestPath, $ManifestPublicKeyPath)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required local file is missing: $file" }
    }

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json -DateKind String
    Assert-ChimeraExactProperties $manifest @('payload', 'signature') 'Manifest envelope'
    Assert-ChimeraExactProperties $manifest.payload @('apkPath', 'commitSha', 'packageName', 'publishedAt', 'schemaVersion', 'sha256', 'signerSha256', 'size', 'versionCode', 'versionName') 'Manifest payload'
    $payload = $manifest.payload
    if ($payload.schemaVersion -ne 1 -or $payload.packageName -cne $ExpectedPackage) { throw 'Manifest package/schema mismatch' }
    if ($payload.signerSha256 -cne $ExpectedSigner) { throw 'Manifest signer mismatch' }
    if ($payload.commitSha -cne $releaseCommit -or [int64]$payload.versionCode -ne $releaseVersion) { throw 'Manifest commit/version does not match ReleaseId' }
    if ($payload.apkPath -notmatch '^/downloads/chimera-[A-Za-z0-9._-]+\.apk$') { throw 'Manifest APK path is unsafe' }
    if ([IO.Path]::GetFileName($ApkPath) -cne [IO.Path]::GetFileName([string]$payload.apkPath)) { throw 'Local APK filename does not match manifest path' }
    if ([int64]$payload.size -ne (Get-Item -LiteralPath $ApkPath).Length) { throw 'APK size does not match manifest' }
    $actualHash = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$payload.sha256 -cne $actualHash) { throw 'APK sha256 does not match manifest' }
    Test-ChimeraEd25519Signature $payload ([string]$manifest.signature) $ManifestPublicKeyPath $NodePath

    if (-not $UploadOperation) {
        $UploadOperation = { param($Local, $Remote) & scp -- $Local "$HostName`:$Remote"; if ($LASTEXITCODE -ne 0) { throw "Upload failed: $Remote" } }.GetNewClosure()
    }
    if (-not $RemoteOperation) {
        $RemoteOperation = { param($Verb, $Id) & ssh -- $HostName $Verb $Id; if ($LASTEXITCODE -ne 0) { throw "$Verb failed" } }.GetNewClosure()
    }
    if (-not $HealthOperation) {
        $HealthOperation = {
            param($Url, $Range)
            for ($attempt = 0; $attempt -lt 12; $attempt++) {
                try {
                    $headers = if ($Range) { @{ Range = 'bytes=0-0' } } else { @{} }
                    $response = Invoke-WebRequest -Uri $Url -Headers $headers -TimeoutSec 10 -MaximumRedirection 0
                    $expectedStatuses = if ($Range) { @(200, 206) } else { @(200) }
                    if ($expectedStatuses -contains $response.StatusCode) { return $true }
                } catch { }
                Start-Sleep -Seconds 5
            }
            return $false
        }
    }

    & $UploadOperation $ApkPath ".chimera-staging/android/$ReleaseId.apk.partial"
    & $UploadOperation $ManifestPath ".chimera-staging/android/$ReleaseId.manifest.partial"
    & $RemoteOperation 'activate-android' $ReleaseId
    $manifestUrl = "$($origin.GetLeftPart([UriPartial]::Authority))/downloads/chimera-update.json"
    if (-not (& $HealthOperation $manifestUrl $false)) { throw 'Android manifest health check failed' }
    $apkUrl = "$($origin.GetLeftPart([UriPartial]::Authority))$($payload.apkPath)"
    if (-not (& $HealthOperation $apkUrl $true)) { throw 'Android APK range health check failed' }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-ChimeraAndroidActivation -ApkPath $ApkPath -ManifestPath $ManifestPath -ManifestPublicKeyPath $ManifestPublicKeyPath -HostName $HostName -ReleaseId $ReleaseId -HealthOrigin $HealthOrigin -NodePath $NodePath
}
