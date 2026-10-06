'use strict';
let pwTest;
try { pwTest = require('@playwright/test'); } catch (_) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const catalogue = require('../../site/config/esim.json');

test('My data example switches between credit and eSIMs without issuing a package or using a wallet', async ({ page }) => {
  const network = stubNetwork(page);
  const writes = [];
  page.on('request', (request) => { if (request.method() !== 'GET' && !request.url().match(/robinhood|ordofi|publicnode/)) writes.push(request.url()); });
  await page.goto('/index.html#/');
  const preview = page.locator('.ott-account-preview');
  await expect(preview.getByRole('heading', { name: 'Your wallet. Your data.' })).toBeVisible();
  await expect(preview.locator('.ott-statement')).toContainText('SAMPLE MEMBER ACCOUNT. EXAMPLE ONLY.');
  await expect(preview.locator('.ott-statement-balance')).toContainText('$15.00');
  await expect(preview.locator('.ott-ap-credit-stats')).toContainText('$20.00');
  await expect(preview.locator('.ott-ap-credit-stats')).toContainText('$5.00');
  await expect(preview.getByRole('button', { name: 'Data balance', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.locator('#account-esim-example')).toBeHidden();
  await preview.getByRole('button', { name: 'eSIMs', exact: true }).click();
  await expect(preview.getByRole('button', { name: 'eSIMs', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.locator('#account-credit-example')).toBeHidden();
  await expect(preview.locator('#account-esim-example')).toBeVisible();
  await expect(preview.locator('#account-esim-example')).toContainText('Sample eSIM');
  await expect(preview.locator('#account-esim-example')).toContainText('Japan');
  await expect(preview.locator('.ott-ap-package-size')).toHaveText('5GB');
  await expect(preview.locator('.ott-ap-package-bottom')).toContainText('30 days');
  await expect(preview.locator('#account-esim-example')).toContainText('Each package has its own validity');
  await preview.getByRole('button', { name: 'Data balance', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(preview.locator('#account-credit-example')).toBeVisible();
  await expect(preview.locator('#account-credit-example')).toContainText('Fees fund the data pool');
  await expect(preview.locator('.ott-ap-footnote')).toContainText('Membership enrolment is not open.');
  await expect(preview.locator('.ott-ap-intro')).toContainText('No wallet needed. No real orders.');
  const exploreApp = preview.getByRole('link', { name: 'Explore the app' });
  await expect(exploreApp).toHaveAttribute('href', '#/app');
  await exploreApp.click();
  await expect(page).toHaveURL(/#\/app$/);
  await expect(page.getByRole('button', { name: 'Try the app preview', exact: true })).toBeVisible();
  await expect(page.locator('#wallet-gate')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(network.blocked).toEqual([]);
});

test('configured launch links to My data while preserving the example label and sample figures', async ({ page }) => {
  stubNetwork(page);
  const live = { ...catalogue, coin: '0x' + '1'.repeat(40), curve: '0x' + '2'.repeat(40), treasury: '0x' + '3'.repeat(40) };
  await page.route('**/config/esim.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(live) }));
  await page.goto('/index.html#/');
  const preview = page.locator('.ott-account-preview');
  await expect(preview.getByRole('link', { name: 'Open My data' })).toHaveAttribute('href', '#/data');
  await expect(preview.locator('.ott-statement')).toContainText('SAMPLE MEMBER ACCOUNT. EXAMPLE ONLY.');
  await expect(preview.locator('.ott-statement-balance')).toContainText('$15.00');
  await expect(preview.locator('.ott-ap-demo-wallet')).toHaveText('Sample member account');
});

test('the account preview stays readable and operable at phone widths with reduced motion', async ({ page }) => {
  stubNetwork(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/index.html#/');
    const preview = page.locator('.ott-account-preview');
    await preview.scrollIntoViewIfNeeded();
    for (const button of ['Data balance', 'eSIMs']) {
      const control = preview.getByRole('button', { name: button, exact: true });
      const size = await control.boundingBox();
      expect(size.height).toBeGreaterThanOrEqual(44);
      expect(size.x).toBeGreaterThanOrEqual(0);
      expect(size.x + size.width).toBeLessThanOrEqual(width);
      await control.click();
    }
    const bounds = await preview.locator('.ott-ap-device').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(preview.locator('.ott-ap-footnote')).toBeVisible();
  }
});
