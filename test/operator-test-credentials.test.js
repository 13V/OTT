#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { PRIVATE_BASE } = require('../scripts/operator-test-files');
const { validate, saveEncrypted, loadLocalCredentials } = require('../scripts/operator-test-credentials');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok ' + name); }
if (process.platform !== 'win32') {
  check('DPAPI credential setup refuses unsupported platforms', () => assert.throws(() => validate({}), /Windows/));
} else {
  const marker = 'UNIT-PRIVATE-KEY-$(never-execute)-`never-execute`';
  const protect = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$testPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
@{ schema = 1; encryption = 'windows-dpapi-current-user'; KV_REST_API_URL = 'https://unit-test.upstash.io'; BLINK_API_KEY = (ConvertFrom-SecureString (ConvertTo-SecureString $testPayload.key -AsPlainText -Force)); KV_REST_API_TOKEN = (ConvertFrom-SecureString (ConvertTo-SecureString $testPayload.token -AsPlainText -Force)) } | ConvertTo-Json -Compress
`;
  const config = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', protect], {
    input: JSON.stringify({ key: marker, token: marker + '-TOKEN' }), encoding: 'utf8', windowsHide: true,
  }));
  fs.mkdirSync(PRIVATE_BASE, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(PRIVATE_BASE, 'unit-credentials-'));
  const file = path.join(fixture, 'credentials.json');
  try {
    check('plaintext credentials cannot be saved', () => assert.throws(() => saveEncrypted({ ...config, BLINK_API_KEY: marker }, file), /encrypted/));
    check('keys cannot be forwarded to an arbitrary credential endpoint', () => assert.throws(() => saveEncrypted({ ...config, KV_REST_API_URL: 'https://evil.example' }, file), /Upstash/));
    check('credential output cannot enter the repository or OneDrive', () => assert.throws(() => saveEncrypted(config, path.join(__dirname, '..', 'review', 'credentials.json')), /outside/));
    check('encrypted local setup writes no plaintext marker', () => {
      assert.equal(saveEncrypted(config, file), file);
      assert.ok(!fs.readFileSync(file, 'utf8').includes(marker));
    });
    check('DPAPI decrypts only into the calling process result', () => {
      const loaded = loadLocalCredentials(file);
      assert.equal(loaded.BLINK_API_KEY, marker); assert.equal(loaded.KV_REST_API_TOKEN, marker + '-TOKEN');
      assert.equal(loaded.KV_REST_API_URL, 'https://unit-test.upstash.io');
    });
    check('existing credential file cannot be silently replaced', () => assert.throws(() => saveEncrypted(config, file), /already exist/));
    check('corrupt ciphertext produces a generic error', () => {
      const corrupted = path.join(fixture, 'corrupted.json');
      saveEncrypted({ ...config, BLINK_API_KEY: '01000000' + '0'.repeat(120) }, corrupted);
      assert.throws(() => loadLocalCredentials(corrupted), /^Error: Could not unlock local credentials/);
    });
    check('credential CLI rejects plaintext without printing it', () => {
      const result = spawnSync(process.execPath, ['scripts/operator-test-credentials.js'], {
        cwd: path.join(__dirname, '..'), input: JSON.stringify({ ...config, BLINK_API_KEY: marker }), encoding: 'utf8',
      });
      assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(marker));
    });
    check('PowerShell secure prompt parses without running it', () => {
      const script = String.raw`$parseTokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:OTT_PROMPT_SCRIPT, [ref]$parseTokens, [ref]$parseErrors); Write-Output $parseErrors.Count`;
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, OTT_PROMPT_SCRIPT: path.join(__dirname, '..', 'scripts', 'setup-phone-test.ps1') }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.trim(), '0');
    });
  } finally {
    const resolved = fs.realpathSync(fixture);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(PRIVATE_BASE).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('unit-credentials-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
console.log(checks + ' private credential checks passed. Only fixture keys were used.');
