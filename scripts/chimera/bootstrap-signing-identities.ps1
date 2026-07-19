[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $BackupRoot,
    [Parameter(Mandatory)] [string] $StorePasswordFile,
    [Parameter(Mandatory)] [string] $KeyPasswordFile,
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

function Protect-PrivatePath([string] $Path) {
    $acl = if (Test-Path -LiteralPath $Path -PathType Container) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$productPath = Join-Path $repoRoot 'brand\chimera\product.json'
$product = Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json
$keytool = 'D:\Desktop\Hack\tools\jdk21\bin\keytool.exe'
$openssl = 'D:\Scoop\apps\git\2.55.0.3\mingw64\bin\openssl.exe'
if (-not (Test-Path -LiteralPath $keytool)) { throw 'Pinned JDK keytool was not found.' }
if (-not (Test-Path -LiteralPath $openssl) -or (Get-FileHash -LiteralPath $openssl -Algorithm SHA256).Hash -ne '822034DA8A01558C17CBE53F42F33985A6EAF7C89E21273779F9C6560D8C4D78') { throw 'Pinned OpenSSL binary hash did not match the approved tool.' }
$opensslVersion = & $openssl version 2>&1
if ($LASTEXITCODE -ne 0 -or $opensslVersion -notmatch '^OpenSSL 3\.') { throw 'Pinned OpenSSL does not provide required OpenSSL 3.x Ed25519 support.' }

$bundlePath = Join-Path $BackupRoot 'chimera-private-signing-material.zip.enc'
if (-not $OfflineRecoveryRotation -and ((Test-Path -LiteralPath $bundlePath) -or $product.updatePublicKey -or $product.androidSignerSha256)) {
    throw 'Signing identities already exist. Offline recovery/rotation mode is required to replace them.'
}

$storePassword = Get-SecretFromProtectedFile $StorePasswordFile
$keyPassword = Get-SecretFromProtectedFile $KeyPasswordFile
if ($storePassword.Length -lt 6 -or $keyPassword.Length -lt 6) { throw 'Signing passwords must be at least six characters.' }

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("chimera-signing-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    Protect-PrivatePath $staging
    $opensslPassFile = Join-Path $staging 'openssl-password.txt'
    [System.IO.File]::WriteAllText($opensslPassFile, $storePassword, [System.Text.UTF8Encoding]::new($false))
    Protect-PrivatePath $opensslPassFile
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    Protect-PrivatePath $BackupRoot
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
    $bundle = $bundlePath
    & $openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in $archive -out $bundle -pass "file:$opensslPassFile" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Private signing material encryption failed.' }
    Protect-PrivatePath $bundle

    $product.updatePublicKey = $updatePublicKey
    $product.androidSignerSha256 = $androidSha
    $tempProduct = Join-Path (Split-Path $productPath) ('.product.' + [guid]::NewGuid() + '.json')
    [System.IO.File]::WriteAllText($tempProduct, ($product | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempProduct -Destination $productPath -Force

    [pscustomobject]@{
        encryptedPrivateBundle = $bundle
        androidKeystore = (Join-Path $BackupRoot 'chimera-private-signing-material.zip.enc')
        updatePublicKey = $updatePublicKey
        androidSignerSha256 = $androidSha
    } | ConvertTo-Json -Compress
}
finally {
    Remove-Item Env:CHIMERA_STORE_PASSWORD, Env:CHIMERA_KEY_PASSWORD -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
