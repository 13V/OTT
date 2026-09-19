'use strict';
/**
 * The Status route (#/status) reads six sources nothing else on the site reads together in one
 * place: /api/status (site/api/status.js, owned elsewhere — this file only relies on the shape it
 * documents) and five JSON files (config/esim.json, data/allowances.json, data/treasury.json,
 * data/claims.json, data/funding.json), plus the same five chain reads site/esim.js makes once a
 * coin exists. Every one of those six is stubbed here so each number and each health row is a
 * number this file chose and can name — and every test proves the page survives losing one or all
 * of them, because that is the one thing a status page is not allowed to get wrong.
 */
// package.json's devDependency is @playwright/test; a sandbox with no npm install instead has the
// base `playwright` package on NODE_PATH, whose `playwright/test` subpath is the same test runner.
// Trying the real package first means a normal `npm install` changes nothing about this file.
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork, hexWord } = require('./support/network.js');

const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const BRAND = { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' };

// Week arithmetic — identical to plan-contract.md, scripts/allowances.js and site/esim.js's own
// copy. Computed from the real clock at load time so "this week" fixtures are genuinely current
// whenever the suite actually runs.
const WEEK_S = 604800;
const ANCHOR = 345600;
const weekOf = (s) => Math.floor((s - ANCHOR) / WEEK_S);
const weekStartOf = (w) => ANCHOR + w * WEEK_S;
const weekEndOf = (w) => weekStartOf(w) + WEEK_S;
const CUR_WEEK = weekOf(Math.floor(Date.now() / 1000));
const CUR_WEEK_START = weekStartOf(CUR_WEEK);
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Three places across five wholesale packages — the same catalogue shape test/site/data.spec.js
// uses, so the arithmetic below is the same arithmetic that file already proves correct: Germany's
// 10 GB for $7.99 is 80c/GB (cheapest per gigabyte), Global's 1 GB for $8.99 is $8.99/GB (dearest
// per gigabyte), and Europe's 1 GB for $1.19 is the cheapest package to just buy.
const PACKAGES = [
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '105 countries' },
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 4.99, regions: 'DE' },
  { code: 'fixed_10GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 10, days: 30, priceUsd: 7.99, regions: 'DE' },
];
const base = { pair: USDG, taxBps: 1000, budgetBps: 10000, provider: 'wholesale', catalogueAt: '2026-09-01', packages: PACKAGES, brand: BRAND };
const NOT_LAUNCHED = Object.assign({ coin: '', curve: '', treasury: '' }, base);
const LAUNCHED = Object.assign({ coin: COIN, curve: CURVE, treasury: TREASURY }, base);

// The curve's five view functions. raisedUsd $6,500.00 of a $20,000.00 threshold is 32.5% of the
// way to graduation, which Math.round renders as 33%; a 1000bps creator tax is 10%; $340.00 of tax
// is still sitting in the curve; the coin has not graduated.
const CALLS = {
  '0x4f1f58fd': hexWord(6500000000n),   // realQuoteReserve()     -> raisedUsd    6500.00
  '0x8b0bc501': hexWord(20000000000n),  // graduationThreshold()  -> thresholdUsd 20000.00
  '0xe7c2b772': hexWord(0),             // graduated()            -> false
  '0xc1bb8901': hexWord(1000),          // creatorTaxBps()        -> 10%
  '0xdb2bd533': hexWord(340000000n),    // creatorTaxBalance()    -> taxHeldUsd   340.00
};

const NOW = Math.floor(Date.now() / 1000);
const TXHASH = '0x' + 'ab'.repeat(32);

// A fully healthy /api/status: every check ok, the pool reading present, the coin launched.
const API_OK = {
  ok: true, asOf: NOW, brand: BRAND,
  config: { launched: true, coin: COIN, curve: CURVE, treasury: TREASURY, provider: 'wholesale', packages: 5, places: 3, catalogueAt: '2026-09-01', budgetBps: 10000, taxBps: 1000 },
  wiring: { provider: 'wholesale', payer: 'blink', store: 'vercel-kv' },
  ready: { config: true, provider: true, payer: true, store: true, allowances: true },
  checks: {
    store: { ok: true, detail: 'vercel-kv reachable' },
    payer: { ok: true, detail: 'blink wallet reachable, balance readable' },
    provider: { ok: true, detail: 'catalogue reachable' },
    allowances: { ok: true, detail: 'allowances.json is fresh' },
  },
  pool: { usd: 812.34, sats: 1500000 },
};

