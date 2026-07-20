[CmdletBinding()]
param(
    [switch] $DryRun,
    [string] $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
    [string] $ResultPath,
    [string] $BundlePath
)

$ErrorActionPreference = 'Stop'
# Contract markers: ls-remote; worktree add; --no-ff; bump-release.mjs;
# git bundle create; upstreamMergeCommitSha; candidateTipSha; finally.
$configPath = Join-Path $RepositoryRoot 'brand/chimera/upstream.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Invoke-Git([string[]] $Arguments, [string] $At = $RepositoryRoot, [switch] $AllowFailure) {
    $output = & git -C $At @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "git command failed: git $($Arguments[0])" }
    return ($output -join "`n").Trim()
}

function Write-Result([hashtable] $Value) {
    $json = $Value | ConvertTo-Json -Depth 6 -Compress
    if ($ResultPath) {
        $parent = Split-Path -Parent $ResultPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        [IO.File]::WriteAllText($ResultPath, "$json`n", [Text.UTF8Encoding]::new($false))
    }
    Write-Output $json
}

if ($config.schemaVersion -ne 1 -or $config.branch -ne 'main') { throw 'Invalid upstream sync configuration' }
$upstreamOutput = @(& git ls-remote --exit-code $config.upstreamUrl "refs/heads/$($config.branch)" 2>&1)
$upstreamExit = $LASTEXITCODE
$upstreamLine = $upstreamOutput | Select-Object -First 1
if ($upstreamExit -ne 0 -or $upstreamLine -notmatch '^([a-f0-9]{40})\s+') { throw 'Unable to resolve upstream main' }
$upstreamSha = $Matches[1]
$originOutput = @(& git ls-remote --exit-code $config.originUrl "refs/heads/$($config.branch)" 2>&1)
$originExit = $LASTEXITCODE
$originLine = $originOutput | Select-Object -First 1
if ($originExit -ne 0 -or $originLine -notmatch '^([a-f0-9]{40})\s+') { throw 'Unable to resolve origin main' }
$originSha = $Matches[1]

if ($DryRun) {
    Write-Result @{ schemaVersion = 1; status = $(if ($upstreamSha -eq $config.lastAcceptedSha) { 'no-op' } else { 'upstream-available' }); currentSha = $config.lastAcceptedSha; upstreamSha = $upstreamSha }
    exit 0
}

if ((Invoke-Git @('status', '--porcelain')).Length -ne 0) { throw 'Main worktree must be clean' }
function Normalize-RemoteUrl([string] $Value) { return $Value.TrimEnd('/') -replace '\.git$', '' }
if ((Normalize-RemoteUrl (Invoke-Git @('remote', 'get-url', 'origin'))) -ne (Normalize-RemoteUrl $config.originUrl)) { throw 'Unexpected origin URL' }
$existingUpstream = Invoke-Git @('remote', 'get-url', 'upstream') -AllowFailure
if ($LASTEXITCODE -ne 0) { Invoke-Git @('remote', 'add', 'upstream', $config.upstreamUrl) | Out-Null }
elseif ((Normalize-RemoteUrl $existingUpstream) -ne (Normalize-RemoteUrl $config.upstreamUrl)) { throw 'Unexpected upstream URL' }
Invoke-Git @('remote', 'set-url', '--push', 'upstream', 'DISABLED') | Out-Null
Invoke-Git @('fetch', '--no-tags', 'origin', $originSha) | Out-Null
Invoke-Git @('fetch', '--no-tags', 'upstream', $upstreamSha) | Out-Null

Invoke-Git @('merge-base', '--is-ancestor', $upstreamSha, $originSha) -AllowFailure | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Result @{ schemaVersion = 1; status = 'no-op'; originSha = $originSha; upstreamSha = $upstreamSha }
    exit 0
}

