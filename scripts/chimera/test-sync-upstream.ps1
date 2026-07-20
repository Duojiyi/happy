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
    New-Item -ItemType Directory -Path (Join-Path $seed 'docs'), (Join-Path $seed 'brand/chimera'), (Join-Path $seed 'scripts/chimera'), (Join-Path $seed 'packages/happy-app') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $seed 'README.md') -Value 'base'
    Set-Content -LiteralPath (Join-Path $seed 'package.json') -Value '{"type":"module"}'
    Set-Content -LiteralPath (Join-Path $seed 'packages/happy-app/app.config.js') -Value 'export default { expo: { version: "1.0.0" } };'
    Set-Content -LiteralPath (Join-Path $seed 'brand/chimera/upstream.json') -Value '{"schemaVersion":1}'
    Set-Content -LiteralPath (Join-Path $seed 'scripts/chimera/bump-release.mjs') -Value @'
import { mkdir, writeFile } from 'node:fs/promises';
const value = process.argv[process.argv.indexOf('--upstream-app-version') + 1];
await mkdir('brand/chimera', { recursive: true });
await writeFile('brand/chimera/bumped-version.txt', `${value}\n`);
'@
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
    $candidate = Join-Path $root 'candidate'
    git clone --branch $json.branch $bundle $candidate | Out-Null
    if ((Get-Content -Raw (Join-Path $candidate 'brand/chimera/bumped-version.txt')).Trim() -ne '1.0.0') { throw 'initial candidate bump used the wrong app version' }

    Set-Content -LiteralPath (Join-Path $seed 'packages/happy-app/app.config.js') -Value 'export default { expo: { version: "2.0.0" } };'
    Set-Content -LiteralPath (Join-Path $seed 'docs/tool.ts') -Value 'console.log("executable docs fixture");'
    Set-Content -LiteralPath (Join-Path $seed 'README.sh') -Value 'exit 0'
    git -C $seed add .
    git -C $seed commit -m 'upstream executable docs files' | Out-Null
    git -C $seed push upstream main | Out-Null
    $secondResult = Join-Path $root 'result-second.json'
    $secondBundle = Join-Path $root 'candidate-second.bundle'
    & $scriptPath -RepositoryRoot $repo -ResultPath $secondResult -BundlePath $secondBundle
    if ($LASTEXITCODE -ne 0) { throw 'second fixture sync failed' }
    $secondJson = Get-Content -Raw $secondResult | ConvertFrom-Json
    if ($secondJson.status -ne 'candidate' -or $secondJson.classification -ne 'executable') { throw 'executable file under docs or README.* bypassed audits' }
    $secondCandidate = Join-Path $root 'candidate-second'
    git clone --branch $secondJson.branch $secondBundle $secondCandidate | Out-Null
    if ((Get-Content -Raw (Join-Path $secondCandidate 'brand/chimera/bumped-version.txt')).Trim() -ne '2.0.0') { throw 'release bump did not resolve the candidate worktree app version' }

    $leaseRemote = Join-Path $root 'lease.git'
    git init --bare $leaseRemote | Out-Null
    git -C $seed push $leaseRemote HEAD:refs/heads/candidate | Out-Null
    $expected = (git --git-dir=$leaseRemote rev-parse refs/heads/candidate).Trim()
    git -C $seed commit --allow-empty -m 'lease update' | Out-Null
    git -C $seed push "--force-with-lease=refs/heads/candidate:$expected" $leaseRemote HEAD:refs/heads/candidate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'explicit lease rejected the expected remote SHA' }
    $stale = (git --git-dir=$leaseRemote rev-parse refs/heads/candidate).Trim()
    $external = Join-Path $root 'external'
    git clone --branch candidate $leaseRemote $external | Out-Null
    git -C $external -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -m external | Out-Null
    git -C $external push origin candidate | Out-Null
    git -C $seed commit --allow-empty -m 'stale lease update' | Out-Null
    git -C $seed push "--force-with-lease=refs/heads/candidate:$stale" $leaseRemote HEAD:refs/heads/candidate 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'stale explicit lease unexpectedly overwrote an externally advanced branch' }
    git -C $repo worktree list --porcelain | Select-String ([regex]::Escape($root + [IO.Path]::DirectorySeparatorChar + 'worktree')) | ForEach-Object { throw 'temporary worktree leaked' }
} finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
Write-Output 'Upstream sync fixture tests passed.'
