'use strict';
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const catalogue = require('../../site/config/esim.json');

const addr = '0x4ca685f4a1cd39ba0d0f1cd06b3f2b0f5b7cdd11';
const launched = Object.assign({}, catalogue, {
  coin: '0x1111111111111111111111111111111111111111',
  curve: '0x2222222222222222222222222222222222222222',
  treasury: '0x3333333333333333333333333333333333333333',
});
const respond = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('destination search, no results, and coverage selection use the catalogue', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await page.goto('/index.html#/');
  const search = page.getByRole('searchbox', { name: 'Where will you use your data?' });
  const plans = page.locator('.ott-plan-details');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('United States');
  await expect(page.locator('.ott-coverage-result')).not.toContainText('null');
  await expect(plans).not.toHaveAttribute('open', '');
  await expect(page.locator('.plan-grid')).toBeHidden();
  await search.fill('Japan');
  await expect(page.locator('.destination-result')).toHaveCount(1);
  await expect(page.locator('.destination-result')).toContainText('Country');
  await page.locator('.destination-result').click();
  await expect(page.locator('#plan-place')).toHaveValue('japan');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Japan');
  await expect(plans).not.toHaveAttribute('open', '');
  await search.fill('Europe');
  await search.press('Enter');
  await expect(page.locator('#plan-place')).toHaveValue('europe');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Europe');
  await expect(page.locator('.ott-coverage-availability')).toHaveText('3 packages available for use in Europe.');
  await search.fill('Atlantis');
  await expect(page.locator('.destination-empty')).toContainText('No matching place');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.destination-results')).toBeHidden();
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Europe');
  await page.locator('.coverage-details summary').click();
  await page.locator('.cov-item').filter({ hasText: 'Germany' }).click();
  await expect(page.locator('#plan-place')).toHaveValue('germany');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  await plans.locator('summary').click();
  await expect(page.locator('.plan-card')).toHaveCount(3);
  await expect(page.locator('.plan-card').first()).toContainText('DATA CREDIT REQUIRED');
  const prices = catalogue.packages.filter((item) => item.slug === 'germany').sort((a, b) => a.gb - b.gb).map((item) => '$' + item.priceUsd.toFixed(2));
  await expect(page.locator('.plan-price')).toHaveText(prices);
  expect(errors).toEqual([]);
});

test('coverage falls back to Japan when US packages are absent without inventing US availability', async ({ page }) => {
  stubNetwork(page);
  const noUS = Object.assign({}, catalogue, { packages: catalogue.packages.filter((item) => item.slug !== 'united-states') });
  await page.route('**/config/esim.json', (route) => route.fulfill(respond(noUS)));
  await page.goto('/index.html#/');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Japan');
  await page.getByRole('searchbox', { name: 'Where will you use your data?' }).fill('United States');
  await expect(page.locator('.destination-empty')).toContainText('No matching place');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Japan');
});

test('prelaunch account route explains availability and offers a useful return', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/index.html#/');
  await page.locator('#coverage').scrollIntoViewIfNeeded();
  await page.locator('#nav a[data-route="data"]').click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(page.locator('#view h1')).toHaveText('My data');
  await expect(page.locator('.dashboard-empty')).toContainText('there is no weekly credit or eSIM redemption yet');
  await page.getByRole('link', { name: 'Explore destinations' }).click();
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
});

test('prelaunch status treats a static preview as prelaunch rather than a live outage', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/index.html#/status');
  await expect(page.locator('.status-summary')).toContainText('weekly credit and redemptions are not available yet');
  await expect(page.locator('.status-strip')).toContainText('Live service checks begin after launch');
  await expect(page.locator('.status-strip')).toContainText('not active until coin launch');
});

test('a live plan selection carries into the connected dashboard without an order', async ({ page }) => {
  stubNetwork(page);
  await page.route('**/config/esim.json', (route) => route.fulfill(respond(launched)));
  const now = Math.floor(Date.now() / 1000);
  const week = Math.floor((now - 345600) / 604800);
  const weekEnd = 345600 + (week + 1) * 604800;
  await page.route('**/data/allowances.json', (route) => route.fulfill(respond({
    week, weekEnd, decimals: 18, budgetUsd: 500, circulating: '1000000000000000000000000',
    wallets: { [addr]: { tokens: '1000000000000000000000', share: .001, allowanceUsd: 30 } },
  })));
  await page.route('**/api/redeem?address=*', (route) => route.fulfill(respond({
    ok: true, address: addr, week, weekEnd, decimals: 18, stale: false,
    tokens: '1000000000000000000000', share: .001, allowanceUsd: 30,
    redeemedUsd: 0, remainingUsd: 30, orders: [], history: [], sims: [],
  })));
  await page.addInitScript((address) => {
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x1237';
      return null;
    } };
  }, addr);
  await page.goto('/index.html#/');
  await page.locator('.ott-plan-details summary').click();
  await page.locator('#plan-place').selectOption('japan');
  await page.locator('.plan-card').filter({ hasText: '5 GB' }).getByRole('link', { name: 'Select this plan' }).click();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(page.locator('#f-place')).toHaveValue('japan');
  await expect(page.locator('#f-package')).toHaveValue('fixed_5GB_30D_JP');
  await expect(page.locator('.data-mine')).toContainText('Your data');
});

