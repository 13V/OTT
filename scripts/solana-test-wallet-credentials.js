'use strict';
// Isolated software test wallet. No RPC, funding, plaintext file export or network account creation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PRIVATE_BASE, privatePath, writePrivate } = require('./operator-test-files');
const { encodeAddress, decodeAddress } = require('../site/api/_lib/solana-auth');
const FILE = path.join(PRIVATE_BASE, 'solana-wallet.json');
const PURPOSE = 'ott-isolated-solana-test-wallet';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const FAILURE = 'Could not use the private Solana test wallet. Check Windows user encryption, protected storage and the supplied wallet format.';

function windowsOnly() {
  if (process.platform !== 'win32') throw new Error('Solana test-wallet credentials require Windows user encryption.');
}
function safePath(file) {
  const absolute = path.resolve(file);
  // Reject final links and ancestor junctions before privatePath canonicalizes them.
  for (let current = absolute; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(FAILURE); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return privatePath(absolute);
}
function runPowerShell(script, payload) {
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 16384,
    }));
  } catch { throw new Error(FAILURE); }
}
const POWERSHELL_START = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$walletPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
`;
function assertPrivateAcl(file) {
  const script = POWERSHELL_START + String.raw`
$walletFile = New-Object System.IO.FileInfo($walletPayload.file)
$walletAcl = $walletFile.GetAccessControl()
$walletOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$walletIds = $walletAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }
if (!$walletAcl.AreAccessRulesProtected -or $walletAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $walletOwner -or ($walletIds | Where-Object { $_ -ne $walletOwner -and $_ -ne 'S-1-5-18' })) { throw 'Private wallet ACL required' }
'true'
`;
  if (runPowerShell(script, { file }) !== true) throw new Error(FAILURE);
}
function validCiphertext(ciphertext) {
  return typeof ciphertext === 'string' && /^01000000(?:[0-9a-f]{2}){50,4096}$/i.test(ciphertext);
}
function encrypt(text) {
  const script = POWERSHELL_START + String.raw`
$walletSecure = ConvertTo-SecureString $walletPayload.secret -AsPlainText -Force
try { ConvertFrom-SecureString $walletSecure | ConvertTo-Json -Compress }
finally { $walletSecure.Dispose() }
`;
  const ciphertext = runPowerShell(script, { secret: text });
  if (!validCiphertext(ciphertext)) throw new Error(FAILURE);
  return ciphertext;
}
function decrypt(ciphertext) {
  if (!validCiphertext(ciphertext)) throw new Error(FAILURE);
  const script = POWERSHELL_START + String.raw`
