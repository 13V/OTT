'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const { installWallet, walletAddress } = require('./support/wallet');
const { COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, signatureFrom } = require('./support/solana');
test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress();
const SAVED_KEY = 'ott-saved-places:/v1';
const CATALOGUE = require('../../site/config/esim.json');
const JOIN_UNITS = '180000000000';
function config(live = false) {
  const packages = [
    ['united-states', 'United States', 'us', [4, 15, 25]],
    ['japan', 'Japan', 'jp', [2, 8, 20]],
    ['europe', 'Europe', '', [30, 40, 50]],
  ].flatMap(([slug, name, flag, prices]) => prices.map((priceUsd, i) => ({
    slug, name, flag, code: slug + '-' + [1, 5, 10][i], gb: [1, 5, 10][i], days: 30,
    priceUsd, kind: slug === 'europe' ? 'region' : 'country', regions: name,
  })));
  return { ...CATALOGUE, packages, chain: 'solana',
    coin: live ? COIN : '', tokenProgram: live ? TOKEN_2022 : '', treasury: live ? TREASURY : '',
    membership: { ...CATALOGUE.membership, burnAccount: live ? BURN_ACCOUNT : '' } };
}
function standing(extra = {}) {
  const week = Math.floor((Date.now() / 1000 - 345600) / 604800);
  return { ok: true, address: ADDRESS, week, allowancesWeek: week, weekEnd: 345600 + (week + 1) * 604800,
    tokens: '1000000000', decimals: 6, share: 0.01,
    allowanceUsd: 99, redeemedUsd: 95, remainingUsd: 4, stale: false, orders: [], history: [], sims: [],
    membership: { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT,
      burnUsd: 5, requirement: { week, burnTokens: '180000', burnUnits: JOIN_UNITS, priceUsd: 0.0000278 }, burned: JOIN_UNITS,
      welcome: CATALOGUE.membership.welcome, capMultiple: 3, member: true, sharing: true,
      memberSince: { at: Math.floor(Date.now() / 1000) - 86400, slot: 399000000, tx: signatureFrom('holder-experience join') },
      welcomeOrder: null, enrolment: { open: true, reason: '' } },
    ...extra };
}
/**
 * Browsing, filtering and review never ask the wallet for anything. `live` launches the programme
 * and connects a member's wallet the site already knows (a silent reconnect, no prompt); otherwise
 * a wallet is installed but has never been connected here, so the page must not touch it at all.
 */
async function fixture(page, { live = false, account = standing(), apiStatus = 200 } = {}) {
  const network = stubNetwork(page), writes = [];
  let cfg = config(live);
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url());
  });
  await page.route('**/config/esim.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(cfg) }));
  await page.route('**/api/redeem**', route => route.fulfill({ status: apiStatus,
    contentType: 'application/json', body: JSON.stringify(account) }));
  await page.addInitScript(() => {
    window.fixtureTimeOffset = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + window.fixtureTimeOffset;
  });
  const wallet = await installWallet(page, { trusted: live });
  return { writes, network, wallet, setConfig(value) { cfg = value; } };
}
// Anything the wallet was asked for beyond a silent reconnect: a prompt, a signature or a send.
const approvals = wallet => wallet.calls().filter(call => !(call.method === 'connect' && call.silent));
async function choose(page, destination) {
  await page.getByRole('button', { name: /^Choose coverage\./ }).click();
  await page.getByRole('dialog').getByRole('button', { name: destination, exact: true }).click();
}
const packageOptions = page => page.getByRole('group', { name: 'Package size' }).getByRole('button');

