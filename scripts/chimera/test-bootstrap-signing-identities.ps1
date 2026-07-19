param(
    [string] $KeytoolPath,
    [string] $OpenSslPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bootstrap = Join-Path $PSScriptRoot 'bootstrap-signing-identities.ps1'
$workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("chimera signing test " + [guid]::NewGuid())
$backupRoot = Join-Path $workspace 'backups'
$passwordFile = Join-Path $workspace 'store-password.protected'
$keyPasswordFile = Join-Path $workspace 'key-password.protected'
$productPath = Join-Path $repoRoot 'brand\chimera\product.json'
$originalProduct = Get-Content -Raw $productPath
$escapedWorkspace = Join-Path ([System.IO.Path]::GetTempPath()) ("..\chimera escaped signing test " + [guid]::NewGuid())
$keytool = if ($KeytoolPath) { $KeytoolPath } else { (Get-Command keytool.exe -ErrorAction Stop).Source }
$openssl = if ($OpenSslPath) { $OpenSslPath } else { (Get-Command openssl.exe -ErrorAction Stop).Source }
$toolArgs = @{ KeytoolPath = $keytool; OpenSslPath = $openssl }

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
    $wrongToolRejected = $false
    try { & $bootstrap -BackupRoot (Join-Path $workspace 'wrong-tool') -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $productPath -KeytoolPath $keytool -OpenSslPath $keytool | Out-Null }
    catch { $wrongToolRejected = $_.Exception.Message -match 'OpenSSL binary hash' }
    Assert-True $wrongToolRejected 'unapproved tool binary is rejected'
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

    New-Item -ItemType Directory -Path $escapedWorkspace -Force | Out-Null
    $escapedProductPath = Join-Path $escapedWorkspace 'product.json'
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $escapedProductPath
    $env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD = '1'
    $escapedRejected = $false
    try { & $bootstrap -BackupRoot (Join-Path $escapedWorkspace 'backups') -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $escapedProductPath @toolArgs | Out-Null }
    catch { $escapedRejected = $_.Exception.Message -match 'only permitted for temporary paths' }
    Remove-Item Env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD -ErrorAction SilentlyContinue
    Assert-True $escapedRejected 'normalized temp parent traversal is rejected for fault injection'

    $pendingFaultRoot = Join-Path $workspace 'pending-fault-backups'
    $pendingFaultProductPath = Join-Path $workspace 'pending-fault-product.json'
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $pendingFaultProductPath
    $env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD = '1'
    $pendingFaulted = $false
    try { & $bootstrap -BackupRoot $pendingFaultRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $pendingFaultProductPath @toolArgs | Out-Null }
    catch { $pendingFaulted = $_.Exception.Message -match 'Injected failure' }
    Remove-Item Env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD -ErrorAction SilentlyContinue
    Assert-True $pendingFaulted 'fault injection fails after transaction record before bundle rename'
    Assert-True (-not (Test-Path (Join-Path $pendingFaultRoot 'chimera-private-signing-material.zip.enc'))) 'pre-rename fault leaves final absent'
    Assert-True (@(Get-ChildItem -LiteralPath $pendingFaultRoot -Filter '*.pending').Count -eq 1) 'pre-rename fault leaves one pending bundle'
    Assert-True (Test-Path (Join-Path $pendingFaultRoot 'chimera-signing-transaction.json')) 'pre-rename fault leaves transaction record'
    $pendingResumed = & $bootstrap -BackupRoot $pendingFaultRoot -StorePasswordFile $passwordFile -KeyPasswordFile $keyPasswordFile -ProductPath $pendingFaultProductPath @toolArgs 2>&1 | ConvertFrom-Json
    Assert-True $pendingResumed.resumed 'next invocation resumes pending bundle transaction'
    Assert-True (Test-Path (Join-Path $pendingFaultRoot 'chimera-private-signing-material.zip.enc')) 'pending resume promotes final bundle'
    Assert-True (@(Get-ChildItem -LiteralPath $pendingFaultRoot -Filter '*.pending').Count -eq 0) 'pending resume consumes pending bundle'
    Assert-True (-not (Test-Path (Join-Path $pendingFaultRoot 'chimera-signing-transaction.json'))) 'pending resume clears transaction record'

    $concurrentRoot = Join-Path $workspace 'concurrent-backups'
    $concurrentProductPath = Join-Path $workspace 'concurrent-product.json'
    $testProduct.updatePublicKey = ''
    $testProduct.androidSignerSha256 = ''
    $testProduct | ConvertTo-Json | Set-Content -LiteralPath $concurrentProductPath
    $shell = (Get-Process -Id $PID).Path
    $output1 = Join-Path $workspace 'concurrent-1.json'
    $output2 = Join-Path $workspace 'concurrent-2.json'
    $readyPath = Join-Path $workspace 'lock ready.signal'
    $releasePath = Join-Path $workspace 'lock release.signal'
    $childCommand = @'
$ErrorActionPreference = 'Stop'
try {
    $result = & $env:CHIMERA_CHILD_BOOTSTRAP -BackupRoot $env:CHIMERA_CHILD_BACKUP -StorePasswordFile $env:CHIMERA_CHILD_STORE_PASSWORD -KeyPasswordFile $env:CHIMERA_CHILD_KEY_PASSWORD -ProductPath $env:CHIMERA_CHILD_PRODUCT -KeytoolPath $env:CHIMERA_CHILD_KEYTOOL -OpenSslPath $env:CHIMERA_CHILD_OPENSSL 2>&1
    [pscustomobject]@{ ok = $true; output = ($result -join "`n"); exitCode = 0 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CHIMERA_CHILD_OUTPUT
} catch {
    [pscustomobject]@{ ok = $false; output = $_.Exception.Message; exitCode = 1 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CHIMERA_CHILD_OUTPUT
    exit 1
}
'@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
    $env:CHIMERA_CHILD_BOOTSTRAP = $bootstrap
    $env:CHIMERA_CHILD_BACKUP = $concurrentRoot
    $env:CHIMERA_CHILD_STORE_PASSWORD = $passwordFile
    $env:CHIMERA_CHILD_KEY_PASSWORD = $keyPasswordFile
    $env:CHIMERA_CHILD_PRODUCT = $concurrentProductPath
    $env:CHIMERA_CHILD_KEYTOOL = $keytool
    $env:CHIMERA_CHILD_OPENSSL = $openssl
    $env:CHIMERA_TEST_LOCK_READY_PATH = $readyPath
    $env:CHIMERA_TEST_LOCK_RELEASE_PATH = $releasePath
    $env:CHIMERA_CHILD_OUTPUT = $output1
    $process1 = Start-Process -FilePath $shell -ArgumentList '-NoProfile','-EncodedCommand',$encodedCommand -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $readyPath)) {
        if ($process1.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'First bootstrap did not signal that it holds the lock.' }
        Start-Sleep -Milliseconds 25
    }
    $env:CHIMERA_CHILD_OUTPUT = $output2
    $process2 = Start-Process -FilePath $shell -ArgumentList '-NoProfile','-EncodedCommand',$encodedCommand -PassThru -WindowStyle Hidden
    $process2.WaitForExit()
    Assert-True ($process2.ExitCode -ne 0) 'competing bootstrap process exits nonzero'
    New-Item -ItemType File -Path $releasePath | Out-Null
    $process1.WaitForExit()
    Remove-Item Env:CHIMERA_TEST_LOCK_READY_PATH, Env:CHIMERA_TEST_LOCK_RELEASE_PATH -ErrorAction SilentlyContinue
    $concurrentResults = @((Get-Content -Raw $output1 | ConvertFrom-Json), (Get-Content -Raw $output2 | ConvertFrom-Json))
    Assert-True (@($concurrentResults | Where-Object ok).Count -eq 1) 'exactly one concurrent bootstrap succeeds'
    Assert-True (@($concurrentResults | Where-Object { -not $_.ok -and $_.output -match 'already in progress' }).Count -eq 1) 'other concurrent bootstrap is rejected by the held lock'
    $concurrentProduct = Get-Content -Raw $concurrentProductPath | ConvertFrom-Json
    $successfulInventory = ($concurrentResults | Where-Object ok).output | ConvertFrom-Json
    Assert-True ($concurrentProduct.updatePublicKey -eq $successfulInventory.updatePublicKey) 'concurrent product public key matches bundle inventory'
    Assert-True ($concurrentProduct.androidSignerSha256 -eq $successfulInventory.androidSignerSha256) 'concurrent product signer matches bundle inventory'
    Assert-True (-not (Test-Path (Join-Path $concurrentRoot 'chimera-signing-transaction.json'))) 'concurrent bootstrap leaves no transaction record'

    Write-Output 'PASS: bootstrap signing identities'
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $escapedWorkspace -Recurse -Force -ErrorAction SilentlyContinue
}
