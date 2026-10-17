#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { apiOrigin, catalogueReady, publicChecks, prelaunchPublicChecks, statusChecks, prelaunchStatusChecks, probeBackend, burnAccountCheck } = require('../scripts/check-launch');
const S = require('../site/solana.js');
const { weekOf } = require('../site/api/_lib/week');
const { catalogueFingerprint } = require('../site/api/_lib/catalogue');
const now = Date.now();
const bundle = { code: 'fixed_5GB_30D_US', slug: 'united-states', name: 'United States', kind: 'country', regions: 'US', gb: 5, days: 30, priceUsd: 7.99 };
// A real pump.fun mint (Token-2022) and the incinerator's token account for it, as read on mainnet
// (test/fixtures/solana/join-creates-account.json), so the derivation check is a real one.
const COIN = 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump';
const BURN_ACCOUNT = 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF';
const TREASURY = 'GWUESs5wHvAqLR9gNLS6G4BKPqnCZ2iCe91o311EqMpR';
const membership = burnAccount => ({ burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } });
const esim = { chain: 'solana', coin: COIN, tokenProgram: S.PROGRAMS.token2022, treasury: TREASURY, membership: membership(BURN_ACCOUNT), provider: 'wholesale', catalogueAt: '2026-10-05', packages: [bundle] };
const chain = { chain: 'solana', cluster: 'mainnet-beta', rpcs: ['https://rpc.example', 'https://rpc2.example/path'], browserRpcs: ['https://rpc.example'] };
const config = { app: { apiBaseUrl: 'https://api.example' }, esim, chain };
// /api/status's config summary carries the incinerator account inside its membership summary.
const summary = cfg => ({ chain: cfg.chain, coin: cfg.coin, tokenProgram: cfg.tokenProgram, treasury: cfg.treasury, provider: cfg.provider, catalogueAt: cfg.catalogueAt,
  membership: { configured: true, ...cfg.membership }, packages: cfg.packages.length, catalogueFingerprint: catalogueFingerprint(cfg) });