test('sample budget filters plans, explains an empty destination and returns to all packages without orders', async ({ page }) => {
  const { writes, wallet } = await fixture(page);
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.locator('.om-plan-budget')).toHaveText('Sample credit: $15.00');
  const fit = page.getByRole('checkbox', { name: 'Fits my sample credit', exact: true });
  await expect(fit).toBeEnabled();
  await expect(packageOptions(page)).toHaveCount(3);
  await fit.check();
  await expect(packageOptions(page)).toHaveCount(2);
  await expect(packageOptions(page).nth(1)).toContainText('$15.00');
  await expect(packageOptions(page).filter({ hasText: '$25.00' })).toHaveCount(0);
  await choose(page, 'Europe');
  await expect(page.getByRole('heading', { name: 'No packages fit this balance.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review package', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse all packages', exact: true }).click();
  await expect(fit).not.toBeChecked();
  await expect(packageOptions(page)).toHaveCount(3);
  // A wallet that has never connected here is not touched by browsing a sample account.
  expect(wallet.calls()).toEqual([]);
  expect(writes).toEqual([]);
});

test('saved destinations survive reload, remove cleanly and prune a changed catalogue', async ({ page }) => {
  const control = await fixture(page);
  await page.goto('/#/app/plans');
  await choose(page, 'Japan');
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove saved destination', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SAVED_KEY)).toEqual(['japan']);
  await page.reload();
  const saved = page.getByRole('group', { name: 'Saved destinations', exact: true });
  await saved.getByRole('button', { name: 'Japan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose coverage. Japan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove saved destination', exact: true }).click();
  await expect(saved).toHaveCount(0);
  await page.reload();
  await expect(saved).toHaveCount(0);
  await choose(page, 'Japan');
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  const updated = config(); updated.packages = updated.packages.filter(pkg => pkg.slug !== 'japan');
  control.setConfig(updated);
  await page.reload();
  await expect(saved).toHaveCount(0);
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SAVED_KEY)).toEqual(['united-states']);
  expect(control.writes).toEqual([]);
});

test('live filtering uses API remaining credit rather than the larger static allocation', async ({ page }) => {
  const { writes, wallet } = await fixture(page, { live: true });
  await page.goto('/#/app/plans');
  const fit = page.getByRole('checkbox', { name: 'Fits my credit', exact: true });
  await expect(fit).toBeEnabled();
  await expect(page.locator('.om-plan-budget')).toHaveText('Confirmed remaining credit: $4.00');
  await fit.check();
  await expect(packageOptions(page)).toHaveCount(1);
  await expect(packageOptions(page)).toContainText('1 GB');
  await expect(packageOptions(page)).toContainText('$4.00');
  await fit.uncheck();
  await expect(packageOptions(page)).toHaveCount(3);
  expect(approvals(wallet)).toEqual([]);
  expect(writes).toEqual([]);
});

