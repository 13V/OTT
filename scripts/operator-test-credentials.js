'use strict';
// User-entered credentials stay outside OneDrive, encrypted for this Windows user.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PRIVATE_BASE, privatePath, writePrivate } = require('./operator-test-files');
const FILE = path.join(PRIVATE_BASE, 'credentials.json');

function validate(config) {
  if (process.platform !== 'win32') throw new Error('Local credentials require Windows user encryption.');
  if (!config || config.schema !== 1 || config.encryption !== 'windows-dpapi-current-user') throw new Error('Invalid encrypted credential format.');
  let url;
  try { url = new URL(config.KV_REST_API_URL); } catch { throw new Error('Use the verified Upstash HTTPS REST endpoint.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use the verified Upstash HTTPS REST endpoint.');
  for (const name of ['BLINK_API_KEY', 'KV_REST_API_TOKEN']) {
    if (typeof config[name] !== 'string' || !/^01000000[0-9a-f]{100,131072}$/i.test(config[name])) throw new Error('Credential values must be encrypted with Windows DPAPI.');
  }
  return { schema: 1, encryption: 'windows-dpapi-current-user', KV_REST_API_URL: url.origin,
    BLINK_API_KEY: config.BLINK_API_KEY, KV_REST_API_TOKEN: config.KV_REST_API_TOKEN };
}
function saveEncrypted(config, file = FILE) {
  const target = privatePath(file);
  if (fs.existsSync(target)) throw new Error('Local credentials already exist. Review the existing file before replacing it.');
  return writePrivate(target, JSON.stringify(validate(config), null, 2) + '\n');
}
function loadLocalCredentials(file = FILE) {
  const target = privatePath(file);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Local credentials cannot be a symbolic link.');
  const config = validate(JSON.parse(fs.readFileSync(target, 'utf8')));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$credentialPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$credentialFile = New-Object System.IO.FileInfo($credentialPayload.file)
$credentialAcl = $credentialFile.GetAccessControl()
$credentialOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$credentialIds = $credentialAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }
if (!$credentialAcl.AreAccessRulesProtected -or ($credentialIds | Where-Object { $_ -ne $credentialOwner -and $_ -ne 'S-1-5-18' })) { throw 'Private credential ACL required' }
function Unprotect-Credential($ciphertext) {
  $secureCredential = ConvertTo-SecureString $ciphertext
  $credentialPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCredential)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialPointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialPointer); $secureCredential.Dispose() }
}
@{ BLINK_API_KEY = (Unprotect-Credential $credentialPayload.BLINK_API_KEY); KV_REST_API_TOKEN = (Unprotect-Credential $credentialPayload.KV_REST_API_TOKEN) } | ConvertTo-Json -Compress
`;
  let decoded;
  try {
    decoded = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify({ ...config, file: target }), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('Could not unlock local credentials for this Windows user.'); }
  if (!decoded.BLINK_API_KEY || !decoded.KV_REST_API_TOKEN) throw new Error('Local credentials are incomplete.');
  return { BLINK_API_KEY: decoded.BLINK_API_KEY, KV_REST_API_URL: config.KV_REST_API_URL, KV_REST_API_TOKEN: decoded.KV_REST_API_TOKEN };
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { saveEncrypted(JSON.parse(input)); console.log('Encrypted local credentials saved. No account or payment was created.'); }
    catch { console.error('Credentials were not saved. Check the private file, Windows encryption and Upstash endpoint.'); process.exitCode = 1; }
  });
}
module.exports = { FILE, validate, saveEncrypted, loadLocalCredentials };
