'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });
const FIRST = '0x4444444444444444444444444444444444444444';
const NEXT = '0x5555555555555555555555555555555555555555';

async function connectionFixture(page, turns, { revoke = false, duringApproval = false, sameAccount = false, chainOnly = false } = {}) {
  stubNetwork(page);
  const writes = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url());
  });
  await page.addInitScript(({ first, next, turns, revoke, duringApproval, sameAccount, chainOnly }) => {
    const handlers = new Map();
    window.fixtureConnectionMethods = [];
    function changeAccount() {
      let remaining = turns;
      function emitChange() {
        if (--remaining > 0) { queueMicrotask(emitChange); return; }
        const event = chainOnly ? 'chainChanged' : 'accountsChanged';
        const value = chainOnly ? '0x1237' : revoke ? [] : [sameAccount ? first : next];
        for (const callback of handlers.get(event) || []) callback(value);
      }
      queueMicrotask(emitChange);
    }
    window.ethereum = {
      on(event, callback) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(callback);
      },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async request({ method }) {
        window.fixtureConnectionMethods.push(method);
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') {
          if (duringApproval) changeAccount();
          return [first];
        }
        if (method === 'eth_chainId') {
          // Account events can arrive while the transport and app finish their
          // successive awaits of the chain response. Neither may revive FIRST.
          if (!duringApproval) changeAccount();
          return '0x1237';
        }
        throw new Error('Unexpected fixture wallet request: ' + method);
      },
    };
  }, { first: FIRST, next: NEXT, turns, revoke, duringApproval, sameAccount, chainOnly });
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  return writes;
}

for (const turns of [1, 2, 3]) {
  test('an account change during connection keeps the newly selected wallet (event turn ' + turns + ')', async ({ page }) => {
    const writes = await connectionFixture(page, turns);
    await expect(page.locator('#toasts')).toContainText('Could not connect');
    expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(NEXT);
    expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([NEXT]);
    await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(NEXT);
    await expect(page.getByRole('dialog')).not.toContainText(FIRST);
    expect(await page.evaluate(() => window.fixtureConnectionMethods)).toEqual(['eth_accounts', 'eth_requestAccounts', 'eth_chainId']);
    expect(writes).toEqual([]);
  });
}

test('revocation after the chain response cannot restore the captured account', async ({ page }) => {
  const writes = await connectionFixture(page, 2, { revoke: true });
  await expect(page.locator('#toasts')).toContainText('Could not connect');
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Wallet settings', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureConnectionMethods)).not.toContain('personal_sign');
  expect(writes).toEqual([]);
});

test('an older wallet approval cannot overwrite an account already changed by the provider', async ({ page }) => {
  const writes = await connectionFixture(page, 1, { duringApproval: true });
  await expect(page.locator('#toasts')).toContainText('Your wallet changed while connecting');
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(NEXT);
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([NEXT]);
  await expect(page.getByRole('button', { name: 'Wallet settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixtureConnectionMethods)).toEqual(['eth_accounts', 'eth_requestAccounts']);
  expect(writes).toEqual([]);
});

for (const chainOnly of [false, true]) {
  test('a normal ' + (chainOnly ? 'network' : 'shared-account') + ' event during approval still connects', async ({ page }) => {
    const writes = await connectionFixture(page, 1, { duringApproval: true, sameAccount: true, chainOnly });
    await expect(page.getByRole('button', { name: 'Wallet settings', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(FIRST);
    expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([FIRST]);
    await expect(page.locator('#toasts')).not.toContainText('Could not connect');
    expect(await page.evaluate(() => window.fixtureConnectionMethods)).toEqual(['eth_accounts', 'eth_requestAccounts', 'eth_chainId']);
    expect(writes).toEqual([]);
  });
}