$branch = "sync/upstream-$($upstreamSha.Substring(0, 12))"
$worktree = Join-Path ([IO.Path]::GetTempPath()) ("chimera-upstream-" + [guid]::NewGuid().ToString('N'))
$created = $false
try {
    Invoke-Git @('branch', '-D', $branch) -AllowFailure | Out-Null
    Invoke-Git @('worktree', 'add', '-b', $branch, $worktree, $originSha) | Out-Null
    $created = $true
    Invoke-Git @('config', 'user.name', 'Chimera Upstream Bot') $worktree | Out-Null
    Invoke-Git @('config', 'user.email', 'chimera-upstream@users.noreply.github.com') $worktree | Out-Null
    Invoke-Git @('merge', '--no-ff', '--no-edit', $upstreamSha) $worktree | Out-Null
    $upstreamMergeCommitSha = Invoke-Git @('rev-parse', 'HEAD') $worktree

    foreach ($protected in $config.protectedPaths) {
        if ($protected -notmatch '^[A-Za-z0-9._/-]+$' -or $protected.Contains('..')) { throw 'Unsafe protected path' }
        Invoke-Git @('rm', '-r', '-f', '--ignore-unmatch', '--', $protected) $worktree -AllowFailure | Out-Null
        Invoke-Git @('checkout', $originSha, '--', $protected) $worktree -AllowFailure | Out-Null
    }
    Invoke-Git @('diff', '--quiet', 'HEAD') $worktree -AllowFailure | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git @('add', '--', '.') $worktree | Out-Null
        Invoke-Git @('commit', '-m', 'chore(sync): restore Chimera protected tree') $worktree | Out-Null
    }

    # Classify only the restored upstream delta. Chimera's deterministic release
    # metadata bump must not turn a documentation-only upstream change executable.
    $changes = @((Invoke-Git @('diff', '--name-status', $originSha, 'HEAD') $worktree) -split "`n" | Where-Object { $_ })
    $paths = @()
    $classification = 'docs-only'
    foreach ($line in $changes) {
        $parts = $line -split "`t"
        if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[AM]$') { throw 'Unsupported rename, delete, type, or unknown path change' }
        $path = $parts[1]
        if ($path -match '[\x00-\x1f]' -or $path.Contains('..')) { throw 'Unsafe changed path' }
        $mode = Invoke-Git @('ls-tree', 'HEAD', '--', $path) $worktree
        if ($mode -match '^(120000|160000) ') { throw 'Symlink and submodule changes are blocked' }
        $paths += $path
        if ($path -notmatch '^(README|README\.(md|mdx|txt)|docs/.+\.(md|mdx|txt)|[^/]+\.(md|mdx|txt))$') { $classification = 'executable' }
    }

    $candidateConfigPath = Join-Path $worktree 'brand/chimera/upstream.json'
    $candidateConfig = Get-Content -Raw -LiteralPath $candidateConfigPath | ConvertFrom-Json
    $candidateConfig.lastAcceptedSha = $upstreamSha
    [IO.File]::WriteAllText($candidateConfigPath, (($candidateConfig | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))

    $bump = Join-Path $worktree 'scripts/chimera/bump-release.mjs'
    $appConfig = Join-Path $worktree 'packages/happy-app/app.config.js'
    if ((Test-Path -LiteralPath $bump) -and (Test-Path -LiteralPath $appConfig)) {
        Push-Location $worktree
        try {
            $version = (& node -e "import('./packages/happy-app/app.config.js').then(m => console.log(m.default.expo.version))" 2>&1 | Select-Object -Last 1).Trim()
            if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'Unable to resolve upstream app version' }
            & node scripts/chimera/bump-release.mjs --upstream-app-version $version
            if ($LASTEXITCODE -ne 0) { throw 'Release bump failed' }
        }
        finally { Pop-Location }
    }
    Invoke-Git @('diff', '--quiet', 'HEAD') $worktree -AllowFailure | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git @('add', '--', 'brand/chimera') $worktree | Out-Null
        if (Test-Path -LiteralPath (Join-Path $worktree 'packages/happy-app/sources/chimera')) {
            Invoke-Git @('add', '--', 'packages/happy-app/sources/chimera') $worktree | Out-Null
        }
        Invoke-Git @('commit', '-m', 'chore(sync): record upstream and bump Chimera release') $worktree | Out-Null
    }

    $candidateTipSha = Invoke-Git @('rev-parse', 'HEAD') $worktree
    if ((Invoke-Git @('rev-parse', "$upstreamMergeCommitSha^1") $worktree) -ne $originSha) { throw 'Invalid upstream merge first parent' }
    if ((Invoke-Git @('rev-parse', "$upstreamMergeCommitSha^2") $worktree) -ne $upstreamSha) { throw 'Invalid upstream merge second parent' }
    $firstParents = @((Invoke-Git @('rev-list', '--first-parent', $candidateTipSha) $worktree) -split "`n")
    if ($upstreamMergeCommitSha -notin $firstParents) { throw 'Candidate does not first-parent reach upstream merge' }
    $diffSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($paths | Sort-Object) -join "`n"))).ToLowerInvariant()
    if (-not $BundlePath) { $BundlePath = Join-Path (Split-Path -Parent $ResultPath) 'candidate.bundle' }
    $bundleParent = Split-Path -Parent $BundlePath
    if ($bundleParent) { New-Item -ItemType Directory -Force -Path $bundleParent | Out-Null }
    Invoke-Git @('bundle', 'create', $BundlePath, $branch) | Out-Null
    Write-Result @{ schemaVersion = 1; status = 'candidate'; branch = $branch; originSha = $originSha; upstreamSha = $upstreamSha; upstreamMergeCommitSha = $upstreamMergeCommitSha; candidateTipSha = $candidateTipSha; classification = $classification; changedPaths = $paths; diffSha256 = $diffSha256 }
} catch {
    $conflicts = @()
    if ($created) { $conflicts = @((Invoke-Git @('diff', '--name-only', '--diff-filter=U') $worktree -AllowFailure) -split "`n" | Where-Object { $_ -match '^[A-Za-z0-9._/-]+$' }) }
    if ($ResultPath) { Write-Result @{ schemaVersion = 1; status = 'blocked'; upstreamSha = $upstreamSha; reason = 'merge-or-policy-gate'; files = $conflicts } }
    throw
} finally {
    if ($created) { Invoke-Git @('merge', '--abort') $worktree -AllowFailure | Out-Null; Invoke-Git @('worktree', 'remove', '--force', $worktree) -AllowFailure | Out-Null }
}
