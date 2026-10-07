#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { PRIVATE_BASE, writePrivate } = require('../scripts/operator-test-files');
const { encodeAddress, decodeAddress } = require('../site/api/_lib/solana-auth');
const { FILE, PURPOSE, createWallet, importEncryptedWallet, readWalletInfo, loadWallet } = require('../scripts/solana-test-wallet-credentials');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok ' + name); }
const GENERIC = /^Error: Could not use the private Solana test wallet\./;
const publicFields = ['address', 'chain', 'encrypted', 'file', 'purpose', 'schema'];
check('isolated default file stays in the existing private directory', () => assert.equal(FILE, path.join(PRIVATE_BASE, 'solana-wallet.json')));
if (process.platform !== 'win32') {
  check('wallet creation refuses unsupported platforms without creating a file', () => assert.throws(() => createWallet(path.join(os.tmpdir(), 'unused-solana-wallet.json')), GENERIC));
  check('wallet import, metadata and unlock refuse unsupported platforms', () => {
    for (const action of [() => importEncryptedWallet({}), () => readWalletInfo(), () => loadWallet()]) assert.throws(action, GENERIC);
  });
} else {
  const ps = (script, payload) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const encrypt = text => JSON.parse(ps(String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$fixturePayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fixtureSecure = ConvertTo-SecureString $fixturePayload.secret -AsPlainText -Force
try { ConvertFrom-SecureString $fixtureSecure | ConvertTo-Json -Compress }
finally { $fixtureSecure.Dispose() }
`, { secret: text }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const secret = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]);
  const address = encodeAddress(secret.subarray(32));
  const base58 = encodeAddress(secret);
  const ciphertext = encrypt(base58);
  fs.mkdirSync(PRIVATE_BASE, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(PRIVATE_BASE, 'unit-solana-wallet-'));
  const file = name => path.join(fixture, name + '.json');
  try {
    check('new fixture wallet exposes only public metadata and encrypted storage', () => {
      const result = createWallet(file('generated'));
      assert.deepEqual(Object.keys(result).sort(), publicFields);
      assert.equal(result.schema, 1); assert.equal(result.purpose, PURPOSE); assert.equal(result.chain, 'solana');
      assert.equal(result.encrypted, true); assert.ok(decodeAddress(result.address));
      const stored = JSON.parse(fs.readFileSync(result.file, 'utf8'));
      assert.equal(stored.address, result.address); assert.match(stored.ciphertext, /^01000000/);
      assert.ok(!('secretKey' in stored)); assert.ok(!('seed' in stored));
    });
    check('created fixture signer matches its advertised Ed25519 public key', () => {
      const wallet = loadWallet(file('generated'));
      const message = Buffer.from('local generated fixture proof; no transaction');
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey]), format: 'der', type: 'spki' });
      assert.equal(encodeAddress(wallet.publicKey), wallet.address);
      assert.equal(crypto.verify(null, message, pub, wallet.sign(message)), true);
      assert.ok(!('secretKey' in wallet)); assert.ok(!('privateKey' in wallet));
      wallet.dispose(); assert.throws(() => wallet.sign(message), GENERIC);
    });
    check('existing generated wallet cannot be replaced', () => {
      const original = fs.readFileSync(file('generated'), 'utf8');
      assert.throws(() => createWallet(file('generated')), /already exists/);
      assert.throws(() => importEncryptedWallet({ address, ciphertext }, file('generated')), /already exists/);
      assert.equal(fs.readFileSync(file('generated'), 'utf8'), original);
    });
    check('encrypted base58 import validates and never writes the fixture secret', () => {
      const result = importEncryptedWallet({ address, ciphertext }, file('imported'));
      assert.deepEqual(Object.keys(result).sort(), publicFields); assert.equal(result.address, address);
      const stored = fs.readFileSync(result.file, 'utf8');
      for (const value of [base58, secret.toString('base64'), JSON.stringify([...secret])]) assert.ok(!stored.includes(value));
      assert.equal(readWalletInfo(result.file).address, address);
    });
    check('imported fixture signer verifies only the matching message/key and disposes safely', () => {
      const wallet = loadWallet(file('imported'));
      const message = Buffer.from('local imported fixture proof; no transaction');
      const sig = wallet.sign(message);
      assert.equal(sig.length, 64); assert.equal(crypto.verify(null, message, publicKey, sig), true);
      assert.equal(crypto.verify(null, Buffer.from('different fixture'), publicKey, sig), false);
      assert.throws(() => wallet.sign('string input refused'), GENERIC);
      wallet.dispose(); assert.throws(() => wallet.sign(message), GENERIC);
    });
    check('Solana CLI JSON import validates the same 64-byte key', () => {
      const imported = importEncryptedWallet({ address, ciphertext: encrypt(JSON.stringify([...secret])) }, file('json-import'));
      assert.equal(imported.address, address); const wallet = loadWallet(imported.file); wallet.dispose();
    });
    check('public address mismatch and altered public-key half refuse import', () => {
      const different = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
      assert.throws(() => importEncryptedWallet({ address: encodeAddress(Buffer.from(different.x, 'base64url')), ciphertext }, file('wrong-address')), GENERIC);
      const altered = Buffer.from(secret); altered[63] ^= 1;
      assert.throws(() => importEncryptedWallet({ address, ciphertext: encrypt(encodeAddress(altered)) }, file('wrong-public-half')), GENERIC);
      altered.fill(0); assert.equal(fs.existsSync(file('wrong-address')), false); assert.equal(fs.existsSync(file('wrong-public-half')), false);
    });
    check('32-byte seed, malformed base58 and non-byte JSON arrays are rejected', () => {
      for (const value of [encodeAddress(secret.subarray(0, 32)), '0'.repeat(88), '1'.repeat(65), JSON.stringify([...secret.slice(0, 63)]),
        JSON.stringify([...secret.slice(0, 63), 256]), JSON.stringify([...secret.slice(0, 63), 1.5]), JSON.stringify([...secret.slice(0, 63), '1'])]) {
        assert.throws(() => importEncryptedWallet({ address, ciphertext: encrypt(value) }, file('invalid-key')), GENERIC);
        assert.equal(fs.existsSync(file('invalid-key')), false);
      }
    });
    check('plaintext, malformed ciphertext and noncanonical public addresses are rejected', () => {
      for (const value of [{ address, ciphertext: base58 }, { address, ciphertext: '01000000' + '0'.repeat(120) },
        { address: address + '1', ciphertext }, { address: ' ' + address, ciphertext }, { address: address.toLowerCase(), ciphertext }, null]) {
        assert.throws(() => importEncryptedWallet(value, file('invalid-input')), GENERIC);
        assert.equal(fs.existsSync(file('invalid-input')), false);
      }
    });
    check('public-only info does not decrypt or validate private signing material', () => {
      const stored = JSON.parse(fs.readFileSync(file('imported'), 'utf8'));
      const corrupt = { ...stored, ciphertext: '01000000' + '0'.repeat(120) };
      writePrivate(file('corrupt'), JSON.stringify(corrupt));
      const result = readWalletInfo(file('corrupt'));
      assert.deepEqual(Object.keys(result).sort(), publicFields); assert.equal(result.address, address);
      assert.throws(() => loadWallet(file('corrupt')), GENERIC);
    });
    check('decrypted signer must match the stored public metadata before use', () => {
      const stored = JSON.parse(fs.readFileSync(file('imported'), 'utf8'));
      const different = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
      writePrivate(file('wrong-metadata'), JSON.stringify({ ...stored, address: encodeAddress(Buffer.from(different.x, 'base64url')) }));
      assert.throws(() => loadWallet(file('wrong-metadata')), GENERIC);
    });
    check('wrong purpose/schema/chain and oversized records cannot be read or unlocked', () => {
      const stored = JSON.parse(fs.readFileSync(file('imported'), 'utf8'));
      for (const change of [{ schema: 2 }, { purpose: 'blink-credentials' }, { chain: 'evm' }, { address: 'not-a-wallet' }]) {
        writePrivate(file('wrong-schema'), JSON.stringify({ ...stored, ...change }));
        assert.throws(() => readWalletInfo(file('wrong-schema')), GENERIC); assert.throws(() => loadWallet(file('wrong-schema')), GENERIC);
      }
      writePrivate(file('oversized'), ' '.repeat(16385)); assert.throws(() => readWalletInfo(file('oversized')), GENERIC);
    });
    check('wallet output cannot enter the repository, OneDrive or an arbitrary directory', () => {
      for (const target of [path.join(__dirname, '..', 'review', 'wallet.json'), path.join(os.homedir(), 'OneDrive', 'wallet.json'), path.join(os.tmpdir(), 'wallet.json')]) {
        assert.throws(() => createWallet(target), GENERIC); assert.throws(() => importEncryptedWallet({ address, ciphertext }, target), GENERIC);
      }
    });
    check('wallet file ACL permits only this user and SYSTEM and relaxed ACL refuses reads', () => {
      const checkAcl = String.raw`
$fixturePayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fixtureFile = New-Object System.IO.FileInfo($fixturePayload.file)
$fixtureAcl = $fixtureFile.GetAccessControl()
$fixtureOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixtureIds = $fixtureAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }
Write-Output ($fixtureAcl.AreAccessRulesProtected -and !($fixtureIds | Where-Object { $_ -ne $fixtureOwner -and $_ -ne 'S-1-5-18' }))
`;
      assert.equal(ps(checkAcl, { file: file('imported') }).trim(), 'True');
      const stored = fs.readFileSync(file('imported'), 'utf8'); writePrivate(file('relaxed'), stored);
      ps(String.raw`
$fixturePayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fixtureFile = New-Object System.IO.FileInfo($fixturePayload.file)
$fixtureAcl = $fixtureFile.GetAccessControl()
$fixtureAcl.SetAccessRuleProtection($false, $true)
$fixtureFile.SetAccessControl($fixtureAcl)
`, { file: file('relaxed') });
      assert.throws(() => readWalletInfo(file('relaxed')), GENERIC); assert.throws(() => loadWallet(file('relaxed')), GENERIC);
    });
    check('junction ancestors are rejected before creation, import or public read', () => {
      const junction = path.join(fixture, 'junction');
      fs.symlinkSync(fixture, junction, 'junction');
      try {
        assert.throws(() => createWallet(path.join(junction, 'linked.json')), GENERIC);
        assert.throws(() => importEncryptedWallet({ address, ciphertext }, path.join(junction, 'linked.json')), GENERIC);
        assert.throws(() => readWalletInfo(path.join(junction, 'imported.json')), GENERIC);
        assert.throws(() => loadWallet(path.join(junction, 'imported.json')), GENERIC);
      } finally { fs.unlinkSync(junction); }
    });
    check('atomic publication cannot overwrite a competing wallet file', () => {
      const originalLink = fs.linkSync;
      try {
        fs.linkSync = (source, target) => { writePrivate(target, 'competing-wallet-fixture'); return originalLink(source, target); };
        assert.throws(() => createWallet(file('race')), GENERIC);
        assert.equal(fs.readFileSync(file('race'), 'utf8'), 'competing-wallet-fixture');
      } finally { fs.linkSync = originalLink; }
    });
    check('failed imports leave no temporary key files behind', () => assert.equal(fs.readdirSync(fixture).filter(name => name.endsWith('.tmp')).length, 0));
    check('credential CLI rejects plaintext without printing supplied private markers', () => {
      const marker = 'UNIT-PRIVATE-SOLANA-KEY-$(never-execute)-`never-execute`';
      const result = spawnSync(process.execPath, ['scripts/solana-test-wallet-credentials.js'], {
        cwd: path.join(__dirname, '..'), input: JSON.stringify({ address, ciphertext: marker }), encoding: 'utf8',
      });
      assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(marker));
    });
    check('optional secure import prompt parses without running it', () => {
      const script = String.raw`
$fixturePayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$parseTokens = $null; $parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($fixturePayload.file, [ref]$parseTokens, [ref]$parseErrors)
Write-Output $parseErrors.Count
`;
      assert.equal(ps(script, { file: path.join(__dirname, '..', 'scripts/setup-solana-test-wallet.ps1') }).trim(), '0');
    });
  } finally {
    secret.fill(0);
    const resolved = fs.realpathSync(fixture);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(PRIVATE_BASE).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('unit-solana-wallet-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
console.log(checks + ' Solana test-wallet credential checks passed. Only temporary generated fixture keys were used.');
