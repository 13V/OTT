'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });

const ADDRESS = '0x4444444444444444444444444444444444444444';
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const WEEK_END = 345600 + (WEEK + 1) * 604800;
const CFG = { ...require('../../site/config/esim.json'), coin: '0x1111111111111111111111111111111111111111',
  curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' };
const ORDER = { n: 0, week: WEEK, transactionId: 'fixture-only', packageCode: 'fixed_5GB_30D_US', priceUsd: 7.99,
  iccid: 'fixture-not-an-iccid', createdAt: new Date().toISOString(), stage: 'done', pending: false,
  codes: false, ac: '', qrCodeUrl: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '' };
const STANDING = { ok: true, address: ADDRESS, week: WEEK, weekEnd: WEEK_END, tokens: '1234000000000000000000',
  share: 0.01, allowanceUsd: 20, decimals: 18, redeemedUsd: 7.99, remainingUsd: 12.01, stale: false,
  orders: [ORDER], history: [], sims: [] };
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });

async function accountFixture(page, { remote = false } = {}) {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  await page.route('**/config/app.json', route => route.fulfill(json({
    walletConnect: { projectId: remote ? '11111111111111111111111111111111' : '' }, apiBaseUrl: '',
  })));
  // A published allowance alone cannot say how much has already been spent.
  await page.route('**/data/allowances.json', route => route.fulfill(json({ week: WEEK, weekEnd: WEEK_END, decimals: 18,
    wallets: { [ADDRESS]: { tokens: STANDING.tokens, share: 0.01, allowanceUsd: 999 } } })));
  await page.addInitScript(({ address, remote }) => {
    window.fixtureWalletMethods = [];
    window.fixtureRemoteConnections = 0;
    const handlers = new Map();
    const provider = {
      accounts: [], session: null,
      async connect() { window.fixtureRemoteConnections++; provider.accounts = [address]; provider.session = { topic: 'fixture-session' }; },
      async disconnect() { provider.accounts = []; provider.session = null; },
      async request({ method }) {
        window.fixtureWalletMethods.push(method);
        if (method === 'eth_accounts') return remote ? provider.accounts : [address];
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') return '0xfixture-signature';
        throw new Error('Unexpected wallet action: ' + method);
      },
      on(event, callback) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(callback); },
      off(event, callback) { handlers.get(event)?.delete(callback); },
    };
    window.fixtureAccountProvider = provider;
    if (remote) window.OTTWalletConnectSDK = { init: async () => provider };
    else window.ethereum = provider;
  }, { address: ADDRESS, remote });
}

test('Home shows confirmed API credit and expiry without requesting a wallet signature', async ({ page }) => {
  await accountFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  await page.route('**/api/redeem**', route => { requests.push(route.request().method()); return route.fulfill(json(STANDING)); });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await expect(page.locator('.om-credit-details')).toContainText('Allocated$20.00');
  await expect(page.locator('.om-credit-details')).toContainText('Used$7.99');
  await expect(page.locator('.om-credit-expiry time')).toHaveAttribute('datetime', new Date(WEEK_END * 1000).toISOString());
  const primary = await page.locator('.om-credit-card').getByRole('button', { name: 'Find a data plan', exact: true }).boundingBox();
  const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
  expect(primary.y + primary.height).toBeLessThanOrEqual(nav.y);
  await expect(page.locator('.om-credit-card')).not.toContainText('Sample');
  await expect(page.locator('.om-credit-card')).not.toContainText('GB');
  expect(await page.evaluate(() => window.fixtureWalletMethods)).toEqual(['eth_accounts']);
  expect(requests.every(method => method === 'GET')).toBe(true);
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(ADDRESS);
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  await page.reload();
  await expect(page.locator('.om-credit-card')).toBeVisible();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureWalletMethods)).toEqual([]);
});

test('stale or expired allocations never appear as spendable Home credit', async ({ page }) => {
  await accountFixture(page);
  let response = { ...STANDING, stale: true, remainingUsd: 100 };
  await page.route('**/api/redeem**', route => route.fulfill(json(response)));
  await page.goto('/#/app');
  await expect(page.locator('.om-pass-title')).toHaveText('Awaiting allocation');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
  response = { ...STANDING, stale: false, weekEnd: Math.floor(Date.now() / 1000) - 60 };
  await page.getByRole('button', { name: 'Refresh account', exact: true }).click();
  await expect(page.locator('.om-pass-title')).toHaveText('Awaiting allocation');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
});

test('unavailable or mismatched API responses never borrow a balance from the published allowance', async ({ page }) => {
  await accountFixture(page);
  let response = null;
  await page.route('**/api/redeem**', route => response ? route.fulfill(json(response)) : route.fulfill({ status: 503, body: 'API unavailable' }));
  await page.goto('/#/app');
  await expect(page.locator('.om-pass-title')).toHaveText('Credit unavailable');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
  await expect(page.locator('.om-credit-card')).not.toContainText('$999');
  response = { ...STANDING, address: '0x5555555555555555555555555555555555555555' };
  await page.getByRole('button', { name: 'Refresh account', exact: true }).click();
  await expect(page.locator('.om-pass-title')).toHaveText('Credit unavailable');
  await expect(page.locator('.om-balance')).toHaveCount(0);
});