// Three wallets holding a 1,000,000 OTT circulating supply between them: A holds half, B a
// quarter, C a hundredth — so the top-holders table has a real spread, in share and in the
// allowance that share buys against this week's $400.00 budget ($200.00 / $100.00 / $4.00).
const WALLET_A = '0x' + 'a'.repeat(40);
const WALLET_B = '0x' + 'b'.repeat(40);
const WALLET_C = '0x' + 'c'.repeat(40);
const oneOtt = 10n ** 18n;
const ALLOWANCES_FRESH = {
  asOf: NOW - 60, block: 1, week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: weekEndOf(CUR_WEEK),
  snapshotBlock: 1, coin: COIN, curve: CURVE,
  budgetUsd: 400, budgetSource: 'tax collected in week ' + (CUR_WEEK - 1),
  circulating: (1000000n * oneOtt).toString(), decimals: 18, holders: 3,
  wallets: {
    [WALLET_A]: { tokens: (500000n * oneOtt).toString(), share: 0.5, allowanceUsd: 200 },
    [WALLET_B]: { tokens: (250000n * oneOtt).toString(), share: 0.25, allowanceUsd: 100 },
    [WALLET_C]: { tokens: (10000n * oneOtt).toString(), share: 0.01, allowanceUsd: 4 },
  },
};

// treasury.json, claims.json and funding.json, each timestamped well inside the freshness windows
// status.js uses (2h for the indexer, 48h for the two daily keepers), so every health row reads ok.
const TREASURY_FRESH = {
  asOf: NOW - 60, treasury: TREASURY, escrowClaimableUsd: 88.10, walletUsd: 15.00,
  reseller: { name: 'wholesale', balanceUsd: 812.34, sats: 1500000, asOf: NOW - 60 },
  spend30dUsd: 55.20, redemptions30d: 9, perDayUsd: 1.84, runwayDays: 240,
  lastClaim: { at: NOW - 3600, kind: 'usdg', amount: 41.70, txHash: TXHASH }, status: 'funded',
};
const CLAIMS_FRESH = [{ at: NOW - 3600, kind: 'usdg', amount: 41.70, txHash: TXHASH }];
const FUNDING_FRESH = [{ at: NOW - 7200, finishedAt: NOW - 7100, amountUsd: 50.00, sats: 123456, fixedFloatOrder: 'FF-TEST-1', status: 'done' }];

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });
const missing = (page, pattern) => page.route(pattern, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));

const stubConfig = (page, cfg) => page.route('**/config/esim.json', (route) => route.fulfill(json(cfg)));
const stubAllowances = (page, body) => page.route('**/data/allowances.json', (route) => route.fulfill(json(body)));
const stubTreasury = (page, body) => page.route('**/data/treasury.json', (route) => route.fulfill(json(body)));
const stubClaims = (page, body) => page.route('**/data/claims.json', (route) => route.fulfill(json(body)));
const stubFunding = (page, body) => page.route('**/data/funding.json', (route) => route.fulfill(json(body)));
const stubApiStatus = (page, body) => page.route('**/api/status**', (route) => route.fulfill(json(body)));

/** Every one of the six sources answering the "everything is fine and fresh" fixtures above. */
async function stubAllFresh(page, { cfg = LAUNCHED, api = API_OK } = {}) {
  await stubConfig(page, cfg);
  await stubAllowances(page, ALLOWANCES_FRESH);
  await stubTreasury(page, TREASURY_FRESH);
  await stubClaims(page, CLAIMS_FRESH);
  await stubFunding(page, FUNDING_FRESH);
  await stubApiStatus(page, api);
}

// A band is its .section, found by its own heading rather than by position or by a row's text —
// the health section also contains a row literally named "The coin", so matching on .section-head
// is what tells the two apart. Each .section still wraps exactly one .card of content, so a
// locator scoped to the .section also reaches everything inside that card.
const cardByTitle = (page, title) => page.locator('.section').filter({ has: page.locator('.section-head', { hasText: title }) });
// Matched on the row's own <b> name, not the whole row's text — "Claim keeper" and "Funding
// keeper" both say "the coin has not launched" in their detail, which is a substring match for
// "The coin" too if the whole row's text is searched instead of just its name.
const rowByName = (page, name) => page.locator('.status-row').filter({ has: page.locator('b', { hasText: name }) });

