$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'activate-web-release.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Missing activation script: $scriptPath" }
. $scriptPath

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action; throw 'Expected action to throw' } catch {
        if ($_.Exception.Message -eq 'Expected action to throw' -or $_.Exception.Message -notmatch $Pattern) { throw }
    }
}

$workspace = Join-Path ([System.IO.Path]::GetTempPath()) "chimera-web-activate-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $workspace | Out-Null
try {
    $bundle = Join-Path $workspace 'bundle'
    New-Item -ItemType Directory -Path (Join-Path $bundle 'assets') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $bundle 'index.html'), '<script src="/assets/app-deadbeef.js"></script>')
    [IO.File]::WriteAllText((Join-Path $bundle 'assets/app-deadbeef.js'), 'console.log("chimera")')
    $archive = Join-Path $workspace 'chimera-web.tar.gz'
    & tar -czf $archive -C $bundle .
    if ($LASTEXITCODE -ne 0) { throw 'web fixture archive creation failed' }

    $commit = 'c' * 40
    $events = [Collections.Generic.List[string]]::new()
    $upload = { param($Local, $Remote) $events.Add("upload:$Remote") }
    $remote = { param($Verb, $Id) $events.Add("remote:$Verb`:$Id") }
    $health = { param($Url) $events.Add("health:$Url"); $true }
    Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health
    Assert-True ($events[0] -eq "upload:.chimera-staging/web/$commit.tar.gz.partial") 'web archive must use an isolated partial staging name'
    Assert-True ($events[1] -eq "remote:activate-web:$commit") 'web helper invocation must contain only verb and commit'
    Assert-True ($events.Contains('health:https://103.250.173.136/')) 'web root must pass after activation'
    Assert-True (($events -join "`n") -match 'health:https://103\.250\.173\.136/assets/app-deadbeef\.js') 'representative hashed asset must pass after activation'

    $events.Clear()
    $badHealth = { param($Url) $events.Add("health:$Url"); $false }
    Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $remote -HealthOperation $badHealth } 'health'

    $events.Clear()
    $failedUpload = { param($Local, $Remote) $events.Add("upload:$Remote"); throw 'web partial upload failed' }
    Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $failedUpload -RemoteOperation $remote -HealthOperation $health } 'partial upload failed'
    Assert-True (-not (($events -join "`n") -match 'remote:')) 'failed web partial upload must not invoke activation'

    $events.Clear()
    $failedRemote = { param($Verb, $Id) $events.Add("remote:$Verb`:$Id"); throw 'web validation failed' }
    Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $failedRemote -HealthOperation $health } 'validation failed'
    Assert-True (-not (($events -join "`n") -match 'health:')) 'remote validation failure must preserve current web release without health polling'

    $unsafe = Join-Path $workspace 'unsafe.tar.gz'
    $outside = Join-Path $workspace 'outside.txt'
    [IO.File]::WriteAllText($outside, 'unsafe')
    & tar -czf $unsafe -C $workspace outside.txt --transform='s|outside.txt|../outside.txt|' 2>$null
    if ($LASTEXITCODE -eq 0) {
        Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $unsafe -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'traversal|unsafe'
    }
    Assert-Throws { Assert-ChimeraWebArchiveEntries @('index.html', '../outside.txt', 'assets/app-deadbeef.js') 'assets/app-deadbeef.js' } 'traversal|unsafe'
    Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha '../escape' -RepresentativeAsset 'assets/app-deadbeef.js' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'CommitSha'
    Assert-Throws { Invoke-ChimeraWebActivation -BundlePath $archive -HostName 'web@103.250.173.136' -CommitSha $commit -RepresentativeAsset '../secret' -HealthOrigin 'https://103.250.173.136' -UploadOperation $upload -RemoteOperation $remote -HealthOperation $health } 'RepresentativeAsset'

    Write-Output 'Web activation client tests passed.'
} finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
