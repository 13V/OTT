'use strict';
/**
 * The dashboard, once a wallet has an eSIM of its own.
 *
 * data.spec.js covers the states a wallet passes through before it holds anything, and it does so
 * with the order shape written before nadanada tracked a standing profile — no `sims`, no
 * `topupOf` — which is exactly the fallback the page still has to honour for a provider that has
 * no notion of one. This file covers the shape the live site actually serves now: a wallet owns
 * eSIMs, and a week's claim is a BUNDLE QUEUED ON ONE, not another SIM to install.
 *
 * What that has to look like on the page, and what is asserted here: every bundle is filed under
 * the profile it lives on rather than standing alone; a top-up carries no QR and no activation
 * code of its own, because the code is the one the holder already scanned; a holder who buys a
 * second region gets a second card, labelled, so they know which SIM works where; and the plan
 * picker says which of the two is about to happen before the holder spends anything.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork, hexWord } = require('./support/network.js');

const ADDR = '0x4ca685f4a1cd39ba0d0f1cd06b3f2b0f5b7cdd11';
const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const WEEK_S = 604800;
const ANCHOR = 345600;
const weekOf = (s) => Math.floor((s - ANCHOR) / WEEK_S);
const weekStartOf = (w) => ANCHOR + w * WEEK_S;
const NOW_S = Math.floor(Date.now() / 1000);
const CUR_WEEK = weekOf(NOW_S);
const CUR_WEEK_END = weekStartOf(CUR_WEEK) + WEEK_S;
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Germany and Japan: two places, so the two-profile case is a real one rather than a contrivance.
const PACKAGES = [
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 4.99, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_1GB_7D_JP', slug: 'japan', name: 'Japan', kind: 'country', gb: 1, days: 7, priceUsd: 2.99, regions: 'JP', flag: '🇯🇵' },
];
const LAUNCHED = {
  coin: COIN, curve: CURVE, treasury: TREASURY, pair: USDG, taxBps: 1000, budgetBps: 10000,
  provider: 'nadanada', packages: PACKAGES,
  brand: { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' },
};
const CALLS = {
  '0xf59e38b7': hexWord(1234560000n), '0x4f1f58fd': hexWord(3000000000n),
  '0x8b0bc501': hexWord(10000000000n), '0xe7c2b772': hexWord(0),
  '0xc1bb8901': hexWord(1000), '0xdb2bd533': hexWord(50000000n),
};

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });
const stubConfig = (page) => page.route('**/config/esim.json', (r) => r.fulfill(json(LAUNCHED)));
const stubAllowances = (page) => page.route('**/data/allowances.json', (r) => r.fulfill(json({
  asOf: NOW_S, block: 64200000, week: CUR_WEEK, weekStart: weekStartOf(CUR_WEEK), weekEnd: CUR_WEEK_END,
  snapshotBlock: 64200000, coin: COIN, curve: CURVE, budgetUsd: 412.5,
  budgetSource: 'tax collected in week ' + (CUR_WEEK - 1),
  circulating: '812345678000000000000000', decimals: 18, holders: 214,
  wallets: { [ADDR]: { tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20 } },
})));
const stubWallet = (page) => page.addInitScript((addr) => {
  window.__eth = [];
  window.ethereum = {
    request: async ({ method }) => {
      window.__eth.push({ method });
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'personal_sign') return '0x' + 'ab'.repeat(65);
      return null;
    },
  };
}, ADDR);

const DE_ICCID = '8900000000000000011';
const JP_ICCID = '8900000000000000022';

/** An eSIM as /api/redeem serves it, codes withheld unless the read was signed. */
const sim = (iccid, slug, extra) => Object.assign({
  iccid, slug, createdAt: '2026-09-01T00:00:00Z',
  qrCodeUrl: '', ac: '', manualCode: '', smdpAddress: '', matchingId: '',
  appleInstallUrl: '', androidInstallUrl: '', codes: false,
}, extra || {});
const withCodes = (s) => Object.assign({}, s, {
  qrCodeUrl: './qr-' + s.slug + '.png', ac: 'LPA:1$smdp.nadanada.me$' + s.slug.toUpperCase(),
  smdpAddress: 'smdp.nadanada.me', matchingId: s.slug.toUpperCase(),
  appleInstallUrl: 'https://esimsetup.apple.com/es?a=' + s.slug,
  androidInstallUrl: 'https://nadanada.me/install/android/' + s.slug,
  codes: true,
});
/** A bundle. `topupOf` set means it queued on a profile already installed, so it has no code. */
const bundle = (n, code, iccid, extra) => Object.assign({
  n, week: CUR_WEEK, transactionId: 'ott-' + String(n).repeat(32).slice(0, 32),
  packageCode: code, priceUsd: 1.99, iccid, topupOf: '', toppedUp: false,
  createdAt: '2026-09-14T00:00:00Z', pending: false, stage: 'done', note: '',
  qrCodeUrl: '', ac: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', codes: false,
}, extra || {});

