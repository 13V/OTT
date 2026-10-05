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

// Three places across five wholesale packages, at real catalogue prices. Europe and Global each
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
const base = { pair: USDG, taxBps: 1000, budgetBps: 10000, provider: 'wholesale', packages: PACKAGES, brand: BRAND };
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

test('before launch, home explains the mechanism and availability', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-hero-sub')).toContainText('Weekly data credit for eligible OTT holders.');
  await expect(page).toHaveTitle('OT+T — a memecoin with a data plan');
  await expect(page.locator('.ott-station')).toHaveCount(4);
  await expect(page.locator('.ott-station h3')).toHaveText(['OTT trades fund the data.', 'The weekly budget is set.', 'He checks his weekly credit.', 'He gets online in Tokyo.']);
  await expect(page.locator('.ott-hero-actions').getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '#how-it-works');
  await expect(page.locator('.ott-hero-actions').getByRole('link', { name: 'Check launch status' })).toHaveAttribute('href', '#/status');
  await expect(page.locator('.ott-hero-note')).toContainText('Prelaunch');
  await expect(page.locator('.ott-hero-note')).toContainText('not available yet');
  await expect(page.locator('.ott-journey-note')).toContainText('no weekly holder credit');
  await expect(page.locator('.ott-faq')).toContainText('Buying today does not establish eligibility for the current week');
  await expect(page.getByRole('link', { name: 'Launch the coin on whatever.fun' })).toHaveCount(0);
  await expect(page.locator('.data-mine')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('coverage leads with a supported place and reveals actual plans from config without a wallet', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  // No budget has been published for an unlaunched coin — the same shape scripts/allowances.js
  // writes for one, per plan-contract.md — so the plan cards' "OTT this week" line cannot be
  // computed and must fall back to the coverage fact alone rather than inventing a number.
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');

  await expect(page.locator('.ott-journey')).toContainText('From a trading screen to a Tokyo street.');
  await expect(page.locator('.ott-station')).toContainText(['Trading itself does not earn data credit', 'Last week’s collected tax', 'weekly balance check', 'He can use available credit']);

  // This fixture lacks both the US and Japan, so coverage starts with its first valid place.
  const picker = page.locator('#plan-place');
  const details = page.locator('.ott-plan-details');
  await expect(page.locator('.ott-coverage-result')).toContainText('Europe');
  await expect(page.locator('.ott-coverage-availability')).toHaveText('1 package available for use in Europe.');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(picker).toBeHidden();
  await expect(page.locator('.plan-grid')).toBeHidden();
  await expect(page.locator('.ott-ticket, .ott-package-button, .ott-terminal-art')).toHaveCount(0);
  await details.getByText('View available plans', { exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(picker.locator('optgroup[label="Regions"] option')).toHaveCount(2);
  await expect(picker.locator('optgroup[label="Countries"] option')).toHaveCount(1);
  // The native picker uses clear country names; flags belong to the airport board.
  await expect(picker.locator('option', { hasText: 'Germany' })).toHaveText('Germany');
  await expect(picker.locator('option', { hasText: 'Europe' })).toHaveText('Europe');

  // Europe sells one size in this fixture, which is the selected package.
  const grid = page.locator('.plan-grid');
  await expect(grid.locator('.plan-card')).toHaveCount(1);
  await expect(grid.locator('.plan-card.featured')).toHaveCount(1);
  await expect(grid.locator('.plan-size')).toHaveText('1 GB');
  await expect(grid.locator('.plan-price')).toHaveText('$1.19');
  await expect(grid.locator('.plan-term')).toHaveText('7 days of data');
  await expect(grid.locator('.plan-meta')).toContainText('38 countries');
  await expect(grid.locator('.plan-meta')).not.toContainText('OTT this week');
  await expect(grid.getByRole('link', { name: 'Check launch status' })).toHaveAttribute('href', '#/status');
  await expect(grid.locator('.plan-credit-label')).toHaveText('DATA CREDIT REQUIRED');

  // Switching place keeps the coverage result and public packages in agreement.
  await picker.selectOption('germany');
  await expect(grid.locator('.plan-card')).toHaveCount(3);
  await expect(grid.locator('.plan-card.featured')).toHaveCount(1);
  const featured = grid.locator('.plan-card.featured');
  await expect(featured.locator('.plan-size')).toHaveText('5 GB');
  await expect(featured.locator('.plan-price')).toHaveText('$4.99');
  await expect(page.locator('.ott-coverage-result')).toContainText('Germany');
  await expect(page.locator('.ott-coverage-availability')).toHaveText('3 packages available for use in Germany.');
  await expect(grid).toContainText('$1.99');
  await expect(grid).toContainText('$4.99');
  await expect(grid.locator('.plan-meta').first()).toContainText('DE');

  await expect(page.locator('.ott-station')).toHaveCount(4);
  await expect(page.locator('.ott-allocation')).toContainText('weekly balance check');

  // The optional coverage directory lists each configured place once; prices stay with plans.
  const cov = page.locator('.cov-item');
  await expect(page.locator('#coverage')).not.toHaveAttribute('open', '');
  await page.locator('.coverage-details summary').click();
  await expect(cov).toHaveCount(3);
  const regions = page.locator('.ott-coverage-group').filter({ has: page.getByRole('heading', { name: 'Regions', exact: true }) });
  const countries = page.locator('.ott-coverage-group').filter({ has: page.getByRole('heading', { name: 'Countries', exact: true }) });
  await expect(regions).toContainText('Europe');
  await expect(regions).toContainText('Global');
  await expect(countries).toContainText('Germany');
  const deItem = cov.filter({ hasText: 'Germany' });
  await expect(deItem.locator('.cov-flag')).toHaveAttribute('src', './assets/flags/de.svg');

  expect(errors).toEqual([]);
});

test('the public catalogue stays browsable when a weekly allocation is unavailable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  // Account budget data does not gate reading actual packages.
  await stubAllowances(page, {});
  await page.route('**/api/redeem**', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'no api in this test' }));

  await page.goto('/index.html#/');
  await expect(page.locator('.ott-plan-details')).not.toHaveAttribute('open', '');
  await page.locator('.ott-plan-details summary').click();
  const grid = page.locator('.plan-grid');
  await expect(grid.locator('.plan-price')).toHaveText('$1.19');

  await page.locator('#plan-place').selectOption('germany');
  await expect(grid.locator('.plan-card')).toHaveCount(3);
  await expect(grid.locator('.plan-price')).toHaveText(['$1.99', '$4.99', '$7.99']);
  await expect(grid.getByRole('link', { name: 'Select this plan' })).toHaveCount(3);
  await expect(page.locator('.ott-coverage-result')).toContainText('Germany');
  await expect(page.locator('.data-mine')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a config with no brand block renders exactly as it did before the brand existed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED_NO_BRAND);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });

  await page.goto('/index.html#/');
  // A missing optional brand block does not break the public story or catalogue.
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-station')).toHaveCount(4);
  await expect(page.locator('.ott-journey-note')).toContainText('Prelaunch');
  expect(errors).toEqual([]);
});

