'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
test.use({ serviceWorkers: 'block' });
const ADDRESS = '0x4444444444444444444444444444444444444444';
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const CFG = { ...require('../../site/config/esim.json'), coin: '0x1111111111111111111111111111111111111111',
  curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' };
const STANDING = { ok: true, address: ADDRESS, week: WEEK, weekEnd: 345600 + (WEEK + 1) * 604800,
  tokens: '1000000000000000000000', decimals: 18, share: 0.01, allowanceUsd: 10, redeemedUsd: 0,
  remainingUsd: 10, stale: false, orders: [], history: [], sims: [] };
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
async function fixture(page, reject = false) {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  await page.route('**/data/allowances.json', route => route.fulfill(json({ week: WEEK, weekEnd: STANDING.weekEnd, decimals: 18,
    wallets: { [ADDRESS]: { tokens: STANDING.tokens, share: 0.01, allowanceUsd: 10 } } })));
  await page.addInitScript(({ address, reject }) => {
    window.recoveryWalletMethods = [];
    window.rejectRecoveryApproval = reject;
    window.ethereum = { on() {}, request: async ({ method }) => {
      window.recoveryWalletMethods.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'personal_sign') {
        if (window.rejectRecoveryApproval) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        if (window.pauseRecoveryApproval) await new Promise(resolve => { window.resolveRecoveryApproval = resolve; });
        return '0x' + 'ab'.repeat(65);
      }
      throw new Error('Unexpected fixture wallet method');
    } };
  }, { address: ADDRESS, reject });
}
function order(body, pending = true) {
  const pkg = CFG.packages.find(value => value.code === body.packageCode);
  return { n: body.n, week: WEEK, packageCode: pkg.code, transactionId: 'fixture-order-' + body.n,
    priceUsd: pkg.priceUsd, iccid: pending ? '' : 'fixture-iccid', stage: pending ? 'invoiced' : 'done', pending,
    codes: false, ac: '', createdAt: new Date().toISOString() };
}

test('a lost accepted response recovers the existing order with a GET and no second purchase', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  const posts = [];
  let standing = STANDING;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'GET') return route.fulfill(json(standing));
    const body = route.request().postDataJSON(); posts.push(body);
    const accepted = order(body);
    standing = { ...STANDING, orders: [accepted], redeemedUsd: accepted.priceUsd, remainingUsd: 10 - accepted.priceUsd };
    return route.abort('failed');
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('#f-place')).toBeDisabled();
  await expect(page.locator('.data-order-progress')).toHaveAttribute('data-phase', 'checking');
  await expect(page.locator('.data-order-progress')).not.toContainText('The provider is issuing your data package.');
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  await expect(page.locator('.data-sims')).toContainText('Paying the invoice');
  expect(posts).toHaveLength(1);
  expect(await page.evaluate(() => window.recoveryWalletMethods.filter(method => method === 'personal_sign').length)).toBe(1);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('fixture-order');
});

test('checking an unseen order permits only an explicit retry of the same plan and slot', async ({ page }) => {
  await fixture(page);
  const posts = [];
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'GET') return route.fulfill(json(STANDING));
    const body = route.request().postDataJSON(); posts.push(body);
    if (posts.length === 1) return route.abort('failed');
    const accepted = order(body, false);
    return route.fulfill(json({ ok: true, order: accepted, remainingUsd: 10 - accepted.priceUsd, sims: [] }));
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same order', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('#f-place')).toBeDisabled();
  expect(posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry same order', exact: true }).click();
  await expect(page.locator('.data-sims')).toContainText('fixture-iccid');
  expect(posts).toHaveLength(2);
  expect(posts[1].n).toBe(posts[0].n); expect(posts[1].packageCode).toBe(posts[0].packageCode);
});

test('a declined signature leaves the plan retryable without sending a purchase', async ({ page }) => {
  await fixture(page, true);
  let posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() !== 'GET') posts++;
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('User rejected the request.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(page.locator('#f-place')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  expect(posts).toBe(0);
});

test('route changes preserve the unconfirmed plan and mismatched reads cannot unlock it', async ({ page }) => {
  await fixture(page);
  let foreign = false, posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') { posts++; return route.abort('failed'); }
    return route.fulfill(json(foreign ? { ...STANDING, address: '0x5555555555555555555555555555555555555555',
      orders: [{ ...order({ packageCode: CFG.packages[0].code, n: 0 }), ac: 'PRIVATE-FOREIGN-CODE' }] } : STANDING));
  });
  await page.goto('/#/app/esims');
  await page.locator('#f-place').selectOption('australia');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Help', exact: true }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toBeVisible();
  await expect(page.locator('#f-place')).toHaveValue('australia');
  foreign = true;
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.locator('.data-order-recovery')).toContainText('could not be checked');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('PRIVATE-FOREIGN-CODE');
  expect(posts).toBe(1);
});

test('leaving the account during wallet approval cancels a purchase before dispatch', async ({ page }) => {
  await fixture(page);
  let posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  await page.evaluate(() => { window.pauseRecoveryApproval = true; });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.getByRole('status', { name: 'Order progress', exact: true })).toHaveAttribute('data-phase', 'wallet');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Help', exact: true }).click();
  await page.evaluate(() => { window.pauseRecoveryApproval = false; window.resolveRecoveryApproval(); });
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  expect(posts).toBe(0);
});

test('connected eSIMs precede expandable holdings details on phones and desktop', async ({ page }) => {
  await fixture(page);
  const existing = order({ packageCode: 'fixed_1GB_7D_AU', n: 0 }, false);
  await page.route('**/api/redeem**', route => route.fulfill(json({ ...STANDING, orders: [existing] })));
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    await page.goto('/#/app/esims');
    await page.reload();
    await expect(page.locator('.data-sims')).toBeVisible();
    await expect(page.locator('.data-account-details')).not.toHaveAttribute('open', '');
    expect(await page.locator('.data-sims').evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.data-account-details')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.locator('.data-account-details > summary').click();
    await expect(page.locator('.data-headline')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
