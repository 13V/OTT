'use strict';
/**
 * The Status route (#/status) reads six sources nothing else on the site reads together in one
 * place: /api/status (site/api/status.js; this file relies only on the shape it documents) and
 * five JSON files (config/esim.json, data/allowances.json, data/treasury.json, data/claims.json,
 * data/funding.json), plus one Solana read once a coin exists: the coin's pump.fun bonding curve.
 * Every one of those is stubbed here, so each number and each health row is one this file chose
 * and can name, and every test proves the page survives losing one or all of them, because that
 * is the one thing a status page is not allowed to get wrong.
 */
// package.json's devDependency is @playwright/test; a sandbox with no npm install instead has the
// base `playwright` package on NODE_PATH, whose `playwright/test` subpath is the same test runner.
// Trying the real package first means a normal `npm install` changes nothing about this file.
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const { S, COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, addressFrom, programAddress, signatureFrom } = require('./support/solana.js');

const BRAND = { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' };

// Week arithmetic: identical to scripts/allowances.js and site/esim.js's own copy. Computed from
// the real clock at load time so "this week" fixtures are genuinely current whenever the suite runs.
const WEEK_S = 604800;
const ANCHOR = 345600;
const weekOf = (s) => Math.floor((s - ANCHOR) / WEEK_S);
const weekStartOf = (w) => ANCHOR + w * WEEK_S;
const weekEndOf = (w) => weekStartOf(w) + WEEK_S;
const CUR_WEEK = weekOf(Math.floor(Date.now() / 1000));
const CUR_WEEK_START = weekStartOf(CUR_WEEK);
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Three places across five wholesale packages, the same catalogue shape test/site/data.spec.js
// uses: Germany's 10 GB for $7.99 is 80c/GB (cheapest per gigabyte), Global's 1 GB for $8.99 is
// $8.99/GB (dearest per gigabyte), and Europe's 1 GB for $1.19 is the cheapest package to just buy.
const PACKAGES = [
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '105 countries' },
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 4.99, regions: 'DE' },
  { code: 'fixed_10GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 10, days: 30, priceUsd: 7.99, regions: 'DE' },
];
const WELCOME = { gb: 1, days: 7, maxUsd: 4 };
const base = { chain: 'solana', budgetBps: 8000, provider: 'wholesale', catalogueAt: '2026-09-01', packages: PACKAGES, brand: BRAND };
const NOT_LAUNCHED = Object.assign({ coin: '', tokenProgram: '', treasury: '',
  membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: '', capMultiple: 3, welcome: WELCOME } }, base);
const LAUNCHED = Object.assign({ coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, welcome: WELCOME } }, base);

// The coin's pump.fun bonding curve, at the PDA site/status.js derives: seed "bonding-curve" and
// the mint, under the pump program.
const CURVE = programAddress([Buffer.from('bonding-curve'), S.addressBytes(COIN)], S.PROGRAMS.pump);
const CURVE_SALE_UNITS = 793100000000000n;   // 793.1M tokens at 6 decimals
/**
 * The curve account as getAccountInfo returns it (base64). Anchor layout: an 8-byte discriminator,
 * then virtual token and SOL reserves, real token reserves (what is left to sell), real SOL
 * reserves (what it has raised), the total supply, `complete` and the creator.
 */
function curveAccount({ remainingUnits, raisedLamports, complete = false, owner = S.PROGRAMS.pump, discriminator = [23, 183, 248, 55, 96, 216, 172, 96] }) {
  const b = Buffer.alloc(151);
  Buffer.from(discriminator).copy(b, 0);
  b.writeBigUInt64LE(1073000000000000n - (CURVE_SALE_UNITS - remainingUnits), 8);   // virtual token reserves
  b.writeBigUInt64LE(30000000000n + raisedLamports, 16);                            // virtual SOL reserves
  b.writeBigUInt64LE(remainingUnits, 24);                                            // real token reserves
  b.writeBigUInt64LE(raisedLamports, 32);                                            // real SOL reserves
  b.writeBigUInt64LE(1000000000000000n, 40);                                         // token total supply
  b[48] = complete ? 1 : 0;
  Buffer.from(S.addressBytes(TREASURY)).copy(b, 49);                                 // creator
  return { owner, lamports: Number(raisedLamports) + 1231920, executable: false, rentEpoch: 18446744073709551615, space: b.length, data: [b.toString('base64'), 'base64'] };
}
// 32.5% of the sale done (Math.round shows 33%) and 27.5 SOL raised; the coin has not graduated.
const CURVE_LIVE = curveAccount({ remainingUnits: CURVE_SALE_UNITS * 675n / 1000n, raisedLamports: 27500000000n });
const CURVE_GRADUATED = curveAccount({ remainingUnits: 0n, raisedLamports: 0n, complete: true });

