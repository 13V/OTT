#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { apiOrigin, catalogueReady, publicChecks, prelaunchPublicChecks, statusChecks, prelaunchStatusChecks, probeBackend } = require('../scripts/check-launch');
const { weekOf } = require('../site/api/_lib/week');
const { catalogueFingerprint } = require('../site/api/_lib/catalogue');
const now = Date.now();
const bundle = { code: 'fixed_5GB_30D_US', slug: 'united-states', name: 'United States', kind: 'country', regions: 'US', gb: 5, days: 30, priceUsd: 7.99 };
const esim = { coin: '0x' + '1'.repeat(40), curve: '0x' + '2'.repeat(40), treasury: '0x' + '3'.repeat(40), provider: 'wholesale', catalogueAt: '2026-10-05', packages: [bundle] };
const config = { app: { walletConnect: { projectId: 'a'.repeat(32) }, apiBaseUrl: 'https://api.example' }, esim, chain: { chainId: 4663, rpc: 'https://rpc.example' } };
const status = { ok: true, asOf: Math.floor(now / 1000), config: { ...esim, packages: esim.packages.length, catalogueFingerprint: catalogueFingerprint(esim), launched: true },
  redemption: { enabled: true, ready: true },
  ready: { config: true, provider: true, payer: true, store: true, allowances: true },
  wiring: { provider: 'wholesale', payer: 'blink', store: 'upstash' },
  allowances: { week: weekOf(Math.floor(now / 1000)), stale: false }, pool: { usd: 20, sats: 20000 } };
const failed = rows => rows.filter(row => !row.ok).map(row => row.id);

