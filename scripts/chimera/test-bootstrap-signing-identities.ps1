$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bootstrap = Join-Path $PSScriptRoot 'bootstrap-signing-identities.ps1'
$workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("chimera-signing-test-" + [guid]::NewGuid())
$backupRoot = Join-Path $workspace 'backups'
$passwordFile = Join-Path $workspace 'store-password.protected'
$keyPasswordFile = Join-Path $workspace 'key-password.protected'
$productPath = Join-Path $repoRoot 'brand\chimera\product.json'
$originalProduct = Get-Content -Raw $productPath
$keytool = 'D:\Desktop\Hack\tools\jdk21\bin\keytool.exe'
$openssl = 'D:\Scoop\apps\git\2.55.0.3\mingw64\bin\openssl.exe'
$toolArgs = @{ KeytoolPath = $keytool; OpenSslPath = $openssl; KeytoolSha256 = (Get-FileHash $keytool -Algorithm SHA256).Hash; OpenSslSha256 = (Get-FileHash $openssl -Algorithm SHA256).Hash }

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Write-ProtectedPassword([string] $Path, [string] $Value) {
    $secure = ConvertTo-SecureString $Value -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $secure | Set-Content -LiteralPath $Path -NoNewline
}

function Get-ExactAclSids([string] $Path) {
    return @((Get-Acl -LiteralPath $Path).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
}

try {
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $productPath = Join-Path $workspace 'product.json'
    Set-Content -LiteralPath $productPath -Value $originalProduct -NoNewline
    $testProduct = $originalProduct | ConvertFrom-Json
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $productPath
    Write-ProtectedPassword $passwordFile 'test-store-password-8Q!'
    Write-ProtectedPassword $keyPasswordFile 'test-key-password-9R!'

    $first = & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $productPath @toolArgs 2>&1
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
    $expectedAclSids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
    Assert-True ((Get-ExactAclSids $inventory.encryptedPrivateBundle) -join ',' -eq ($expectedAclSids -join ',')) 'encrypted bundle ACL is exact allowlist'

    $passwordInput = Join-Path $workspace 'bundle-password.txt'
    Set-Content -LiteralPath $passwordInput -Value 'test-store-password-8Q!' -NoNewline
    $decryptedZip = Join-Path $workspace 'private.zip'
    & $openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $inventory.encryptedPrivateBundle -out $decryptedZip -pass "file:$passwordInput" 2>$null
    Assert-True ($LASTEXITCODE -eq 0) 'private bundle decrypts with correct password'
    $wrongPasswordInput = Join-Path $workspace 'wrong-password.txt'
    Set-Content -LiteralPath $wrongPasswordInput -Value 'wrong-password' -NoNewline
    & $openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $inventory.encryptedPrivateBundle -out (Join-Path $workspace 'wrong.zip') -pass "file:$wrongPasswordInput" 2>$null
    Assert-True ($LASTEXITCODE -ne 0) 'private bundle rejects wrong password'
    Expand-Archive -LiteralPath $decryptedZip -DestinationPath (Join-Path $workspace 'decrypted')
    $env:TEST_STORE_PASSWORD = 'test-store-password-8Q!'
    $jksDetails = & $keytool -list -v -keystore (Join-Path $workspace 'decrypted\chimera-release.jks') -storepass:env TEST_STORE_PASSWORD -alias chimera-release 2>&1
    Remove-Item Env:TEST_STORE_PASSWORD
    Assert-True (($jksDetails -join "`n") -match 'PrivateKeyEntry') 'bundle contains JKS private key'
    Assert-True (($jksDetails -join "`n") -match '(?s)RSA.*4096|4096.*RSA') 'JKS key is RSA 4096'
    $manifestDetails = & $openssl pkey -in (Join-Path $workspace 'decrypted\manifest-ed25519-private.pem') -text -noout 2>&1
    Assert-True (($manifestDetails -join "`n") -match 'ED25519') 'manifest key is Ed25519'
    $source = Get-Content -Raw $bootstrap
    Assert-True ($source -notmatch '-storepass \$storePassword|-keypass \$keyPassword|-pass "pass:\$storePassword"') 'subprocess commands do not contain secret password arguments'

    $secondRejected = $false
    try { & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $productPath @toolArgs | Out-Null }
    catch { $secondRejected = $_.Exception.Message -match 'already exist' }
    Assert-True $secondRejected 'second bootstrap refuses identity rotation'

    $bad = Get-Content -Raw $productPath | ConvertFrom-Json
    $bad.updatePublicKey = 'AAAA'
    $bad | ConvertTo-Json | Set-Content -LiteralPath $productPath
    $mismatchRejected = $false
    try { & $bootstrap -BackupRoot $backupRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $productPath -OfflineRecoveryRotation @toolArgs | Out-Null }
    catch { $mismatchRejected = $_.Exception.Message -match 'public metadata does not match' }
    Assert-True $mismatchRejected 'mismatched public values are rejected'

    $faultRoot = Join-Path $workspace 'fault-backups'
    $faultProductPath = Join-Path $workspace 'fault-product.json'
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $faultProductPath
    $env:CHIMERA_TEST_FAIL_AFTER_BUNDLE_RENAME = '1'
    $faulted = $false
    try { & $bootstrap -BackupRoot $faultRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $faultProductPath @toolArgs | Out-Null }
    catch { $faulted = $_.Exception.Message -match 'Injected failure' }
    Remove-Item Env:CHIMERA_TEST_FAIL_AFTER_BUNDLE_RENAME -ErrorAction SilentlyContinue
    Assert-True $faulted 'fault injection fails after final bundle rename'
    $faultProduct = Get-Content -Raw $faultProductPath | ConvertFrom-Json
    Assert-True (-not $faultProduct.updatePublicKey) 'fault leaves product unchanged'
    Assert-True (Test-Path (Join-Path $faultRoot 'chimera-private-signing-material.zip.enc')) 'fault leaves final bundle for resume'
    Assert-True (Test-Path (Join-Path $faultRoot 'chimera-signing-transaction.json')) 'fault leaves transaction record for resume'
    $resumed = & $bootstrap -BackupRoot $faultRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $faultProductPath @toolArgs 2>&1 | ConvertFrom-Json
    Assert-True $resumed.resumed 'next invocation resumes incomplete transaction'
    Assert-True (-not (Test-Path (Join-Path $faultRoot 'chimera-signing-transaction.json'))) 'resume clears transaction record'

    Write-Output 'PASS: bootstrap signing identities'
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
