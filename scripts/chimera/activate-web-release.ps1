param(
    [string]$BundlePath,
    [string]$HostName,
    [string]$CommitSha,
    [string]$RepresentativeAsset,
    [string]$HealthOrigin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-ChimeraWebArchiveEntries([string[]]$RawEntries, [string]$RepresentativeAsset) {
    foreach ($entry in $RawEntries) {
        $candidate = ([string]$entry).Replace('\', '/')
        if ($candidate -match '^(?:/|[A-Za-z]:)' -or $candidate -match '(^|/)\.\.(/|$)') { throw 'Web bundle contains unsafe traversal entries' }
    }
    $entries = @($RawEntries | ForEach-Object { ([string]$_).Replace('\', '/') -replace '^\./', '' })
    if ($entries -notcontains 'index.html') { throw 'Web bundle must contain index.html at its root' }
    if ($entries -notcontains $RepresentativeAsset) { throw 'RepresentativeAsset is missing from web bundle' }
}

function Invoke-ChimeraWebActivation {
    param(
        [Parameter(Mandatory)][string]$BundlePath,
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][string]$CommitSha,
        [Parameter(Mandatory)][string]$RepresentativeAsset,
        [Parameter(Mandatory)][string]$HealthOrigin,
        [scriptblock]$UploadOperation,
        [scriptblock]$RemoteOperation,
        [scriptblock]$HealthOperation
    )
    if ($CommitSha -notmatch '^[a-f0-9]{40}$') { throw 'CommitSha must be a lowercase 40-character Git commit' }
    if ($HostName -notmatch '^[A-Za-z0-9_.@-]+$') { throw 'HostName contains unsafe characters' }
    if ($RepresentativeAsset -notmatch '^[A-Za-z0-9_][A-Za-z0-9._/-]*[.-][a-f0-9]{8,}\.[A-Za-z0-9]+$' -or $RepresentativeAsset -match '(^|/)\.\.(/|$)') { throw 'RepresentativeAsset must be a safe content-hashed asset path' }
    $origin = [Uri]$HealthOrigin
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -cne 'https' -or $origin.AbsolutePath -ne '/') { throw 'HealthOrigin must be an HTTPS origin' }
    if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) { throw 'Web bundle does not exist' }

    $rawEntries = @(& tar -tzf $BundlePath 2>$null)
    if ($LASTEXITCODE -ne 0 -or $rawEntries.Count -eq 0) { throw 'Web bundle is not a readable non-empty tar.gz archive' }
    Assert-ChimeraWebArchiveEntries $rawEntries $RepresentativeAsset

    if (-not $UploadOperation) {
        $UploadOperation = { param($Local, $Remote) & scp -- $Local "$HostName`:$Remote"; if ($LASTEXITCODE -ne 0) { throw "Upload failed: $Remote" } }.GetNewClosure()
    }
    if (-not $RemoteOperation) {
        $RemoteOperation = { param($Verb, $Id) & ssh -- $HostName $Verb $Id; if ($LASTEXITCODE -ne 0) { throw "$Verb failed" } }.GetNewClosure()
    }
    if (-not $HealthOperation) {
        $HealthOperation = {
            param($Url)
            for ($attempt = 0; $attempt -lt 12; $attempt++) {
                try {
                    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 10 -MaximumRedirection 0
                    if ($response.StatusCode -eq 200) { return $true }
                } catch { }
                Start-Sleep -Seconds 5
            }
            return $false
        }
    }

    & $UploadOperation $BundlePath ".chimera-staging/web/$CommitSha.tar.gz.partial"
    & $RemoteOperation 'activate-web' $CommitSha
    $base = $origin.GetLeftPart([UriPartial]::Authority)
    if (-not (& $HealthOperation "$base/")) { throw 'Web root health check failed; server helper must preserve or restore the previous symlink' }
    if (-not (& $HealthOperation "$base/$RepresentativeAsset")) { throw 'Web asset health check failed; server helper must preserve or restore the previous symlink' }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-ChimeraWebActivation -BundlePath $BundlePath -HostName $HostName -CommitSha $CommitSha -RepresentativeAsset $RepresentativeAsset -HealthOrigin $HealthOrigin
}
