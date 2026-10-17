'use strict';
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const { installWallet, walletAddress } = require('./support/wallet.js');

// Isolate the shell contract from app screens, whose balances and redemption UI have their own
// tests. This fixture uses the same render(view, ctx, screen) entry point as mobile-app.js.
async function stubMobileApp(page) {
  stubNetwork(page);
  await page.route(url => url.pathname.endsWith('/mobile-app.js'), (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `(function () {
      window.OTTMobileApp = { render: function (view, ctx, screen) {
        window.__appContext = ctx;
        view.appendChild(ctx.h('h1', {}, 'OTT app: ' + screen));
        view.appendChild(ctx.h('p', { class: 'test-app-account' }, ctx.currentAccount() || 'No wallet connected'));
        view.appendChild(ctx.h('a', { href: '#/app/plans' }, 'Browse app plans'));
        view.appendChild(ctx.h('a', { href: '#/app/help' }, 'App help'));
        view.appendChild(ctx.h('a', { href: '#/status' }, 'Website status'));
        view.appendChild(ctx.h('button', { onclick: async function () {
          await ctx.connect();
          if (ctx.isCurrent()) ctx.refresh();
        } }, 'Connect in app'));
      } };
    })();`,
  }));
}

test('app deep links hide website furniture and browser history restores the correct screen', async ({ page }) => {
  await stubMobileApp(page);
  await page.goto('/index.html#/app/esims');
  await expect(page.locator('#view h1')).toHaveText('OTT app: esims');
  await expect(page).toHaveTitle('OTT app — OT+T');
  await expect(page.locator('body')).toHaveClass(/ott-app-mode/);
  await expect(page.locator('#masthead')).toBeHidden();
  await expect(page.locator('#site-footer')).toBeHidden();

  await page.getByRole('link', { name: 'Browse app plans', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('OTT app: plans');
  await page.getByRole('link', { name: 'App help', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('OTT app: help');
  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('OTT app: plans');

  await page.getByRole('link', { name: 'Website status', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('Everything, and whether it is running.');
  await expect(page).toHaveTitle('Status — OT+T');
  await expect(page.locator('#masthead')).toBeVisible();
  await expect(page.locator('#site-footer')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/ott-app-mode/);
  await page.locator('#nav').getByRole('link', { name: 'Open app', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('OTT app: home');
});

test('app boot still provides its offline screen when network configuration is unavailable', async ({ page }) => {
  await stubMobileApp(page);
  await page.route('**/config/addresses.json', (route) => route.abort());
  await page.goto('/index.html#/app/help');
  await expect(page.locator('#view h1')).toHaveText('OTT app: help');
  expect(await page.evaluate(() => window.__appContext.cfg)).toEqual({});
  expect(await page.evaluate(() => window.__appContext.walletAvailable())).toBe(false);
  // With no wallet in this browser, connecting offers to open OT+T inside a wallet app instead.
  await page.getByRole('button', { name: 'Connect in app', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Open OT+T in your wallet' });
  await expect(chooser).toBeVisible();
  const here = encodeURIComponent(page.url());
  const ref = encodeURIComponent(new URL(page.url()).origin);
  await expect(chooser.getByRole('link', { name: 'Open in Phantom' })).toHaveAttribute('href', 'https://phantom.app/ul/browse/' + here + '?ref=' + ref);
  await expect(chooser.getByRole('link', { name: 'Open in Solflare' })).toHaveAttribute('href', 'https://solflare.com/ul/v1/browse/' + here + '?ref=' + ref);
  await chooser.getByRole('button', { name: 'Close' }).click();
  await expect(chooser).toHaveCount(0);
  await expect(page.locator('#view h1')).toHaveText('OTT app: help');
  await expect(page.locator('.test-app-account')).toHaveText('No wallet connected');

  // A website visit retains the existing configuration error rather than advertising invented
  // live figures or attempting a made-up RPC endpoint.
  await page.goto('/index.html#/status');
  await page.reload();
  await expect(page.locator('#view')).toContainText('Could not load configuration');
});

test('app entry reconnects a remembered wallet without prompting and refreshes after account changes', async ({ page }) => {
  const first = walletAddress('holder');
  const next = walletAddress('second account');
  await stubMobileApp(page);
  // Phantom already approved this site, and the site remembers that Phantom was the wallet used.
  const wallet = await installWallet(page, { trusted: true });
  await page.goto('/index.html#/app');
  await expect(page.locator('.test-app-account')).toHaveText(first);
  // Only the silent reconnect: no approval prompt, no signature.
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
  await page.evaluate(() => {
    const reset = window.WhateverData.resetWallet;
    window.__walletResets = 0;
    window.WhateverData.resetWallet = () => { window.__walletResets++; reset?.(); };
  });
  await wallet.switchTo(page, 'second account');
  await expect(page.locator('.test-app-account')).toHaveText(next);
  // Revoking the site's access in the wallet disconnects it here too.
  await wallet.switchTo(page, null);
  await expect(page.locator('.test-app-account')).toHaveText('No wallet connected');
  // Every account change forgets what the earlier account had signed.
  expect(await page.evaluate(() => window.__walletResets)).toBe(2);
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
  // A wallet that shares no account on an explicit connection leaves the app disconnected.
  await page.getByRole('button', { name: 'Connect in app', exact: true }).click();
  await expect.poll(() => wallet.calls().length).toBe(2);
  expect(wallet.calls()[1]).toEqual({ method: 'connect', silent: false });
  await expect(page.locator('.test-app-account')).toHaveText('No wallet connected');
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

test('an unknown app screen stays in app home while an unknown website route returns to the homepage', async ({ page }) => {
  await stubMobileApp(page);
  await page.goto('/index.html#/app/not-a-screen');
  await expect(page.locator('#view h1')).toHaveText('OTT app: home');
  await expect(page.locator('#masthead')).toBeHidden();
  await page.goto('/index.html#/not-a-route');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await expect(page.locator('#masthead')).toBeVisible();
});