for (const failure of ['expired', 'previous allocation', 'failed API', 'invalid amount', 'not a member']) {
  test(failure + ' never enables a live credit filter or substitutes sample credit', async ({ page }) => {
    const account = standing();
    let apiStatus = 200;
    // Weekly credit is for members: a wallet that has not joined has none to filter by, whatever
    // figure a standing carries.
    if (failure === 'not a member') account.membership = { ...account.membership, member: false, memberSince: null, sharing: false, burned: '0' };
    if (failure === 'expired') account.weekEnd = Math.floor(Date.now() / 1000) - 1;
    if (failure === 'previous allocation') account.allowancesWeek--;
    if (failure === 'failed API') { apiStatus = 503; account.ok = false; account.error = 'Local account fixture is unavailable'; }
    if (failure === 'invalid amount') account.remainingUsd = null;
    const { writes, wallet } = await fixture(page, { live: true, account, apiStatus });
    await page.goto('/#/app/plans');
    // A wallet that hasn't joined is told why it has no credit, not to refresh.
    await expect(page.locator('.om-plan-budget')).toHaveText(failure === 'not a member'
      ? 'Weekly credit is for members. Join OT+T on the eSIMs screen to share next week’s budget.'
      : 'Current credit is unavailable. Browse all packages or refresh your account.');
    await expect(page.getByRole('checkbox', { name: 'Fits my credit', exact: true })).toBeDisabled();
    await expect(packageOptions(page)).toHaveCount(3);
    await expect(page.locator('.om-preview-banner')).toHaveCount(0);
    expect(approvals(wallet)).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test('zero confirmed credit shows an honest empty filter and an expired confirmed balance disables it', async ({ page }) => {
  await fixture(page, { live: true, account: standing({ remainingUsd: 0 }) });
  await page.goto('/#/app/plans');
  const fit = page.getByRole('checkbox', { name: 'Fits my credit', exact: true });
  await expect(page.locator('.om-plan-budget')).toHaveText('Confirmed remaining credit: $0.00');
  await fit.check();
  await expect(page.getByRole('heading', { name: 'No packages fit this balance.', exact: true })).toBeVisible();
  await page.evaluate(() => { window.fixtureTimeOffset = 8 * 24 * 60 * 60 * 1000; });
  await page.getByRole('button', { name: 'Browse all packages', exact: true }).click();
  await expect(fit).toBeDisabled();
  await expect(fit).not.toBeChecked();
  await expect(packageOptions(page)).toHaveCount(3);
  await expect(page.locator('.om-plan-budget')).toContainText('Credit has expired.');
});

test('an existing destination shortcut opens package review with no signature, order or private details', async ({ page }) => {
  const privateFixture = 'HOLDER-PRIVATE-ACTIVATION-FIXTURE';
  const { writes, network, wallet } = await fixture(page, { live: true, account: standing({ sims: [{
    slug: 'japan', iccid: '8901000000000000001', createdAt: new Date().toISOString(), codes: true,
    ac: 'LPA:1$smdp.invalid$' + privateFixture, qrCodeUrl: 'https://private.fixture/' + privateFixture,
    matchingId: privateFixture, appleInstallUrl: 'https://private.fixture/apple/' + privateFixture,
  }] }) });
  await page.goto('/#/app');
  const destinations = page.getByRole('heading', { name: 'Add data for a destination', exact: true }).locator('..');
  await expect(destinations).toContainText('The provider decides whether an existing eSIM can be topped up.');
  await destinations.getByRole('button', { name: 'Japan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose coverage. Japan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('If you already have an eSIM for this destination');
  await expect(review).toContainText('Otherwise, it may issue a new eSIM');
  await expect(review.getByRole('button', { name: 'Continue to eSIMs', exact: true })).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(privateFixture);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(privateFixture);
  expect(approvals(wallet)).toEqual([]);
  expect(network.blocked.some(url => url.includes('private.fixture'))).toBe(false);
  expect(writes).toEqual([]);
});

test('a revealed eSIM reviews the cheapest destination plan and preselects it without another approval', async ({ page }) => {
  const sim = { slug: 'japan', iccid: '8901000000000000001', createdAt: new Date().toISOString(),
    codes: false, ac: '', manualCode: '', qrCodeUrl: '', smdpAddress: '', matchingId: '',
    appleInstallUrl: '', androidInstallUrl: '' };
  const state = standing({ sims: [sim] });
  const { writes, wallet } = await fixture(page, { live: true, account: state });
  const readPosts = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'POST') readPosts.push(request.postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(request.method() === 'POST'
      ? { ...state, sims: [{ ...sim, codes: true, ac: 'LPA:1$smdp.fixture$EXPLICIT-READ-FIXTURE' }] } : state) });
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('EXPLICIT-READ-FIXTURE');
  expect(readPosts).toHaveLength(1);
  expect(readPosts[0].packageCode).toBeUndefined();
  expect(readPosts[0].message.split('\n')[0]).toBe('OT+T — show my eSIM codes');
  expect(wallet.verify(readPosts[0].message, readPosts[0].signature)).toBe(true);
  expect(wallet.calls('signMessage')).toHaveLength(1);
  await expect(page.locator('#f-place')).not.toHaveValue('japan');
  await page.getByRole('button', { name: 'Review more data for Japan', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Japan data plan', exact: true });
  await expect(review).toContainText('1 GB');
  await expect(review).toContainText('$2.00');
  await expect(review).toContainText('the provider will top it up when compatible');
  await expect(review).toContainText('Otherwise, it may issue a new eSIM');
  await review.getByRole('button', { name: 'Continue to eSIMs', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page).toHaveURL(/#\/app\/esims$/);
  await expect(page.locator('#f-place')).toHaveValue('japan');
  await expect(page.locator('#f-package')).toHaveValue('japan-1');
  await expect(page.locator('.data-redeem').getByRole('button', { name: /^Redeem Japan/ })).toContainText('1 GB');
  expect(readPosts).toHaveLength(1);
  expect(writes).toHaveLength(1);
  // Reviewing and preselecting a plan asked the wallet for nothing more.
  expect(wallet.calls('signMessage')).toHaveLength(1);
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
});
