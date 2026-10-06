# Run this yourself in PowerShell. Keys are entered without echo and encrypted by Windows.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$credentialTarget = Join-Path $env:USERPROFILE '.codex\private\ott-phone-test\credentials.json'
if (Test-Path -LiteralPath $credentialTarget) { throw 'Local credentials already exist. Review the existing private file before replacing it.' }
Write-Host 'Use your dedicated, unfunded Blink test wallet. Do not paste keys into chat.'
$blinkCredential = Read-Host 'Blink API key (hidden input)' -AsSecureString
$redisEndpoint = Read-Host 'Upstash HTTPS REST URL'
$redisCredential = Read-Host 'Upstash standard read/write REST token (hidden input)' -AsSecureString
try {
  $encryptedCredentials = @{
    schema = 1
    encryption = 'windows-dpapi-current-user'
    BLINK_API_KEY = (ConvertFrom-SecureString $blinkCredential)
    KV_REST_API_URL = $redisEndpoint
    KV_REST_API_TOKEN = (ConvertFrom-SecureString $redisCredential)
  }
  $encryptedCredentials | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'operator-test-credentials.js')
  if ($LASTEXITCODE -ne 0) { throw 'Private credential setup failed.' }
  Write-Host 'Next: run the read-only preflight. Leave the wallet unfunded until we review its results.'
} finally {
  $blinkCredential.Dispose()
  $redisCredential.Dispose()
  $encryptedCredentials = $null
}