const status = { ok: true, asOf: Math.floor(now / 1000), config: { ...summary(esim), launched: true },
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
  assert.equal(failed(publicChecks(config)).includes('wallet'), false, 'the WalletConnect project is no longer a launch requirement');
  assert.deepEqual(failed(publicChecks({ ...config, app: { apiBaseUrl: '' }, esim: { ...esim, treasury: '' } })), ['api', 'contracts']);
  for (const [field, value] of [['coin', S.PROGRAMS.system], ['coin', '0x' + '1'.repeat(40)], ['coin', COIN.toLowerCase()], ['tokenProgram', COIN], ['treasury', ''], ['chain', 'robinhood']]) {
    assert.equal(publicChecks({ ...config, esim: { ...esim, [field]: value } }).find(row => row.id === 'contracts').ok, false, field + ' ' + value);
  }
  assert.equal(publicChecks({ ...config, esim: { ...esim, membership: membership('') } }).find(row => row.id === 'contracts').ok, false);
  for (const network of [{ ...chain, chain: 'evm' }, { ...chain, cluster: 'devnet' }, { ...chain, rpcs: [] }, { ...chain, rpcs: ['http://rpc.example'] }, { ...chain, browserRpcs: undefined },
    { ...chain, rpcs: ['https://user:secret@rpc.example'] }, { chainId: 4663, rpc: 'https://rpc.example' }]) {
    assert.equal(publicChecks({ ...config, chain: network }).find(row => row.id === 'chain').ok, false, JSON.stringify(network));
  }

  console.log('the incinerator account is re-derived from the coin');
  assert.equal((await burnAccountCheck(esim)).ok, true);
  assert.equal((await burnAccountCheck({ ...esim, membership: membership(TREASURY) })).ok, false);
  assert.equal((await burnAccountCheck({ ...esim, tokenProgram: S.PROGRAMS.token })).ok, false, 'the same mint under the other token program derives another account');
  assert.equal((await burnAccountCheck({ ...esim, coin: '' })).ok, false);
  for (const packages of [[], [{}], [bundle, bundle], [{ ...bundle, priceUsd: 0 }], [{ ...bundle, priceUsd: Infinity }], [{ ...bundle, days: 0 }], [{ ...bundle, gb: '5' }], [{ ...bundle, name: '' }]]) assert.equal(catalogueReady({ packages }), false);

  console.log('a successful HTTP response does not establish live readiness');
  assert.equal(failed(statusChecks({ ok: true }, esim, now)).includes('status'), true);
  assert.deepEqual(failed(statusChecks(status, esim, now)), []);
  assert.equal(failed(statusChecks({ ...status, asOf: status.asOf - 181 }, esim, now)).includes('status'), true);
  assert.equal(failed(statusChecks({ ...status, config: { ...status.config, coin: TREASURY } }, esim, now)).includes('contracts-match'), true);
  assert.equal(failed(statusChecks({ ...status, config: { ...status.config, membership: { ...status.config.membership, burnAccount: TREASURY } } }, esim, now)).includes('contracts-match'), true);
  assert.equal(failed(statusChecks({ ...status, config: { ...status.config, chain: '' } }, esim, now)).includes('contracts-match'), true);
  assert.equal(failed(statusChecks({ ...status, ready: { ...status.ready, payer: false } }, esim, now)).includes('backend-payer'), true);
  assert.equal(failed(statusChecks({ ...status, wiring: { provider: 'mock', payer: 'mock', store: 'memory' } }, esim, now)).includes('real-provider'), true);
  assert.equal(failed(statusChecks({ ...status, wiring: { ...status.wiring, provider: 'esimaccess' } }, { ...esim, provider: 'esimaccess' }, now)).includes('real-provider'), true);
  assert.equal(failed(statusChecks({ ...status, allowances: { ...status.allowances, week: status.allowances.week - 1 } }, esim, now)).includes('current-week'), true);
  assert.equal(failed(statusChecks({ ...status, pool: { usd: 0, sats: 0 } }, esim, now)).includes('funded-payer'), true);
  assert.equal(failed(statusChecks({ ...status, redemption: { enabled: false, ready: false } }, esim, now)).includes('redemption-enabled'), true);
  assert.equal(failed(statusChecks({ ...status, error: 'status computation failed' }, esim, now)).includes('status'), true);

  console.log('prelaunch checks separate preparation from wallet funding and token launch');
  const prelaunchEsim = { ...esim, coin: '', tokenProgram: '', treasury: '', membership: membership('') };
  const prelaunchStatus = { ...status, config: { ...summary(prelaunchEsim), launched: false }, redemption: { enabled: false, ready: false }, ready: { ...status.ready, payer: false, allowances: false }, allowances: null, pool: null };
  assert.deepEqual(failed(prelaunchPublicChecks({ ...config, esim: prelaunchEsim })), []);
  assert.equal(failed(prelaunchPublicChecks({ ...config, esim: { ...prelaunchEsim, coin: esim.coin } })).includes('prelaunch-contracts'), true);
  assert.equal(failed(prelaunchPublicChecks({ ...config, esim: { ...prelaunchEsim, membership: membership(BURN_ACCOUNT) } })).includes('prelaunch-contracts'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, config: { ...prelaunchStatus.config, tokenProgram: S.PROGRAMS.token2022 } }, prelaunchEsim, now)).includes('prelaunch-contracts-match'), true);
  assert.deepEqual(failed(prelaunchStatusChecks(prelaunchStatus, prelaunchEsim, now)), []);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, redemption: { enabled: true, ready: false } }, prelaunchEsim, now)).includes('redemption-paused'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, ready: { ...prelaunchStatus.ready, provider: false } }, prelaunchEsim, now)).includes('backend-provider'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, wiring: { ...prelaunchStatus.wiring, store: 'memory' } }, prelaunchEsim, now)).includes('backend-store'), true);
  assert.equal(failed(prelaunchStatusChecks({ ...prelaunchStatus, config: { ...prelaunchStatus.config, catalogueAt: '2026-09-01' } }, prelaunchEsim, now)).includes('backend-config'), true);
  assert.equal(failed(prelaunchStatusChecks({ ok: true }, prelaunchEsim, now)).includes('status'), true);

  console.log('catalogue agreement checks purchase terms, not only a matching count and date');
  for (const [field, value] of Object.entries({ code: 'different-public-code', packageCode: 'different-provider-SKU', slug: 'australia', name: 'Australia',
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
  assert.equal(catalogueFingerprint({ packages: [{ ...bundle, packageCode: bundle.code }] }), catalogueFingerprint(esim));
  for (const packageCode of ['', '   ', 7, null]) assert.equal(catalogueReady({ packages: [{ ...bundle, packageCode }] }), false);
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
