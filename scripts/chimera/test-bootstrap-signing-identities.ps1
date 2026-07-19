$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bootstrap = Join-Path $PSScriptRoot 'bootstrap-signing-identities.ps1'
$workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("chimera-signing-test-" + [guid]::NewGuid())
$backupRoot = Join-Path $workspace 'backups'
$passwordFile = Join-Path $workspace 'store-password.protected'
$keyPasswordFile = Join-Path $workspace 'key-password.protected'
$productPath = Join-Path $repoRoot 'brand\chimera\product.json'
$originalProduct = Get-Content -Raw $productPath

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Write-ProtectedPassword([string] $Path, [string] $Value) {
    $secure = ConvertTo-SecureString $Value -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $secure | Set-Content -LiteralPath $Path -NoNewline
}

try {
    $testProduct = $originalProduct | ConvertFrom-Json
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $productPath
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    Write-ProtectedPassword $passwordFile 'test-store-password-8Q!'
    Write-ProtectedPassword $keyPasswordFile 'test-key-password-9R!'

    $first = & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile 2>&1
    Assert-True ($LASTEXITCODE -eq 0) "first bootstrap failed: $first"
    $inventory = $first | ConvertFrom-Json
    Assert-True ($inventory.androidSignerSha256 -match '^[0-9A-F]{64}$') 'inventory has a colon-free uppercase Android SHA-256'
    Assert-True ($inventory.updatePublicKey -match '^[A-Za-z0-9+/]+={0,2}$') 'inventory has an Ed25519 public key'
    Assert-True (-not (($first -join "`n") -match 'test-(store|key)-password')) 'bootstrap output contains no password'

    $product = Get-Content -Raw $productPath | ConvertFrom-Json
    Assert-True ($product.productName -eq 'Chimera') 'product name'
    Assert-True ($product.slug -eq 'chimera') 'slug'
    Assert-True ($product.androidApplicationId -eq 'org.chimerahub.chimera') 'application id'
    Assert-True (@($product.deepLinkSchemes) -join ',' -eq 'chimera,happy') 'deep links'
    Assert-True ($product.relayOrigin -eq 'https://39.98.68.173') 'relay origin'
    Assert-True ($product.repository -eq 'Duojiyi/happy') 'repository'
    Assert-True ($product.upstreamAppVersion -eq '1.7.0') 'upstream version'
    Assert-True ($product.chimeraRevision -eq 1) 'revision'
    Assert-True ($product.androidVersionCode -eq 1) 'version code'
    Assert-True ($product.updatePublicKey -eq $inventory.updatePublicKey) 'public update key persisted'
    Assert-True ($product.androidSignerSha256 -eq $inventory.androidSignerSha256) 'certificate fingerprint persisted'
    Assert-True ((Get-Item $inventory.encryptedPrivateBundle).Length -gt 0) 'encrypted bundle exists'
    $acl = Get-Acl -LiteralPath $inventory.encryptedPrivateBundle
    Assert-True (-not ($acl.Access | Where-Object { $_.IdentityReference -match 'Everyone|Users' })) 'encrypted bundle excludes broad user ACLs'

    $secondRejected = $false
    try { & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile | Out-Null }
    catch { $secondRejected = $_.Exception.Message -match 'already exist' }
    Assert-True $secondRejected 'second bootstrap refuses identity rotation'

    $bad = Get-Content -Raw $productPath | ConvertFrom-Json
    $bad.updatePublicKey = 'AAAA'
    $bad | ConvertTo-Json | Set-Content -LiteralPath $productPath
    $mismatchRejected = $false
    try { & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile | Out-Null }
    catch { $mismatchRejected = $_.Exception.Message -match 'already exist' }
    Assert-True $mismatchRejected 'mismatched public values are rejected'

    Write-Output 'PASS: bootstrap signing identities'
}
finally {
    Set-Content -LiteralPath $productPath -Value $originalProduct -NoNewline
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