const NOW = Math.floor(Date.now() / 1000);
const CLAIM_TX = signatureFrom('fee collection');
const FUND_TX = signatureFrom('funding deposit');

// A fully healthy /api/status: every check ok, the pool reading present, the coin launched.
const API_OK = {
  ok: true, asOf: NOW, brand: { name: BRAND.name, full: BRAND.full, ticker: BRAND.ticker },
  config: {
    chain: 'solana', launched: true, coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, provider: 'wholesale',
    packages: 5, places: 3, catalogueAt: '2026-09-01', catalogueFingerprint: 'f'.repeat(64), budgetBps: 8000,
    membership: { configured: true, burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, welcome: WELCOME },
  },
  wiring: { provider: 'wholesale', payer: 'blink', store: 'upstash' },
  ready: { config: true, provider: true, payer: true, store: true, allowances: true },
  redemption: { enabled: true, ready: true },
  checks: {
    store: { ok: true, detail: 'read, wrote and atomically updated a probe key' },
    payer: { ok: true, detail: 'reached the wallet: $812.34 (1500000 sats)' },
    provider: { ok: true, detail: 'catalogue answered, 14 bundles for germany' },
    allowances: { ok: true, detail: '3 holders, $400.00 budget, week ' + CUR_WEEK },
  },
  pool: { usd: 812.34, sats: 1500000 },
  allowances: { week: CUR_WEEK, currentWeek: CUR_WEEK, stale: false, budgetUsd: 400, holders: 3, members: 3, requirement: { week: CUR_WEEK, burnTokens: '180000' } },
};

// Three members sharing this week's $400.00 budget: A holds half of the members' OTT, B 30% and C
// 20%, so the table has a real spread in share and in the allowance that share buys
// ($200.00 / $120.00 / $80.00; nobody reaches the 3× cap).
const WALLET_A = addressFrom('member a');
const WALLET_B = addressFrom('member b');
const WALLET_C = addressFrom('member c');
const ott = (n) => (BigInt(n) * 1000000n).toString();
const since = (label, at) => ({ at, slot: 399000000, tx: signatureFrom('join ' + label) });
const ALLOWANCES_FRESH = {
  asOf: NOW - 60, slot: 400000000, chain: 'solana',
  week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: weekEndOf(CUR_WEEK),
  coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, treasury: TREASURY,
  budgetUsd: 400, budgetSource: 'creator fees collected in week ' + (CUR_WEEK - 1),
  fees: { weekUsd: { [CUR_WEEK - 1]: 500 }, collections: [{ tx: CLAIM_TX, at: NOW - 86400 * 3, slot: 398000000, lamports: '3333333333', solUsd: 150, usd: 500 }], cursor: { signature: CLAIM_TX, slot: 398000000 } },
  membership: {
    burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3,
    requirement: { week: CUR_WEEK, burnTokens: '180000', burnUnits: '180000000000', priceUsd: 0.0000278, solUsd: 150, source: 'bonding-curve', at: CUR_WEEK_START + 600 },
    requirements: { [CUR_WEEK]: '180000000000' },
    members: 3, capUsd: 400, allocatedUsd: 400, unallocatedUsd: 0, cursor: { signature: signatureFrom('join c'), slot: 399500000 },
  },
  members: {
    [WALLET_A]: { burned: '180000000000', since: since('a', CUR_WEEK_START - 86400 * 9) },
    [WALLET_B]: { burned: '180000000000', since: since('b', CUR_WEEK_START - 86400 * 8) },
    [WALLET_C]: { burned: '180000000000', since: since('c', CUR_WEEK_START - 86400 * 7) },
  },
  joins: {},
  holders: 3, memberTokens: ott(1000000),
  wallets: {
    [WALLET_A]: { tokens: ott(500000), share: 0.5, allowanceUsd: 200, member: true },
    [WALLET_B]: { tokens: ott(300000), share: 0.3, allowanceUsd: 120, member: true },
    [WALLET_C]: { tokens: ott(200000), share: 0.2, allowanceUsd: 80, member: true },
  },
};

