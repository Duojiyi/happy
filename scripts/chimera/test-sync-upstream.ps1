$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'sync-upstream.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw 'sync-upstream.ps1 is missing' }
$source = Get-Content -Raw -LiteralPath $scriptPath
foreach ($pattern in @('ls-remote', 'worktree add', '--no-ff', 'upstreamMergeCommitSha', 'candidateTipSha', 'bump-release.mjs', 'git bundle create', 'finally')) {
    if ($source -notmatch [regex]::Escape($pattern)) { throw "sync script missing: $pattern" }
}
if ($source -match 'push\s+upstream') { throw 'sync script must never push upstream' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("chimera-sync-test-" + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $upstream = Join-Path $root 'upstream.git'
    $origin = Join-Path $root 'origin.git'
    $seed = Join-Path $root 'seed'
    git init --bare $upstream | Out-Null
    git init --bare $origin | Out-Null
    git init -b main $seed | Out-Null
    git -C $seed config user.name Fixture
    git -C $seed config user.email fixture@example.test
    New-Item -ItemType Directory -Path (Join-Path $seed 'docs'), (Join-Path $seed 'brand/chimera'), (Join-Path $seed 'scripts/chimera') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $seed 'README.md') -Value 'base'
    Set-Content -LiteralPath (Join-Path $seed 'brand/chimera/upstream.json') -Value '{"schemaVersion":1}'
    Set-Content -LiteralPath (Join-Path $seed 'scripts/chimera/bump-release.mjs') -Value ''
    git -C $seed add .
    git -C $seed commit -m base | Out-Null
    git -C $seed remote add origin $origin
    git -C $seed push origin main | Out-Null
    git -C $seed remote add upstream $upstream
    git -C $seed push upstream main | Out-Null
    Add-Content -LiteralPath (Join-Path $seed 'README.md') -Value 'upstream'
    git -C $seed commit -am upstream | Out-Null
    git -C $seed push upstream main | Out-Null
    $repo = Join-Path $root 'repo'
    git clone --branch main $origin $repo | Out-Null
    git -C $repo remote add upstream $upstream
    $config = @{ schemaVersion = 1; originUrl = $origin; upstreamUrl = $upstream; branch = 'main'; lastAcceptedSha = ('0' * 40); protectedPaths = @('brand/chimera', 'scripts/chimera') } | ConvertTo-Json -Depth 4
    Set-Content -LiteralPath (Join-Path $repo 'brand/chimera/upstream.json') -Value $config
    git -C $repo add .
    git -C $repo -c user.name=Fixture -c user.email=fixture@example.test commit -m config | Out-Null
    git -C $repo push origin main | Out-Null
    $result = Join-Path $root 'result.json'
    $bundle = Join-Path $root 'candidate.bundle'
    & $scriptPath -RepositoryRoot $repo -ResultPath $result -BundlePath $bundle
    if ($LASTEXITCODE -ne 0) { throw 'fixture sync failed' }
    $json = Get-Content -Raw $result | ConvertFrom-Json
    if ($json.status -ne 'candidate' -or $json.classification -ne 'docs-only') { throw 'unexpected fixture result' }
    if (-not (Test-Path $bundle)) { throw 'candidate bundle missing' }
    git -C $repo worktree list --porcelain | Select-String ([regex]::Escape($root + [IO.Path]::DirectorySeparatorChar + 'worktree')) | ForEach-Object { throw 'temporary worktree leaked' }
} finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
Write-Output 'Upstream sync fixture tests passed.'
