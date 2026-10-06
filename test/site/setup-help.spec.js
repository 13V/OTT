'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const CFG = require('../../site/config/esim.json');
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
test.use({ serviceWorkers: 'block' });

async function readOnlyFixture(page) {
  stubNetwork(page);
  const apiRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.fixtureHelpWalletMethods = [];
    window.fixtureHelpStorageWrites = [];
    for (const name of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (...args) {
        window.fixtureHelpStorageWrites.push(name);
        return original.apply(this, args);
      };
    }
    window.ethereum = { request: async ({ method }) => {
      window.fixtureHelpWalletMethods.push(method);
      if (method === 'eth_accounts') return [];
      throw new Error('Help must not request a wallet action');
    } };
  });
  return apiRequests;
}

async function checkReadOnly(page, apiRequests) {
  expect(await page.evaluate(() => window.fixtureHelpWalletMethods)).toEqual(['eth_accounts']);
  expect(await page.evaluate(() => window.fixtureHelpStorageWrites)).toEqual([]);
  expect(apiRequests).toEqual([]);
}

async function fitsDialog(sheet) {
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test('offline troubleshooting gives phone-specific checks and returns keyboard focus without wallet or account activity', async ({ page }) => {
  const apiRequests = await readOnlyFixture(page);
  await page.route('**/config/esim.json', route => route.abort());
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/#/app/help');
  const source = page.getByRole('button', { name: 'Installed but no data?', exact: true });
  await source.click();
  const sheet = page.getByRole('dialog', { name: 'Installed but no data?', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(/\bnull\b/);
  await expect(sheet).toContainText('OTT cannot detect whether your eSIM is installed or connected.');
  await expect(sheet.locator('li')).toHaveCount(4);
  await expect(sheet).toContainText('Turn On This Line');
  await expect(sheet.getByRole('link', { name: 'Apple’s cellular data guide ↗', exact: true })).toHaveAttribute('href', 'https://support.apple.com/en-us/118227');
  await expect(sheet.getByRole('link', { name: 'Apple’s roaming guide ↗', exact: true })).toHaveAttribute('href', 'https://support.apple.com/en-us/109037');
  await fitsDialog(sheet);
  const android = sheet.getByRole('group', { name: 'Phone type', exact: true }).getByRole('button', { name: 'Android', exact: true });
  await android.focus();
  await page.keyboard.press('Enter');
  await expect(android).toHaveAttribute('aria-pressed', 'true');
  await expect(android).toBeFocused();
  await expect(sheet).toContainText('Use SIM and Mobile data');
  await expect(sheet).toContainText('Leave your regular line’s roaming settings alone.');
  await expect(sheet).toContainText('turn Wi-Fi back on and contact your eSIM provider');
  await expect(sheet).toContainText('Keep your QR and activation code private');
  await expect(sheet.getByRole('link', { name: 'Google Pixel mobile data guide ↗', exact: true })).toHaveAttribute('href', 'https://support.google.com/pixelphone/answer/2926415?hl=en');
  await expect(sheet.getByRole('link', { name: 'Google Pixel troubleshooting ↗', exact: true })).toHaveAttribute('href', 'https://support.google.com/pixelphone/answer/14116080?hl=en');
  await expect(sheet.getByRole('link')).toHaveCount(2);
  await fitsDialog(sheet);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(source).toBeFocused();
  await checkReadOnly(page, apiRequests);
});

test('package review opens compatibility guidance and preserves its selection and focus on small phones', async ({ page }) => {
  const apiRequests = await readOnlyFixture(page);
  const pkg = CFG.packages.find(value => value.slug === 'japan' && value.gb === 10);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#/app/plans');
    await page.getByRole('button', { name: /^Choose coverage\./ }).click();
    const picker = page.getByRole('dialog');
    await picker.getByLabel('Search a country or region', { exact: true }).fill('Japan');
    await picker.getByRole('button', { name: 'Japan', exact: true }).click();
    await page.getByRole('group', { name: 'Package size', exact: true }).getByRole('button', { name: /^10 GB,/ }).click();
    const reviewSource = page.getByRole('button', { name: 'Review package', exact: true });
    await reviewSource.click();
    const review = page.getByRole('dialog', { name: 'Japan data plan', exact: true });
    const checker = review.getByRole('button', { name: 'Check your phone', exact: true });
    await checker.click();
    const device = page.getByRole('dialog', { name: 'Check your phone', exact: true });
    await expect(device).toBeVisible();
    await expect(device).toContainText('OTT cannot detect your phone’s eSIM support or carrier lock.');
    await device.getByRole('button', { name: 'Google Pixel', exact: true }).click();
    await expect(device.locator('.om-settings-path')).toContainText('Network & internet');
    await fitsDialog(device);
    expect(await page.locator('dialog [id]').evaluateAll(elements => new Set(elements.map(element => element.id)).size === elements.length)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(device).toHaveCount(0);
    await expect(review).toBeVisible();
    await expect(checker).toBeFocused();
    await expect(review).toContainText('10 GB');
    await expect(review).toContainText(pkg.days + ' days');
    await expect(review).toContainText('$' + pkg.priceUsd.toFixed(2));
    await fitsDialog(review);
    await review.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reviewSource).toBeFocused();
    await expect(page.getByRole('button', { name: /^10 GB,/ })).toHaveAttribute('aria-pressed', 'true');
  }
  await checkReadOnly(page, apiRequests);
});

test('sample troubleshooting explains that sample eSIMs cannot connect and makes no account request', async ({ page }) => {
  const apiRequests = await readOnlyFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
  const help = page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Help', exact: true });
  await help.click();
  await expect(help).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Installed but no data?', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Installed but no data?', exact: true });
  await expect(sheet).toContainText('Preview only. Sample eSIMs cannot connect to a mobile network.');
  await fitsDialog(sheet);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.om-preview-banner')).toContainText('No real orders.');
  await checkReadOnly(page, apiRequests);
});

