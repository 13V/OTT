'use strict';
/**
 * The public page (#/) and My data (#/data). The public page reads only config/esim.json; My data
 * also reads the keeper's allowances.json and /api/redeem, and asks the wallet to sign. Every one
 * of those is stubbed here, so each number the page shows is a number this file chose and the
 * assertion can name it. The states that matter: "not launched yet" (the checked-in config until
 * launch day), launched with no wallet, a member who held nothing at the snapshot, a week whose
 * allowance has not been published yet ("stale"), an unreachable API, and the ordinary case of a
 * member spending weekly credit. Each must be honest without an exception.
 */
// package.json's devDependency is @playwright/test; a sandbox with no npm install instead has the
// base `playwright` package on NODE_PATH, whose `playwright/test` subpath is the same test runner.
// Trying the real package first means a normal `npm install` changes nothing about this file.
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const { installWallet, walletAddress } = require('./support/wallet.js');
const { COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, signatureFrom } = require('./support/solana.js');

const ADDR = walletAddress();

// Week arithmetic — identical to scripts/allowances.js, site/api/_lib/week.js and site/esim.js's
// own copy, so a fixture's week is never off by one from what the page computes for itself.
// Computed from the real clock at load time (not a hardcoded week number) so this file's "current
// week" fixtures are genuinely current whenever the suite runs, and "last week" is in the past.
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
const WELCOME = { gb: 1, days: 7, maxUsd: 4 };
const TERMS = { burnUsd: 5, burnOwner: INCINERATOR, capMultiple: 3, welcome: WELCOME };
const base = { chain: 'solana', budgetBps: 8000, provider: 'wholesale', packages: PACKAGES, brand: BRAND };
// The checked-in config until launch day: the four launch fields empty.
const NOT_LAUNCHED = Object.assign({ coin: '', tokenProgram: '', treasury: '', membership: Object.assign({ burnAccount: '' }, TERMS) }, base);
const LAUNCHED = Object.assign({ coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, membership: Object.assign({ burnAccount: BURN_ACCOUNT }, TERMS) }, base);
// A config from before the brand existed — no `brand` key at all — to prove the fallback path.
const NOT_LAUNCHED_NO_BRAND = Object.assign({}, NOT_LAUNCHED);
delete NOT_LAUNCHED_NO_BRAND.brand;

// 1,234 OTT (6 decimals) is 0.152% of the members' OTT at the snapshot, and $20.00 of allowance
// floors to 25 GB at Germany's ~80¢/GB and 2 GB at Global's $8.99/GB.
const TOKENS = '1234000000';
const ROW = { tokens: TOKENS, share: 0.00152, allowanceUsd: 20, member: true };
const JOIN_UNITS = '180000000000';
const REQUIREMENT = { week: CUR_WEEK, burnTokens: '180000', burnUnits: JOIN_UNITS, priceUsd: 0.0000278 };
const SINCE = { at: NOW_S - 3 * 86400, slot: 399000000, tx: signatureFrom('data spec join') };

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });

function stubConfig(page, cfg) {
  return page.route('**/config/esim.json', (route) => route.fulfill(json(cfg)));
}
// The week's ledger as scripts/allowances.js writes it (docs/membership.md): this week's budget,
// the members' OTT at the snapshot, and `wallets` for the members sharing this week. `overrides`
// replaces top-level fields over this "healthy, currently published, nobody sharing yet" default.
function ledger(overrides) {
  return Object.assign({
    asOf: NOW_S, slot: 400000000, chain: 'solana', week: CUR_WEEK, weekStart: CUR_WEEK_START, weekEnd: CUR_WEEK_END,
    coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, treasury: TREASURY,
    budgetUsd: 412.5, budgetSource: 'creator fees collected in week ' + (CUR_WEEK - 1),
    membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, requirement: REQUIREMENT,
      requirements: { [CUR_WEEK]: JOIN_UNITS }, members: 214, cursor: null },
    members: {}, joins: {}, holders: 214, memberTokens: '812345678000', wallets: {},
  }, overrides || {});
}
// What the keeper writes before launch: no coin, no budget, no membership.
const PRELAUNCH_LEDGER = ledger({ coin: '', tokenProgram: '', treasury: '', budgetUsd: 0, budgetSource: '', membership: null, holders: 0, memberTokens: '0' });
function stubAllowances(page, file) {
  return page.route('**/data/allowances.json', (route) => route.fulfill(json(file)));
}
const memberLedger = (overrides) => ledger(Object.assign({
  members: { [ADDR]: { burned: JOIN_UNITS, since: SINCE } }, wallets: { [ADDR]: ROW },
}, overrides || {}));