test('narrow layout has usable navigation and no horizontal overflow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/index.html#/');
  await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(page.locator('#nav')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nav')).toBeHidden();
  await expect(page.locator('#nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.locator('.ott-plan-details summary').click();
  await page.locator('#plan-place').selectOption('united-states');
  await expect(page.locator('.plan-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('.coverage-details summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  expect(errors).toEqual([]);
});

test('the mobile clay hero explains the product and routes prelaunch visitors to launch status', async ({ page }) => {
  stubNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html#/');
  await expect(page.locator('.hero-visual')).toBeVisible();
  await expect(page.locator('.ott-hero-title')).toHaveText('A memecoin with a data plan.');
  const caption = page.locator('.ott-hero-caption').getByRole('img', { name: 'Touch Grass, Stay Online.', exact: true });
  await expect(caption).toBeVisible();
  await expect.poll(() => caption.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  const image = page.locator('.ott-hero-scene > img');
  await expect(image).toHaveAttribute('src', './assets/ott/hero-touch-grass.webp');
  await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.ott-hero-note')).toContainText('Weekly credit and redemption are not available yet.');
  await expect(page.locator('.ott-token-strip')).toContainText('Prelaunch');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('.ott-hero-actions').getByRole('link', { name: 'How it works' }).click();
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('how-it-works').getBoundingClientRect().top))).toBeLessThan(130);
  const primary = page.locator('.ott-hero-actions').getByRole('link', { name: 'Check launch status', exact: true });
  await expect(primary).toHaveAttribute('href', '#/status');
  await primary.click();
  await expect(page).toHaveURL(/#\/status$/);
  await expect(page.locator('.status-summary')).toContainText('weekly credit and redemptions are not available yet');
});

test('a configured hero opens My data without requesting wallet access or an order', async ({ page }) => {
  stubNetwork(page);
  await page.route('**/config/esim.json', (route) => route.fulfill(respond(launched)));
  await page.addInitScript(() => {
    window.__heroWalletMethods = [];
    window.ethereum = { request: async ({ method }) => {
      window.__heroWalletMethods.push(method);
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return '0x1237';
      return null;
    } };
  });
  const orderWrites = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/(redeem|sim|sign)/.test(request.url())) orderWrites.push(request.url());
  });
  await page.goto('/index.html#/');
  await expect(page.locator('.ott-token-strip')).toContainText('Programme configured');
  const primary = page.locator('.ott-hero-actions').getByRole('link', { name: 'Check my credit', exact: true });
  await expect(primary).toHaveAttribute('href', '#/data');
  await primary.click();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(page.locator('#view h1')).toHaveText('My data');
  await expect(page.locator('.data-mine')).toContainText('Connect');
  const walletMethods = await page.evaluate(() => window.__heroWalletMethods);
  expect(walletMethods).not.toContain('eth_requestAccounts');
  expect(walletMethods).not.toContain('eth_sendTransaction');
  expect(walletMethods).not.toContain('personal_sign');
  expect(orderWrites).toEqual([]);
});

test('a featured destination in the catalogue updates coverage while the Tokyo illustration keeps its identity', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/index.html#/');
  const shortcuts = page.locator('#plans .ott-coverage-shortcuts');
  await expect(shortcuts).toBeVisible();
  await shortcuts.locator('.ott-destination-shortcut[data-slug="europe"]').click();
  await expect(page.locator('#plan-place')).toHaveValue('europe');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Europe');
  await expect(page.locator('.ott-plan-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.ott-scene-caption strong')).toHaveText('Shibuya, Tokyo');
  await expect(page.locator('#plan-place')).toHaveValue('europe');
  await page.locator('.ott-plan-details summary').click();
  await page.locator('#plan-place').selectOption('germany');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  await expect(page.locator('.ott-scene-caption strong')).toHaveText('Shibuya, Tokyo');
  await expect(page.locator('.ott-travel-image img')).toHaveAttribute('src', './assets/ott/shibuya-clay.webp');
});

test('allocation example is clearly illustrative and computes real input changes', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/index.html#/');
  await expect(page.locator('.ott-statement')).toContainText('SAMPLE ACCOUNT. EXAMPLE ONLY.');
  await expect(page.locator('.ott-example')).not.toHaveAttribute('open', '');
  await expect(page.locator('.ott-example-label')).toContainText('Example only. This is not your balance or a forecast.');
  await expect(page.locator('.ott-allocation-result')).toHaveText('$10.00');
  await expect(page.locator('.ott-allocation-explanation')).toContainText('1% of the $1,000.00 weekly budget');
  await page.locator('.ott-example summary').click();
  await page.locator('#ott-example-share').fill('0');
  await expect(page.locator('.ott-allocation-result')).toHaveText('$0.00');
  await expect(page.locator('.ott-allocation-percentage')).toHaveText('0%');
  await page.locator('#ott-example-share').fill('101');
  await expect(page.locator('.ott-allocation-result')).toHaveText('—');
  await expect(page.locator('.ott-example-error')).toContainText('share from 0% to 100%');
  await page.locator('#ott-example-share').fill('2.5');
  await expect(page.locator('.ott-allocation-result')).toHaveText('$25.00');
  await expect(page.locator('.ott-allocation-percentage')).toHaveText('2.5%');
  await expect(page.locator('.ott-allocation-explanation')).toContainText('$25.00 in data credit');
  await page.locator('#ott-example-budget').fill('0');
  await expect(page.locator('.ott-allocation-result')).toHaveText('$0.00');
  await expect(page.locator('.ott-allocation-budget')).toHaveText('$0.00');
  await expect(page.locator('.ott-statement-balance')).toContainText('$15.00');
});

test('destinations navigation from Status opens the catalogue on home', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/index.html#/status');
  await page.locator('#nav').getByRole('link', { name: 'Destinations' }).click();
  await expect(page.locator('#plans h2')).toHaveText('Use it at home. Take it with you.');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('plans').getBoundingClientRect().top))).toBeLessThan(130);
});
