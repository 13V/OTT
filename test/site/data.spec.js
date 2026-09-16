'use strict';
/**
 * The programme page — OT+T's home route (#/); it lived at #/data back when this site was two
 * routes inside whatever.fun — reads three things nothing else on the site reads: config/esim.json,
 * the indexer's allowances.json, and /api/redeem, plus six view functions on the coin's curve and
 * the fee escrow. Every one of them is stubbed here, so each number the page shows is a number
 * this file chose and the assertion can name it. The two states that matter are "not launched
 * yet" (the checked-in config until launch day) and "launched", and within launched, a visitor
 * with no wallet must see an invitation rather than an exception.
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

// Three places across five nadanada packages, at real catalogue prices. Europe and Global each
// sell one 1 GB size; Germany sells all three sizes, which makes it the only place with both a
// region and a country in the picker, and — at $7.99 for 10 GB, 80¢/GB — the cheapest place per
// gigabyte in this fixture, so `cheapest()` picks it. Global's 1 GB at $8.99 is the dearest per
// gigabyte. $1,234.56 of treasury therefore pools to 1,545 GB at Germany's rate, or 137 GB at
// Global's — the numbers the pool tile is checked against below.
const PACKAGES = [
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '105 countries' },
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 4.99, regions: 'DE' },
  { code: 'fixed_10GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 10, days: 30, priceUsd: 7.99, regions: 'DE' },
];
const BRAND = { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' };
const base = { pair: USDG, taxBps: 1000, rebateBps: 800, provider: 'nadanada', packages: PACKAGES, brand: BRAND };
const NOT_LAUNCHED = Object.assign({ coin: '', curve: '', treasury: '' }, base);
const LAUNCHED = Object.assign({ coin: COIN, curve: CURVE, treasury: TREASURY }, base);
// A config from before the brand existed — no `brand` key at all — to prove the fallback path.
const NOT_LAUNCHED_NO_BRAND = Object.assign({}, NOT_LAUNCHED);
delete NOT_LAUNCHED_NO_BRAND.brand;

// The six reads, as USDG (6 decimals) or bare numbers. The page turns these into the figures the
// tests below look for: $1,234.56 claimable, 1,545 GB of pool at Germany's $0.80/GB, 30% of the
// way to graduation, a 10% tax with $50.00 still sitting in the curve.
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
function stubAllowances(page, wallets) {
  const file = { asOf: 1789391153, block: 62830333, coin: COIN, curve: CURVE, rebateBps: 800, wallets: wallets || {} };
  return page.route('**/data/allowances.json', (route) => route.fulfill(json(file)));
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

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('Trade the coin. Fly with data.');
  await expect(page).toHaveTitle('OT+T — trade the coin, fly with data');
  // The brand, read from config: the head names the carrier by its display name and its full
  // corporate name, and the explainer names it in the first sentence.
  await expect(page.locator('.page-head .label')).toHaveText('OT+T · ONCHAIN TELEPHONE + TELEGRAPH');
  await expect(page.locator('.page-lede')).toContainText('OT+T is a phone carrier');
  await expect(page.locator('.data-explainer')).toContainText('OT+T’s bonding curve');
  const card = page.locator('.data-notlaunched');
  await expect(card).toContainText('Not launched yet');
  await expect(card).toContainText('Carrier');
  await expect(card).toContainText('OT+T · Onchain Telephone + Telegraph');
  await expect(card).toContainText('Ticker');
  await expect(card).toContainText('OTT');
  await expect(card).toContainText('8% of traded volume');
  await expect(card).toContainText('3 places · 1, 5 and 10 GB · from $1.19');
  await expect(card).toContainText('eSIMs from nadanada, paid by Lightning');
  await expect(card).toContainText('pre-graduation');
  // esim.js has no launchpad route of its own on this site, so the not-launched card sends a
  // trader to whatever.fun's launch form instead — a new tab, labelled honestly as a departure.
  const launchLink = card.locator('a[href="https://whatever-fun.vercel.app/#/new"]');
  await expect(launchLink).toHaveText('Launch the coin on whatever.fun');
  await expect(launchLink).toHaveAttribute('target', '_blank');
  await expect(launchLink).toHaveAttribute('rel', 'noopener');
  // Nothing about a wallet before there is a coin, no chain read, and no pool card either.
  await expect(page.locator('.data-mine')).toHaveCount(0);
  await expect(page.locator('.data-pool')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a config with no brand block renders exactly as it did before the brand existed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED_NO_BRAND);

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toHaveText('Trade the coin. Fly with data.');
  await expect(page.locator('.page-head .label')).toHaveText('MOBILE DATA, EARNED BY TRADING');
  await expect(page.locator('.page-lede')).toContainText('A coin whose creator tax buys eSIM gigabytes');
  await expect(page.locator('.data-explainer')).toContainText('the coin’s bonding curve');
  const card = page.locator('.data-notlaunched');
  await expect(card).toContainText('Not launched yet');
  await expect(card).not.toContainText('Carrier');
  await expect(card).not.toContainText('Ticker');
  expect(errors).toEqual([]);
});