test('fully wired and launched: every health row is ok, and every section shows the fixtures’ own numbers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubAllFresh(page);

  await page.goto('/index.html#/status');
  await expect(page.locator('#view h1')).toHaveText('Everything, and whether it is running.');
  await expect(page).toHaveTitle('Status — OT+T');
  await expect(page.locator('.page-head .label')).toHaveText('OT+T · NETWORK STATUS');

  // Health strip: seven rows, every one of them ok.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(7);
  await expect(page.locator('.status-dot.ok')).toHaveCount(7);
  await expect(page.locator('.status-dot.warn')).toHaveCount(0);
  await expect(page.locator('.status-dot.off')).toHaveCount(0);
  await expect(rowByName(page, 'The coin')).toContainText('launched');
  await expect(rowByName(page, 'Network partner')).toContainText('Network partner');
  await expect(rowByName(page, 'Network partner')).toContainText('catalogue reachable');
  await expect(rowByName(page, 'Lightning wallet')).toContainText('Lightning wallet · blink');
  await expect(rowByName(page, 'Store')).toContainText('Store · vercel-kv');
  await expect(rowByName(page, 'Indexer')).toContainText(/updated .*ago/);
  await expect(rowByName(page, 'Claim keeper')).toContainText('$41.70 USDG');
  await expect(rowByName(page, 'Funding keeper')).toContainText('$50.00');
  await expect(rowByName(page, 'Funding keeper')).toContainText('done');

  // The coin: raised $6,500.00 of a $20,000.00 threshold (32.5% -> 33%), 10% tax, $340.00 held,
  // not graduated.
  const coin = cardByTitle(page, 'The coin');
  await expect(coin).toContainText('$6,500.00');
  await expect(coin).toContainText('$20,000.00');
  await expect(coin).toContainText('10%');
  await expect(coin).toContainText('$340.00');
  await expect(coin).toContainText('Not yet');
  await expect(coin.locator('.data-progress')).toContainText('$6,500.00 of $20,000.00');
  await expect(coin.locator('.data-progress')).toContainText('33% of the way to graduation.');

  // The pool: balance from the health check's own pool reading, the rest from treasury.json.
  const pool = cardByTitle(page, 'The pool');
  await expect(pool).toContainText('$812.34');
  await expect(pool).toContainText('1,500,000 sats');
  await expect(pool).toContainText('240 days');
  await expect(pool).toContainText('$55.20');
  await expect(pool).toContainText('9');

  // The treasury: escrow and wallet from treasury.json, the last claim from claims.json (with a
  // link built from ctx.cfg.explorer) and the last funding run from funding.json.
  const treasury = cardByTitle(page, 'The treasury');
  await expect(treasury).toContainText('$88.10');
  await expect(treasury).toContainText('$15.00');
  await expect(treasury).toContainText('$41.70 USDG');
  await expect(treasury.locator('a[href*="' + TXHASH + '"]')).toBeVisible();
  await expect(treasury).toContainText('$50.00 → 123,456 sats');
  await expect(treasury).toContainText('order FF-TEST-1');

  // The programme: this week's $400.00 budget, 3 holders, the week it is for, and the
  // top-holders table sorted by allowance (A $200, B $100, C $4).
  const programme = cardByTitle(page, 'The programme');
  await expect(programme).toContainText('$400.00');
  await expect(programme).toContainText('tax collected in week ' + (CUR_WEEK - 1));
  await expect(programme).toContainText('3');
  await expect(programme).toContainText('wallets with a share of the supply');
  await expect(programme).toContainText(fmtDate(CUR_WEEK_START));
  const rows = programme.locator('.status-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('500,000 OTT');
  await expect(rows.nth(0)).toContainText('50.0%');
  await expect(rows.nth(0)).toContainText('$200.00');
  await expect(rows.nth(1)).toContainText('250,000 OTT');
  await expect(rows.nth(1)).toContainText('25.0%');
  await expect(rows.nth(1)).toContainText('$100.00');
  await expect(rows.nth(2)).toContainText('10,000 OTT');
  await expect(rows.nth(2)).toContainText('1.00%');
  await expect(rows.nth(2)).toContainText('$4.00');

  // The catalogue: from config/esim.json — 3 places, 5 packages, cheapest $1.19 (Europe), per
  // gigabyte $0.80 (Germany) to $8.99 (Global), catalogue dated Sep 1, 2026.
  const catalogue = cardByTitle(page, 'The catalogue');
  await expect(catalogue).toContainText('Connected');
  await expect(catalogue).toContainText('$1.19');
  await expect(catalogue).toContainText('Europe · 1 GB');
  await expect(catalogue).toContainText('$0.80 – $8.99');
  await expect(catalogue).toContainText('Sep 1, 2026');

  expect(errors).toEqual([]);
});

