'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });

const ADDRESS = '0x4444444444444444444444444444444444444444';
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const WEEK_END = 345600 + (WEEK + 1) * 604800;
const CFG = { ...require('../../site/config/esim.json'), coin: '0x1111111111111111111111111111111111111111',
  curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' };
const ORDER = { n: 0, week: WEEK, transactionId: 'fixture-setup', packageCode: 'fixed_5GB_30D_US', priceUsd: 7.99,
  iccid: 'fixture-setup-iccid', createdAt: new Date().toISOString(), stage: 'done', pending: false, codes: true,
  ac: 'LPA:1$smdp.fixture.example$SETUP-CODE', qrCodeUrl: '', smdpAddress: 'smdp.fixture.example', matchingId: 'SETUP-CODE',
  appleInstallUrl: 'https://esimsetup.apple.com/es?carddata=fixture-only', androidInstallUrl: 'https://provider.fixture.example/install/fixture-only' };
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
const redacted = order => ({ ...order, codes: false, ac: '', qrCodeUrl: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '' });
const standing = orders => ({ ok: true, address: ADDRESS, week: WEEK, weekEnd: WEEK_END,
  tokens: '1234000000000000000000', share: 0.01, allowanceUsd: 20, decimals: 18, redeemedUsd: 7.99,
  remainingUsd: 12.01, stale: false, orders, history: [], sims: [] });

async function setupFixture(page, { order = ORDER, prelaunch = false } = {}) {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(prelaunch ? { ...CFG, coin: '', curve: '', treasury: '' } : CFG)));
  await page.route('**/config/app.json', route => route.fulfill(json({ walletConnect: { projectId: '' }, apiBaseUrl: '' })));
  const requests = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    requests.push({ method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
    return route.fulfill(json(standing([request.method() === 'POST' ? order : redacted(order)])));
  });
  await page.addInitScript(address => {
    window.fixtureSetupMethods = [];
    window.fixtureSetupHandlers = {};
    window.fixtureSetupCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureSetupCopies.push(value); } } });
    window.ethereum = {
      request: async ({ method }) => {
        window.fixtureSetupMethods.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') {
          if (window.rejectSetupSignature) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          if (window.deferSetupSignature) return new Promise(resolve => { window.finishSetupSignature = () => resolve('0xfixture-setup-signature'); });
          return '0xfixture-setup-signature';
        }
        throw new Error('Unexpected wallet request: ' + method);
      },
      on: (event, callback) => { window.fixtureSetupHandlers[event] = callback; },
      off: (event, callback) => { if (window.fixtureSetupHandlers[event] === callback) delete window.fixtureSetupHandlers[event]; },
    };
  }, ADDRESS);
  return requests;
}

async function reveal(page) {
  await page.goto('/#/app/esims');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
}

