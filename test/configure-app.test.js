#!/usr/bin/env node
'use strict';
/** Public activation settings are validated before touching any configuration. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { parseArgs, configureApp } = require('../scripts/configure-app.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-configure-app-'));
const filename = path.join(scratch, 'app.json');
let checks = 0;
function check(name, callback) {
  callback(); checks++; console.log('  ok   ' + name);
}
const write = value => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'));

try {
  check('the backend setting stores a canonical origin and preserves unrelated fields', () => {
    write({ apiBaseUrl: 'https://old.example', theme: { name: 'clay' } });
    assert.equal(configureApp(['--api-origin', 'https://Backend.example:443/'], filename).changed, true);
    assert.deepEqual(read(), { apiBaseUrl: 'https://backend.example', theme: { name: 'clay' } });
  });
  check('repeated identical input does not rewrite bytes', () => {
    configureApp(['--api-origin', 'https://api.example:8443'], filename);
    const before = fs.readFileSync(filename);
    assert.equal(configureApp(['--api-origin', 'https://api.example:8443'], filename).changed, false);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(read().theme.name, 'clay');
  });
  check('unrelated JSON keys are preserved as data without changing object prototypes', () => {
    fs.writeFileSync(filename, '{"__proto__":{"keep":"root"},"walletConnect":{"projectId":"","__proto__":{"keep":"wallet"}}}');
    configureApp(['--api-origin', 'https://api.example'], filename);
    assert.equal(Object.hasOwn(read(), '__proto__'), true);
    assert.equal(read().__proto__.keep, 'root');
    assert.equal(Object.hasOwn(read().walletConnect, '__proto__'), true);
    assert.equal(read().walletConnect.__proto__.keep, 'wallet');
  });
  check('missing, duplicate, unknown and secret-shaped inputs make no writes', () => {
    const before = fs.readFileSync(filename);
    for (const args of [[], ['--api-origin'], ['--api-origin', ''], ['--api-origin', '--api-origin'],
      ['--api-origin', 'https://api.example', '--api-origin', 'https://api.example'], ['--token', 'sample-private-token'],
      // The WalletConnect project id belonged to the Robinhood Chain wallet and is no longer a setting.
      ['--project-id', '0123456789abcdef0123456789abcdef'], ['--api-origin=https://api.example']]) {
      assert.throws(() => configureApp(args, filename));
      assert.deepEqual(fs.readFileSync(filename), before);
    }
  });
  check('API origin refuses protocols, paths, query strings, fragments and credentials', () => {
    const before = fs.readFileSync(filename);
    for (const origin of ['http://api.example', 'javascript:alert(1)', '//api.example', 'https://api.example/api',
      'https://api.example/..', 'https://api.example/./', 'https://api.example?token=sample-private-token',
      'https://api.example#fragment', 'https://user:sample-private-token@api.example', 'https://api.example\\',
      ' https://api.example', 'https://api.example ', 'https://api.example:99999', 'https://']) {
      assert.throws(() => configureApp(['--api-origin', origin], filename));
      assert.deepEqual(fs.readFileSync(filename), before);
    }
  });
  check('malformed configuration remains untouched', () => {
    for (const value of ['{"invalid":"sample-private-token"', '[]', 'null']) {
      fs.writeFileSync(filename, value);
      assert.throws(() => configureApp(['--api-origin', 'https://api.example'], filename));
      assert.equal(fs.readFileSync(filename, 'utf8'), value);
    }
    assert.throws(() => configureApp(['--api-origin', 'https://api.example'], path.join(scratch, 'missing.json')));
    assert.equal(fs.existsSync(path.join(scratch, 'missing.json')), false);
  });
  check('saved API origin matches the runtime client resolver', () => {
    write({ apiBaseUrl: '' });
    configureApp(['--api-origin', 'https://api.example'], filename);
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'site', 'client-config.js'), 'utf8'), { window, URL, location: { hostname: '13v.github.io' } });
    window.OTTClientConfig.configure(read());
    assert.equal(window.OTTClientConfig.apiUrl('./api/redeem?address=public'), 'https://api.example/api/redeem?address=public');
    assert.equal(window.OTTClientConfig.apiUrl('./api/status'), 'https://api.example/api/status');
    // Only the two API routes the site has are allowed; the old Solana sign-in route is gone.
    assert.throws(() => window.OTTClientConfig.apiUrl('./api/auth'));
  });
  check('CLI usage and error output never print supplied secret values', () => {
    const script = path.join(__dirname, '..', 'scripts', 'configure-app.js');
    const before = fs.readFileSync(path.join(__dirname, '..', 'site', 'config', 'app.json'));
    for (const args of [['--token', 'sample-private-token'], ['--api-origin', 'https://user:sample-private-token@api.example'], []]) {
      const out = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      assert.equal(out.status, 1);
      assert.equal((out.stdout + out.stderr).includes('sample-private-token'), false);
    }
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage:/);
    assert.deepEqual(fs.readFileSync(path.join(__dirname, '..', 'site', 'config', 'app.json')), before);
  });
  assert.deepEqual(fs.readdirSync(scratch), ['app.json']);
  console.log('configure-app: ' + checks + ' focused checks passed.');
} finally {
  // Remove only the exact test file and its freshly created empty temp directory.
  try { fs.unlinkSync(filename); } catch (_) { /* A failed initial check may not create it. */ }
  fs.rmdirSync(scratch);
}
