'use strict';
/**
 * The programme page — OT+T's home route (#/); it lived at #/data back when this site was two
 * routes inside whatever.fun — reads three things nothing else on the site reads: config/esim.json,
 * the indexer's allowances.json, and /api/redeem, plus six view functions on the coin's curve and
 * the fee escrow. Every one of them is stubbed here, so each number the page shows is a number
 * this file chose and the assertion can name it. Holding is the plan now: allowances.json carries a
 * whole week's shape (a budget, a circulating supply, a per-wallet share) rather than a running
 * per-wallet total, and the redeem API answers the same wallet standing the founder actually asked
 * for — what a wallet holds, and what that buys this week. The states that matter are "not launched
 * yet" (the checked-in config until launch day), "launched" with no wallet (an invitation), a
 * wallet that holds nothing, a week whose allowance has not been published yet ("stale"), and the
 * ordinary case, all of which must be honest without an exception.
 */
// package.json's devDependency is @playwright/test; a sandbox with no npm install instead has the
// base `playwright` package on NODE_PATH, whose `playwright/test` subpath is the same test runner.
// Trying the real package first means a normal `npm install` changes nothing about this file.
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork, hexWord } = require('./support/network.js');

const ADDR = '0x4ca685f4a1cd39ba0d0f1cd06b3f2b0f5b7cdd11';
const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

// Week arithmetic — identical to plan-contract.md, scripts/allowances.js and site/esim.js's own
// copy, so a fixture's week is never off by one from what the page computes for itself. Computed
// from the real clock at load time (not a hardcoded week number) so this file's "current week"
// fixtures are genuinely current whenever the suite actually runs, and "last week" is always
// genuinely in the past.
const WEEK_S = 604800;
const ANCHOR = 345600;
const weekOf = (s) => Math.floor((s - ANCHOR) / WEEK_S);
const weekStartOf = (w) => ANCHOR + w * WEEK_S;
const weekEndOf = (w) => weekStartOf(w) + WEEK_S;
const NOW_S = Math.floor(Date.now() / 1000);
const CUR_WEEK = weekOf(NOW_S);
const CUR_WEEK_START = weekStartOf(CUR_WEEK);
const CUR_WEEK_END = weekEndOf(CUR_WEEK);
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
// The "Resets in" tile's countdown text, mirroring esim.js's own fmtCountdown() exactly, computed
// fresh at call time rather than once — the assertion that uses this calls it right before
// checking, so the few milliseconds a test takes to run cannot round it to a different minute.
function fmtCountdownLike(weekEndSec) {
  const ms = weekEndSec * 1000 - Date.now();
  if (ms <= 0) return 'any moment';
  const totalMin = Math.ceil(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + (totalMin % 60) + 'm';
  return totalMin + 'm';
}

// Three places across five nadanada packages, at real catalogue prices. Europe and Global each
// sell one 1 GB size; Germany sells all three sizes, which makes it the only place with both a
// region and a country in the picker, and — at $7.99 for 10 GB, ~80¢/GB — the cheapest place per
// gigabyte in this fixture, so `cheapest()` picks it. Global's 1 GB at $8.99 is the dearest per
// gigabyte. Germany carries a flag (a real country does, in the real catalogue) and the two
// regions do not, exactly like production data.
const PACKAGES = [
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '105 countries' },
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 4.99, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_10GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 10, days: 30, priceUsd: 7.99, regions: 'DE', flag: '🇩🇪' },
];
const BRAND = { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' };
const base = { pair: USDG, taxBps: 1000, budgetBps: 10000, provider: 'nadanada', packages: PACKAGES, brand: BRAND };
const NOT_LAUNCHED = Object.assign({ coin: '', curve: '', treasury: '' }, base);
const LAUNCHED = Object.assign({ coin: COIN, curve: CURVE, treasury: TREASURY }, base);
// A config from before the brand existed — no `brand` key at all — to prove the fallback path.
const NOT_LAUNCHED_NO_BRAND = Object.assign({}, NOT_LAUNCHED);
delete NOT_LAUNCHED_NO_BRAND.brand;

// The six reads, as USDG (6 decimals) or bare numbers. The page turns these into the figures the
// tests below look for: $1,234.56 claimable, 1,545 GB of it at Germany's $0.80/GB, 30% of the way
// to graduation, a 10% tax with $50.00 still sitting in the curve.
const CALLS = {
  '0xf59e38b7': hexWord(1234560000n),        // balanceOfToken(treasury, USDG)
  '0x4f1f58fd': hexWord(3000000000n),        // realQuoteReserve()
  '0x8b0bc501': hexWord(10000000000n),       // graduationThreshold()
  '0xe7c2b772': hexWord(0),                  // graduated()
  '0xc1bb8901': hexWord(1000),               // creatorTaxBps()
  '0xdb2bd533': hexWord(50000000n),          // creatorTaxBalance()
};

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });

function stubConfig(page, cfg) {
  return page.route('**/config/esim.json', (route) => route.fulfill(json(cfg)));
}
function stubTreasury(page, t) {
  return page.route('**/data/treasury.json', (route) => route.fulfill(json(t)));
}
// The week's own shape, per plan-contract.md: a budget, a circulating supply, a holder count, and
// a wallets map keyed by lowercase address. `overrides` replaces individual top-level fields (or
// `wallets`) over this "healthy, currently-published, nobody-holds-anything-yet" default, so a test
// only has to say what actually matters for it.
function stubAllowances(page, overrides) {
  const base = {
    asOf: NOW_S, block: 64200000, week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: CUR_WEEK_END,
    snapshotBlock: 64200000, coin: COIN, curve: CURVE,
    budgetUsd: 412.5, budgetSource: 'tax collected in week ' + (CUR_WEEK - 1),
    circulating: '812345678000000000000000', decimals: 18, holders: 214,
    wallets: {},
  };
  const file = Object.assign({}, base, overrides || {});
  return page.route('**/data/allowances.json', (route) => route.fulfill(json(file)));
}
const ALLOW_BUDGET_USD = 412.5;
const ALLOW_CIRCULATING = '812345678000000000000000';
const ALLOW_DECIMALS = 18;
// How many OTT tokensToCover() says a package needs, computed with the page's own arithmetic and
// its own fmtTokens() rounding, so this can never drift from a hand-typed literal.
function needStr(priceUsd) {
  const circulating = Number(BigInt(ALLOW_CIRCULATING)) / Math.pow(10, ALLOW_DECIMALS);
  const need = priceUsd * circulating / ALLOW_BUDGET_USD;
  return need.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** A wallet that answers the four methods the page uses, and records every call it was asked. */
function stubWallet(page) {
  return page.addInitScript((addr) => {
    window.__eth = [];
    window.ethereum = {
      request: async ({ method, params }) => {
        window.__eth.push({ method, params });
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') return '0x' + 'ab'.repeat(65);
        return null;
      },
    };
  }, ADDR);
}

test('before launch, #/ shows the rules and the launch link', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('Mobile data in 28 places, just for holding OTT.');
  await expect(page.locator('.hero-sub')).toHaveText('Your share of OTT becomes a data allowance every week — spend it on an eSIM before it resets.');
  await expect(page).toHaveTitle('OT+T — hold the coin, fly with data');
  // No wallet in this browser context, so the hero's primary action offers to connect one rather
  // than jumping straight to the plans.
  await expect(page.locator('.hero-actions').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  // Scoped to .hero-actions: the primary nav also has a "How it works" link, to #/about.
  await expect(page.locator('.hero-actions').getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '#how-it-works');
  // The brand, read from config, is named in the how-it-works band's second step — see the
  // dedicated test below for the catalogue-driven sections, which render identically before and
  // after launch.
  await expect(page.locator('.step-body').nth(1)).toContainText('OT+T’s trades');
  const card = page.locator('.data-notlaunched');
  await expect(card).toContainText('Not launched yet');
  await expect(card).toContainText('Carrier');
  await expect(card).toContainText('OT+T · Onchain Telephone + Telegraph');
  await expect(card).toContainText('Ticker');
  await expect(card).toContainText('OTT');
  await expect(card).toContainText('last week’s creator tax, split by every wallet’s share of the circulating supply');
  await expect(card).toContainText('3 places · 1, 5 and 10 GB · from $1.19');
  await expect(card).toContainText('eSIMs from nadanada, paid by Lightning');
  await expect(card).toContainText('pre-graduation');
  await expect(card).toContainText('USDG');
  // esim.js has no launchpad route of its own on this site, so the not-launched card sends a
  // holder to whatever.fun's launch form instead — a new tab, labelled honestly as a departure.
  const launchLink = card.locator('a[href="https://whatever-fun.vercel.app/#/new"]');
  await expect(launchLink).toHaveText('Launch the coin on whatever.fun');
  await expect(launchLink).toHaveAttribute('target', '_blank');
  await expect(launchLink).toHaveAttribute('rel', 'noopener');
  // Nothing about a wallet before there is a coin, no chain read, and no pool card either.
  await expect(page.locator('.data-mine')).toHaveCount(0);
  await expect(page.locator('.data-pool')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the plan catalogue, how-it-works and coverage render from config alone, the same before or after launch', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  // No budget has been published for an unlaunched coin — the same shape scripts/allowances.js
  // writes for one, per plan-contract.md — so the plan cards' "OTT this week" line cannot be
  // computed and must fall back to the coverage fact alone rather than inventing a number.
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');

  // Trust row: five checkable claims, two of them read straight off this fixture's own catalogue.
  const trust = page.locator('.trust-item');
  await expect(trust).toHaveCount(5);
  await expect(trust).toContainText([
    '3 places on the menu', 'eSIMs from $1.19', 'No trading required — holding is all it takes',
    'No app, no SIM swap, no contract', 'Paid over Bitcoin Lightning — no person in the loop',
  ]);

  // The plan picker opens on the first place (Europe), grouped into the same two optgroups the
  // catalogue's kinds imply — one region for each of Europe and Global, one country for Germany.
  const picker = page.locator('#plan-place');
  await expect(picker.locator('optgroup[label="Regions"] option')).toHaveCount(2);
  await expect(picker.locator('optgroup[label="Countries"] option')).toHaveCount(1);
  // Germany's option carries its flag; the two regions do not.
  await expect(picker.locator('option', { hasText: 'Germany' })).toHaveText('🇩🇪 Germany');
  await expect(picker.locator('option', { hasText: 'Europe' })).toHaveText('Europe');

  // Europe sells one size in this fixture, so its one card is not "featured" — that badge only
  // means something when there is a second size in the running to lose to.
  const grid = page.locator('.plan-grid');
  await expect(grid.locator('.plan-card')).toHaveCount(1);
  await expect(grid.locator('.plan-card.featured')).toHaveCount(0);
  await expect(grid.locator('.plan-size')).toHaveText('1 GB');
  await expect(grid.locator('.plan-price')).toHaveText('$1.19');
  await expect(grid.locator('.plan-term')).toHaveText('7 days');
  await expect(grid.locator('.plan-meta')).toContainText('38 countries');
  await expect(grid.locator('.plan-meta')).not.toContainText('OTT this week');
  await expect(grid.getByRole('link', { name: 'Get this eSIM' })).toHaveAttribute('href', '#your-data');

  // Switching the place repaints the grid: Germany sells three sizes, and the honestly-computed
  // best deal is the 10 GB one (80¢/GB against 5 GB's ~$1.00 and 1 GB's $1.99) — not whichever
  // card happens to sit in the middle.
  await picker.selectOption('germany');
  await expect(grid.locator('.plan-card')).toHaveCount(3);
  await expect(grid.locator('.plan-card.featured')).toHaveCount(1);
  const featured = grid.locator('.plan-card.featured');
  await expect(featured.locator('.plan-size')).toHaveText('10 GB');
  await expect(featured.locator('.plan-price')).toHaveText('$7.99');
  await expect(featured.locator('.plan-badge')).toHaveText('Most data per dollar');
  await expect(grid).toContainText('$1.99');
  await expect(grid).toContainText('$4.99');
  await expect(grid.locator('.plan-meta').first()).toContainText('DE');

  // How it works: three plain steps, numbered. Step 1 is the mechanism (holding, no brand
  // needed); step 2 names this fixture's own brand for the week's budget; step 3 is redemption.
  const steps = page.locator('.step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0).locator('.step-n')).toHaveText('1');
  await expect(steps.nth(0).locator('.step-title')).toHaveText('Hold OTT');
  await expect(steps.nth(0).locator('.step-body')).toContainText('holding is the whole mechanism');
  await expect(steps.nth(1).locator('.step-n')).toHaveText('2');
  await expect(steps.nth(1).locator('.step-body')).toContainText('OT+T’s trades');
  await expect(steps.nth(1).locator('.step-body')).toContainText('share of the circulating supply');
  await expect(steps.nth(2).locator('.step-n')).toHaveText('3');
  await expect(steps.nth(2).locator('.step-body')).toContainText('nadanada');
  await expect(steps.nth(2).locator('.step-body')).toContainText('scan the QR at the airport');
  await expect(steps.nth(2).locator('.step-body')).toContainText('does not carry over');

  // Coverage: every place in the catalogue, once each, with its cheapest shelf price (not its
  // cheapest per-gigabyte price — Germany's cheapest entry is 1 GB at $1.99, even though 10 GB is
  // the better deal per gigabyte).
  const cov = page.locator('.cov-item');
  await expect(cov).toHaveCount(3);
  await expect(cov.filter({ hasText: 'Europe' })).toContainText('from $1.19');
  await expect(cov.filter({ hasText: 'Global' })).toContainText('from $8.99');
  const deItem = cov.filter({ hasText: 'Germany' });
  await expect(deItem).toContainText('from $1.99');
  await expect(deItem.locator('.cov-flag')).toHaveText('🇩🇪');

  expect(errors).toEqual([]);
});

test('the plan cards say how much OTT a wallet would need to hold to cover each package this week', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  // A real, currently-published budget — the one thing the previous test's fixture deliberately
  // left at zero — so tokensToCover() has something to divide by.
  await stubAllowances(page, {});
  await page.route('**/api/redeem**', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'no api in this test' }));

  await page.goto('/index.html#/');
  const grid = page.locator('.plan-grid');
  // Europe, 1 GB at $1.19 — priceUsd × circulating ÷ budgetUsd, the same arithmetic the page uses.
  await expect(grid.locator('.plan-meta')).toContainText('needs ≈ ' + needStr(1.19) + ' OTT this week');

  await page.locator('#plan-place').selectOption('germany');
  // The featured 10 GB Germany package costs more dollars than the 1 GB one, so it also needs more
  // OTT to cover — proving this reads the package's own price, not a fixed figure repeated per card.
  const featured = grid.locator('.plan-card.featured');
  await expect(featured.locator('.plan-meta')).toContainText('needs ≈ ' + needStr(7.99) + ' OTT this week');
  const oneGb = grid.locator('.plan-card').filter({ has: page.locator('.plan-size', { hasText: '1 GB' }) });
  await expect(oneGb.locator('.plan-meta')).toContainText('needs ≈ ' + needStr(1.99) + ' OTT this week');
  expect(errors).toEqual([]);
});