test('the nav exposes destinations, explanation, account, and status', async ({ page }) => {
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, { coin: '', curve: '', budgetUsd: 0, budgetSource: '', circulating: '0', holders: 0 });
  await page.goto('/index.html#/');
  const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => a.textContent));
  expect(links).toEqual(['The idea', 'Destinations', 'My data', 'Status', 'Open app']);
  await expect(page.locator('#nav a[data-route="home"]')).toHaveClass(/active/);
});

test('once launched, the public page routes holders to My data and keeps operational figures on Status', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, {});

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-hero-note')).toContainText('Weekly credit depends');
  await expect(page.locator('.ott-account-preview').getByRole('link', { name: 'Open My data' })).toHaveAttribute('href', '#/data');
  await expect(page.locator('#programme')).toHaveCount(0);
  await page.locator('.ott-account-preview').getByRole('link', { name: 'Open My data' }).click();
  await expect(page.locator('.data-mine')).toContainText('No browser wallet detected');
  await expect(page.locator('.data-mine').getByRole('button', { name: 'Connect wallet' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('with a wallet, the dashboard leads with what it holds and what that buys, then the redeem flow renders the QR and the activation code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await page.addInitScript((addr) => {
    window.__eth = [];
    window.ethereum = { request: async ({ method, params }) => {
      window.__eth.push({ method, params });
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'personal_sign') {
        const bytes = params[0].slice(2).match(/.{2}/g).map(byte => parseInt(byte, 16));
        const message = new TextDecoder().decode(new Uint8Array(bytes));
        return '0x' + (message.includes('authorise a data redemption') ? 'ab' : 'cd').repeat(65);
      }
      return null;
    } };
  }, ADDR);

  // 1,234 OTT of 812,345.678 circulating is a 0.152% share — matching plan-contract.md's own
  // worked example — and $20.00 of allowance floors to 25 GB at Germany's ~80¢/GB, 2 GB at
  // Global's $8.99/GB, the same "≈ N GB place · M GB place" spread the plan cards already use.
  await stubAllowances(page, { wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } } });

  const past = {
    n: 0, transactionId: 'ott-' + 'a'.repeat(32), packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99, week: CUR_WEEK,
    qrCodeUrl: 'https://provider.fixture.example/qr-old.png', ac: 'LPA:1$old.example$OLD', iccid: '8900000000000000001',
    createdAt: '2026-09-01T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp-old.example', matchingId: 'OLD-MATCH',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=old', androidInstallUrl: 'https://provider.example/install/android/old',
    note: '',
  };
  const fresh = {
    n: 1, transactionId: 'ott-' + 'b'.repeat(32), packageCode: 'fixed_5GB_30D_DE', priceUsd: 4.99, week: CUR_WEEK,
    qrCodeUrl: '', ac: 'LPA:1$smdp.provider.example$MATCH-123', iccid: '8900000000000000002',
    createdAt: '2026-09-14T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp.provider.example', matchingId: 'MATCH-123',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=1', androidInstallUrl: 'https://provider.example/install/android/1',
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
    // The backend accepts read authorization only for a signed read.
    if (!reqBody.message.startsWith('OT+T — show my eSIM codes\n')) {
      await route.fulfill(json({ ok: false, error: 'Reading codes requires read authorization.' }, 403));
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

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await expect(page.locator('.data-pool')).toHaveCount(0);

  // The two headline figures the founder asked for, first in the DOM and biggest on the page.
  const headline = mine.locator('.dh-tile');
  await expect(headline).toHaveCount(2);
  await expect(mine.locator('.credit-summary')).toContainText('$18.01');
  await expect(headline.nth(0)).toContainText('OTT at snapshot');
  await expect(headline.nth(0)).toContainText('1,234 OTT');
  await expect(headline.nth(0)).toContainText('0.152%');
  await expect(headline.nth(1)).toContainText('Weekly allocation');
  await expect(headline.nth(1)).toContainText('$20.00');
  await expect(headline.nth(1)).toContainText('25 GB');
  await expect(headline.nth(1)).toContainText('≈ 25 GB Germany · 2 GB Global');
  // The very first figure in the panel is a headline tile, not one of the compact supporting ones —
  // the "big number first" the founder asked for, not a grid of equal-weight tiles.
  await expect(mine.locator('.dh-tile, .u-tile, .stat-tile').first()).toHaveClass(/dh-tile/);

  // Used and left, in the same units as the headline (GB, at the same cheapest rate), with the
  // dollar figures — the ledger's real unit — kept as the honest sub-caption underneath.
  const tiles = mine.locator('.data-tiles');
  await expect(tiles).toContainText('Used this week');
  await expect(tiles).toContainText('$1.99');
  await expect(tiles).toContainText('Left this week');
  // 23, not the 22 that flooring $18.01 on its own would give: the three GB figures on screen have
  // to add up, because a reader who subtracts 2 from 25 and gets 22 reads it as a bug. So "left" is
  // what remains of the headline after "used", and the dollars underneath stay exact.
  await expect(tiles).toContainText('$18.01');
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
  // fixture names no `sims` and no `topupOf` (the shape written before wholesale tracked a standing
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
  await expect(pastCard.locator('img.data-qr')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(pastCard).toContainText('SM-DP+');
  await expect(pastCard).toContainText('smdp-old.example');
  await expect(pastCard).toContainText('OLD-MATCH');
  await expect(pastCard.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', 'https://esimsetup.apple.com/es?a=old');
  await expect(pastCard.getByRole('link', { name: 'Install on Android' })).toHaveAttribute('href', 'https://provider.example/install/android/old');

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
  await expect(card.locator('.data-ac')).toHaveText('LPA:1$smdp.provider.example$MATCH-123');
  await expect(card).toContainText('Germany · 5 GB · 30 days');
  await expect(card).toContainText('$4.99');
  // The one-tap install links and the manual SM-DP+/matching-id fallback both render when
  // wholesale sent them.
  await expect(card.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', 'https://esimsetup.apple.com/es?a=1');
  await expect(card.getByRole('link', { name: 'Install on Android' })).toHaveAttribute('href', 'https://provider.example/install/android/1');
  await expect(card).toContainText('SM-DP+');
  await expect(card).toContainText('smdp.provider.example');
  await expect(card).toContainText('MATCH-123');
  // The redemption response confirms its new package and balance. It does not authorize a
  // read of every previous package's installation details.
  await expect(mine.locator('.credit-summary')).toContainText('$13.02');
  await expect(mine.locator('.data-tiles')).toContainText('$6.98');
  await expect(pastCard.locator('.data-ac')).toHaveText('—');
  await expect(pastCard.locator('.data-install')).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts.filter(p => !p.packageCode)).toHaveLength(1);
  await mine.getByRole('button', { name: 'Show my eSIM codes' }).click();
  await expect(pastCard.locator('.data-ac')).toHaveText('LPA:1$old.example$OLD');

  // The redeem named the slot it was filling: this wallet had 1 order, so n is 1.
  const redeemPost = posts.find((p) => p.packageCode);
  expect(redeemPost.address).toBe(ADDR);
  expect(redeemPost.packageCode).toBe('fixed_5GB_30D_DE');
  expect(redeemPost.n).toBe(1);
  // Both signed reads came from the holder's Show my eSIM codes action. The redemption never
  // sends its own signature to the read endpoint.
  const readPosts = posts.filter((p) => !p.packageCode);
  expect(readPosts).toHaveLength(2);
  expect(readPosts.every(p => !Object.hasOwn(p, 'n'))).toBe(true);

  // What was signed, and what each signature authorises. A redemption's message names the plan
  // and the slot, so it is spent on that one order and can never be walked across the week; a
  // read's names neither and is reused while it is fresh, which is why three calls cost two
  // signatures rather than three. Both are written to be read in a wallet prompt.
  expect(posts).toHaveLength(3);
  const reads = posts.filter((p) => !p.packageCode);
  expect(reads).toHaveLength(2);
  expect(new Set(reads.map((p) => p.signature)).size).toBe(1);
  expect(redeemPost.signature).toBe('0x' + 'ab'.repeat(65));
  expect(reads.every(p => p.signature === '0x' + 'cd'.repeat(65))).toBe(true);
  expect(reads.every(p => p.signature !== redeemPost.signature)).toBe(true);
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
  expect(readLines.some((l) => l.startsWith('Slot: '))).toBe(false);

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

  await page.goto('/index.html#/data');
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

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('has not been published yet');
  await expect(mine).toContainText('the week that ended ' + fmtDate(weekEndOf(lastWeek)));
  await expect(mine).toContainText('every half hour');
  // The last-published week's own numbers still render underneath the notice — the file's real
  // $20.00 allowance (25 GB, used the exact same way the ordinary dashboard test checks it), not
  // the API's own protective zero.
  await expect(mine.locator('.dh-tile').first()).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('$20.00');
  await expect(mine.locator('.credit-summary')).toContainText('Awaiting allocation');
  await expect(mine.locator('.data-tiles')).toContainText('Current spendable credit unavailable');
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
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

  await page.goto('/index.html#/data');
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

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Could not reach the redeem API');
  // What the indexer's own file says is still shown: the holding, the share, this week's GB.
  await expect(mine.locator('.dh-tile').nth(0)).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('$20.00');
  // Used/left cannot be known without the API — said as unknown, not shown as zero.
  await expect(mine.locator('.data-tiles')).toContainText('Redeem API unavailable');
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

  await page.goto('/index.html#/data');
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
