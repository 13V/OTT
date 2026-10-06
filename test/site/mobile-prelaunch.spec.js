'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const CFG = require('../../site/config/esim.json');
const json = body => ({ contentType: 'application/json', body: JSON.stringify(body) });
test.use({ serviceWorkers: 'block' });

test('device checks work before launch without a wallet approval, installation link or order', async ({ page }) => {
  stubNetwork(page);
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url()); });
  await page.addInitScript(() => {
    window.prelaunchWalletMethods = [];
    window.ethereum = { request: async ({ method }) => {
      window.prelaunchWalletMethods.push(method);
      if (method === 'eth_accounts') return [];
      throw new Error('Device checks must not ask for wallet approval');
    } };
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#/app/help');
  const check = page.getByRole('button', { name: 'Check your phone', exact: true });
  await check.click();
  const sheet = page.getByRole('dialog', { name: 'Check your phone', exact: true });
  await expect(sheet).toContainText('while OTT is in prelaunch');
  await expect(sheet).toContainText('No SIM restrictions');
  await expect(sheet).toContainText('OTT cannot detect your phone’s eSIM support or carrier lock.');
  await expect(sheet.getByRole('link', { name: 'Apple’s carrier lock guide ↗', exact: true })).toHaveAttribute('href', 'https://support.apple.com/en-us/109316');
  const devices = sheet.getByRole('group', { name: 'Device to check', exact: true });
  await devices.getByRole('button', { name: 'Google Pixel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(devices.getByRole('button', { name: 'Google Pixel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.om-settings-path')).toHaveText('Settings → Network & internet → SIMs → Add SIM → Set up an eSIM');
  await expect(sheet).toContainText('An Add eSIM option alone does not confirm that it is unlocked.');
  await expect(sheet.getByRole('link', { name: 'Google Pixel eSIM guidance ↗', exact: true })).toHaveAttribute('href', 'https://support.google.com/pixelphone/answer/16115470?hl=en');
  await devices.getByRole('button', { name: 'Samsung Galaxy', exact: true }).click();
  await expect(devices.getByRole('button', { name: 'Samsung Galaxy', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.om-settings-path')).toHaveText('Settings → Connections → SIM manager → Add eSIM');
  await expect(sheet.getByRole('link', { name: 'Samsung Galaxy eSIM guidance ↗', exact: true })).toHaveAttribute('href', 'https://www.samsung.com/us/support/answer/ANS10001619/');
  await expect(sheet.locator('a[href^="https://esimsetup"]')).toHaveCount(0);
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(check).toBeFocused();
  expect(await page.evaluate(() => window.prelaunchWalletMethods)).toEqual(['eth_accounts']);
  expect(writes).toEqual([]);
});

test('an empty or invalid catalogue shows a recoverable state and keeps the setup guide usable', async ({ page }) => {
  stubNetwork(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let packages = [];
  await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, packages })));
  await page.goto('/#/app');
  await expect(page.locator('.om-status-pill')).toHaveText('Offline');
  await expect(page.getByRole('heading', { name: 'You’re offline, or OTT couldn’t load.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the app preview', exact: true })).toHaveCount(0);
  packages = [null, {}, { ...CFG.packages[0], priceUsd: -1 }, { ...CFG.packages[0], days: 0 }];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.om-status-pill')).toHaveText('Offline');
  await page.getByRole('link', { name: 'Open the setup guide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check your phone', exact: true })).toBeVisible();
  packages = [null, {}, ...CFG.packages];
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.om-status-pill')).toHaveText('Prelaunch');
  await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$15.00');
  expect(errors).toEqual([]);
});

test('zero token addresses never make the app advertise a configured programme', async ({ page }) => {
  stubNetwork(page);
  const zero = '0x' + '0'.repeat(40);
  await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, coin: zero, curve: zero, treasury: zero })));
  await page.goto('/#/app/plans');
  await expect(page.locator('.om-status-pill')).toHaveText('Prelaunch');
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Membership enrolment and purchases are not open.');
  await expect(page.getByRole('button', { name: 'Continue to eSIMs', exact: true })).toHaveCount(0);
});
