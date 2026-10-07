# Optional isolated wallet import. Private input is hidden and DPAPI-encrypted before Node receives it.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$walletTarget = Join-Path $env:USERPROFILE '.codex\private\ott-phone-test\solana-wallet.json'
if (Test-Path -LiteralPath $walletTarget) { throw 'The private Solana test wallet already exists and cannot be replaced.' }
Write-Host 'Import only your isolated test wallet. Do not enter a mnemonic or paste a key into chat.'
$walletAddress = Read-Host 'Solana public address'
$walletSecret = Read-Host '64-byte private key (base58 or Solana CLI JSON array; hidden input)' -AsSecureString
try {
  @{ address = $walletAddress; ciphertext = (ConvertFrom-SecureString $walletSecret) } | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'solana-test-wallet-credentials.js')
  if ($LASTEXITCODE -ne 0) { throw 'Private wallet import failed. No wallet was replaced.' }
  Write-Host 'The isolated wallet is saved with Windows user encryption. No funds or blockchain transactions were created.'
} finally { $walletSecret.Dispose() }
