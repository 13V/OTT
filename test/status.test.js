#!/usr/bin/env node
'use strict';
/**
 * site/api/status.js, end to end, offline.
 *
 * A node:http server stands in for the deployment's own config and allowances files, exactly as
 * test/redeem.test.js's does; a second tiny server stands in for wholesale's bundle listing; the
 * mock Lightning payer (site/api/lib/payers/mock.js) stands in for a wallet. What is asserted is
 * the wire contract (GET only, JSON, never cached, no CORS), that a fully wired deployment reports
 * every check healthy with the numbers read from the real config, that one broken leg — a payer
 * that throws, a store that is not configured, an allowances file stamped for the wrong week —
 * never fails the other checks or the request itself, that the response is cached for a while and
 * ?fresh=1 breaks the cache, and — the one that matters most — that a secret never reaches the
 * response even along the one path (a Blink error message) that could plausibly carry one.
 *
 *   node test/status.test.js
 */
const http = require('node:http');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const mockPayer = require(path.join(API, 'lib', 'payers', 'mock.js'));
const week = require(path.join(API, 'lib', 'week.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };

// --------------------------------------------------------------------------- fixtures
const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const BRAND = { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT' };
// Four packages across three places, so packages/places are two different numbers and a mistake
// between them (counting rows instead of distinct slugs) would be caught.
const PACKAGES = [
  { code: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99 },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', priceUsd: 4.99 },
  { code: 'fixed_1GB_7D_FR', slug: 'france', priceUsd: 1.19 },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', priceUsd: 8.99 },
];
const LAUNCHED_CONFIG = {
  coin: COIN, curve: CURVE, treasury: '', provider: 'wholesale', catalogueAt: '2026-09-15',
  budgetBps: 10000, taxBps: 1000, brand: BRAND, packages: PACKAGES,
};
const UNLAUNCHED_CONFIG = Object.assign({}, LAUNCHED_CONFIG, { coin: '', curve: '' });

// The current week, computed the same way status.js computes it (site/api/lib/week.js), so the
// allowances fixture below is unconditionally "this week" whenever this file happens to run.
const CUR = week.weekOf(Math.floor(Date.now() / 1000));
const STALE_WEEK = CUR - 1;

// The contract shape: written by the indexer, for one specific week, each wallet's standing FOR
// THAT WEEK ONLY — the holding, its share of the circulating supply, and the dollars that share
// is worth of this week's budget.
const ALLOWANCES = {
  asOf: 1789500000, block: 64082470, week: CUR, weekStart: week.weekStart(CUR), weekEnd: week.weekEnd(CUR),
  snapshotBlock: 64082470, coin: COIN, curve: CURVE, budgetUsd: 412.5, budgetSource: 'test fixture',
  circulating: '1000000000000000000000000', decimals: 18, holders: 3,
  wallets: {
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { tokens: '10000000000000000000', share: 0.01, allowanceUsd: 0.8 },
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { tokens: '20000000000000000000', share: 0.02, allowanceUsd: 1.6 },
    '0xcccccccccccccccccccccccccccccccccccccccc': { tokens: '30000000000000000000', share: 0.03, allowanceUsd: 2.4 },
  },
};
// The same file, but stamped for last week — what a dashboard sees the instant the clock rolls
// past Monday 00:00 UTC and the indexer has not run yet.
const STALE_ALLOWANCES = Object.assign({}, ALLOWANCES, { week: STALE_WEEK, weekStart: week.weekStart(STALE_WEEK), weekEnd: week.weekEnd(STALE_WEEK) });
const FILES = {
  '/config/esim.json': LAUNCHED_CONFIG,
  '/config/esim-unlaunched.json': UNLAUNCHED_CONFIG,
  '/data/allowances.json': ALLOWANCES,
  '/data/allowances-stale.json': STALE_ALLOWANCES,
};

// A fake req/res pair in the shape Node gives a Vercel function, the same one test/redeem.test.js uses.
function call(handler, { method = 'GET', url = '/api/status' } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); },
    };
    handler(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
}

async function main() {
  // The deployment's own files.
  const fileServer = http.createServer((req, res) => {
    const file = FILES[new URL(req.url, 'http://x').pathname];
    if (!file) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(file));
  });
  await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
  const fileBase = 'http://127.0.0.1:' + fileServer.address().port;

  // A tiny fake of wholesale's own bundle listing, and nothing else — proving the provider check
  // never reaches for purchase or complete.
  let bundleHits = 0;
  const wholesaleServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/esim/bundles') {
      bundleHits++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ success: true, data: { bundles: Array.from({ length: 8 }, (_, i) => ({ name: 'bundle-' + i })) } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not stubbed: ' + req.url }));
  });
  await new Promise((r) => wholesaleServer.listen(0, '127.0.0.1', r));
  const wholesaleBase = 'http://127.0.0.1:' + wholesaleServer.address().port;

  process.env.ESIM_CONFIG_URL = fileBase + '/config/esim.json';
  process.env.ALLOWANCES_URL = fileBase + '/data/allowances.json';
  process.env.ESIM_PROVIDER = 'wholesale';
  process.env.LN_PAYER = 'mock';
  process.env.STORE = 'memory';
  process.env.WHOLESALE_ALLOW_MEMORY_STORE = '1';
  process.env.WHOLESALE_BASE_URL = wholesaleBase;
  // Off everywhere except the section that tests it below, so every other ?fresh=1 in this file
  // (the default GET()) keeps forcing a real computation the way it always has — on a fast enough
  // machine two calls can land in the same millisecond, so "negligible" has to mean exactly 0, not
  // just small.
  process.env.STATUS_FRESH_MIN_MS = '0';
  delete process.env.VERCEL_URL;
  delete process.env.BLINK_API_KEY;
  delete process.env.BLINK_API_URL;
  mockPayer._reset();

  const status = require(path.join(API, 'status.js'));
  const GET = (qs = '?fresh=1') => call(status, { method: 'GET', url: '/api/status' + qs });

  console.log('the wire format');
  let r = await call(status, { method: 'POST' });
  check('a non-GET method is 405', r.status, 405);
  check('with an allow header naming GET', r.headers.allow, 'GET');
  check('and the same JSON, no-store contract as a real response', [r.headers['content-type'], r.headers['cache-control']], ['application/json; charset=utf-8', 'no-store']);
  r = await GET();
  check('GET answers 200 as JSON that is never cached', [r.status, r.headers['content-type'], r.headers['cache-control']], [200, 'application/json; charset=utf-8', 'no-store']);
  checkThat('no CORS header is ever set', !('access-control-allow-origin' in r.headers));

  console.log('\na fully wired deployment');
  r = await GET();
  check('ok is true and every check is healthy', [r.body.ok, r.body.checks.store.ok, r.body.checks.payer.ok, r.body.checks.provider.ok, r.body.checks.allowances.ok], [true, true, true, true, true]);
  check('ready mirrors every check, config included', r.body.ready, { config: true, provider: true, payer: true, store: true, allowances: true });
  check('the brand comes from the config', r.body.brand, BRAND);
  check('packages counts rows, places counts distinct slugs', [r.body.config.packages, r.body.config.places, r.body.config.catalogueAt], [4, 3, '2026-09-15']);
  check('launched, budget and tax also come from the config', [r.body.config.launched, r.body.config.coin, r.body.config.budgetBps, r.body.config.taxBps], [true, COIN, 10000, 1000]);
  check('the pool is filled from the mock wallet\'s own numbers', r.body.pool, { usd: 800, sats: 1000000 });
  check('wiring names what env vars actually selected, not just what esim.json says', r.body.wiring, { provider: 'wholesale', payer: 'mock', store: 'memory' });
  checkThat('the allowances check names the holder count and the budget for the current week', new RegExp('3 holders?, \\$412\\.50 budget, week ' + CUR).test(r.body.checks.allowances.detail), r.body.checks.allowances.detail);
  check('and the structured numbers behind it sit at the top level, like the payer\'s pool', r.body.allowances, { week: CUR, currentWeek: CUR, stale: false, budgetUsd: 412.5, holders: 3 });
  checkThat('the provider check names how many bundles came back', /8 bundles/.test(r.body.checks.provider.detail), r.body.checks.provider.detail);
  checkThat('and wholesale saw only the bundle listing, never purchase or complete', bundleHits > 0);

  console.log('\na payer that cannot answer');
  mockPayer._state.mode = 'down';
  r = await GET();
  check('the request still succeeds', r.status, 200);
  check('the payer check fails and the pool is null', [r.body.checks.payer.ok, r.body.pool], [false, null]);
  checkThat('every other check is unaffected by the payer failing', r.body.checks.store.ok && r.body.checks.provider.ok && r.body.checks.allowances.ok, JSON.stringify(r.body.checks));
  mockPayer._state.mode = 'success';

  console.log('\nno store configured');
  delete process.env.STORE;
  delete process.env.STORE_URL; delete process.env.STORE_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  r = await GET();
  check('the request still succeeds', r.status, 200);
  check('the store check fails', r.body.checks.store.ok, false);
  checkThat('and names the env var to set', /KV_REST_API_URL/.test(r.body.checks.store.detail), r.body.checks.store.detail);
  checkThat('every other check is unaffected by the store failing', r.body.checks.payer.ok && r.body.checks.provider.ok && r.body.checks.allowances.ok);
  process.env.STORE = 'memory';

  console.log('\nan allowance file stamped for the wrong week — exactly what this check exists to catch');
  process.env.ALLOWANCES_URL = fileBase + '/data/allowances-stale.json';
  r = await GET();
  check('the request still succeeds', r.status, 200);
  check('the allowances check fails, plainly, rather than reporting a clean bill of health', r.body.checks.allowances.ok, false);
  checkThat('and says the file is for last week, not published for the current one',
    new RegExp('week ' + STALE_WEEK + '.*not the current week ' + CUR).test(r.body.checks.allowances.detail), r.body.checks.allowances.detail);
  check('ready.allowances mirrors the failure', r.body.ready.allowances, false);
  check('the top-level allowances field carries both weeks and the stale flag for a dashboard to key off', r.body.allowances, { week: STALE_WEEK, currentWeek: CUR, stale: true, budgetUsd: 412.5, holders: 3 });
  checkThat('every other check is unaffected by the allowances file being stale', r.body.checks.store.ok && r.body.checks.payer.ok && r.body.checks.provider.ok, JSON.stringify(r.body.checks));
  process.env.ALLOWANCES_URL = fileBase + '/data/allowances.json';

  console.log('\nan unlaunched config');
  process.env.ESIM_CONFIG_URL = fileBase + '/config/esim-unlaunched.json';
  r = await GET();
  check('the request still succeeds and says the coin is not launched', [r.status, r.body.ok, r.body.config.launched], [200, true, false]);
  check('but the config itself still loaded fine', r.body.ready.config, true);
  process.env.ESIM_CONFIG_URL = fileBase + '/config/esim.json';

  console.log('\nthe cache, and the floor under an unauthenticated ?fresh=1');
  await GET('?fresh=1');
  const baseline = bundleHits;
  await GET('');
  await GET('');
  check('two more calls with no ?fresh=1 cost nothing more: the cache answered both', bundleHits, baseline);

  // Give ?fresh=1 a real floor and prove a loop of it can no longer cost one wholesale hit per
  // request — the amplifier the audit found: 3 store ops, 2 Blink calls and 1 wholesale call per
  // bypass, unauthenticated, against the same rate-limited accounts real redemptions depend on.
  process.env.STATUS_FRESH_MIN_MS = '250';
  const beforeLoop = bundleHits;
  await GET('?fresh=1');
  await GET('?fresh=1');
  await GET('?fresh=1');
  checkThat('three ?fresh=1 requests in a row cost at most one real hit, not three', bundleHits - beforeLoop <= 1, 'went from ' + beforeLoop + ' to ' + bundleHits);
  const afterLoop = bundleHits;
  await new Promise((r) => setTimeout(r, 300));
  await GET('?fresh=1');
  check('once the floor elapses, ?fresh=1 does force exactly one more fresh hit — it still works for an operator', bundleHits, afterLoop + 1);
  const afterElapsed = bundleHits;
  await GET('?fresh=1');
  check('and looping it again right away goes back to costing nothing: the floor renews on every real computation', bundleHits, afterElapsed);
  process.env.STATUS_FRESH_MIN_MS = '0';

  console.log('\nan unknown provider name is a broken deployment, not a clean bill of health');
  process.env.ESIM_PROVIDER = 'atlantis';
  r = await GET();
  check('the request still succeeds', r.status, 200);
  check('the provider and store checks both fail rather than reporting nothing to probe', [r.body.checks.provider.ok, r.body.checks.store.ok], [false, false]);
  checkThat('the wiring still names what was actually asked for', r.body.wiring.provider === 'atlantis', r.body.wiring.provider);
  process.env.ESIM_PROVIDER = 'wholesale';

  console.log('\nscrubbing a secret');
  process.env.LN_PAYER = 'blink';
  const SECRET = 'sk-distinctive-937zx-do-not-leak';
  process.env.BLINK_API_KEY = SECRET;
  // A Blink that misbehaves by echoing the key it was sent back in its own error message — the
  // one shape of failure that could actually carry a secret through blink.js's own error path.
  const blinkServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ errors: [{ message: 'bad key ' + req.headers['x-api-key'] }] }));
  });
  await new Promise((resolve) => blinkServer.listen(0, '127.0.0.1', resolve));
  process.env.BLINK_API_URL = 'http://127.0.0.1:' + blinkServer.address().port + '/graphql';
  r = await GET();
  check('the request still succeeds', r.status, 200);
  check('the payer check fails', r.body.checks.payer.ok, false);
  checkThat('the pool is null', r.body.pool === null);
  checkThat('the wallet\'s own error text still comes through', /bad key/.test(r.body.checks.payer.detail), r.body.checks.payer.detail);
  checkThat('but the secret itself never reaches the response, scrubbed or not', JSON.stringify(r.body).indexOf(SECRET) === -1, JSON.stringify(r.body));
  await new Promise((resolve) => blinkServer.close(resolve));
  process.env.LN_PAYER = 'mock';
  delete process.env.BLINK_API_KEY;
  delete process.env.BLINK_API_URL;

  await new Promise((r2) => fileServer.close(r2));
  await new Promise((r2) => wholesaleServer.close(r2));
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
