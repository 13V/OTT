'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const { installWallet, walletAddress } = require('./support/wallet');
const { COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, signatureFrom } = require('./support/solana');
test.use({ serviceWorkers: 'block' });

const CATALOGUE = require('../../site/config/esim.json');
const SAVED_KEY = 'ott-saved-places:/v1';
const ADDRESS = walletAddress();
const COUNTRIES = [...new Map(CATALOGUE.packages.filter(pkg => pkg.kind !== 'region').map(pkg => [pkg.slug, pkg])).values()];
const SAVED = ['united-states', ...COUNTRIES.filter(pkg => !['united-states', 'japan'].includes(pkg.slug)).slice(0, 10).map(pkg => pkg.slug), 'japan'];
const week = () => Math.floor((Date.now() / 1000 - 345600) / 604800);
const JOIN_UNITS = '180000000000';

/**
 * Browsing and package review never ask the wallet for anything. `live` launches the programme and
 * connects a member's wallet the site already knows (a silent reconnect, no prompt); otherwise a
 * wallet is installed but has never been connected here, so the page must not touch it at all.
 */
async function fixture(page, { saved = [], live = false } = {}) {
  stubNetwork(page);
  const writes = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url());
  });
  const cfg = { ...CATALOGUE, chain: 'solana',
    coin: live ? COIN : '', tokenProgram: live ? TOKEN_2022 : '', treasury: live ? TREASURY : '',
    membership: { ...CATALOGUE.membership, burnAccount: live ? BURN_ACCOUNT : '' } };
  await page.route('**/config/esim.json', route => route.fulfill({ json: cfg }));
  await page.route('**/api/redeem**', route => route.fulfill({ json: {
    ok: true, address: ADDRESS, week: week(), allowancesWeek: week(), weekEnd: 345600 + (week() + 1) * 604800,
    tokens: '1000000000', decimals: 6, share: 0.01,
    allowanceUsd: 20, redeemedUsd: 5, remainingUsd: 15, stale: false, orders: [], history: [], sims: [],
    membership: { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT,
      burnUsd: 5, requirement: { week: week(), burnTokens: '180000', burnUnits: JOIN_UNITS, priceUsd: 0.0000278 }, burned: JOIN_UNITS,
      welcome: CATALOGUE.membership.welcome, capMultiple: 3, member: true, sharing: true,
      memberSince: { at: Math.floor(Date.now() / 1000) - 86400, slot: 399000000, tx: signatureFrom('holder-ux join') },
      welcomeOrder: null, enrolment: { open: true, reason: '' } },
  } }));
  await page.addInitScript(({ saved, key }) => {
    // Set preferences once so a reload exercises the browser's real saved value.
    if (!sessionStorage.getItem('holder-ux-initialized')) {
      localStorage.setItem(key, JSON.stringify(saved));
      sessionStorage.setItem('holder-ux-initialized', 'yes');
    }
  }, { saved, key: SAVED_KEY });
  const wallet = await installWallet(page, { trusted: live });
  return { writes, wallet };
}
// Anything the wallet was asked for beyond a silent reconnect: a prompt, a signature or a send.
const approvals = wallet => wallet.calls().filter(call => !(call.method === 'connect' && call.silent));

async function ready(page) {
  await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoPageOverflow(page) {
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
}

async function expectSingleSavedRow(page) {
  const saved = page.getByRole('group', { name: 'Saved destinations', exact: true });
  await expect(saved.getByRole('button')).toHaveCount(12);
  const bounds = await saved.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(Math.max(...bounds.map(box => box.y)) - Math.min(...bounds.map(box => box.y))).toBeLessThanOrEqual(1);
  expect(bounds.every(box => box.height >= 44)).toBe(true);
  expect(await saved.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
}

for (const width of [390, 320]) {
  test(`twelve saved destinations stay in one accessible phone row at ${width}px`, async ({ page }) => {
    expect(SAVED).toHaveLength(12);
    const { writes, wallet } = await fixture(page, { saved: SAVED });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#/app/plans');
    await ready(page);
    await expectNoPageOverflow(page);
    await expectSingleSavedRow(page);
    const review = page.getByRole('button', { name: 'Review package', exact: true });
    if (width === 390) {
      const box = await review.boundingBox();
      const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
    }
    const japan = page.getByRole('group', { name: 'Saved destinations', exact: true }).getByRole('button', { name: 'Japan', exact: true });
    await japan.focus();
    await page.keyboard.press('Enter');
    await expect(japan).toBeFocused();
    await expect(japan).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Choose coverage. Japan', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await expectSingleSavedRow(page);
    const chipBox = await japan.boundingBox();
    expect(chipBox.x).toBeGreaterThanOrEqual(0);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(width);
    await review.click();
    await expect(page.getByRole('dialog')).toContainText('Japan');
    await page.keyboard.press('Escape');
    await expect(review).toBeFocused();
    expect(wallet.calls()).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test('keyboard destination saving keeps focus and survives a return visit', async ({ page }) => {
  const { writes, wallet } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/app/plans');
  await ready(page);
  const coverage = page.getByRole('button', { name: /^Choose coverage\./ });
  await coverage.focus();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog');
  await picker.getByLabel('Search a country or region', { exact: true }).fill('Japan');
  await page.keyboard.press('Tab');
  await expect(picker.getByRole('button', { name: 'Japan', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(coverage).toHaveAccessibleName('Choose coverage. Japan');
  await expect(coverage).toBeFocused();
  const save = page.locator('.om-save-destination');
  await page.keyboard.press('Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(save).toHaveAccessibleName('Remove saved destination');
  await expect(save).toBeFocused();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SAVED_KEY)).toEqual(['japan']);
  await page.reload();
  await ready(page);
  const japan = page.getByRole('group', { name: 'Saved destinations', exact: true }).getByRole('button', { name: 'Japan', exact: true });
  await japan.focus();
  await page.keyboard.press('Enter');
  await expect(japan).toBeFocused();
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveAccessibleName('Save destination');
  await expect(save).toBeFocused();
  await expect(page.getByRole('group', { name: 'Saved destinations', exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SAVED_KEY)).toEqual([]);
  expect(wallet.calls()).toEqual([]);
  expect(writes).toEqual([]);
});

test('sample package credit stays beside the choice and review opens without a signature or order', async ({ page }) => {
  const { writes, wallet } = await fixture(page, { saved: SAVED });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await ready(page);
  await expect(page.locator('.om-package-budget')).toContainText('$15.00');
  await expect(page.locator('.om-package-budget')).toContainText(/sample/i);
  const review = page.getByRole('button', { name: 'Review package', exact: true });
  const box = await review.boundingBox();
  const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
  await review.click();
  await expect(page.getByRole('dialog')).toContainText('Preview only.');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Add to preview', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(review).toBeFocused();
  expect(wallet.calls()).toEqual([]);
  expect(writes).toEqual([]);
});

test('live package review continues to the named eSIM screen without submitting an order', async ({ page }) => {
  const { writes, wallet } = await fixture(page, { live: true });
  await page.goto('/#/app/plans');
  await ready(page);
  await expect(page.locator('.om-plan-budget')).toContainText('$15.00');
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const next = page.getByRole('dialog').getByRole('button', { name: 'Continue to eSIMs', exact: true });
  await expect(next).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/#\/app\/esims$/);
  await expect(page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true })).toHaveAttribute('aria-current', 'page');
  // The member's wallet reconnected silently; nothing was signed, sent or prompted for.
  expect(wallet.calls().some(call => call.method === 'connect' && call.silent)).toBe(true);
  expect(approvals(wallet)).toEqual([]);
  expect(writes).toEqual([]);
});