/** The API's membership answer for a member in this week's split; `extra` changes any field. */
const membership = (extra) => Object.assign({
  configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, burnUsd: 5,
  requirement: REQUIREMENT, burned: JOIN_UNITS, welcome: WELCOME, capMultiple: 3, member: true, memberSince: SINCE, sharing: true,
  welcomeOrder: null, enrolment: { open: true, reason: '' },
}, extra);
const standingOf = (extra) => Object.assign({
  ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END, stale: false, allowancesWeek: CUR_WEEK,
  tokens: TOKENS, share: 0.00152, allowanceUsd: 20, decimals: 6, redeemedUsd: 0, remainingUsd: 20, poolUsd: null,
  orders: [], history: [], sims: [], membership: membership(),
}, extra);

test('before launch, home explains the mechanism and availability', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, PRELAUNCH_LEDGER);

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-hero-sub')).toContainText('Burn once to get your eSIM.');
  await expect(page.locator('.ott-hero-sub')).toContainText('Trading fees fund your data.');
  await expect(page).toHaveTitle('OT+T — a memecoin with a data plan');
  await expect(page.locator('.ott-member-enrol-copy h3, .ott-member-stop-copy h3')).toHaveText(['One burn. Your first eSIM.', 'Trading fees pay for data.', 'Members use their data credit.']);
  await expect(page.locator('.ott-hero-actions').getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '#how-it-works');
  await expect(page.locator('.ott-hero-actions').getByRole('link', { name: 'Explore the app' })).toHaveAttribute('href', '#/app');
  await expect(page.locator('.ott-hero-note')).toContainText('Enrolment is not open until launch.');
  await expect(page.locator('.ott-hero-note')).toContainText('burn about $5 of OTT once for your first eSIM');
  await expect(page.locator('.ott-hero-note')).toContainText(/enrolment.*(?:not open|closed)/i);
  await expect(page.locator('.ott-token-strip')).toContainText('Solana · pump.fun');
  await expect(page.locator('.ott-token-strip')).toContainText('Prelaunch');
  await expect(page.locator('.ott-journey-note')).toContainText('Enrolment opens when OTT launches.');
  await expect(page.locator('.ott-journey-note')).toContainText('can’t be refunded');
  await expect(page.locator('.ott-faq')).toContainText(/burn/i);
  await expect(page.locator('.data-mine')).toHaveCount(0);
  // Nothing on the page still describes the chain or launchpad this site was extracted from.
  await expect(page.locator('body')).not.toContainText(/Robinhood|USDG|whatever\.fun|MetaMask|WalletConnect|100,000 OTT/);
  expect(errors).toEqual([]);
});

test('coverage leads with a supported place and reveals actual plans from config without a wallet', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, PRELAUNCH_LEDGER);

  await page.goto('/index.html#/');

  await expect(page.locator('.ott-journey')).toContainText('Burn once. Stay connected.');
  await expect(page.locator('.ott-journey')).toContainText('No repeat burn for each top-up.');
  await expect(page.locator('.ott-journey')).toContainText('fees actually collected');
  await expect(page.locator('.ott-journey')).toContainText('80% of the fees actually collected each week');

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
  // Members' weekly credit is capped, and the plan list says so with the published multiple.
  await expect(page.locator('.ott-credit-explain')).toContainText('no member gets more than 3× the average');

  await expect(page.locator('.ott-member-enrol-copy h3, .ott-member-stop-copy h3')).toHaveCount(3);
  await expect(page.locator('.ott-allocation')).toContainText('each on average');

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
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  // Account budget data does not gate reading actual packages.
  await stubAllowances(page, ledger());
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
  await stubAllowances(page, PRELAUNCH_LEDGER);

  await page.goto('/index.html#/');
  // A missing optional brand block does not break the public story or catalogue.
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-member-enrol-copy h3, .ott-member-stop-copy h3')).toHaveCount(3);
  await expect(page.locator('.ott-journey-note')).toContainText('Prelaunch');
  expect(errors).toEqual([]);
});

test('the nav exposes destinations, explanation, account, and status', async ({ page }) => {
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
  await stubAllowances(page, PRELAUNCH_LEDGER);
  await page.goto('/index.html#/');
  const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => a.textContent));
  expect(links).toEqual(['The idea', 'Destinations', 'Trust', 'My data', 'Status', 'Open app']);
  await expect(page.locator('#nav a[data-route="home"]')).toHaveClass(/active/);
});