// treasury.json, claims.json and funding.json as scripts/treasury.js, claim.js and fund.js write
// them, each timestamped well inside the freshness windows status.js uses (2h for the indexer,
// 48h for the two daily keepers), so every health row reads ok.
const TREASURY_FRESH = {
  asOf: NOW - 60, treasury: TREASURY, solUsd: 150, walletSol: 0.1, walletUsd: 15.00, claimableSol: 0.5873, claimableUsd: 88.10,
  reseller: { name: 'wholesale', balanceUsd: 812.34, asOf: NOW - 60, sats: 1500000, wallet: 'blink' },
  spend30dUsd: 55.20, redemptions30d: 9, perDayUsd: 1.84, runwayDays: 240,
  weekBudgetUsd: 400, weekRedeemedUsd: 12, owedUsd: 388,
  lastClaim: { at: NOW - 3600, sol: 0.278, usd: 41.70, tx: CLAIM_TX }, status: 'funded',
};
const CLAIMS_FRESH = [{ at: NOW - 3600, lamports: '278000000', sol: 0.278, solUsd: 150, usd: 41.70, tx: CLAIM_TX, sources: ['curve'], dryRun: false }];
const FUNDING_FRESH = [{ at: NOW - 7200, finishedAt: NOW - 7100, amountUsd: 50.00, solSent: 0.3334, lamports: '333400000', sats: 123456,
  fixedFloatOrder: 'FF-TEST-1', invoiceHash: 'ab'.repeat(32), depositTx: FUND_TX, status: 'done', dryRun: false }];

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });
const missing = (page, pattern) => page.route(pattern, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));

const stubConfig = (page, cfg) => page.route('**/config/esim.json', (route) => route.fulfill(json(cfg)));
const stubAllowances = (page, body) => page.route('**/data/allowances.json', (route) => route.fulfill(json(body)));
const stubTreasury = (page, body) => page.route('**/data/treasury.json', (route) => route.fulfill(json(body)));
const stubClaims = (page, body) => page.route('**/data/claims.json', (route) => route.fulfill(json(body)));
const stubFunding = (page, body) => page.route('**/data/funding.json', (route) => route.fulfill(json(body)));
const stubApiStatus = (page, body) => page.route('**/api/status**', (route) => route.fulfill(json(body)));
/** The Solana RPC, answering the coin's curve with `curve` (null: there is no such account). */
const stubChain = (page, curve = CURVE_LIVE) => stubNetwork(page, { accounts: curve ? { [CURVE]: curve } : {} });

/** Every one of the six sources answering the "everything is fine and fresh" fixtures above. */
async function stubAllFresh(page, { cfg = LAUNCHED, api = API_OK } = {}) {
  await stubConfig(page, cfg);
  await stubAllowances(page, ALLOWANCES_FRESH);
  await stubTreasury(page, TREASURY_FRESH);
  await stubClaims(page, CLAIMS_FRESH);
  await stubFunding(page, FUNDING_FRESH);
  await stubApiStatus(page, api);
}

// A band is its .section, found by its own heading rather than by position or by a row's text:
// the health section also contains a row literally named "The coin", so matching on .section-head
// is what tells the two apart. Each .section still wraps exactly one .card of content, so a
// locator scoped to the .section also reaches everything inside that card.
const cardByTitle = (page, title) => page.locator('.section').filter({ has: page.locator('.section-head', { hasText: title }) });
// Matched on the row's own <b> name, not the whole row's text: "Fee keeper" and "Funding keeper"
// both say "the coin has not launched" in their detail, which is a substring match for "The coin"
// too if the whole row's text is searched instead of just its name.
const rowByName = (page, name) => page.locator('.status-row').filter({ has: page.locator('b', { hasText: name }) });
// A stat tile, found by its exact label: "Week" alone would also match "This week’s budget".
const exactly = (text) => new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const tileByLabel = (scope, label) => scope.locator('.u-tile').filter({ has: scope.page().locator('.u-tile-label', { hasText: exactly(label) }) });