const standing = (extra) => Object.assign({
  ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
  tokens: '1234000000000000000000', share: 0.00152, allowanceUsd: 20, decimals: 18,
  redeemedUsd: 0, remainingUsd: 20, stale: false, allowancesWeek: CUR_WEEK,
  orders: [], history: [], sims: [],
}, extra);

/**
 * The dashboard, painted for a wallet that stubWallet() already answers eth_accounts for — the
 * page connects itself on load, so there is no button to press. treasury.json is stubbed away as
 * missing: these tests are about the wallet's own panel, not the pool card, and a real
 * scripts/treasury.js run in this checkout must not be able to change what they see.
 */
async function open(page, body) {
  await page.route('**/api/redeem**', (r) => r.fulfill(json(body)));
  await page.route('**/data/treasury.json', (r) => r.fulfill({ status: 404, body: 'no treasury reading' }));
  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  return mine;
}

test('a week\'s claim is a bundle on the eSIM the holder already has, not a second eSIM to install', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page); await stubAllowances(page); await stubWallet(page);

  // Two weeks of Germany: the first minted the profile, the second queued onto it.
  const mine = await open(page, standing({
    sims: [sim(DE_ICCID, 'germany')],
    orders: [bundle(0, 'fixed_5GB_30D_DE', DE_ICCID, { topupOf: DE_ICCID, toppedUp: true, priceUsd: 4.99 })],
    history: [bundle(1, 'fixed_1GB_7D_DE', DE_ICCID, { week: CUR_WEEK - 1 })],
    redeemedUsd: 4.99, remainingUsd: 15.01,
  }));

  // One profile, not two — the whole point of the change.
  await expect(mine.locator('.data-sim')).toHaveCount(1);
  const card = mine.locator('.data-sim');
  await expect(card).toContainText(DE_ICCID);
  await expect(mine.locator('.data-sims .label')).toHaveText('YOUR ESIM');

  // Both weeks' bundles are filed under it, the older one attributed to the week that paid for it.
  await expect(card.locator('.data-bundle')).toHaveCount(2);
  await expect(card).toContainText('Germany · 5 GB · 30 days');
  await expect(card).toContainText('Germany · 1 GB · 7 days');
  await expect(card).toContainText('Week of ' + fmtDate(weekStartOf(CUR_WEEK - 1)));

  // And it says what queueing actually means, because nothing about it is guessable.
  await expect(card).toContainText('queue one after another');
  await expect(card).toContainText('start counting down until your phone connects to a network in Germany');

  // Codes are withheld until the holder asks, exactly as they were per-order before: the row is
  // there, holding an em dash, and nothing installable is on the page.
  await expect(card.locator('.data-ac')).toHaveText('—');
  await expect(card.locator('img.data-qr')).toHaveCount(0);
  await expect(card.locator('.data-install')).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Show my eSIM codes' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the one code the holder scans belongs to the eSIM, and a top-up never carries one of its own', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page); await stubAllowances(page); await stubWallet(page);

  // The real sequence, not a shortcut: the unsigned GET withholds the codes, and only the signed
  // POST the reveal button makes carries them.
  const shape = (s) => standing({
    sims: [s],
    orders: [bundle(0, 'fixed_5GB_30D_DE', DE_ICCID, { topupOf: DE_ICCID, toppedUp: true, priceUsd: 4.99 })],
    history: [bundle(1, 'fixed_1GB_7D_DE', DE_ICCID, { week: CUR_WEEK - 1 })],
    redeemedUsd: 4.99, remainingUsd: 15.01,
  });
  await page.route('**/data/treasury.json', (r) => r.fulfill({ status: 404, body: 'no treasury reading' }));
  await page.route('**/api/redeem**', (r) => r.fulfill(json(
    r.request().method() === 'GET' ? shape(sim(DE_ICCID, 'germany')) : shape(withCodes(sim(DE_ICCID, 'germany'))))));
  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await mine.getByRole('button', { name: 'Show my eSIM codes' }).click();

  const card = mine.locator('.data-sim');
  // Exactly one activation code on the page, on the SIM — not one per bundle.
  await expect(mine.locator('.data-ac')).toHaveCount(1);
  await expect(card.locator('.data-ac')).toHaveText('LPA:1$smdp.nadanada.me$GERMANY');
  await expect(card.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', 'https://esimsetup.apple.com/es?a=germany');
  // Two bundles, and neither of them shows a code, because neither of them has one.
  await expect(card.locator('.data-bundle')).toHaveCount(2);
  await expect(card.locator('.data-bundle .data-ac')).toHaveCount(0);
  // And with nothing left hidden, the button that revealed them stops offering to.
  await expect(mine.getByRole('button', { name: 'Show my eSIM codes' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a second region is a second eSIM, each labelled by where it works', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page); await stubAllowances(page); await stubWallet(page);

  const mine = await open(page, standing({
    sims: [sim(JP_ICCID, 'japan', { createdAt: '2026-09-12T00:00:00Z' }), sim(DE_ICCID, 'germany')],
    orders: [
      bundle(0, 'fixed_1GB_7D_JP', JP_ICCID, { priceUsd: 2.99 }),
      bundle(1, 'fixed_5GB_30D_DE', DE_ICCID, { topupOf: DE_ICCID, toppedUp: true, priceUsd: 4.99 }),
    ],
    history: [bundle(2, 'fixed_1GB_7D_DE', DE_ICCID, { week: CUR_WEEK - 1 })],
    redeemedUsd: 7.98, remainingUsd: 12.02,
  }));

  await expect(mine.locator('.data-sim')).toHaveCount(2);
  await expect(mine.locator('.data-sims .label')).toHaveText('YOUR ESIMS');
  const de = mine.locator('.data-sim').filter({ hasText: DE_ICCID });
  const jp = mine.locator('.data-sim').filter({ hasText: JP_ICCID });
  // Each bundle under the profile it is actually on, across this week and last.
  await expect(de.locator('.data-bundle')).toHaveCount(2);
  await expect(jp.locator('.data-bundle')).toHaveCount(1);
  await expect(jp).toContainText('Japan · 1 GB · 7 days');
  await expect(de).not.toContainText('Japan');
  // And each says which country starts ITS clock — the reason they are separate profiles at all.
  await expect(jp).toContainText('connects to a network in Japan');
  await expect(de).toContainText('connects to a network in Germany');
  expect(errors).toEqual([]);
});

test('a pool that cannot cover the week says so before the button, not after', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page); await stubAllowances(page); await stubWallet(page);

  // $20 of allowance against a pool holding $6.20. The budget comes from tax collected on chain,
  // which has no ceiling; the pool is moved across by a keeper once a day. A holder is owed that
  // fact up front rather than a failed order.
  await page.route('**/data/treasury.json', (r) => r.fulfill({ status: 404, body: 'none' }));
  await page.route('**/api/redeem**', (r) => r.fulfill(json(standing({ poolUsd: 6.2 }))));
  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await expect(mine).toContainText('The data pool holds $6.20 just now, less than the $20.00 you have left this week');
  await expect(mine).toContainText('topped up');
  // The plan picker is still there: smaller plans genuinely do go through.
  await expect(mine.locator('.data-redeem')).toHaveCount(1);

  // A pool that covers it says nothing at all, and neither does one it could not read.
  for (const pool of [400, null]) {
    await page.route('**/api/redeem**', (r) => r.fulfill(json(standing({ poolUsd: pool }))));
    await page.reload();
    await expect(page.locator('.data-mine')).toContainText(ADDR);
    await expect(page.locator('.data-mine')).not.toContainText('The data pool holds');
  }
  expect(errors).toEqual([]);
});

test('the picker says whether a plan tops up an eSIM or issues one, before anything is spent', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page); await stubAllowances(page); await stubWallet(page);

  const mine = await open(page, standing({
    sims: [sim(DE_ICCID, 'germany')],
    orders: [bundle(0, 'fixed_1GB_7D_DE', DE_ICCID)],
    redeemedUsd: 1.99, remainingUsd: 18.01,
  }));

  const redeem = mine.locator('.data-redeem');
  // A wallet that already has an eSIM is adding data to it, and the picker says so up front.
  await expect(redeem.locator('.label').first()).toHaveText('ADD DATA');
  const place = redeem.locator('#f-place');
  await place.selectOption('germany');
  await expect(redeem).toContainText('Adds to your eSIM for Germany — nothing to install again.');
  await place.selectOption('japan');
  await expect(redeem).toContainText('Issues a new eSIM for Japan, ready to install.');
  expect(errors).toEqual([]);
});