test('once launched, the public page routes members to My data, and without a wallet My data offers to open OT+T in one', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, ledger());

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('.ott-hero-note')).toContainText('Burn about $5 of OTT once to join.');
  await expect(page.locator('.ott-token-strip')).toContainText('Programme configured');
  await expect(page.locator('.ott-account-preview').getByRole('link', { name: 'Open My data' })).toHaveAttribute('href', '#/data');
  await expect(page.locator('#programme')).toHaveCount(0);
  await page.locator('.ott-account-preview').getByRole('link', { name: 'Open My data' }).click();
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('No Solana wallet found in this browser. On a phone, open OT+T in Phantom or Solflare');
  // With no wallet installed, connecting offers the wallet apps' own in-app browser links.
  await mine.getByRole('button', { name: 'Connect wallet' }).click();
  const sheet = page.getByRole('dialog', { name: 'Open OT+T in your wallet' });
  await expect(sheet).toBeVisible();
  const here = encodeURIComponent(page.url());
  const ref = encodeURIComponent(new URL(page.url()).origin);
  await expect(sheet.getByRole('link', { name: 'Open in Phantom' })).toHaveAttribute('href', 'https://phantom.app/ul/browse/' + here + '?ref=' + ref);
  await expect(sheet.getByRole('link', { name: 'Open in Solflare' })).toHaveAttribute('href', 'https://solflare.com/ul/v1/browse/' + here + '?ref=' + ref);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(mine.locator('.hint')).toHaveText('No wallet connected.');
  expect(errors).toEqual([]);
});