test('an unfunded wallet sees zero credit and can browse plans without a signature or order', async ({ page }) => {
  await accountFixture(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const requests = [];
  await page.route('**/api/redeem**', route => {
    requests.push(route.request().method());
    return route.fulfill(json({ ...STANDING, tokens: '0', share: 0, allowanceUsd: 0, redeemedUsd: 0,
      remainingUsd: 0, orders: [], history: [], sims: [] }));
  });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  await expect(page.locator('.om-credit-card')).not.toContainText('Sample');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.locator('.data-mine')).toContainText('This wallet holds no OTT, so it has no data this week.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my eSIM codes', exact: true })).toHaveCount(0);
  await expect(page.locator('.data-qr')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Your wallet will confirm the exact package before a real redemption.');
  expect(await page.evaluate(() => window.fixtureWalletMethods)).toEqual(['eth_accounts']);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(method => method === 'GET')).toBe(true);
});

test('WalletConnect reaches real account reads and rejects private codes returned after disconnect', async ({ page }) => {
  await accountFixture(page, { remote: true });
  let releaseCodes;
  const pendingCodes = new Promise(resolve => { releaseCodes = resolve; });
  const posts = [];
  const signed = { ...STANDING, orders: [{ ...ORDER, codes: true, ac: 'LPA:1$smdp.example$FIXTURE-ONLY',
    smdpAddress: 'smdp.example', matchingId: 'FIXTURE-ONLY' }] };
  await page.route('**/api/redeem**', async route => {
    if (route.request().method() === 'GET') return route.fulfill(json(STANDING));
    posts.push(route.request().postDataJSON());
    await pendingCodes;
    return route.fulfill(json(signed));
  });
  await page.goto('/#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  expect(await page.evaluate(() => window.ethereum)).toBeUndefined();
  expect(await page.evaluate(() => window.fixtureRemoteConnections)).toBe(1);
  expect(await page.evaluate(() => window.fixtureWalletMethods)).not.toContain('personal_sign');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  releaseCodes();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('FIXTURE-ONLY');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('FIXTURE-ONLY');
  expect(await page.evaluate(() => window.fixtureWalletMethods.filter(method => method === 'personal_sign').length)).toBe(2);
  expect(posts).toHaveLength(2);
  expect(posts.every(body => !body.packageCode)).toBe(true);
});

test('configured external backend handles both public and authorized reads without a local API fallback', async ({ page }) => {
  await accountFixture(page);
  const origin = 'https://api.fixture.example';
  await page.route('**/config/app.json', route => route.fulfill(json({ walletConnect: { projectId: '' }, apiBaseUrl: origin })));
  const remoteRequests = [];
  const localRequests = [];
  await page.route(origin + '/api/redeem**', route => {
    const request = route.request();
    remoteRequests.push({ url: request.url(), method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
    const signed = { ...STANDING, orders: [{ ...ORDER, codes: true, ac: 'LPA:1$smdp.example$EXTERNAL-FIXTURE' }] };
    return route.fulfill(json(request.method() === 'POST' ? signed : STANDING));
  });
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname === '/api/redeem', route => {
    localRequests.push(route.request().url()); return route.fulfill({ status: 500, body: 'A local fallback must not be used.' });
  });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('EXTERNAL-FIXTURE');
  expect(remoteRequests.some(request => request.method === 'GET')).toBe(true);
  const authorized = remoteRequests.filter(request => request.method === 'POST');
  expect(authorized).toHaveLength(1);
  expect(new URL(authorized[0].url).origin).toBe(origin);
  expect(authorized[0].body.message).toContain('Site: ' + new URL(page.url()).host);
  expect(authorized[0].body).not.toHaveProperty('packageCode');
  expect(localRequests).toEqual([]);
});

test('invalid backend origins stop authorization before asking the wallet to sign', async ({ page }) => {
  await accountFixture(page);
  const posts = [];
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  const reveal = page.getByRole('button', { name: 'Show my eSIM codes', exact: true });
  await expect(reveal).toBeVisible();
  for (const apiBaseUrl of ['http://api.fixture.example', 'https://user:password@api.fixture.example',
    'https://api.fixture.example/?token=fixture', 'https://api.fixture.example/ott']) {
    await page.evaluate(apiBaseUrl => window.OTTClientConfig.configure({ apiBaseUrl }), apiBaseUrl);
    await reveal.click();
    await expect(page.locator('.data-sims .hint')).toContainText('backend address is invalid');
    expect(await page.evaluate(() => window.fixtureWalletMethods)).not.toContain('personal_sign');
  }
  expect(posts).toEqual([]);
  await expect(page.locator('.data-ac')).not.toContainText('FIXTURE-ONLY');
});
