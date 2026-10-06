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

async function wrongNetworkFixture(page, outcome = 'switch') {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  const posts = [];
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'GET') return route.fulfill(json(STANDING));
    const body = route.request().postDataJSON();
    posts.push(body);
    const pkg = CFG.packages.find(pkg => pkg.code === body.packageCode);
    const order = { n: body.n, week: WEEK, packageCode: body.packageCode, priceUsd: pkg.priceUsd,
      transactionId: 'fixture-network-order', stage: 'invoiced', pending: true, codes: false };
    return route.fulfill(json({ ok: true, order, remainingUsd: 10 - pkg.priceUsd, sims: [] }));
  });
  await page.addInitScript(({ address, outcome }) => {
    let chain = '0x1';
    const handlers = new Map();
    window.fixtureNetworkMethods = [];
    window.ethereum = {
      on(event, callback) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(callback);
      },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async request({ method }) {
        window.fixtureNetworkMethods.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') {
          if (outcome === 'reject') throw Object.assign(new Error('User rejected the network switch.'), { code: 4001 });
          if (outcome === 'revoke') {
            for (const callback of handlers.get('accountsChanged') || []) callback([]);
            return null;
          }
          chain = '0x1237';
          for (const callback of handlers.get('chainChanged') || []) callback(chain);
          return null;
        }
        if (method === 'personal_sign') return '0xfixture-signature';
        throw new Error('Unexpected fixture wallet request: ' + method);
      },
    };
  }, { address: ADDRESS, outcome });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  return posts;
}

test('switching a restored wallet refreshes the account before any signature and requires a deliberate retry', async ({ page }) => {
  const posts = await wrongNetworkFixture(page);
  await expect(page.locator('#toasts')).toContainText('Review your refreshed account and try your action again.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  expect(await page.evaluate(() => window.fixtureNetworkMethods)).toEqual(['eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  expect(posts).toEqual([]);
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-sims')).toContainText('Paying the invoice');
  expect(posts).toHaveLength(1);
  expect(await page.evaluate(() => window.fixtureNetworkMethods.filter(method => method === 'personal_sign').length)).toBe(1);
  expect(posts[0].message).toContain('Plan: ' + posts[0].packageCode);
  expect(posts[0].message).toContain('Slot: 0');
});

test('declining the network switch leaves the order retryable without a signature or purchase', async ({ page }) => {
  const posts = await wrongNetworkFixture(page, 'reject');
  await expect(page.locator('.data-redeem')).toContainText('User rejected the network switch.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  expect(await page.evaluate(() => window.fixtureNetworkMethods)).not.toContain('personal_sign');
  expect(posts).toEqual([]);
});

test('revoking the account during network switching prevents stale approval and false retry guidance', async ({ page }) => {
  const posts = await wrongNetworkFixture(page, 'revoke');
  await expect(page.locator('.data-mine').getByRole('button', { name: 'Connect wallet', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  await expect(page.locator('#toasts')).not.toContainText('Wallet connection updated');
  expect(await page.evaluate(() => window.fixtureNetworkMethods)).not.toContain('personal_sign');
  expect(posts).toEqual([]);
});