test('a config with no brand block renders exactly as it did before the brand existed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED_NO_BRAND);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');
  // The hero itself names no brand, so it renders identically either way; only the how-it-works
  // band's second step, which names whoever runs the curve, falls back to the generic wording.
  await expect(page.locator('#view h1')).toHaveText('Mobile data in 28 places, just for holding OTT.');
  await expect(page.locator('.step-body').nth(1)).toContainText('the coin’s trades');
  await expect(page.locator('.step-body').nth(1)).not.toContainText('OT+T');
  const card = page.locator('.data-notlaunched');
  await expect(card).toContainText('Not launched yet');
  await expect(card).not.toContainText('Carrier');
  await expect(card).not.toContainText('Ticker');
  expect(errors).toEqual([]);
});

test('the nav lists exactly three routes, home first, and highlights the active one', async ({ page }) => {
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });
  await page.goto('/index.html#/');
  const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => a.dataset.route));
  expect(links).toEqual(['home', 'status', 'about']);
  await expect(page.locator('#nav a[data-route="home"]')).toHaveClass(/active/);
});

test('once launched, the treasury and pool are read from the chain, and a wallet-less visitor is invited rather than thrown at', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, {});
  await stubTreasury(page, {
    asOf: 1789396369, treasury: TREASURY, escrowClaimableUsd: 1234.56, walletUsd: 67.89,
    reseller: { name: 'nadanada', balanceUsd: 412, sats: 734521, asOf: 1789396369 },
    spend30dUsd: 10.44, redemptions30d: 4, perDayUsd: 0.35, runwayDays: 1177,
    lastClaim: { at: 1789300000, kind: 'usdg', amount: 41.7, txHash: '0xabc' }, status: 'funded',
  });

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('Mobile data in 28 places, just for holding OTT.');
  // With a wallet available (stubNetwork does not add one, but the redeem flow test below does;
  // here there is none), the hero still offers to connect rather than assuming one.
  await expect(page.locator('.hero-actions').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  // The programme's own numbers are supporting detail, painted last — below the wallet section
  // this visitor has not connected to yet, not beside it.
  await expect(page.locator('#programme .section-head')).toContainText('The programme’s numbers');
  // The pool card: the Lightning wallet's balance, published, with one word on it.
  const pool = page.locator('.data-pool');
  await expect(pool).toContainText('FUNDED');
  await expect(pool).toContainText('Pool balance');
  await expect(pool).toContainText('$412.00');
  await expect(pool).toContainText('in the Lightning wallet that pays nadanada');
  await expect(pool).toContainText('734,521 sats');
  await expect(pool).toContainText('1,177 days');
  await expect(pool).toContainText('4 eSIMs redeemed');
  await expect(pool).toContainText('$41.70 USDG out of the escrow');
  await expect(pool).toContainText('sits in a Lightning wallet, off chain');
  await expect(pool).toContainText('holds $67.89 USDG');
  const tiles = page.locator('.data-tiles').first();
  await expect(tiles).toContainText('$1,234.56');              // escrow.balanceOfToken(treasury, USDG)
  await expect(tiles).toContainText('1,545 GB');                // ÷ Germany's $0.80/GB (10 GB for $7.99)
  await expect(tiles).toContainText('$0.80/GB (Germany · 10 GB)');
  await expect(tiles).toContainText('137 GB global');           // ÷ Global's $8.99/GB
  await expect(tiles).toContainText('10%');                     // creatorTaxBps
  await expect(tiles).toContainText('$50.00 still held');       // creatorTaxBalance
  await expect(tiles).not.toContainText('Rebate');               // the rebate tile is retired
  await expect(page.locator('.data-progress')).toContainText('$3,000.00 of $10,000.00');
  await expect(page.locator('.data-progress')).toContainText('30% of the way');

  // Chromium has no window.ethereum, so this is the wallet-less path.
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Connect a wallet');
  await expect(mine).toContainText('refreshes every Monday');
  await expect(mine.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(mine).not.toContainText('Could not');
  await expect(mine.locator('.dh-tile')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with a wallet, the dashboard leads with what it holds and what that buys, then the redeem flow renders the QR and the activation code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);

  // 1,234 OTT of 812,345.678 circulating is a 0.152% share — matching plan-contract.md's own
  // worked example — and $20.00 of allowance floors to 25 GB at Germany's ~80¢/GB, 2 GB at
  // Global's $8.99/GB, the same "≈ N GB place · M GB place" spread the plan cards already use.
  await stubAllowances(page, { wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } } });

  const past = {
    n: 0, transactionId: 'ott-' + 'a'.repeat(32), packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99, week: CUR_WEEK,
    qrCodeUrl: './qr-old.png', ac: 'LPA:1$old.example$OLD', iccid: '8900000000000000001',
    createdAt: '2026-09-01T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp-old.example', matchingId: 'OLD-MATCH',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=old', androidInstallUrl: 'https://nadanada.me/install/android/old',
    note: '',
  };
  const fresh = {
    n: 1, transactionId: 'ott-' + 'b'.repeat(32), packageCode: 'fixed_5GB_30D_DE', priceUsd: 4.99, week: CUR_WEEK,
    qrCodeUrl: '', ac: 'LPA:1$smdp.nadanada.me$MATCH-123', iccid: '8900000000000000002',
    createdAt: '2026-09-14T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp.nadanada.me', matchingId: 'MATCH-123',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=1', androidInstallUrl: 'https://nadanada.me/install/android/1',
    note: '',
  };
  const redactCodes = (o) => Object.assign({}, o, { qrCodeUrl: '', ac: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', codes: false });
  const withCodes = (o) => Object.assign({}, o, { codes: true });
  const standingShape = (extra) => Object.assign({
    ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
    tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20, decimals: 18,
    history: [],
  }, extra);

  const posts = [];
  // The redeem this test drives creates order #1, so a signed read made after it sees both orders;
  // `redeemed` is this route's own memory of whether that has happened yet, the way the real
  // endpoint's memory is the provider's order history.
  let redeemed = false;
  await page.route('**/api/redeem**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      expect(new URL(req.url()).searchParams.get('address')).toBe(ADDR);
      await route.fulfill(json(standingShape({ redeemedUsd: 1.99, remainingUsd: 18.01, orders: [redactCodes(past)] })));
      return;
    }
    const reqBody = JSON.parse(req.postData());
    posts.push(reqBody);
    if (reqBody.packageCode) {
      // A redeem names its slot; recording it here and asserting afterward keeps a failed
      // expectation from being swallowed as a route error.
      redeemed = true;
      await route.fulfill(json({ ok: true, order: withCodes(fresh), remainingUsd: 13.02 }));
      return;
    }
    // A signed read: the standing again, with codes this time.
    const orders = redeemed ? [withCodes(past), withCodes(fresh)] : [withCodes(past)];
    await route.fulfill(json(standingShape({ redeemedUsd: redeemed ? 6.98 : 1.99, remainingUsd: redeemed ? 13.02 : 18.01, orders })));
  });

  // This test is about the wallet panel, not the pool card, so treasury.json is stubbed away as
  // missing (404) rather than left to whatever a real scripts/treasury.js run may have written to
  // disk in this checkout.
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'no treasury reading' }));

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await expect(page.locator('.data-pool')).toHaveCount(0);

  // The two headline figures the founder asked for, first in the DOM and biggest on the page.
  const headline = mine.locator('.dh-tile');
  await expect(headline).toHaveCount(2);
  await expect(headline.nth(0)).toContainText('OTT held');
  await expect(headline.nth(0)).toContainText('1,234 OTT');
  await expect(headline.nth(0)).toContainText('0.152%');
  await expect(headline.nth(1)).toContainText('Data this week');
  await expect(headline.nth(1)).toContainText('25 GB');
  await expect(headline.nth(1)).toContainText('≈ 25 GB Germany · 2 GB Global');
  // The very first figure in the panel is a headline tile, not one of the compact supporting ones —
  // the "big number first" the founder asked for, not a grid of equal-weight tiles.
  await expect(mine.locator('.dh-tile, .u-tile, .stat-tile').first()).toHaveClass(/dh-tile/);

  // Used and left, in the same units as the headline (GB, at the same cheapest rate), with the
  // dollar figures — the ledger's real unit — kept as the honest sub-caption underneath.
  const tiles = mine.locator('.data-tiles');
  await expect(tiles).toContainText('Used this week');
  await expect(tiles).toContainText('2 GB');
  await expect(tiles).toContainText('$1.99 redeemed');
  await expect(tiles).toContainText('Left this week');
  // 23, not the 22 that flooring $18.01 on its own would give: the three GB figures on screen have
  // to add up, because a reader who subtracts 2 from 25 and gets 22 reads it as a bug. So "left" is
  // what remains of the headline after "used", and the dollars underneath stay exact.
  await expect(tiles).toContainText('23 GB');
  await expect(tiles).toContainText('$18.01 left to spend');
  // textContent, not innerText: the tile labels are uppercased by CSS, and innerText returns the
  // transformed text while every assertion above matches the source casing.
  const after = (text, label) => Number((text.split(label)[1] || '').match(/(\d+)\s*GB/)[1]);
  const tileText = await tiles.textContent();
  const headlineGb = Number((await mine.locator('.dh-tile').nth(1).textContent()).match(/(\d+)\s*GB/)[1]);
  expect(after(tileText, 'Used this week') + after(tileText, 'Left this week')).toBe(headlineGb);
  await expect(tiles).toContainText('Your share');
  await expect(tiles).toContainText('0.152%');
  await expect(tiles).toContainText('Resets in');
  // Days and hours to the exact second this assertion runs — proving the tile reads the real
  // countdown from weekEnd, not a placeholder — computed with the page's own arithmetic so a few
  // milliseconds of test time cannot make this flaky.
  await expect(tiles).toContainText(fmtCountdownLike(CUR_WEEK_END));
  await expect(tiles).toContainText('does not carry over');

  // The past order came from a plain GET, so its SIM card is listed but redacted: no code, no QR,
  // no install links, no manual line — only what was never gated (name, price, ICCID) shows. This
  // fixture names no `sims` and no `topupOf` (the shape written before nadanada tracked a standing
  // profile), so the past order is its own eSIM, exactly as one order always was.
  await expect(mine).toContainText('YOUR ESIM');
  const pastCard = mine.locator('.data-sim').filter({ hasText: '8900000000000000001' });
  await expect(pastCard).toHaveCount(1);
  await expect(pastCard).toContainText('Germany · 1 GB · 7 days');
  await expect(pastCard).toContainText('$1.99');
  await expect(pastCard).toContainText('8900000000000000001');
  await expect(pastCard.locator('.data-ac')).toHaveText('—');
  await expect(pastCard.locator('img.data-qr')).toHaveCount(0);
  await expect(pastCard.locator('.data-install')).toHaveCount(0);
  await expect(pastCard).not.toContainText('SM-DP+');

  // "Show my eSIM codes" signs in once and asks for the same standing again, this time signed —
  // the past order's card repaints in place with its code, its QR and both fallbacks.
  await mine.getByRole('button', { name: 'Show my eSIM codes' }).click();
  await expect(pastCard.locator('.data-ac')).toHaveText('LPA:1$old.example$OLD');
  await expect(pastCard.locator('img.data-qr')).toHaveAttribute('src', /qr-old\.png$/);
  await expect(pastCard).toContainText('SM-DP+');
  await expect(pastCard).toContainText('smdp-old.example');
  await expect(pastCard).toContainText('OLD-MATCH');
  await expect(pastCard.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', 'https://esimsetup.apple.com/es?a=old');
  await expect(pastCard.getByRole('link', { name: 'Install on Android' })).toHaveAttribute('href', 'https://nadanada.me/install/android/old');

  // The place select groups regions and countries, and opens on the first place's smallest size.
  await expect(mine.locator('#f-place optgroup[label="Regions"] option')).toHaveCount(2);
  await expect(mine.locator('#f-place optgroup[label="Countries"] option')).toHaveCount(1);
  await expect(mine.getByRole('button', { name: 'Redeem Europe · 1 GB — $1.19' })).toBeVisible();

  // Changing the place repaints the sizes and re-picks the smallest; clicking a size updates the
  // hidden input, marks itself active, and the Redeem button follows whichever is picked.
  await mine.locator('#f-place').selectOption('germany');
  await expect(mine.getByRole('button', { name: 'Redeem Germany · 1 GB — $1.99' })).toBeVisible();
  await mine.locator('.data-sizes button[data-code="fixed_5GB_30D_DE"]').click();
  await expect(mine.locator('#f-package')).toHaveValue('fixed_5GB_30D_DE');
  await expect(mine.locator('.data-sizes button[data-code="fixed_5GB_30D_DE"]')).toHaveClass(/active/);
  await mine.getByRole('button', { name: 'Redeem Germany · 5 GB — $4.99' }).click();

  // A fresh claim that names no top-up mints its own eSIM, so it is the SIM card itself — not just
  // a bundle row — that gets the "this is new" treatment.
  const card = mine.locator('.data-sim.fresh');
  await expect(card).toBeVisible();
  await expect(card.locator('img.data-qr')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(card.locator('.data-ac')).toHaveText('LPA:1$smdp.nadanada.me$MATCH-123');
  await expect(card).toContainText('Germany · 5 GB · 30 days');
  await expect(card).toContainText('$4.99');
  // The one-tap install links and the manual SM-DP+/matching-id fallback both render when
  // nadanada sent them.
  await expect(card.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', 'https://esimsetup.apple.com/es?a=1');
  await expect(card.getByRole('link', { name: 'Install on Android' })).toHaveAttribute('href', 'https://nadanada.me/install/android/1');
  await expect(card).toContainText('SM-DP+');
  await expect(card).toContainText('smdp.nadanada.me');
  await expect(card).toContainText('MATCH-123');
  // The balance the API answered with, not one the page worked out for itself — and the signed
  // read that followed the redeem carried the past order's code too, with no extra click needed.
  await expect(mine.locator('.data-tiles')).toContainText('$13.02 left to spend');
  await expect(mine.locator('.data-tiles')).toContainText('$6.98 redeemed');
  await expect(pastCard.locator('.data-ac')).toHaveText('LPA:1$old.example$OLD');

  // The redeem named the slot it was filling: this wallet had 1 order, so n is 1.
  const redeemPost = posts.find((p) => p.packageCode);
  expect(redeemPost.address).toBe(ADDR);
  expect(redeemPost.packageCode).toBe('fixed_5GB_30D_DE');
  expect(redeemPost.n).toBe(1);
  // Two signed reads happened — "Show my eSIM codes", and the one that followed the redeem — plus
  // the redeem itself, three signed calls in all.
  const readPosts = posts.filter((p) => !p.packageCode);
  expect(readPosts).toHaveLength(2);

  // What was signed, and what each signature authorises. A redemption's message names the plan
  // and the slot, so it is spent on that one order and can never be walked across the week; a
  // read's names neither and is reused while it is fresh, which is why three calls cost two
  // signatures rather than three. Both are written to be read in a wallet prompt.
  expect(posts).toHaveLength(3);
  const reads = posts.filter((p) => !p.packageCode);
  expect(reads).toHaveLength(2);
  expect(new Set(reads.map((p) => p.signature)).size).toBe(1);
  expect(redeemPost.signature).toBe('0x' + 'ab'.repeat(65));
  expect(redeemPost.message).not.toBe(reads[0].message);

  const lines = redeemPost.message.split('\n');
  expect(lines[0]).toBe('OT+T — authorise a data redemption');
  expect(lines).toContain('Wallet: ' + ADDR);
  expect(lines).toContain('Plan: fixed_5GB_30D_DE');
  expect(lines).toContain('Slot: 1');
  const site = lines.find((l) => l.startsWith('Site: '));
  expect(site).toMatch(/^Site: 127\.0\.0\.1:\d+$/);
  const issued = Number((lines.find((l) => l.startsWith('Issued: ')) || '').slice(8));
  expect(Math.abs(issued - Math.floor(Date.now() / 1000))).toBeLessThan(60);

  const readLines = reads[0].message.split('\n');
  expect(readLines[0]).toBe('OT+T — show my eSIM codes');
  expect(readLines.some((l) => l.startsWith('Plan: '))).toBe(false);

  const signs = await page.evaluate(() => window.__eth.filter((c) => c.method === 'personal_sign'));
  expect(signs).toHaveLength(2);
  expect(signs.every((c) => c.params[1] === ADDR)).toBe(true);
  const hex = '0x' + Buffer.from(redeemPost.message, 'utf8').toString('hex');
  expect(signs.map((c) => c.params[0])).toContain(hex);
  expect(errors).toEqual([]);
});

test('a wallet that holds nothing is told so directly, and pointed at where to get OTT', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);
  await stubAllowances(page, { wallets: {} }); // this wallet is not in the map at all
  await page.route('**/api/redeem**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill(json({
        ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
        tokens: '0', share: 0, allowanceUsd: 0, decimals: 18,
        redeemedUsd: 0, remainingUsd: 0, orders: [], history: [],
      }));
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'unused in this test' });
  });

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('This wallet holds no OTT, so it has no data this week.');
  const buy = mine.locator('a[href="https://whatever-fun.vercel.app/#/new"]');
  await expect(buy).toHaveText('Get OTT on whatever.fun');
  await expect(buy).toHaveAttribute('target', '_blank');
  // Nothing to redeem, so no dashboard, no redeem form, no orders list.
  await expect(mine.locator('.dh-tile')).toHaveCount(0);
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  await expect(mine).not.toContainText('Data this week');
  expect(errors).toEqual([]);
});