test('fully wired and launched: every health row is ok, and every section shows the fixtures’ own numbers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  const network = stubChain(page);
  await stubAllFresh(page);

  await page.goto('/index.html#/status');
  await expect(page.locator('#view h1')).toHaveText('Everything, and whether it is running.');
  await expect(page).toHaveTitle('Status — OT+T');
  await expect(page.locator('.page-head .label')).toHaveText('OT+T · NETWORK STATUS');
  await expect(page.locator('.page-head .page-lede')).toContainText('the same Solana accounts every other route uses');
  await expect(page.locator('.status-summary')).toContainText('PROGRAMME CONFIGURED');

  // Health strip: eight rows, every one of them ok.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(8);
  await expect(page.locator('.status-dot.ok')).toHaveCount(8);
  await expect(page.locator('.status-dot.warn')).toHaveCount(0);
  await expect(page.locator('.status-dot.off')).toHaveCount(0);
  await expect(rowByName(page, 'The coin')).toContainText('launched');
  await expect(rowByName(page, 'Network partner')).toContainText('Network partner');
  await expect(rowByName(page, 'Network partner')).toContainText('catalogue answered, 14 bundles for germany');
  await expect(rowByName(page, 'Lightning wallet')).toContainText('Lightning wallet · blink');
  await expect(rowByName(page, 'Store')).toContainText('Store · upstash');
  await expect(rowByName(page, 'Data redemption')).toContainText('Purchases are enabled. Funding and service checks passed.');
  await expect(rowByName(page, 'Indexer')).toContainText(/updated .*ago/);
  await expect(rowByName(page, 'Fee keeper')).toContainText('last collected 60m ago (0.278 SOL)');
  await expect(rowByName(page, 'Funding keeper')).toContainText('last ran 2h ago, moved $50.00 (done)');

  // The coin: one getAccountInfo on the curve PDA, base64. 32.5% of the sale is done (33% once
  // rounded), 27.5 SOL raised, the curve's 0.30% creator fee, not graduated.
  expect(network.requests.filter((r) => r.method === 'getAccountInfo')).toEqual([{ method: 'getAccountInfo', params: [CURVE, { encoding: 'base64', commitment: 'confirmed' }] }]);
  const coin = cardByTitle(page, 'The coin');
  await expect(tileByLabel(coin, 'Curve sold')).toContainText('33%');
  await expect(tileByLabel(coin, 'Curve sold')).toContainText('of the bonding curve’s tokens, toward graduation');
  await expect(tileByLabel(coin, 'Raised')).toContainText('27.5 SOL');
  await expect(tileByLabel(coin, 'Raised')).toContainText('SOL in the bonding curve');
  await expect(tileByLabel(coin, 'Creator fee')).toContainText('0.30%');
  await expect(tileByLabel(coin, 'Creator fee')).toContainText('of each trade on the curve, to the treasury');
  await expect(tileByLabel(coin, 'Graduated')).toContainText('Not yet');
  await expect(coin.locator('.data-progress')).toContainText('33% of the way to graduation.');
  const pumpLink = coin.getByRole('link', { name: 'OTT on pump.fun ↗' });
  await expect(pumpLink).toHaveAttribute('href', 'https://pump.fun/coin/' + COIN);
  await expect(pumpLink).toHaveAttribute('target', '_blank');
  await expect(pumpLink).toHaveAttribute('rel', 'noopener');
  await expect(coin.getByRole('link', { name: 'Token on Solscan ↗' })).toHaveAttribute('href', 'https://solscan.io/token/' + COIN);

  // The pool: balance from the health check's own pool reading, the rest from treasury.json.
  const pool = cardByTitle(page, 'The pool');
  await expect(pool).toContainText('$812.34');
  await expect(pool).toContainText('1,500,000 sats');
  await expect(pool).toContainText('240 days');
  await expect(pool).toContainText('$55.20');
  await expect(tileByLabel(pool, 'Redemptions')).toContainText('9');

  // The treasury: uncollected creator fees and the wallet from treasury.json, the last fee
  // collection from claims.json (linked on Solscan) and the last funding run from funding.json.
  const treasury = cardByTitle(page, 'The treasury');
  await expect(tileByLabel(treasury, 'Uncollected fees')).toContainText('$88.10');
  await expect(tileByLabel(treasury, 'Uncollected fees')).toContainText('0.5873 SOL waiting in pump.fun’s creator vaults');
  await expect(tileByLabel(treasury, 'Treasury wallet')).toContainText('$15.00');
  await expect(tileByLabel(treasury, 'Treasury wallet')).toContainText('0.1 SOL before it is moved to the pool');
  await expect(treasury.getByRole('link', { name: TREASURY.slice(0, 6) + '…' + TREASURY.slice(-4) })).toHaveAttribute('href', 'https://solscan.io/account/' + TREASURY);
  await expect(treasury).toContainText('Last fee collection: 0.278 SOL ($41.70) on ' + fmtDate(NOW - 3600));
  const claimLink = treasury.locator('a[href="https://solscan.io/tx/' + CLAIM_TX + '"]');
  await expect(claimLink).toHaveText(CLAIM_TX.slice(0, 8) + '…' + CLAIM_TX.slice(-6));
  await expect(treasury).toContainText('Last funding run: 0.3334 SOL · $50.00 → 123,456 sats');
  await expect(treasury).toContainText('done · order FF-TEST-1');

  // The programme: this week's $400.00 budget, 3 members sharing it, this week's join amount, the
  // week it is for, and the members table sorted by allowance (A $200, B $120, C $80).
  const programme = cardByTitle(page, 'The programme');
  await expect(tileByLabel(programme, 'This week’s budget')).toContainText('$400.00');
  await expect(tileByLabel(programme, 'This week’s budget')).toContainText('creator fees collected in week ' + (CUR_WEEK - 1));
  await expect(tileByLabel(programme, 'Members sharing')).toContainText('3');
  await expect(tileByLabel(programme, 'Members sharing')).toContainText('members in this week’s split');
  await expect(tileByLabel(programme, 'Join amount')).toContainText('180,000 OTT');
  await expect(tileByLabel(programme, 'Join amount')).toContainText('about $5.00, set for this week');
  await expect(tileByLabel(programme, 'Week')).toContainText(fmtDate(CUR_WEEK_START));
  const rows = programme.locator('.status-table tbody tr');
  await expect(rows).toHaveCount(3);
  const expected = [[WALLET_A, '500,000 OTT', '50.0%', '$200.00'], [WALLET_B, '300,000 OTT', '30.0%', '$120.00'], [WALLET_C, '200,000 OTT', '20.0%', '$80.00']];
  for (const [i, [wallet, holds, share, allowance]] of expected.entries()) {
    await expect(rows.nth(i).locator('td')).toHaveText([wallet.slice(0, 6) + '…' + wallet.slice(-4), holds, share, allowance]);
  }

  // The catalogue: from config/esim.json: 3 places, 5 packages, cheapest $1.19 (Europe), per
  // gigabyte $0.80 (Germany) to $8.99 (Global), catalogue dated Sep 1, 2026.
  const catalogue = cardByTitle(page, 'The catalogue');
  await expect(catalogue).toContainText('Connected');
  await expect(catalogue).toContainText('$1.19');
  await expect(catalogue).toContainText('Europe · 1 GB');
  await expect(catalogue).toContainText('$0.80 – $8.99');
  await expect(catalogue).toContainText('Sep 1, 2026');

  // Nothing on the page still speaks of the chain or the money this programme used to run on.
  await expect(page.locator('#view')).not.toContainText(/Robinhood|USDG|escrow|10% tax|creator tax/i);
  expect(errors).toEqual([]);
});

