[CmdletBinding()]
param(
    [string] $HostIp = '39.98.68.173'
)

$ErrorActionPreference = 'Stop'
$base = "https://$HostIp"

$tcp = [Net.Sockets.TcpClient]::new($HostIp, 443)
$tls = $null
try {
    $tls = [Net.Security.SslStream]::new($tcp.GetStream(), $false)
    $tls.AuthenticateAsClient($HostIp)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    if (-not $chain.Build($certificate)) { throw 'TLS certificate chain is not publicly trusted.' }
    $san = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1
    if ($null -eq $san -or $san.Format($false) -notmatch "(?<![0-9])$([regex]::Escape($HostIp))(?![0-9])") { throw 'TLS certificate lacks the required IP SAN.' }
    if ($certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddHours(48)) { throw 'TLS certificate expires in less than 48 hours.' }
} finally {
    if ($null -ne $tls) { $tls.Dispose() }
    $tcp.Dispose()
}

function Invoke-ChimeraGet([string] $Path) {
    $response = Invoke-WebRequest -Uri "$base$Path" -Method Get -TimeoutSec 20 -MaximumRedirection 0
    if ($response.StatusCode -ne 200) { throw "$Path returned HTTP $($response.StatusCode)" }
    return $response
}

$health = Invoke-ChimeraGet '/health'
$config = (Invoke-ChimeraGet '/v1/chimera/config').Content | ConvertFrom-Json
if ($null -eq $config.announcement -or $config.androidUpdateManifestPath -ne '/downloads/chimera-update.json') {
    throw 'Public Chimera configuration has an unexpected schema.'
}

$manifest = (Invoke-ChimeraGet '/downloads/chimera-update.json').Content | ConvertFrom-Json
if ($manifest.PSObject.Properties.Name -notcontains 'payload' -or $manifest.PSObject.Properties.Name -notcontains 'signature') {
    throw 'Android update manifest envelope is invalid.'
}

foreach ($port in 80, 443) {
    if (-not (Test-NetConnection -ComputerName $HostIp -Port $port -InformationLevel Quiet)) {
        throw "Required TCP port $port is not reachable."
    }
}

Write-Output "Chimera external smoke checks passed for $HostIp"