test('with a wallet, the dashboard leads with what it holds and what that buys, then the redeem flow renders the QR and the activation code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  const wallet = await installWallet(page, { trusted: true });
  await stubAllowances(page, memberLedger());

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

  const posts = [];
  // The redeem this test drives creates order #1, so a signed read made after it sees both orders;
  // `redeemed` is this route's own memory of whether that has happened yet, the way the real
  // endpoint's memory is the provider's order history.
  let redeemed = false;
  await page.route('**/api/redeem**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      expect(new URL(req.url()).searchParams.get('address')).toBe(ADDR);
      await route.fulfill(json(standingOf({ redeemedUsd: 1.99, remainingUsd: 18.01, orders: [redactCodes(past)] })));
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
    await route.fulfill(json(standingOf({ redeemedUsd: redeemed ? 6.98 : 1.99, remainingUsd: redeemed ? 13.02 : 18.01, orders })));
  });

  // This test is about the wallet panel, not the pool card, so treasury.json is stubbed away as
  // missing (404) rather than left to whatever a real scripts/treasury.js run may have written to
  // disk in this checkout.
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'no treasury reading' }));

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await expect(page.locator('.data-pool')).toHaveCount(0);
  // A member who has not claimed the welcome eSIM is offered it, and is told they share this week.
  await expect(mine.locator('.data-membership h3')).toHaveText('Claim your welcome eSIM');
  await expect(mine.locator('.data-membership')).toContainText('You’re in this week’s split.');

  // The two headline figures the founder asked for, first in the DOM and biggest on the page.
  const headline = mine.locator('.dh-tile');
  await expect(headline).toHaveCount(2);
  await expect(mine.locator('.credit-summary')).toContainText('$18.01');
  await expect(mine.locator('.credit-summary')).toContainText('no member gets more than 3× the average');
  await expect(headline.nth(0)).toContainText('OTT at snapshot');
  await expect(headline.nth(0)).toContainText('1,234 OTT');
  await expect(headline.nth(0)).toContainText('0.152%');
  await expect(headline.nth(1)).toContainText('Weekly allocation');
  await expect(headline.nth(1)).toContainText('$20.00');
  await expect(headline.nth(1)).toContainText('25 GB');
  await expect(headline.nth(1)).toContainText('≈ 25 GB Germany · 2 GB Global');
  await expect(headline.nth(1)).toContainText('capped at 3× the average member share');
  // The very first figure in the panel is a headline tile, not one of the compact supporting ones —
  // the "big number first" the founder asked for, not a grid of equal-weight tiles.
  await expect(mine.locator('.dh-tile, .u-tile, .stat-tile').first()).toHaveClass(/dh-tile/);

  // Used and left, with the dollar figures — the ledger's real unit.
  const tiles = mine.locator('.data-tiles');
  await expect(tiles).toContainText('Used this week');
  await expect(tiles).toContainText('$1.99');
  await expect(tiles).toContainText('Left this week');
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
  // Nothing has been signed yet: the page connected silently and only read public figures.
  expect(wallet.calls('signMessage')).toEqual([]);

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
  const reads = posts.filter((p) => !p.packageCode);
  expect(reads).toHaveLength(2);
  expect(reads.every(p => !Object.hasOwn(p, 'n'))).toBe(true);

  // What was signed, and what each signature authorises. A redemption's message names the plan
  // and the slot, so it is spent on that one order and can never be walked across the week; a
  // read's names neither and is reused while it is fresh, which is why three calls cost two
  // signatures rather than three. Both are written to be read in a wallet prompt.
  expect(posts).toHaveLength(3);
  expect(new Set(reads.map((p) => p.signature)).size).toBe(1);
  expect(reads.every(p => p.message === reads[0].message)).toBe(true);
  expect(reads[0].signature).not.toBe(redeemPost.signature);
  expect(redeemPost.message).not.toBe(reads[0].message);
  // Each signature is this wallet's ed25519 signature over exactly the message posted with it.
  expect(wallet.verify(redeemPost.message, redeemPost.signature)).toBe(true);
  expect(wallet.verify(reads[0].message, reads[0].signature)).toBe(true);
  expect(wallet.verify(reads[0].message, redeemPost.signature)).toBe(false);

  const lines = redeemPost.message.split('\n');
  expect(lines.slice(0, 3)).toEqual(['OT+T — authorise a data redemption', 'Site: ' + new URL(page.url()).host, 'Wallet: ' + ADDR]);
  expect(lines.slice(3, 5)).toEqual(['Plan: fixed_5GB_30D_DE', 'Slot: 1']);
  expect(lines).toHaveLength(6);
  expect(lines[2]).toBe('Wallet: ' + ADDR); // exactly as connected: a Solana address is case-sensitive
  expect(lines[1]).toMatch(/^Site: 127\.0\.0\.1:\d+$/);
  const issued = Number((lines.find((l) => l.startsWith('Issued: ')) || '').slice(8));
  expect(Math.abs(issued - Math.floor(Date.now() / 1000))).toBeLessThan(60);

  const readLines = reads[0].message.split('\n');
  expect(readLines.slice(0, 3)).toEqual(['OT+T — show my eSIM codes', 'Site: ' + new URL(page.url()).host, 'Wallet: ' + ADDR]);
  expect(readLines[3]).toMatch(/^Issued: \d{10}$/);
  expect(readLines).toHaveLength(4);

  // The wallet was asked twice, in order: the read, then the redemption, both for this account.
  const signs = wallet.calls('signMessage');
  expect(signs.map((c) => c.message)).toEqual([reads[0].message, redeemPost.message]);
  expect(signs.every((c) => c.account === ADDR)).toBe(true);
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a member who held no OTT at the snapshot is told when their share starts, with no zero tiles and no redeem form', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await installWallet(page, { trusted: true });
  // A member who joined after the snapshot: listed in `members`, not in this week's `wallets`.
  await stubAllowances(page, ledger({ members: { [ADDR]: { burned: JOIN_UNITS, since: SINCE } } }));
  await page.route('**/api/redeem**', (route) => route.fulfill(json(standingOf({
    tokens: '0', share: 0, allowanceUsd: 0, remainingUsd: 0, membership: membership({ sharing: false }),
  }))));

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Your weekly share starts at the next Monday snapshot, from the OTT this wallet holds then.');
  await expect(mine.locator('.data-membership')).toContainText('Your weekly share starts at the next Monday snapshot.');
  // Nothing to redeem, so no dashboard, no redeem form, no orders list.
  await expect(mine.locator('.dh-tile')).toHaveCount(0);
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  await expect(mine).not.toContainText('Data this week');
  expect(errors).toEqual([]);
});