test('a week whose allowance has not been published yet says so, with the week it is showing and when it refreshes — not a zero that looks like a verdict', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);
  const lastWeek = CUR_WEEK - 1;
  // The indexer file is one week behind — still carrying last week's real figures — and
  // /api/redeem, reading that same file, answers with the CURRENT week, stale:true, and a
  // deliberately zeroed allowance and remaining balance: it is honestly saying "not indexed yet",
  // not "this wallet has nothing". `allowancesWeek` names exactly which week it did read.
  await stubAllowances(page, {
    week: lastWeek, weekStart: weekStartOf(lastWeek), weekEnd: weekEndOf(lastWeek),
    wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } },
  });
  await page.route('**/api/redeem**', (route) => route.fulfill(json({
    ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END, stale: true, allowancesWeek: lastWeek,
    tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 0, decimals: 18,
    redeemedUsd: 0, remainingUsd: 0, orders: [], history: [],
  })));

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('has not been published yet');
  await expect(mine).toContainText('the week that ended ' + fmtDate(weekEndOf(lastWeek)));
  await expect(mine).toContainText('every half hour');
  // The last-published week's own numbers still render underneath the notice — the file's real
  // $20.00 allowance (25 GB, used the exact same way the ordinary dashboard test checks it), not
  // the API's own protective zero.
  await expect(mine.locator('.dh-tile').first()).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('25 GB');
  await expect(mine.locator('.data-tiles')).toContainText('$20.00 left to spend');
  expect(errors).toEqual([]);
});