(async () => {
  console.log('public connection settings are checked before remote access');
  assert.equal(apiOrigin('https://api.example/'), 'https://api.example');
  for (const value of ['', 'http://api.example', 'https://user:secret@api.example', 'https://api.example/api', 'https://api.example?token=secret', 'https://api.example#secret', 'https://api.example/..', ' https://api.example', 'https://api.example\\']) assert.equal(apiOrigin(value), '');
  assert.deepEqual(failed(publicChecks(config)), []);
  assert.equal(publicChecks({ ...config, chain: { ...config.chain, rpc: 'https://rpc.example/network' } }).find(row => row.id === 'chain').ok, true);
  assert.deepEqual(failed(publicChecks({ ...config, app: { walletConnect: { projectId: '' }, apiBaseUrl: '' }, esim: { ...esim, treasury: '' } })), ['wallet', 'api', 'contracts']);
  assert.equal(publicChecks({ ...config, esim: { ...esim, coin: '0x' + '0'.repeat(40) } }).find(row => row.id === 'contracts').ok, false);
  for (const packages of [[], [{}], [bundle, bundle], [{ ...bundle, priceUsd: 0 }], [{ ...bundle, priceUsd: Infinity }], [{ ...bundle, days: 0 }], [{ ...bundle, gb: '5' }], [{ ...bundle, name: '' }]]) assert.equal(catalogueReady({ packages }), false);

  console.log('a successful HTTP response does not establish live readiness');
  assert.equal(failed(statusChecks({ ok: true }, esim, now)).includes('status'), true);
  assert.deepEqual(failed(statusChecks(status, esim, now)), []);
  assert.equal(failed(statusChecks({ ...status, asOf: status.asOf - 181 }, esim, now)).includes('status'), true);
  assert.equal(failed(statusChecks({ ...status, config: { ...status.config, coin: '0x' + '4'.repeat(40) } }, esim, now)).includes('contracts-match'), true);
  assert.equal(failed(statusChecks({ ...status, ready: { ...status.ready, payer: false } }, esim, now)).includes('backend-payer'), true);
  assert.equal(failed(statusChecks({ ...status, wiring: { provider: 'mock', payer: 'mock', store: 'memory' } }, esim, now)).includes('real-provider'), true);
  assert.equal(failed(statusChecks({ ...status, wiring: { ...status.wiring, provider: 'esimaccess' } }, { ...esim, provider: 'esimaccess' }, now)).includes('real-provider'), true);
  assert.equal(failed(statusChecks({ ...status, allowances: { ...status.allowances, week: status.allowances.week - 1 } }, esim, now)).includes('current-week'), true);
  assert.equal(failed(statusChecks({ ...status, pool: { usd: 0, sats: 0 } }, esim, now)).includes('funded-payer'), true);
  assert.equal(failed(statusChecks({ ...status, redemption: { enabled: false, ready: false } }, esim, now)).includes('redemption-enabled'), true);
  assert.equal(failed(statusChecks({ ...status, error: 'status computation failed' }, esim, now)).includes('status'), true);

  console.log('prelaunch checks separate preparation from wallet funding and token launch');
  const prelaunchEsim = { ...esim, coin: '', curve: '', treasury: '' };
  const prelaunchStatus = { ...status, config: { ...prelaunchEsim, packages: 1, catalogueFingerprint: catalogueFingerprint(prelaunchEsim), launched: false }, redemption: { enabled: false, ready: false }, ready: { ...status.ready, payer: false, allowances: false }, allowances: null, pool: null };
  assert.deepEqual(failed(prelaunchPublicChecks({ ...config, esim: prelaunchEsim })), []);
  assert.equal(failed(prelaunchPublicChecks({ ...config, esim: { ...prelaunchEsim, coin: esim.coin } })).includes('prelaunch-contracts'), true);
  assert.deepEqual(failed(prelaunchStatusChecks(prelaunchStatus, prelaunchEsim, now)), []);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, redemption: { enabled: true, ready: false } }, prelaunchEsim, now)).includes('redemption-paused'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, ready: { ...prelaunchStatus.ready, provider: false } }, prelaunchEsim, now)).includes('backend-provider'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, wiring: { ...prelaunchStatus.wiring, store: 'memory' } }, prelaunchEsim, now)).includes('backend-store'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, config: { ...prelaunchStatus.config, catalogueAt: '2026-09-01' } }, prelaunchEsim, now)).includes('backend-config'), true);
  assert.equal(failed(prelaunchStatusChecks({ ok: true }, prelaunchEsim, now)).includes('status'), true);

  console.log('catalogue agreement checks purchase terms, not only a matching count and date');
  for (const [field, value] of Object.entries({ code: 'different-provider-SKU', slug: 'australia', name: 'Australia',
    kind: 'region', regions: 'AU', gb: 1, days: 7, priceUsd: 9.99 })) {
    const otherCatalogue = { ...esim, packages: [{ ...bundle, [field]: value }] };
    const changedConfig = { ...status.config, catalogueFingerprint: catalogueFingerprint(otherCatalogue) };
    assert.equal(failed(statusChecks({ ...status, config: changedConfig }, esim, now)).includes('backend-config'), true, field);
    assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, config: { ...prelaunchStatus.config, catalogueFingerprint: changedConfig.catalogueFingerprint } }, prelaunchEsim, now)).includes('backend-config'), true, field);
  }
  for (const fingerprint of [undefined, '', 'old-schema-fingerprint']) {
    assert.equal(failed(statusChecks({ ...status, config: { ...status.config, catalogueFingerprint: fingerprint } }, esim, now)).includes('backend-config'), true);
    assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, config: { ...prelaunchStatus.config, catalogueFingerprint: fingerprint } }, prelaunchEsim, now)).includes('backend-config'), true);
  }
  const secondBundle = { ...bundle, code: 'fixed_1GB_7D_US', gb: 1, days: 7, priceUsd: 1.99 };
  assert.equal(catalogueFingerprint({ packages: [bundle, secondBundle] }), catalogueFingerprint({ packages: [secondBundle, bundle] }));
  assert.equal(catalogueFingerprint({ packages: [{ ...bundle, internalMemo: 'metadata outside purchase terms' }] }), catalogueFingerprint(esim));
  assert.equal(catalogueFingerprint({ packages: [{ code: bundle.code, slug: bundle.slug, priceUsd: bundle.priceUsd }] }), '');
  assert.equal(catalogueFingerprint({ packages: [bundle, bundle] }), '');
  assert.equal(catalogueFingerprint({ packages: [] }), '');

  console.log('remote checks are read-only and verify the browser origin');
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return options.method === 'GET'
      ? new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': 'https://13v.github.io' } })
      : new Response(null, { status: 204, headers: { 'access-control-allow-origin': 'https://13v.github.io', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Content-Type' } });
  };
  assert.deepEqual(failed(await probeBackend('https://api.example', esim, fetcher)), []);
  assert.deepEqual(requests.map(request => [request.url, request.options.method]), [['https://api.example/api/status', 'GET'], ['https://api.example/api/redeem', 'OPTIONS']]);
  assert.equal(requests.every(request => request.options.redirect === 'error' && !request.options.body && request.options.headers.Origin === 'https://13v.github.io'), true);
  const missingCors = async (_url, options) => options.method === 'GET' ? new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } }) : new Response(null, { status: 204 });
  assert.deepEqual(failed(await probeBackend('https://api.example', esim, missingCors)), ['status-cors', 'redeem-cors']);
  const unreachable = await probeBackend('https://api.example', esim, async () => { throw new Error('private-endpoint-secret'); });
  assert.deepEqual(failed(unreachable), ['status', 'redeem-cors']);
  assert.equal(JSON.stringify(unreachable).includes('private-endpoint-secret'), false);
  const prelaunchRequests = [];
  assert.deepEqual(failed(await probeBackend('https://api.example', prelaunchEsim, async (url, options) => {
    prelaunchRequests.push(options.method);
    return options.method === 'GET' ? new Response(JSON.stringify(prelaunchStatus), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': 'https://13v.github.io' } })
      : new Response(null, { status: 204, headers: { 'access-control-allow-origin': 'https://13v.github.io', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
  }, true)), []);
  assert.deepEqual(prelaunchRequests, ['GET', 'OPTIONS']);
  assert.deepEqual(failed(await probeBackend('https://api.example', esim, async (_url, options) => options.method === 'GET' ? new Response('<h1>Website only</h1>', { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 405 }))).includes('status'), true);

  console.log('CLI reports outstanding setup accurately without changing configuration');
  const script = path.resolve(__dirname, '../scripts/check-launch.js');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-prelaunch-check-'));
  try {
    fs.mkdirSync(path.join(folder, 'site/config'), { recursive: true });
    for (const [name, value] of Object.entries({ app: config.app, esim: prelaunchEsim, addresses: config.chain })) fs.writeFileSync(path.join(folder, 'site/config', name + '.json'), JSON.stringify(value));
    const before = fs.readFileSync(path.join(folder, 'site/config/esim.json'), 'utf8');
    const invocation = 'require(' + JSON.stringify(script) + ').main(["--prelaunch","--json"],process.argv[1]).then(code=>process.exitCode=code)';
    const report = JSON.parse(execFileSync(process.execPath, ['-e', invocation, folder], { encoding: 'utf8' }));
    assert.equal(report.stage, 'prelaunch');
    assert.equal(report.configured, true);
    assert.equal(report.remoteChecked, false);
    assert.equal(report.checksPassed, false);
    assert.equal(report.liveRedemptionReady, false);
    assert.equal(report.deferred.includes('Funded Lightning wallet and real payment'), true);
    assert.equal(fs.readFileSync(path.join(folder, 'site/config/esim.json'), 'utf8'), before);
    for (const args of [['--pay'], ['--prelaunch', '--prelaunch']]) {
      const rejected = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /supported flags/);
    }
  } finally {
    const target = path.resolve(folder);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.equal(path.basename(target).startsWith('ott-prelaunch-check-'), true);
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log('launch configuration and read-only probes passed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