test('nothing configured: the store and payer checks fail, and the page shows the endpoint’s own detail text', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  const api = JSON.parse(JSON.stringify(API_OK));
  api.ready.payer = false;
  api.ready.store = false;
  api.checks.payer = { ok: false, detail: 'BLINK_API_KEY is not set' };
  api.checks.store = { ok: false, detail: 'KV_REST_API_URL is not set' };
  await stubAllFresh(page, { api });

  await page.goto('/index.html#/status');
  // The store is load-bearing (nothing can be recorded without it) so a failing check is off; the
  // payer only blocks the last step of a redeem (paying wholesale) so a failing check is a narrower
  // warn — the two rows are deliberately not the same state.
  const payerRow = rowByName(page, 'Lightning wallet');
  await expect(payerRow.locator('.status-dot')).toHaveClass(/warn/);
  await expect(payerRow).toContainText('BLINK_API_KEY is not set');
  const storeRow = rowByName(page, 'Store');
  await expect(storeRow.locator('.status-dot')).toHaveClass(/off/);
  await expect(storeRow).toContainText('KV_REST_API_URL is not set');
  // Provider was left ok, so the strip is not just uniformly broken.
  await expect(rowByName(page, 'Provider').locator('.status-dot')).toHaveClass(/ok/);
  expect(errors).toEqual([]);
});

test('the health endpoint is absent (404): the page still renders every section, with one warn row about the health check', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  // Every file source is fine; only /api/status is left unstubbed, which the static test server —
  // the same as a static host with no functions deployed — answers 404 for.
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, ALLOWANCES_FRESH);
  await stubTreasury(page, TREASURY_FRESH);
  await stubClaims(page, CLAIMS_FRESH);
  await stubFunding(page, FUNDING_FRESH);

  await page.goto('/index.html#/status');
  // One row stands in for the four /api/status would have answered, not four unknown rows.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(4);
  const healthCheckRow = rowByName(page, 'Health check');
  await expect(healthCheckRow.locator('.status-dot')).toHaveClass(/warn/);
  await expect(healthCheckRow).toContainText('could not be reached');
  await expect(healthCheckRow).toContainText('HTTP 404');
  // The three keeper rows come from the data files directly and do not depend on the endpoint.
  await expect(rowByName(page, 'Indexer').locator('.status-dot')).toHaveClass(/ok/);
  await expect(rowByName(page, 'Claim keeper').locator('.status-dot')).toHaveClass(/ok/);
  await expect(rowByName(page, 'Funding keeper').locator('.status-dot')).toHaveClass(/ok/);

  // Every other section still renders with real numbers; only the pool balance (sourced from the
  // endpoint's own pool reading) degrades, and it says why.
  await expect(cardByTitle(page, 'The coin')).toContainText('$6,500.00');
  await expect(cardByTitle(page, 'The treasury')).toContainText('$88.10');
  await expect(cardByTitle(page, 'The programme')).toContainText('$400.00');
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Connected');
  const pool = cardByTitle(page, 'The pool');
  await expect(pool).toContainText('the health check could not be reached');
  await expect(pool).toContainText('240 days');   // runway still comes from treasury.json
  expect(errors).toEqual([]);
});