test('a graduated coin says it trades on PumpSwap, with PumpSwap’s creator fee', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubChain(page, CURVE_GRADUATED);
  await stubAllFresh(page);
  await page.goto('/index.html#/status');
  const coin = cardByTitle(page, 'The coin');
  await expect(tileByLabel(coin, 'Graduated')).toContainText('Yes');
  await expect(tileByLabel(coin, 'Graduated')).toContainText('trading has moved to PumpSwap');
  await expect(tileByLabel(coin, 'Curve sold')).toContainText('100%');
  await expect(tileByLabel(coin, 'Curve sold')).toContainText('the curve sold out and graduated');
  await expect(tileByLabel(coin, 'Creator fee')).toContainText('0.05–0.95%');
  await expect(tileByLabel(coin, 'Creator fee')).toContainText('of each PumpSwap trade, by market cap');
  await expect(coin.locator('.data-progress')).toContainText('Graduated: OTT now trades on PumpSwap.');
  expect(errors).toEqual([]);
});

for (const [name, curve, reason] of [
  ['has no bonding curve account', null, 'the coin has no pump.fun bonding curve'],
  ['has a curve account owned by another program', curveAccount({ remainingUnits: 0n, raisedLamports: 0n, owner: S.PROGRAMS.token }), 'the coin has no pump.fun bonding curve'],
  ['has an account that is not a bonding curve', curveAccount({ remainingUnits: 0n, raisedLamports: 0n, discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }), 'the bonding curve could not be read'],
]) {
  test('a coin that ' + name + ' gets a warning instead of invented progress, and the rest of the page still renders', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
    stubChain(page, curve);
    await stubAllFresh(page);
    await page.goto('/index.html#/status');
    const coin = cardByTitle(page, 'The coin');
    await expect(coin).toContainText('Could not read the bonding curve: ' + reason);
    await expect(coin.locator('.stat-grid')).toHaveCount(0);
    await expect(coin.locator('.data-progress')).toHaveCount(0);
    await expect(coin.getByRole('link', { name: 'OTT on pump.fun ↗' })).toHaveAttribute('href', 'https://pump.fun/coin/' + COIN);
    await expect(cardByTitle(page, 'The programme')).toContainText('$400.00');
    await expect(cardByTitle(page, 'The treasury')).toContainText('$88.10');
    expect(errors).toEqual([]);
  });
}