async function openSetup(page) {
  const button = page.getByRole('button', { name: 'Set up this eSIM', exact: true });
  await button.click();
  const sheet = page.getByRole('dialog', { name: 'Set up your United States eSIM', exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('authorized setup guides both phone types and copies details only after an explicit action', async ({ page }) => {
  const requests = await setupFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await reveal(page);
  const sheet = await openSetup(page);
  await expect(sheet.getByRole('heading', { name: 'Before you start', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await expect(sheet).toContainText('Wi-Fi');
  await expect(sheet.getByRole('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual([]);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet.getByRole('heading', { name: 'Add the eSIM', exact: true })).toBeFocused();
  await expect(sheet.getByRole('link', { name: 'Open iPhone installation', exact: true })).toHaveAttribute('href', ORDER.appleInstallUrl);
  await expect(sheet.getByRole('img', { name: 'Installation QR code for United States', exact: true })).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(sheet).toContainText('Safari on iOS 17.4');
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual([]);
  await sheet.getByRole('button', { name: 'Copy SM-DP+ address', exact: true }).click();
  await sheet.getByRole('button', { name: 'Copy Activation code', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual(['smdp.fixture.example', 'SETUP-CODE']);
  await sheet.getByRole('button', { name: 'Android', exact: true }).click();
  await expect(sheet.getByRole('link', { name: 'Open Android installation', exact: true })).toHaveAttribute('href', ORDER.androidInstallUrl);
  await expect(sheet.getByRole('link', { name: 'Open iPhone installation', exact: true })).toHaveCount(0);
  await expect(sheet).toContainText('Network & internet');
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet.getByRole('heading', { name: 'Choose it for mobile data', exact: true })).toBeVisible();
  await expect(sheet).toContainText('OTT can’t detect whether your phone has finished installation or connected.');
  await sheet.getByRole('button', { name: 'Back to eSIMs', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toBeFocused();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(requests.filter(request => request.method === 'POST').every(request => !request.body.packageCode)).toBe(true);
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(1);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('SETUP-CODE');
  expect(storage).not.toContain(ORDER.ac);
  expect(page.url()).not.toContain('SETUP-CODE');
});

test('manual setup parses the supplied LPA string without inventing an install link', async ({ page }) => {
  await setupFixture(page, { order: { ...ORDER, smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '' } });
  await reveal(page);
  const sheet = await openSetup(page);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet.getByRole('link', { name: /installation/ })).toHaveCount(0);
  await expect(sheet).toContainText('smdp.fixture.example');
  await expect(sheet).toContainText('SETUP-CODE');
  await sheet.getByRole('button', { name: 'Copy Activation code', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual(['SETUP-CODE']);
});

test('supplied activation strings generate local QR codes for the card and phone guide without requesting a provider image', async ({ page }) => {
  const remoteQR = 'https://qr.fixture.example/activation.svg?profile=fixture-only';
  await setupFixture(page, { order: { ...ORDER, qrCodeUrl: remoteQR } });
  const remoteRequests = [];
  page.on('request', request => { if (request.url().startsWith('https://qr.fixture.example/')) remoteRequests.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await reveal(page);
  await expect(page.locator('.data-qr')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  const sheet = await openSetup(page);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet.getByRole('img', { name: 'Installation QR code for United States', exact: true })).toHaveAttribute('src', /^data:image\/svg\+xml/);
  expect(remoteRequests).toEqual([]);
});

test('a signed profile with only a manual LPA code still supports guided setup', async ({ page }) => {
  await setupFixture(page);
  const profile = { ...redacted(ORDER), slug: 'united-states', codes: true, manualCode: ORDER.ac };
  await page.route('**/api/redeem**', route => route.fulfill(json({
    ...standing([redacted(ORDER)]), sims: [{ ...profile, codes: route.request().method() === 'POST' }],
  })));
  await reveal(page);
  const sheet = await openSetup(page);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet).toContainText('smdp.fixture.example');
  await expect(sheet).toContainText('SETUP-CODE');
  await expect(sheet.getByRole('img', { name: 'Installation QR code for United States', exact: true })).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(sheet.getByRole('link', { name: /installation/ })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Copy Activation code', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual(['SETUP-CODE']);
});

test('unsafe provider install URLs are omitted while supplied manual details remain usable', async ({ page }) => {
  await setupFixture(page, { order: { ...ORDER, appleInstallUrl: 'javascript:alert(1)', androidInstallUrl: 'http://provider.fixture.example/install' } });
  await reveal(page);
  const sheet = await openSetup(page);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet.getByRole('link', { name: 'Open iPhone installation', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Android', exact: true }).click();
  await expect(sheet.getByRole('link', { name: 'Open Android installation', exact: true })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('a[href="http://provider.fixture.example/install"]')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Copy Activation code', exact: true })).toBeVisible();
});

test('revoking the wallet closes setup and removes authorized installation details', async ({ page }) => {
  await setupFixture(page);
  await reveal(page);
  const sheet = await openSetup(page);
  await sheet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(sheet).toContainText('SETUP-CODE');
  await page.evaluate(() => window.fixtureSetupHandlers.accountsChanged([]));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await expect(page.locator('.om-install-details')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('SETUP-CODE');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual([]);
});

test('sample accounts and pending provider orders do not advertise an installer', async ({ page }) => {
  const requests = await setupFixture(page, { prelaunch: true });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: 'Explore a sample account', exact: true }).click();
  await expect(page.locator('.om-sim-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  expect(requests.filter(request => request.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSetupMethods)).not.toContain('personal_sign');
  await page.getByRole('button', { name: 'Exit preview', exact: true }).click();
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  await page.route('**/api/redeem**', route => route.fulfill(json(standing([{ ...redacted(ORDER), codes: true, pending: true, stage: 'paid' }]))));
  await page.reload();
  await expect(page.locator('.data-sim')).toContainText('issuing');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Install on/ })).toHaveCount(0);
});

test('unsigned responses remain private even when they incorrectly include installation fields', async ({ page }) => {
  const requests = await setupFixture(page);
  await page.route('**/api/redeem**', route => route.fulfill(json(standing([{ ...ORDER, codes: false }]))));
  await page.goto('/#/app/esims');
  await expect(page.locator('.data-sim')).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText('SETUP-CODE');
  await expect(page.locator('body')).not.toContainText('smdp.fixture.example');
  await expect(page.locator('.data-qr')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Install on/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  expect(requests.filter(request => request.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSetupMethods)).not.toContain('personal_sign');
  expect(await page.evaluate(() => window.fixtureSetupCopies)).toEqual([]);
});

test('provider issuing stays pending even when an authorized response already supplies codes', async ({ page }) => {
  await setupFixture(page, { order: { ...ORDER, pending: true, stage: 'paid' } });
  await reveal(page);
  await expect(page.locator('.data-sim')).toContainText('issuing');
  await expect(page.locator('.data-order-progress')).toHaveAttribute('data-phase', 'issuing');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a completed order without supplied installation details never claims setup is available', async ({ page }) => {
  const requests = await setupFixture(page);
  let completed;
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json(standing(completed ? [redacted(ORDER), redacted(completed)] : [redacted(ORDER)])));
    const body = request.postDataJSON();
    requests.push({ method: 'POST', body });
    const pkg = CFG.packages.find(pkg => pkg.code === body.packageCode);
    completed = { ...redacted(ORDER), codes: true, n: body.n, transactionId: 'fixture-completed-empty',
      iccid: 'fixture-completed-empty-iccid', packageCode: pkg.code, priceUsd: pkg.priceUsd };
    return route.fulfill(json({ ok: true, order: completed, remainingUsd: 12.01 - pkg.priceUsd }));
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  const progress = page.locator('.data-order-progress');
  await expect(progress).toContainText('Package issued. Installation details haven’t been supplied yet. Refresh your eSIMs.');
  await expect(progress).not.toContainText('Setup details available');
  await expect(page.locator('.t-title')).not.toContainText(['Setup details available']);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh eSIMs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh eSIMs', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeVisible();
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(1);
});

test('an issued top-up says the existing eSIM needs no additional installation', async ({ page }) => {
  const requests = await setupFixture(page);
  const profile = { ...ORDER, slug: 'united-states' };
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json({ ...standing([redacted(ORDER)]), sims: [redacted(profile)] }));
    const body = request.postDataJSON();
    requests.push({ method: 'POST', body });
    const pkg = CFG.packages.find(pkg => pkg.code === body.packageCode);
    const topup = { ...redacted(ORDER), codes: true, n: body.n, transactionId: 'fixture-issued-topup',
      packageCode: pkg.code, priceUsd: pkg.priceUsd, topupOf: ORDER.iccid, toppedUp: true };
    return route.fulfill(json({ ok: true, order: topup, sims: [profile], remainingUsd: 12.01 - pkg.priceUsd }));
  });
  await page.goto('/#/app/esims');
  await page.locator('#f-place').selectOption('united-states');
  await expect(page.locator('.data-redeem')).toContainText('top up a compatible eSIM');
  await page.getByRole('button', { name: /^Redeem / }).click();
  const progress = page.locator('.data-order-progress');
  await expect(progress).toContainText('Top-up issued. Your existing eSIM does not need another installation.');
  await expect(progress).not.toContainText('Your phone still needs to add the eSIM');
  await expect(page.locator('.data-sim')).toHaveCount(1);
  await expect(page.locator('.data-bundle')).toHaveCount(2);
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(1);
});

test('order progress waits for approval and provider issuing, and a pending refresh never orders again', async ({ page }) => {
  const requests = await setupFixture(page);
  let releaseOrder;
  const response = new Promise(resolve => { releaseOrder = resolve; });
  let pendingOrder;
  await page.route('**/api/redeem**', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json({
      ...standing(pendingOrder ? [redacted(ORDER), pendingOrder] : [redacted(ORDER)]),
      redeemedUsd: 7.99 + (pendingOrder?.priceUsd || 0), remainingUsd: 12.01 - (pendingOrder?.priceUsd || 0),
    }));
    const body = request.postDataJSON();
    requests.push({ method: 'POST', body });
    await response;
    pendingOrder = { ...redacted(ORDER), n: body.n, transactionId: 'fixture-pending-order', iccid: 'fixture-pending-iccid',
      packageCode: body.packageCode, priceUsd: CFG.packages.find(pkg => pkg.code === body.packageCode).priceUsd, pending: true, stage: 'paid' };
    return route.fulfill(json({ ok: true, order: pendingOrder, remainingUsd: 12.01 - pendingOrder.priceUsd }));
  });
  await page.goto('/#/app/esims');
  const progress = page.locator('.data-order-progress');
  await expect(progress).toHaveAttribute('data-phase', 'select');
  await page.evaluate(() => { window.deferSetupSignature = true; });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(progress).toHaveAttribute('data-phase', 'wallet');
  await expect.poll(() => page.evaluate(() => typeof window.finishSetupSignature)).toBe('function');
  await page.evaluate(() => window.finishSetupSignature());
  await expect(progress).toHaveAttribute('data-phase', 'issuing');
  await expect.poll(() => requests.filter(request => request.method === 'POST').length).toBe(1);
  releaseOrder();
  const pendingBundle = page.locator('.data-bundle').filter({ hasText: 'Paid.' });
  await expect(pendingBundle).toHaveCount(1);
  await expect(progress).toHaveAttribute('data-phase', 'issuing');
  await expect(progress).not.toContainText(/installed|connected/i);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  const signatures = await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length);
  await page.getByRole('button', { name: 'Refresh eSIMs', exact: true }).click();
  await expect(pendingBundle).toHaveCount(1);
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(signatures);
});

test('a closed redemption gate reports no order while signed installation reads remain usable', async ({ page }) => {
  await setupFixture(page);
  const posts = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    if (body) posts.push(body);
    if (body?.packageCode) return route.fulfill({ status: 503, ...json({ ok: false, error: 'data redemption is not enabled yet' }) });
    return route.fulfill(json(standing([body ? ORDER : redacted(ORDER)])));
  });
  await reveal(page);
  await expect(page.locator('.data-ac')).toContainText('SETUP-CODE');
  await page.locator('.data-redeem').getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('Could not redeem: data redemption is not enabled yet');
  await expect(page.getByRole('status', { name: 'Order progress', exact: true })).toHaveAttribute('data-phase', 'select');
  await expect(page.locator('.data-redeem').getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(page.locator('.data-ac')).toContainText('SETUP-CODE');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toBeVisible();
  expect(posts.filter(body => body.packageCode)).toHaveLength(1);
  expect(posts.filter(body => !body.packageCode)).toHaveLength(1);
  await expect(page.locator('.data-order-progress')).not.toContainText('Setup details available');
});

test('declining an order restores the picker and a deliberate retry issues only the approved package', async ({ page }) => {
  await setupFixture(page);
  const orders = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json(standing([redacted(ORDER)])));
    const body = request.postDataJSON();
    orders.push(body);
    const pkg = CFG.packages.find(pkg => pkg.code === body.packageCode);
    return route.fulfill(json({ ok: true, order: { ...ORDER, n: body.n, transactionId: 'fixture-retry',
      iccid: 'fixture-retry-iccid', packageCode: pkg.code, priceUsd: pkg.priceUsd }, remainingUsd: 12.01 - pkg.priceUsd }));
  });
  await page.goto('/#/app/esims');
  await page.evaluate(() => { window.rejectSetupSignature = true; });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('Could not redeem: User rejected the request.');
  await expect(page.getByRole('status', { name: 'Order progress', exact: true })).toHaveAttribute('data-phase', 'select');
  await expect(page.locator('#f-place')).toBeEnabled();
  await expect(page.locator('.data-sizes button').first()).toBeEnabled();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  expect(orders).toEqual([]);
  await page.locator('#f-place').selectOption('united-states');
  const code = await page.locator('#f-package').inputValue();
  await page.evaluate(() => { window.rejectSetupSignature = false; window.deferSetupSignature = true; });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('#f-place')).toBeDisabled();
  await expect(page.locator('.data-sizes button').first()).toBeDisabled();
  expect(orders).toEqual([]);
  await expect.poll(() => page.evaluate(() => typeof window.finishSetupSignature)).toBe('function');
  await page.evaluate(() => window.finishSetupSignature());
  await expect(page.getByRole('status', { name: 'Order progress', exact: true })).toHaveAttribute('data-phase', 'setup');
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({ address: ADDRESS, packageCode: code, n: 1, signature: '0xfixture-setup-signature' });
  expect(orders[0].message).toContain('Plan: ' + code);
  expect(orders[0].message).toContain('Slot: 1');
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(2);
});

test('failed authorized code reads keep installation private and recover without placing an order', async ({ page }) => {
  await setupFixture(page);
  let fail = true;
  const posts = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json(standing([redacted(ORDER)])));
    posts.push(request.postDataJSON());
    if (fail) return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>SETUP-CODE gateway failure</h1>' });
    return route.fulfill(json(standing([ORDER])));
  });
  await reveal(page);
  await expect(page.locator('.data-actions')).toContainText('Could not read your codes: redeem API answered HTTP 502');
  await expect(page.getByRole('button', { name: 'Show my eSIM codes', exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText('SETUP-CODE');
  await expect(page.locator('.data-qr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('SETUP-CODE');
  await expect(page.getByRole('button', { name: 'Set up this eSIM', exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts.every(body => !body.packageCode)).toBe(true);
  expect(await page.evaluate(() => window.fixtureSetupMethods.filter(method => method === 'personal_sign').length)).toBe(1);
});
