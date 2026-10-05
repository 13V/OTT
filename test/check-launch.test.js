#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { apiOrigin, publicChecks, statusChecks, probeBackend } = require('../scripts/check-launch');
const { weekOf } = require('../site/api/lib/week');
const now = Date.now();
const esim = { coin: '0x' + '1'.repeat(40), curve: '0x' + '2'.repeat(40), treasury: '0x' + '3'.repeat(40), provider: 'wholesale', packages: [{}] };
const config = { app: { walletConnect: { projectId: 'a'.repeat(32) }, apiBaseUrl: 'https://api.example' }, esim, chain: { chainId: 4663, rpc: 'https://rpc.example' } };
const status = { ok: true, asOf: Math.floor(now / 1000), config: { ...esim, launched: true },
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
  assert.deepEqual(failed(await probeBackend('https://api.example', esim, async (_url, options) => options.method === 'GET' ? new Response('<h1>Website only</h1>', { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 405 }))).includes('status'), true);
  console.log('launch configuration and read-only probes passed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