test('authorized setup can open troubleshooting and return to its final step without another signature or order', async ({ page }) => {
  stubNetwork(page);
  const address = '0x4444444444444444444444444444444444444444';
  const week = Math.floor((Date.now() / 1000 - 345600) / 604800);
  const order = { n: 0, week, transactionId: 'fixture-help', packageCode: 'fixed_5GB_30D_US', priceUsd: 7.99,
    iccid: 'fixture-help-iccid', stage: 'done', pending: false, codes: false, createdAt: new Date().toISOString() };
  const posts = [];
  await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, coin: '0x1111111111111111111111111111111111111111',
    curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' })));
  await page.route('**/api/redeem**', route => {
    const signed = route.request().method() === 'POST';
    if (signed) posts.push(route.request().postDataJSON());
    return route.fulfill(json({ ok: true, address, week, weekEnd: 345600 + (week + 1) * 604800, tokens: '1234000000000000000000',
      share: 0.01, allowanceUsd: 20, decimals: 18, redeemedUsd: 7.99, remainingUsd: 12.01, stale: false,
      orders: [signed ? { ...order, codes: true, ac: 'LPA:1$smdp.fixture.example$FAKE-HELP-CODE' } : order], history: [], sims: [] }));
  });
  await page.addInitScript(address => {
    window.fixtureHelpSignatures = 0;
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'personal_sign') { window.fixtureHelpSignatures++; return '0xfixture-help-signature'; }
      throw new Error('Unexpected fixture wallet request: ' + method);
    } };
  }, address);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await page.getByRole('button', { name: 'Set up this eSIM', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Set up your United States eSIM', exact: true });
  await setup.getByRole('button', { name: 'Next step', exact: true }).click();
  await setup.getByRole('button', { name: 'Next step', exact: true }).click();
  const source = setup.getByRole('button', { name: 'Installed but no data?', exact: true });
  await source.click();
  const sheet = page.getByRole('dialog', { name: 'Installed but no data?', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText('FAKE-HELP-CODE');
  await fitsDialog(sheet);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(source).toBeFocused();
  await expect(setup.getByRole('heading', { name: 'Choose it for mobile data', exact: true })).toBeVisible();
  await setup.getByRole('button', { name: 'Back to eSIMs', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).not.toHaveProperty('packageCode');
  expect(await page.evaluate(() => window.fixtureHelpSignatures)).toBe(1);
});