test('nothing configured: the store and payer checks fail, and the page shows the endpoint’s own detail text', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubChain(page);
  const api = JSON.parse(JSON.stringify(API_OK));
  api.ready.payer = false;
  api.ready.store = false;
  api.redemption.ready = false;
  api.pool = null;
  api.checks.payer = { ok: false, detail: 'BLINK_API_KEY is not set' };
  api.checks.store = { ok: false, detail: 'KV_REST_API_URL is not set' };
  await stubAllFresh(page, { api });

  await page.goto('/index.html#/status');
  // The store is load-bearing (nothing can be recorded without it) so a failing check is off; the
  // payer only blocks the last step of a redeem (paying wholesale) so a failing check is a narrower
  // warn: the two rows are deliberately not the same state.
  const payerRow = rowByName(page, 'Lightning wallet');
  await expect(payerRow.locator('.status-dot')).toHaveClass(/warn/);
  await expect(payerRow).toContainText('BLINK_API_KEY is not set');
  const storeRow = rowByName(page, 'Store');
  await expect(storeRow.locator('.status-dot')).toHaveClass(/off/);
  await expect(storeRow).toContainText('KV_REST_API_URL is not set');
  // The network partner was left ok, so the strip is not just uniformly broken.
  await expect(rowByName(page, 'Network partner').locator('.status-dot')).toHaveClass(/ok/);
  // With no pool reading, the balance says so rather than showing a zero.
  await expect(tileByLabel(cardByTitle(page, 'The pool'), 'Pool balance')).toContainText('the health check reported no pool reading');
  expect(errors).toEqual([]);
});

for (const [name, redemption, state, detail] of [
  ['paused', { enabled: false, ready: false }, 'off', 'Purchases are paused. Account and installation reads remain available.'],
  ['enabled but not ready', { enabled: true, ready: false }, 'warn', 'Purchases are enabled, but the service is not ready.'],
  ['unknown', undefined, 'warn', 'Redemption readiness is unavailable. Purchases have not been verified.'],
]) {
  test('healthy dependencies do not conceal ' + name + ' redemption', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    stubChain(page);
    const api = JSON.parse(JSON.stringify(API_OK));
    if (redemption === undefined) delete api.redemption; else api.redemption = redemption;
    await stubAllFresh(page, { api });
    await page.goto('/index.html#/status');
    const row = rowByName(page, 'Data redemption');
    await expect(row).toContainText(detail);
    await expect(row.locator('.status-dot')).toHaveClass(new RegExp(state));
    await expect(page.locator('.status-strip .status-dot.ok')).toHaveCount(7);
    await expect(row).not.toContainText('checks passed');
    expect(errors).toEqual([]);
  });
}