test('without membership, a wallet that held nothing is told so directly and pointed at pump.fun', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await installWallet(page, { trusted: true });
  await stubAllowances(page, ledger());
  await page.route('**/api/redeem**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(json(standingOf({ tokens: '0', share: 0, allowanceUsd: 0, remainingUsd: 0, membership: { configured: false } })));
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'unused in this test' });
  });

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('This wallet held no OTT at the weekly snapshot, so it has no weekly share this week.');
  const buy = mine.getByRole('link', { name: 'Get OTT on pump.fun' });
  await expect(buy).toHaveAttribute('href', 'https://pump.fun/coin/' + COIN);
  await expect(buy).toHaveAttribute('target', '_blank');
  await expect(mine.locator('.data-membership')).toHaveCount(0);
  await expect(mine.locator('.dh-tile')).toHaveCount(0);
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a week whose allowance has not been published yet says so, with the week it is showing and when it refreshes — not a zero that looks like a verdict', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await installWallet(page, { trusted: true });
  const lastWeek = CUR_WEEK - 1;
  // The ledger is one week behind — still carrying last week's real figures — and /api/redeem,
  // reading that same file, answers with the CURRENT week, stale:true, and a deliberately zeroed
  // allowance and remaining balance: it is honestly saying "not indexed yet", not "this wallet has
  // nothing". `allowancesWeek` names exactly which week it did read, and joining waits for it.
  await stubAllowances(page, memberLedger({
    week: lastWeek, weekStart: weekStartOf(lastWeek), weekEnd: weekEndOf(lastWeek),
    membership: Object.assign({}, ledger().membership, { requirement: Object.assign({}, REQUIREMENT, { week: lastWeek }), requirements: { [lastWeek]: JOIN_UNITS } }),
  }));
  await page.route('**/api/redeem**', (route) => route.fulfill(json(standingOf({
    stale: true, allowancesWeek: lastWeek, allowanceUsd: 0, redeemedUsd: 0, remainingUsd: 0,
    membership: membership({ sharing: false, requirement: null, enrolment: { open: false, reason: 'Joining reopens once this week’s ledger is published.' } }),
  }))));

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('has not been published yet');
  await expect(mine).toContainText('the week that ended ' + fmtDate(weekEndOf(lastWeek)));
  await expect(mine).toContainText('every half hour');
  // The last-published week's own numbers still render underneath the notice — the file's real
  // $20.00 allowance, not the API's own protective zero.
  await expect(mine.locator('.dh-tile').first()).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('$20.00');
  await expect(mine.locator('.credit-summary')).toContainText('Awaiting allocation');
  await expect(mine.locator('.data-tiles')).toContainText('Current spendable credit unavailable');
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  // Nobody is "sharing" before the week is published; that says nothing about this member.
  await expect(mine.locator('.data-membership')).toContainText('This week’s split isn’t published yet.');
  await expect(mine.locator('.data-membership')).not.toContainText('starts at the next Monday snapshot');
  expect(errors).toEqual([]);
});

test('the "Resets in" tile counts down live, without a repaint', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  const fixed = new Date('2026-09-16T12:00:00Z');
  await page.clock.install({ time: fixed });
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await installWallet(page, { trusted: true });
  const week = weekOf(Math.floor(fixed.getTime() / 1000));
  // 46 minutes from the frozen "now" — close enough that a 90-second jump crosses a whole minute
  // boundary, far enough that it does not also cross an hour boundary and change format.
  const weekEnd = Math.floor(fixed.getTime() / 1000) + 46 * 60;
  await stubAllowances(page, memberLedger({ week, weekStart: weekStartOf(week), weekEnd }));
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

test('when the redeem API cannot be reached, what the keeper last published still shows; redeeming and this week’s orders do not', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  const wallet = await installWallet(page, { trusted: true });
  await stubAllowances(page, memberLedger());
  // No route for /api/redeem: the static test server answers 404 with a text body, which is also
  // what a static host without the function deployed would do.

  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Could not reach the redeem API');
  // What the keeper's own file says is still shown: the holding, the share, this week's credit.
  await expect(mine.locator('.dh-tile').nth(0)).toContainText('1,234 OTT');
  await expect(mine.locator('.dh-tile').nth(1)).toContainText('$20.00');
  // Used/left cannot be known without the API — said as unknown, not shown as zero.
  await expect(mine.locator('.data-tiles')).toContainText('Redeem API unavailable');
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Show my eSIM codes' })).toHaveCount(0);
  // Without the API, nothing can be joined, claimed or signed for.
  await expect(mine.locator('.data-membership')).toHaveCount(0);
  expect(wallet.calls().filter((c) => !(c.method === 'connect' && c.silent))).toEqual([]);
  expect(errors).toEqual([]);
});

test('a bundle claimed in a previous week is still shown, filed under its eSIM and tagged with the week that claimed it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, LAUNCHED);
  await installWallet(page, { trusted: true });
  await stubAllowances(page, memberLedger());
  const oldWeek = CUR_WEEK - 2;
  const history = [{
    n: 0, week: oldWeek, transactionId: 'ott-' + 'c'.repeat(32), packageCode: 'fixed_1GB_7D_EUROPE', priceUsd: 1.19,
    qrCodeUrl: '', ac: '', iccid: '8900000000000000009', createdAt: '2026-08-20T00:00:00Z',
    pending: false, stage: 'done', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', note: '', codes: false,
  }];
  await page.route('**/api/redeem**', (route) => route.fulfill(json(standingOf({ history }))));

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