test('not launched: the coin section is the honest line plus a link out to the launchpad, and no chain read is attempted', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  // Every one of the five curve selectors is wired to flip a flag if it is ever called; the coin
  // has no curve address, so readChain must never run at all.
  let chainCallMade = false;
  const flagged = {};
  for (const sel of Object.keys(CALLS)) flagged[sel] = () => { chainCallMade = true; return hexWord(0); };
  stubNetwork(page, { calls: flagged });
  const api = JSON.parse(JSON.stringify(API_OK));
  api.config.launched = false;
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, {
    asOf: NOW - 60, block: 1, week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: weekEndOf(CUR_WEEK),
    snapshotBlock: 0, coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', decimals: 18, holders: 0, wallets: {},
  });
  await stubTreasury(page, { asOf: NOW - 60, treasury: '', escrowClaimableUsd: null, walletUsd: null, reseller: null, spend30dUsd: 0, redemptions30d: 0, perDayUsd: 0, runwayDays: null, lastClaim: null, status: 'unknown' });
  await stubClaims(page, []);
  await stubFunding(page, []);
  await stubApiStatus(page, api);

  await page.goto('/index.html#/status');
  const coin = cardByTitle(page, 'The coin');
  await expect(coin).toContainText('OT+T has not launched a coin yet.');
  const launch = coin.locator('a[href="https://whatever-fun.vercel.app/#/new"]');
  await expect(launch).toHaveText('Launch the coin on whatever.fun');
  // Leaving the site for the launchpad is a new tab, and never with an opener handle back to us.
  await expect(launch).toHaveAttribute('target', '_blank');
  await expect(launch).toHaveAttribute('rel', 'noopener');
  await expect(coin.locator('.stat-grid')).toHaveCount(0);

  // The health strip agrees: the coin row says not launched, and the two daily keepers say there
  // is nothing to do yet rather than treating an empty log as a problem.
  await expect(rowByName(page, 'The coin')).toContainText('not launched yet');
  await expect(rowByName(page, 'Claim keeper')).toContainText('nothing to claim yet');
  await expect(rowByName(page, 'Funding keeper')).toContainText('nothing to fund yet');

  // The catalogue does not gate on launch state — it is read straight from config/esim.json.
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Connected');
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Sep 1, 2026');

  expect(chainCallMade).toBe(false);
  expect(errors).toEqual([]);
});

test('every data file is missing (404): each section names what is missing and the command that builds it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await missing(page, '**/config/esim.json');
  await missing(page, '**/data/allowances.json');
  await missing(page, '**/data/treasury.json');
  await missing(page, '**/data/claims.json');
  await missing(page, '**/data/funding.json');
  // /api/status is left unstubbed too, so it 404s the same way it does in the dedicated test above.

  await page.goto('/index.html#/status');
  await expect(page.locator('#view h1')).toHaveText('Everything, and whether it is running.');
  // The four /api/status-backed rows collapse to one, and the three file-backed rows each name
  // their own missing file and the command that writes it.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(4);
  await expect(rowByName(page, 'Indexer')).toContainText('node scripts/allowances.js');
  await expect(rowByName(page, 'Claim keeper')).toContainText('node scripts/claim.js');
  await expect(rowByName(page, 'Funding keeper')).toContainText('node scripts/fund.js');

  await expect(cardByTitle(page, 'The coin')).toContainText('config/esim.json could not be read');
  await expect(cardByTitle(page, 'The catalogue')).toContainText('config/esim.json could not be read');
  const pool = cardByTitle(page, 'The pool');
  await expect(pool).toContainText('node scripts/treasury.js');
  const treasury = cardByTitle(page, 'The treasury');
  await expect(treasury).toContainText('node scripts/claim.js');
  await expect(treasury).toContainText('node scripts/fund.js');
  await expect(cardByTitle(page, 'The programme')).toContainText('node scripts/allowances.js');

  // No section is left blank: every one of the six cards still has its heading and a notice.
  for (const title of ['Health', 'The coin', 'The pool', 'The treasury', 'The programme', 'The catalogue']) {
    await expect(cardByTitle(page, title)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the nav lists exactly three routes, status second, and highlights the active one', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await page.goto('/index.html#/status');
  const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => a.dataset.route));
  expect(links).toEqual(['home', 'status', 'about']);
  await expect(page.locator('#nav a[data-route="status"]')).toHaveClass(/active/);
  expect(errors).toEqual([]);
});