test('stale keepers turn their rows to warn and say how long they have been quiet', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubChain(page);
  await stubAllFresh(page);
  // Registered after stubAllFresh, so these answers win: the indexer three hours quiet, the fee
  // keeper three days, and the last funding run left for a person at ff.io.
  await stubAllowances(page, Object.assign({}, ALLOWANCES_FRESH, { asOf: NOW - 3 * 3600 }));
  await stubClaims(page, [Object.assign({}, CLAIMS_FRESH[0], { at: NOW - 3 * 86400 })]);
  await stubFunding(page, [Object.assign({}, FUNDING_FRESH[0], { status: 'expired' })]);
  await page.goto('/index.html#/status');
  await expect(rowByName(page, 'Indexer').locator('.status-dot')).toHaveClass(/warn/);
  await expect(rowByName(page, 'Indexer')).toContainText('stale — last updated 3h ago, expected every 30 minutes');
  await expect(rowByName(page, 'Fee keeper').locator('.status-dot')).toHaveClass(/warn/);
  await expect(rowByName(page, 'Fee keeper')).toContainText('stale — last collected 3d ago (0.278 SOL)');
  await expect(rowByName(page, 'Funding keeper').locator('.status-dot')).toHaveClass(/off/);
  await expect(rowByName(page, 'Funding keeper')).toContainText('the last run is expired and needs a hand at ff.io (order FF-TEST-1)');
  expect(errors).toEqual([]);
});

test('the health endpoint is absent (404): the page still renders every section, with one warn row about the health check', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubChain(page);
  // Every file source is fine; only /api/status is left unstubbed, which the static test server
  // (like a static host with no functions deployed) answers 404 for.
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, ALLOWANCES_FRESH);
  await stubTreasury(page, TREASURY_FRESH);
  await stubClaims(page, CLAIMS_FRESH);
  await stubFunding(page, FUNDING_FRESH);

  await page.goto('/index.html#/status');
  // One row stands in for the five /api/status would have answered, not five unknown rows.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(4);
  const healthCheckRow = rowByName(page, 'Health check');
  await expect(healthCheckRow.locator('.status-dot')).toHaveClass(/warn/);
  await expect(healthCheckRow).toContainText('could not be reached');
  await expect(healthCheckRow).toContainText('HTTP 404');
  // The three keeper rows come from the data files directly and do not depend on the endpoint.
  await expect(rowByName(page, 'Indexer').locator('.status-dot')).toHaveClass(/ok/);
  await expect(rowByName(page, 'Fee keeper').locator('.status-dot')).toHaveClass(/ok/);
  await expect(rowByName(page, 'Funding keeper').locator('.status-dot')).toHaveClass(/ok/);

  // Every other section still renders with real numbers; only the pool balance (sourced from the
  // endpoint's own pool reading) degrades, and it says why.
  await expect(cardByTitle(page, 'The coin')).toContainText('27.5 SOL');
  await expect(cardByTitle(page, 'The treasury')).toContainText('$88.10');
  await expect(cardByTitle(page, 'The programme')).toContainText('$400.00');
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Connected');
  const pool = cardByTitle(page, 'The pool');
  await expect(pool).toContainText('the health check could not be reached');
  await expect(pool).toContainText('240 days');   // runway still comes from treasury.json
  expect(errors).toEqual([]);
});

