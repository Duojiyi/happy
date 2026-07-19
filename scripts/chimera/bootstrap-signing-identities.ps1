[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $BackupRoot,
    [Parameter(Mandatory)] [string] $StorePasswordFile,
    [Parameter(Mandatory)] [string] $KeyPasswordFile,
    [string] $ProductPath,
    [string] $KeytoolPath,
    [string] $OpenSslPath,
    [switch] $OfflineRecoveryRotation
)

$ErrorActionPreference = 'Stop'

function Get-SecretFromProtectedFile([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw 'Protected password input file was not found.' }
    $protected = Get-Content -LiteralPath $Path -Raw
    $secure = ConvertTo-SecureString $protected
    $credential = [pscredential]::new('unused', $secure)
    return $credential.GetNetworkCredential().Password
}

function Protect-PrivatePath([string] $Path, [bool] $Inheritable = $false) {
    $acl = if (Test-Path -LiteralPath $Path -PathType Container) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $inheritance = if ($Inheritable) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, [System.Security.AccessControl.PropagationFlags]::None, 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-ProductAtomic([string] $Path, $Value) {
    $tempProduct = Join-Path (Split-Path $Path) ('.product.' + [guid]::NewGuid() + '.json')
    try {
        [System.IO.File]::WriteAllText($tempProduct, ($Value | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempProduct -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $tempProduct -Force -ErrorAction SilentlyContinue
    }
}

function Assert-ExactKeys($Value, [string[]] $Keys, [string] $Name) {
    $actual = @($Value.psobject.Properties.Name | Sort-Object)
    if (($actual -join '|') -ne (($Keys | Sort-Object) -join '|')) { throw "$Name has an invalid schema." }
}

function Assert-TemporaryTestPaths([string[]] $Paths, [string] $Message) {
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd($separator) + $separator
    foreach ($path in $Paths) {
        if ([string]::IsNullOrWhiteSpace($path)) { throw $Message }
        $fullPath = [System.IO.Path]::GetFullPath($path)
        if ($fullPath.TrimEnd($separator) -eq $tempRoot.TrimEnd($separator) -or -not $fullPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw $Message }
    }
}

New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
Protect-PrivatePath $BackupRoot $true
$lockPath = Join-Path $BackupRoot '.chimera-signing-bootstrap.lock'
$bootstrapLock = $null
try {
    try {
        $bootstrapLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    catch [System.IO.IOException] {
        throw 'Signing identity bootstrap is already in progress.'
    }
    Protect-PrivatePath $lockPath
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $productPath = if ($ProductPath) { $ProductPath } else { Join-Path $repoRoot 'brand\chimera\product.json' }
    $lockSignalEnabled = [bool]($env:CHIMERA_TEST_LOCK_READY_PATH -or $env:CHIMERA_TEST_LOCK_RELEASE_PATH)
    $faultInjectionEnabled = $env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD -eq '1' -or $env:CHIMERA_TEST_FAIL_AFTER_BUNDLE_RENAME -eq '1'
    if ($lockSignalEnabled) {
        if (-not $env:CHIMERA_TEST_LOCK_READY_PATH -or -not $env:CHIMERA_TEST_LOCK_RELEASE_PATH) { throw 'Test lock signaling requires ready and release paths.' }
        Assert-TemporaryTestPaths @($BackupRoot, $ProductPath, $env:CHIMERA_TEST_LOCK_READY_PATH, $env:CHIMERA_TEST_LOCK_RELEASE_PATH) 'Test lock signaling is only permitted for temporary paths.'
    }
    if ($faultInjectionEnabled) {
        Assert-TemporaryTestPaths @($BackupRoot, $productPath) 'Test fault injection is only permitted for temporary paths.'
    }
    if ($lockSignalEnabled) {
        $readyStream = [System.IO.File]::Open($env:CHIMERA_TEST_LOCK_READY_PATH, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $readyStream.Dispose()
        Protect-PrivatePath $env:CHIMERA_TEST_LOCK_READY_PATH
        $releaseDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $env:CHIMERA_TEST_LOCK_RELEASE_PATH)) {
            if ([DateTime]::UtcNow -gt $releaseDeadline) { throw 'Timed out waiting for test lock release signal.' }
            Start-Sleep -Milliseconds 25
        }
    }

$inputProduct = Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json
$productKeys = @('productName','slug','androidApplicationId','deepLinkSchemes','relayOrigin','repository','upstreamAppVersion','chimeraRevision','androidVersionCode','updatePublicKey','androidSignerSha256')
Assert-ExactKeys $inputProduct $productKeys 'Product metadata'
$product = [ordered]@{ productName=[string]$inputProduct.productName; slug=[string]$inputProduct.slug; androidApplicationId=[string]$inputProduct.androidApplicationId; deepLinkSchemes=@($inputProduct.deepLinkSchemes); relayOrigin=[string]$inputProduct.relayOrigin; repository=[string]$inputProduct.repository; upstreamAppVersion=[string]$inputProduct.upstreamAppVersion; chimeraRevision=[int]$inputProduct.chimeraRevision; androidVersionCode=[int]$inputProduct.androidVersionCode; updatePublicKey=[string]$inputProduct.updatePublicKey; androidSignerSha256=[string]$inputProduct.androidSignerSha256 }
$keytool = if ($KeytoolPath) { $KeytoolPath } elseif (Get-Command keytool.exe -ErrorAction SilentlyContinue) { (Get-Command keytool.exe).Source } else { throw 'KeytoolPath is required when keytool is not on PATH.' }
$openssl = if ($OpenSslPath) { $OpenSslPath } elseif (Get-Command openssl.exe -ErrorAction SilentlyContinue) { (Get-Command openssl.exe).Source } else { throw 'OpenSslPath is required when openssl is not on PATH.' }
if (-not (Test-Path -LiteralPath $keytool) -or @('681280FC4B87B3D8366AD76103CA67421DAEBE4F579851A2193E3866D0F8E617') -notcontains (Get-FileHash -LiteralPath $keytool -Algorithm SHA256).Hash) { throw 'Keytool binary hash did not match the approved tool.' }
if (-not (Test-Path -LiteralPath $openssl) -or @('822034DA8A01558C17CBE53F42F33985A6EAF7C89E21273779F9C6560D8C4D78') -notcontains (Get-FileHash -LiteralPath $openssl -Algorithm SHA256).Hash) { throw 'OpenSSL binary hash did not match the approved tool.' }
$opensslVersion = & $openssl version 2>&1
if ($LASTEXITCODE -ne 0 -or $opensslVersion -notmatch '^OpenSSL 3\.') { throw 'Pinned OpenSSL does not provide required OpenSSL 3.x Ed25519 support.' }

$bundlePath = Join-Path $BackupRoot 'chimera-private-signing-material.zip.enc'
$transactionPath = Join-Path $BackupRoot 'chimera-signing-transaction.json'
$hasTransaction = Test-Path -LiteralPath $transactionPath
if (-not $OfflineRecoveryRotation -and (-not $hasTransaction) -and ((Test-Path -LiteralPath $bundlePath) -or $product.updatePublicKey -or $product.androidSignerSha256)) {
    throw 'Signing identities already exist. Offline recovery/rotation mode is required to replace them.'
}

$storePassword = Get-SecretFromProtectedFile $StorePasswordFile
$keyPassword = Get-SecretFromProtectedFile $KeyPasswordFile
if ($storePassword.Length -lt 6 -or $keyPassword.Length -lt 6) { throw 'Signing passwords must be at least six characters.' }

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("chimera-signing-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    Protect-PrivatePath $staging $true
    $opensslPassFile = Join-Path $staging 'openssl-password.txt'
    [System.IO.File]::WriteAllText($opensslPassFile, $storePassword, [System.Text.UTF8Encoding]::new($false))
    Protect-PrivatePath $opensslPassFile
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    Protect-PrivatePath $BackupRoot $true
    if ($hasTransaction -and -not $OfflineRecoveryRotation) {
        $transaction = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
        Assert-ExactKeys $transaction @('schemaVersion','status','expectedProduct','pendingBundlePath','finalBundlePath','pendingBundleSha256','finalBundleSha256') 'Transaction record'
        Assert-ExactKeys $transaction.expectedProduct $productKeys 'Transaction expected product'
        if ($transaction.schemaVersion -ne 1 -or $transaction.status -ne 'bundle-final-product-pending' -or $transaction.finalBundlePath -ne $bundlePath) { throw 'Incomplete signing transaction record is invalid.' }
        $finalExists = Test-Path -LiteralPath $bundlePath
        $pendingExists = Test-Path -LiteralPath $transaction.pendingBundlePath
        if ($finalExists -eq $pendingExists) { throw 'Incomplete signing transaction bundle state is invalid.' }
        $resumeBundle = if ($finalExists) { $bundlePath } else { [string]$transaction.pendingBundlePath }
        $expectedDigest = if ($finalExists) { [string]$transaction.finalBundleSha256 } else { [string]$transaction.pendingBundleSha256 }
        if ((Get-FileHash -LiteralPath $resumeBundle -Algorithm SHA256).Hash -ne $expectedDigest) { throw 'Incomplete signing transaction bundle digest does not match.' }
        $resumeArchive = Join-Path $staging 'resume.zip'
        & $openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $resumeBundle -out $resumeArchive -pass "file:$opensslPassFile" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Incomplete signing transaction bundle could not be decrypted.' }
        $resumeMaterial = Join-Path $staging 'resume'
        Expand-Archive -LiteralPath $resumeArchive -DestinationPath $resumeMaterial
        $env:CHIMERA_STORE_PASSWORD = $storePassword
        $resumeCertificate = & $keytool -list -v -keystore (Join-Path $resumeMaterial 'chimera-release.jks') -storepass:env CHIMERA_STORE_PASSWORD -alias chimera-release 2>&1
        Remove-Item Env:CHIMERA_STORE_PASSWORD -ErrorAction SilentlyContinue
        $resumeShaLine = $resumeCertificate | Where-Object { $_ -match 'SHA256:' } | Select-Object -First 1
        $resumeSha = (($resumeShaLine -replace '.*SHA256:\s*', '') -replace ':', '').Trim().ToUpperInvariant()
        $resumeDer = Join-Path $staging 'resume-public.der'
        & $openssl pkey -in (Join-Path $resumeMaterial 'manifest-ed25519-private.pem') -pubout -outform DER -out $resumeDer 2>$null
        $resumePublic = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($resumeDer))
        $expected = $transaction.expectedProduct
        $fixed = [ordered]@{ productName='Chimera'; slug='chimera'; androidApplicationId='org.chimerahub.chimera'; deepLinkSchemes=@('chimera','happy'); relayOrigin='https://39.98.68.173'; repository='Duojiyi/happy'; upstreamAppVersion='1.7.0'; chimeraRevision=1; androidVersionCode=1; updatePublicKey=$resumePublic; androidSignerSha256=$resumeSha }
        if (($expected | ConvertTo-Json -Depth 8 -Compress) -ne ($fixed | ConvertTo-Json -Depth 8 -Compress)) { throw 'Incomplete signing transaction public identity validation failed.' }
        if (-not $finalExists) {
            Move-Item -LiteralPath $resumeBundle -Destination $bundlePath
            Protect-PrivatePath $bundlePath
        }
        Write-ProductAtomic $productPath $fixed
        Remove-Item -LiteralPath $transactionPath -Force
        [pscustomobject]@{ encryptedPrivateBundle = $bundlePath; androidKeystore = $bundlePath; updatePublicKey = $resumePublic; androidSignerSha256 = $resumeSha; resumed = $true } | ConvertTo-Json -Compress
        return
    }
    if ($OfflineRecoveryRotation) {
        if (-not (Test-Path -LiteralPath $bundlePath)) { throw 'Offline recovery verification requires the existing encrypted private bundle.' }
        Protect-PrivatePath $bundlePath
        $existingArchive = Join-Path $staging 'existing.zip'
        & $openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $bundlePath -out $existingArchive -pass "file:$opensslPassFile" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Existing private bundle could not be decrypted.' }
        $existingMaterial = Join-Path $staging 'existing'
        Expand-Archive -LiteralPath $existingArchive -DestinationPath $existingMaterial
        $env:CHIMERA_STORE_PASSWORD = $storePassword
        $certificate = & $keytool -list -v -keystore (Join-Path $existingMaterial 'chimera-release.jks') -storepass:env CHIMERA_STORE_PASSWORD -alias chimera-release 2>&1
        Remove-Item Env:CHIMERA_STORE_PASSWORD -ErrorAction SilentlyContinue
        $shaLine = $certificate | Where-Object { $_ -match 'SHA256:' } | Select-Object -First 1
        $existingSha = (($shaLine -replace '.*SHA256:\s*', '') -replace ':', '').Trim().ToUpperInvariant()
        $existingDer = Join-Path $staging 'existing-public.der'
        & $openssl pkey -in (Join-Path $existingMaterial 'manifest-ed25519-private.pem') -pubout -outform DER -out $existingDer 2>$null
        $existingPublic = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($existingDer))
        if ($product.updatePublicKey -ne $existingPublic -or $product.androidSignerSha256 -ne $existingSha) { throw 'Existing public metadata does not match the encrypted signing identities.' }
        throw 'Offline recovery verification succeeded; rotation requires a separate audited procedure.'
    }
    $keystore = Join-Path $staging 'chimera-release.jks'
    $manifestPrivate = Join-Path $staging 'manifest-ed25519-private.pem'
    $manifestPublicDer = Join-Path $staging 'manifest-ed25519-public.der'

    $env:CHIMERA_STORE_PASSWORD = $storePassword
    $env:CHIMERA_KEY_PASSWORD = $keyPassword
    & $keytool -genkeypair -noprompt -storetype JKS -keystore $keystore -storepass:env CHIMERA_STORE_PASSWORD -keypass:env CHIMERA_KEY_PASSWORD -alias chimera-release -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 -dname 'CN=Chimera Release, OU=Chimera, O=Chimera, L=Beijing, C=CN' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Android JKS signing key generation failed.' }
    $certificate = & $keytool -list -v -keystore $keystore -storepass:env CHIMERA_STORE_PASSWORD -alias chimera-release 2>&1
    Remove-Item Env:CHIMERA_STORE_PASSWORD, Env:CHIMERA_KEY_PASSWORD -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw 'Unable to derive Android certificate fingerprint.' }
    $shaLine = $certificate | Where-Object { $_ -match 'SHA256:' } | Select-Object -First 1
    $androidSha = (($shaLine -replace '.*SHA256:\s*', '') -replace ':', '').Trim().ToUpperInvariant()
    if ($androidSha -notmatch '^[0-9A-F]{64}$') { throw 'Unable to derive a valid Android certificate SHA-256 fingerprint.' }

    & $openssl genpkey -algorithm Ed25519 -out $manifestPrivate 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Ed25519 manifest key generation failed.' }
    & $openssl pkey -in $manifestPrivate -pubout -outform DER -out $manifestPublicDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to derive Ed25519 public key.' }
    $updatePublicKey = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($manifestPublicDer))

    $archive = Join-Path $staging 'chimera-private-signing-material.zip'
    Compress-Archive -Path $keystore, $manifestPrivate -DestinationPath $archive -CompressionLevel Optimal
    $pendingBundle = Join-Path $BackupRoot ('.chimera-private-signing-material.' + [guid]::NewGuid() + '.pending')
    & $openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in $archive -out $pendingBundle -pass "file:$opensslPassFile" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Private signing material encryption failed.' }
    Protect-PrivatePath $pendingBundle

    $product.updatePublicKey = $updatePublicKey
    $product.androidSignerSha256 = $androidSha
    $transaction = [pscustomobject]@{ schemaVersion = 1; status = 'bundle-final-product-pending'; expectedProduct = $product; pendingBundlePath = $pendingBundle; finalBundlePath = $bundlePath; pendingBundleSha256 = (Get-FileHash -LiteralPath $pendingBundle -Algorithm SHA256).Hash; finalBundleSha256 = (Get-FileHash -LiteralPath $pendingBundle -Algorithm SHA256).Hash }
    [System.IO.File]::WriteAllText($transactionPath, ($transaction | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    Protect-PrivatePath $transactionPath
    if ($env:CHIMERA_TEST_FAIL_AFTER_TRANSACTION_RECORD -eq '1') {
        throw 'Injected failure after transaction record.'
    }
    Move-Item -LiteralPath $pendingBundle -Destination $bundlePath -Force
    Protect-PrivatePath $bundlePath
    if ($env:CHIMERA_TEST_FAIL_AFTER_BUNDLE_RENAME -eq '1') {
        throw 'Injected failure after final bundle rename.'
    }
    Write-ProductAtomic $productPath $product
    Remove-Item -LiteralPath $transactionPath -Force

    [pscustomobject]@{
        encryptedPrivateBundle = $bundlePath
        androidKeystore = (Join-Path $BackupRoot 'chimera-private-signing-material.zip.enc')
        updatePublicKey = $updatePublicKey
        androidSignerSha256 = $androidSha
    } | ConvertTo-Json -Compress
}
finally {
    Remove-Item Env:CHIMERA_STORE_PASSWORD, Env:CHIMERA_KEY_PASSWORD -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
}
finally {
    if ($null -ne $bootstrapLock) { $bootstrapLock.Dispose() }
}