test('the "Resets in" tile counts down live, without a repaint', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  const fixed = new Date('2026-09-16T12:00:00Z');
  await page.clock.install({ time: fixed });
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);
  const week = weekOf(Math.floor(fixed.getTime() / 1000));
  // 46 minutes from the frozen "now" — close enough that a 90-second jump crosses a whole minute
  // boundary, far enough that it does not also cross an hour boundary and change format.
  const weekEnd = Math.floor(fixed.getTime() / 1000) + 46 * 60;
  await stubAllowances(page, { week, weekStart: weekStartOf(week), weekEnd, wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } } });
  await page.route('**/api/redeem**', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'unused in this test' }));

  await page.goto('/index.html#/');
  const tiles = page.locator('.data-mine .data-tiles');
  await expect(tiles).toContainText('46m');
  // No repaint happens here — this is the same DOM node's own interval tick moving the clock
  // forward, not a fresh render triggered by anything this test does.
  await page.clock.fastForward(90 * 1000);
  await expect(tiles).toContainText('45m');
  expect(errors).toEqual([]);
});

test('when the redeem API cannot be reached, what the indexer last published still shows; redeeming and this week’s orders do not', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);
  await stubAllowances(page, { wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } } });
  // No route for /api/redeem: the static test server answers 404 with a text body, which is also
  // what a static host without the function deployed would do.

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Could not reach the redeem API');
  // What the indexer's own file says is still shown: the holding, the share, this week's GB.
  await expect(mine.locator('.dh-tile').nth(0)).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('25 GB');
  // Used/left cannot be known without the API — said as unknown, not shown as zero.
  await expect(mine.locator('.data-tiles')).toContainText('not known');
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Show my eSIM codes' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a bundle claimed in a previous week is still shown, filed under its eSIM and tagged with the week that claimed it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubWallet(page);
  await stubAllowances(page, { wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } } });
  const oldWeek = CUR_WEEK - 2;
  const history = [{
    n: 0, week: oldWeek, transactionId: 'ott-' + 'c'.repeat(32), packageCode: 'fixed_1GB_7D_EUROPE', priceUsd: 1.19,
    qrCodeUrl: '', ac: '', iccid: '8900000000000000009', createdAt: '2026-08-20T00:00:00Z',
    pending: false, stage: 'done', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', note: '', codes: false,
  }];
  await page.route('**/api/redeem**', (route) => route.fulfill(json({
    ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
    tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20, decimals: 18,
    redeemedUsd: 0, remainingUsd: 20, orders: [], history,
  })));

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  // Nothing was claimed this week, only two weeks ago — but the eSIM that bundle minted is still
  // the one SIM card shown, with that one bundle listed underneath and tagged with its own week,
  // because an eSIM already issued does not disappear once the week that paid for it rolls.
  await expect(mine).toContainText('YOUR ESIM');
  const simCard = mine.locator('.data-sim');
  await expect(simCard).toHaveCount(1);
  await expect(simCard).toContainText('8900000000000000009');
  await expect(simCard.locator('.data-bundle')).toHaveCount(1);
  await expect(simCard).toContainText('Week of ' + fmtDate(weekStartOf(oldWeek)));
  await expect(simCard).toContainText('Europe · 1 GB · 7 days');
  expect(errors).toEqual([]);
});