$walletSecure = ConvertTo-SecureString $walletPayload.ciphertext
$walletPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($walletSecure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($walletPointer) | ConvertTo-Json -Compress }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($walletPointer); $walletSecure.Dispose() }
`;
  return runPowerShell(script, { ciphertext });
}
function decodeSecret(text) {
  if (typeof text !== 'string' || !text || text.length > 2048) throw new Error(FAILURE);
  if (text.startsWith('[')) {
    const value = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== 64 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error(FAILURE);
    return Buffer.from(value);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(text)) throw new Error(FAILURE);
  let value = 0n;
  for (const char of text) value = value * 58n + BigInt(ALPHABET.indexOf(char));
  const hex = value.toString(16);
  const body = value ? Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex') : Buffer.alloc(0);
  const bytes = Buffer.concat([Buffer.alloc(/^1*/.exec(text)[0].length), body]);
  if (bytes.length !== 64 || encodeAddress(bytes) !== text) { bytes.fill(0); throw new Error(FAILURE); }
  return bytes;
}
function signerFromSecret(secret, address) {
  let privateKey;
  const encoded = Buffer.concat([PKCS8_PREFIX, secret.subarray(0, 32)]);
  try {
    if (secret.length !== 64 || !decodeAddress(address)) throw new Error(FAILURE);
    privateKey = crypto.createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' });
    const exported = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (exported.length !== SPKI_PREFIX.length + 32 || !exported.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) throw new Error(FAILURE);
    const publicKey = Buffer.from(exported.subarray(SPKI_PREFIX.length));
    if (!crypto.timingSafeEqual(publicKey, secret.subarray(32)) || encodeAddress(publicKey) !== address) throw new Error(FAILURE);
    return { address, chain: 'solana', publicKey,
      sign(message) {
        if (!privateKey || !(message instanceof Uint8Array)) throw new Error(FAILURE);
        try { return crypto.sign(null, message, privateKey); } catch { throw new Error(FAILURE); }
      },
      dispose() { privateKey = null; } };
  } finally { encoded.fill(0); secret.fill(0); }
}
function validateRecord(record) {
  if (!record || record.schema !== 1 || record.purpose !== PURPOSE || record.chain !== 'solana' ||
      record.encryption !== 'windows-dpapi-current-user' || !decodeAddress(record.address) || !validCiphertext(record.ciphertext)) throw new Error(FAILURE);
  return record;
}
function readRecord(file) {
  windowsOnly();
  const target = safePath(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 16384) throw new Error(FAILURE);
  assertPrivateAcl(target); // Verify the existing private file before reading or decrypting it.
  return { target, record: validateRecord(JSON.parse(fs.readFileSync(target, 'utf8'))) };
}
function info(target, record) {
  return { schema: record.schema, purpose: record.purpose, address: record.address,
    chain: 'solana', file: target, encrypted: true };
}
function readWalletInfo(file = FILE) {
  try { const { target, record } = readRecord(file); return info(target, record); }
  catch { throw new Error(FAILURE); }
}
function writeNew(file, makeRecord) {
  windowsOnly();
  const target = safePath(file);
  if (fs.existsSync(target)) throw new Error('The private Solana test wallet already exists and cannot be replaced.');
  const staging = safePath(path.join(path.dirname(target), '.solana-wallet-' + crypto.randomUUID() + '.tmp'));
  try {
    // Establish the private directory/file ACLs before generating or decrypting any key material.
    writePrivate(staging, '');
    const record = validateRecord(makeRecord());
    writePrivate(staging, JSON.stringify(record, null, 2) + '\n');
    if (safePath(target) !== target) throw new Error(FAILURE);
    // A hard-link creation is atomic and fails if any file/link already owns the destination.
    // Unlike rename/writePrivate, it cannot overwrite a competing setup's completed wallet.
    fs.linkSync(staging, target);
    return info(target, record);
  } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
}
function createWallet(file = FILE) {
  try {
    return writeNew(file, () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const jwk = privateKey.export({ format: 'jwk' });
      const secret = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]);
      try {
        const address = encodeAddress(publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length));
        const validated = signerFromSecret(Buffer.from(secret), address); validated.dispose();
        return { schema: 1, purpose: PURPOSE, chain: 'solana', encryption: 'windows-dpapi-current-user',
          address, ciphertext: encrypt(encodeAddress(secret)) };
      } finally { secret.fill(0); }
    });
  } catch (error) {
    if (error.message === 'The private Solana test wallet already exists and cannot be replaced.') throw error;
    throw new Error(FAILURE);
  }
}
function importEncryptedWallet(config = {}, file = FILE) {
  try {
    const { ciphertext, address } = config;
    return writeNew(file, () => {
      if (!decodeAddress(address) || !validCiphertext(ciphertext)) throw new Error(FAILURE);
      const validated = signerFromSecret(decodeSecret(decrypt(ciphertext)), address); validated.dispose();
      return { schema: 1, purpose: PURPOSE, chain: 'solana', encryption: 'windows-dpapi-current-user', address, ciphertext };
    });
  } catch (error) {
    if (error.message === 'The private Solana test wallet already exists and cannot be replaced.') throw error;
    throw new Error(FAILURE);
  }
}
function loadWallet(file = FILE) {
  try {
    const { record } = readRecord(file);
    return signerFromSecret(decodeSecret(decrypt(record.ciphertext)), record.address);
  } catch { throw new Error(FAILURE); }
}
if (require.main === module) {
  // Secure import receives encrypted data only on stdin. Root's workflow owns fresh creation.
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 16384) { console.error(FAILURE); process.exit(1); } });
  process.stdin.on('end', () => {
    try { console.log(JSON.stringify(importEncryptedWallet(JSON.parse(input)))); }
    catch { console.error(FAILURE); process.exitCode = 1; }
  });
}
module.exports = { FILE, PURPOSE, createWallet, importEncryptedWallet, readWalletInfo, loadWallet };