test('not launched: the coin section says OTT will launch on pump.fun, and nothing is read from Solana', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  // The curve is there to be read, but the config names no coin, so readChain must never run.
  const network = stubChain(page);
  const api = JSON.parse(JSON.stringify(API_OK));
  api.config = Object.assign({}, api.config, { launched: false, coin: '', tokenProgram: '', treasury: '',
    membership: Object.assign({}, api.config.membership, { burnAccount: '' }) });
  api.redemption = { enabled: false, ready: false };
  api.allowances = { week: CUR_WEEK, currentWeek: CUR_WEEK, stale: false, budgetUsd: 0, holders: 0, members: 0, requirement: null };
  await stubConfig(page, NOT_LAUNCHED);
  // The prelaunch ledger, as docs/membership.md describes it.
  await stubAllowances(page, {
    asOf: NOW - 60, slot: 400000000, chain: 'solana', week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: weekEndOf(CUR_WEEK),
    coin: '', tokenProgram: '', decimals: 6, treasury: '', budgetUsd: 0, budgetSource: 'the coin is not launched yet',
    membership: null, members: {}, joins: {}, holders: 0, memberTokens: '0', wallets: {},
  });
  await stubTreasury(page, { asOf: NOW - 60, treasury: '', solUsd: null, walletSol: null, walletUsd: null, claimableSol: null, claimableUsd: null,
    reseller: null, spend30dUsd: 0, redemptions30d: 0, perDayUsd: 0, runwayDays: null, weekBudgetUsd: null, weekRedeemedUsd: null, owedUsd: null, lastClaim: null, status: 'unknown' });
  await stubClaims(page, []);
  await stubFunding(page, []);
  await stubApiStatus(page, api);

  await page.goto('/index.html#/status');
  await expect(page.locator('.status-summary')).toContainText('PRELAUNCH');
  const coin = cardByTitle(page, 'The coin');
  await expect(coin).toContainText('OT+T has not launched its coin yet. OTT will launch on pump.fun, paired with SOL.');
  const launch = coin.getByRole('link', { name: 'pump.fun', exact: true });
  await expect(launch).toHaveAttribute('href', 'https://pump.fun');
  // Leaving the site for the launchpad is a new tab, and never with an opener handle back to us.
  await expect(launch).toHaveAttribute('target', '_blank');
  await expect(launch).toHaveAttribute('rel', 'noopener');
  await expect(coin.locator('.stat-grid')).toHaveCount(0);

  // The health strip agrees: the coin row says not launched, and the two daily keepers say there
  // is nothing to do yet rather than treating an empty log as a problem.
  await expect(rowByName(page, 'The coin')).toContainText('not launched yet');
  await expect(rowByName(page, 'Data redemption')).toContainText('Prelaunch. Data redemption is disabled.');
  await expect(rowByName(page, 'Data redemption').locator('.status-dot')).toHaveClass(/off/);
  await expect(rowByName(page, 'Indexer')).toContainText('not active until coin launch');
  await expect(rowByName(page, 'Fee keeper')).toContainText('nothing to collect yet — the coin has not launched');
  await expect(rowByName(page, 'Fee keeper').locator('.status-dot')).toHaveClass(/ok/);
  await expect(rowByName(page, 'Funding keeper')).toContainText('nothing to fund yet — the coin has not launched');

  // The treasury and programme say there is nothing yet, without a dollar figure.
  const treasury = cardByTitle(page, 'The treasury');
  await expect(treasury).toContainText('Nothing to collect yet — the coin has not launched.');
  await expect(treasury).toContainText('Nothing to fund yet — the coin has not launched.');
  await expect(tileByLabel(treasury, 'Uncollected fees')).toContainText('not read yet');
  const programme = cardByTitle(page, 'The programme');
  await expect(tileByLabel(programme, 'Join amount')).toContainText('set at the first ledger update of the week');
  await expect(programme).toContainText('No member is in this week’s split yet.');

  // The catalogue does not gate on launch state: it is read straight from config/esim.json.
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Connected');
  await expect(cardByTitle(page, 'The catalogue')).toContainText('Sep 1, 2026');

  expect(network.methods).toEqual([]);
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
  // The five /api/status-backed rows collapse to one, and the three file-backed rows each name
  // their own missing file and the command that writes it.
  await expect(page.locator('.status-strip .status-row')).toHaveCount(4);
  await expect(rowByName(page, 'Indexer')).toContainText('node scripts/allowances.js');
  await expect(rowByName(page, 'Fee keeper')).toContainText('node scripts/claim.js');
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

test('the nav includes the holder dashboard and highlights status', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await page.goto('/index.html#/status');
  const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => a.textContent));
  expect(links).toEqual(['The idea', 'Destinations', 'Trust', 'My data', 'Status', 'Open app']);
  await expect(page.locator('#nav a[data-route="status"]')).toHaveClass(/active/);
  expect(errors).toEqual([]);
});