test('the nav lists exactly three routes, home first, and highlights the active one', async ({ page }) => {
  stubNetwork(page);
  await stubConfig(page, NOT_LAUNCHED);
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
  await expect(page.locator('#view h1')).toHaveText('Trade the coin. Fly with data.');
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
  await expect(tiles).toContainText('8%');                      // rebateBps from the config
  await expect(page.locator('.data-progress')).toContainText('$3,000.00 of $10,000.00');
  await expect(page.locator('.data-progress')).toContainText('30% of the way');

  // Chromium has no window.ethereum, so this is the wallet-less path.
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Connect a wallet');
  await expect(mine.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(mine).not.toContainText('Could not');
  expect(errors).toEqual([]);
});

test('with a wallet, the banked balance is shown and a redemption renders the QR and the activation code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, { [ADDR]: { tradedUsd: 250, earnedUsd: 20 } });
  await stubWallet(page);

  // The past order carries every field nadanada would give it; redactCodes() blanks the same six
  // fields /api/redeem does for an address-only GET (codes: false) — everything else, ICCID
  // included, is public regardless. The fresh one is what the redeem POST answers with: an empty
  // qrCodeUrl but an ac, so it exercises the page's own QR drawing, plus both install links and
  // the manual SM-DP+/matching-id fallback.
  const past = {
    n: 0, transactionId: 'wf-' + 'a'.repeat(32), packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99,
    qrCodeUrl: './qr-old.png', ac: 'LPA:1$old.example$OLD', iccid: '8900000000000000001',
    createdAt: '2026-09-01T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp-old.example', matchingId: 'OLD-MATCH',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=old', androidInstallUrl: 'https://nadanada.me/install/android/old',
    note: '',
  };
  const fresh = {
    n: 1, transactionId: 'wf-' + 'b'.repeat(32), packageCode: 'fixed_5GB_30D_DE', priceUsd: 4.99,
    qrCodeUrl: '', ac: 'LPA:1$smdp.nadanada.me$MATCH-123', iccid: '8900000000000000002',
    createdAt: '2026-09-14T00:00:00Z', pending: false, stage: 'done',
    smdpAddress: 'smdp.nadanada.me', matchingId: 'MATCH-123',
    appleInstallUrl: 'https://esimsetup.apple.com/es?a=1', androidInstallUrl: 'https://nadanada.me/install/android/1',
    note: '',
  };
  const redactCodes = (o) => Object.assign({}, o, { qrCodeUrl: '', ac: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', codes: false });
  const withCodes = (o) => Object.assign({}, o, { codes: true });

  const posts = [];
  // The redeem this test drives creates order #1, so a signed read made after it sees both past
  // orders; `redeemed` is this route's own memory of whether that has happened yet, the way the
  // real endpoint's memory is the provider's order history.
  let redeemed = false;
  await page.route('**/api/redeem**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      expect(new URL(req.url()).searchParams.get('address')).toBe(ADDR);
      await route.fulfill(json({ ok: true, address: ADDR, earnedUsd: 20, redeemedUsd: 1.99, remainingUsd: 18.01, orders: [redactCodes(past)] }));
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
    await route.fulfill(json({
      ok: true, address: ADDR, earnedUsd: 20,
      redeemedUsd: redeemed ? 6.98 : 1.99, remainingUsd: redeemed ? 13.02 : 18.01,
      orders,
    }));
  });

  // This test is about the wallet panel, not the pool card, so treasury.json is stubbed away as
  // missing (404) rather than left to whatever a real scripts/treasury.js run may have written to
  // disk in this checkout.
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'no treasury reading' }));

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  await expect(page.locator('.data-pool')).toHaveCount(0);
  await expect(mine.locator('.data-tiles')).toContainText('$20.00');
  await expect(mine.locator('.data-tiles')).toContainText('$18.01');
  await expect(mine.locator('.data-tiles')).toContainText('≈ 22 GB Germany · 2 GB Global');

  // The past order came from a plain GET, so it is listed but redacted: no code, no QR, no
  // install links, no manual line — only what was never gated (name, price, ICCID) shows.
  const pastCard = mine.locator('.data-orders .data-order');
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

  const card = mine.locator('.data-order.fresh');
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
  await expect(mine.locator('.data-tiles')).toContainText('$13.02');
  await expect(mine.locator('.data-tiles')).toContainText('$6.98');
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

  // What was signed and what was posted: the contract's exact message, hex-encoded for the
  // wallet, the same on every one of those three calls, and only ever signed once — the wallet
  // was not asked again for the redeem, nor for the read that followed it.
  expect(posts).toHaveLength(3);
  expect(new Set(posts.map((p) => p.signature)).size).toBe(1);
  expect(new Set(posts.map((p) => p.message)).size).toBe(1);
  expect(redeemPost.signature).toBe('0x' + 'ab'.repeat(65));
  const lines = redeemPost.message.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe('OT+T data');
  expect(lines[1]).toBe(ADDR);
  expect(Math.abs(Number(lines[2]) - Math.floor(Date.now() / 1000))).toBeLessThan(60);
  const signs = await page.evaluate(() => window.__eth.filter((c) => c.method === 'personal_sign'));
  expect(signs).toHaveLength(1);
  expect(signs[0].params[1]).toBe(ADDR);
  const hex = '0x' + Buffer.from(redeemPost.message, 'utf8').toString('hex');
  expect(signs[0].params[0]).toBe(hex);
  expect(errors).toEqual([]);
});

test('an API that is not there is a notice in the wallet panel, not an exception', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page, { calls: CALLS });
  await stubConfig(page, LAUNCHED);
  await stubAllowances(page, { [ADDR]: { tradedUsd: 5, earnedUsd: 0.4 } });
  await stubWallet(page);
  // No route for /api/redeem: the static test server answers 404 with a text body, which is also
  // what a static host without the function deployed would do.

  await page.goto('/index.html#/');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText('Could not reach the redeem API');
  // What the indexer said is still shown; only the redeemed side is unknown.
  await expect(mine.locator('.data-tiles')).toContainText('$0.40');
  await expect(mine.getByRole('button', { name: /^Redeem/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
