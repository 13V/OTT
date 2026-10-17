'use strict';
/**
 * The site's side of the Solana wallet: the masthead's Connect wallet button, the wallet chooser in
 * site/app.js, the app's wallet settings, and what My data does when the wallet's account changes.
 * site/wallet.js itself is covered by wallet-transport.spec.js; this file is what a person sees.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const { installWallet, walletAddress, STORAGE_KEY } = require('./support/wallet.js');
const { COIN, TREASURY, TOKEN_2022, BURN_ACCOUNT, INCINERATOR, addressFrom } = require('./support/solana.js');
const catalogue = require('../../site/config/esim.json');

test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress('holder');
const NEXT = walletAddress('second account');
const SOLFLARE = addressFrom('solflare account');
const short = (address) => address.slice(0, 4) + '…' + address.slice(-4);

const WEEK_S = 604800;
const ANCHOR = 345600;
const WEEK = Math.floor((Math.floor(Date.now() / 1000) - ANCHOR) / WEEK_S);
const WEEK_END = ANCHOR + (WEEK + 1) * WEEK_S;
const CONFIG = { ...catalogue, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { ...catalogue.membership, burnAccount: BURN_ACCOUNT } };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
/** A member's public standing, for whichever wallet asks. */
const standing = (address) => ({
  ok: true, address, week: WEEK, weekEnd: WEEK_END, tokens: '250000000000', share: 0.5, decimals: 6,
  allowanceUsd: 12, redeemedUsd: 0, remainingUsd: 12, stale: false, allowancesWeek: WEEK, poolUsd: 120,
  orders: [], history: [], sims: [],
  membership: { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, burnUsd: 5,
    requirement: { week: WEEK, burnTokens: '180000', burnUnits: '180000000000', priceUsd: 0.0000278 }, burned: '180000000000',
    welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3, member: true, memberSince: null, sharing: true,
    welcomeOrder: { n: 0, week: null, welcome: true, transactionId: 'ott-' + 'a'.repeat(32), packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99, pending: false, stage: 'done', codes: false },
    enrolment: { open: true, reason: '' } },
});

/** Launched config, a ledger, and /api/redeem answering each wallet's standing. Returns the addresses asked about. */
async function launchedSite(page) {
  stubNetwork(page);
  const asked = [];
  await page.route('**/config/esim.json', (route) => route.fulfill(json(CONFIG)));
  await page.route('**/data/allowances.json', (route) => route.fulfill(json({ week: WEEK, weekEnd: WEEK_END, coin: COIN, decimals: 6, wallets: {}, members: {} })));
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  await page.route('**/api/redeem**', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill(json({ ok: false, error: 'no POST expected' }, 500));
    const address = new URL(route.request().url()).searchParams.get('address');
    asked.push(address);
    return route.fulfill(json(standing(address)));
  });
  return asked;
}

/** A second standard wallet, so the chooser has a choice to offer. It records its connections. */
async function secondWallet(page, name = 'Solflare', address = SOLFLARE) {
  await page.addInitScript(({ name, address }) => {
    window.__second = { connects: 0, signs: 0 };
    const account = Object.freeze({ address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] });
    let accounts = [];
    const wallet = {
      version: '1.0.0', name, icon: '', chains: ['solana:mainnet'],
      get accounts() { return accounts.slice(); },
      features: {
        'standard:connect': { version: '1.0.0', async connect() { window.__second.connects++; accounts = [account]; return { accounts: accounts.slice() }; } },
        'standard:events': { version: '1.0.0', on() { return () => {}; } },
        'solana:signMessage': { version: '1.0.0', async signMessage() { window.__second.signs++; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } },
        'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], async signAndSendTransaction() { throw new Error('not in this test'); } },
      },
    };
    window.addEventListener('wallet-standard:app-ready', (event) => event.detail.register(wallet));
  }, { name, address });
}

test('with one wallet installed, the masthead connects it straight away and then shows the account', async ({ page }) => {
  stubNetwork(page);
  const wallet = await installWallet(page);
  await page.goto('/index.html#/about');
  const slot = page.locator('#wallet-slot');
  await slot.getByRole('button', { name: 'Connect wallet' }).click();
  const link = slot.locator('.wallet-addr');
  await expect(link).toHaveText(short(ADDRESS));
  await expect(link).toHaveAttribute('aria-label', 'My data, wallet ' + ADDRESS);
  await expect(link).toHaveAttribute('href', '#/data');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: false }]);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('Phantom');
});

test('with two wallets installed, a chooser lists both and connects only the one picked', async ({ page }) => {
  stubNetwork(page);
  const phantom = await installWallet(page);
  await secondWallet(page);
  await page.goto('/index.html#/about');
  await page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a wallet' });
  await expect(chooser).toBeVisible();
  const choices = chooser.locator('.wallet-choice');
  await expect(choices).toHaveText(['Phantom', 'SSolflare']);
  // A wallet's own icon when it has one, and its initial when it does not.
  await expect(choices.nth(0).locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await expect(choices.nth(1).locator('.wallet-choice-mark')).toHaveText('S');
  // Nothing has been asked of either wallet just by opening the chooser.
  expect(phantom.calls()).toEqual([]);
  expect(await page.evaluate(() => window.__second.connects)).toBe(0);

  await chooser.getByRole('button', { name: 'Solflare' }).click();
  await expect(page.locator('#wallet-slot .wallet-addr')).toHaveText(short(SOLFLARE));
  await expect(chooser).toHaveCount(0);
  expect(await page.evaluate(() => window.__second.connects)).toBe(1);
  expect(phantom.calls()).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: 'Solflare', accounts: [SOLFLARE], connected: true });
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('Solflare');
});

test('closing the chooser connects nothing and leaves Connect wallet ready', async ({ page }) => {
  stubNetwork(page);
  const phantom = await installWallet(page);
  await secondWallet(page);
  await page.goto('/index.html#/about');
  await page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a wallet' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' })).toBeEnabled();
  expect(phantom.calls()).toEqual([]);
  expect(await page.evaluate(() => window.__second.connects)).toBe(0);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

test('closing the chooser returns keyboard focus to the Connect wallet button that opened it', async ({ page }) => {
  await launchedSite(page);
  await installWallet(page);
  await secondWallet(page);
  // In the app, the opener stays where it was.
  await page.goto('/index.html#/app');
  const appButton = page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' });
  await appButton.click();
  await expect(page.getByRole('dialog', { name: 'Choose a wallet' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(appButton).toBeFocused();
  // In the masthead, the button is redrawn, and the new one takes focus.
  await page.goto('/index.html#/about');
  await page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Choose a wallet' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' })).toBeFocused();
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

test('without a wallet, the site explains how to open OT+T inside Phantom or Solflare', async ({ page }) => {
  await launchedSite(page);
  await page.goto('/index.html#/data');
  const panel = page.locator('.data-mine');
  await expect(panel).toContainText('No Solana wallet found in this browser. On a phone, open OT+T in Phantom or Solflare; on a computer, install a Solana wallet extension.');

  await page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' }).click();
  const chooser = page.getByRole('dialog', { name: 'Open OT+T in your wallet' });
  await expect(chooser).toContainText('OT+T works with Solana wallets such as Phantom and Solflare.');
  const here = encodeURIComponent(page.url());
  const ref = encodeURIComponent(new URL(page.url()).origin);
  await expect(chooser.getByRole('link', { name: 'Open in Phantom' })).toHaveAttribute('href', 'https://phantom.app/ul/browse/' + here + '?ref=' + ref);
  await expect(chooser.getByRole('link', { name: 'Open in Solflare' })).toHaveAttribute('href', 'https://solflare.com/ul/v1/browse/' + here + '?ref=' + ref);
  await expect(chooser.getByRole('link', { name: 'Phantom', exact: true })).toHaveAttribute('href', 'https://phantom.com/download');
  await chooser.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' })).toBeEnabled();
});

test('a declined connection says so, and the next attempt can still connect', async ({ page }) => {
  stubNetwork(page);
  const wallet = await installWallet(page, { connect: 'reject' });
  await page.goto('/index.html#/about');
  const slot = page.locator('#wallet-slot');
  await slot.getByRole('button', { name: 'Connect wallet' }).click();
  const toast = page.locator('#toasts .toast').last();
  await expect(toast).toContainText('Wallet connection failed');
  await expect(toast).toContainText('The connection was not approved.');
  await expect(slot.getByRole('button', { name: 'Connect wallet' })).toBeEnabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

  wallet.behave({ connect: 'approve' });
  await slot.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(slot.locator('.wallet-addr')).toHaveText(short(ADDRESS));
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: false }, { method: 'connect', silent: false }]);
});

test('a declined connection in the app says so on the app’s own button', async ({ page }) => {
  await launchedSite(page);
  await installWallet(page, { connect: 'reject' });
  await page.goto('/index.html#/app');
  const connect = page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' });
  await connect.click();
  await expect(page.locator('#toasts')).toContainText('Could not connect');
  await expect(page.locator('#toasts')).toContainText('The connection was not approved.');
  await expect(connect).toBeEnabled();
  await expect(page.locator('.om-balance')).toHaveCount(0);
});

test('a wallet connected on an earlier visit reconnects on load without asking, and My data opens on its account', async ({ page }) => {
  const asked = await launchedSite(page);
  const wallet = await installWallet(page, { trusted: true });
  await page.goto('/index.html#/data');
  await expect(page.locator('.data-mine .data-addr')).toHaveText(ADDRESS);
  await expect(page.locator('#wallet-slot .wallet-addr')).toHaveText(short(ADDRESS));
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
  expect(asked).toEqual([ADDRESS]);
});

test('the app’s wallet settings show the account and its Solscan page, and disconnecting holds across a reload', async ({ page }) => {
  await launchedSite(page);
  const wallet = await installWallet(page);
  await page.goto('/index.html#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.locator('.om-balance')).toHaveText('$12.00');
  await expect(page.locator('.om-wallet-row')).toContainText('Wallet connected' + short(ADDRESS));

  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your wallet' });
  await expect(settings.locator('.om-wallet-address')).toHaveText(ADDRESS);
  await expect(settings).toContainText('Your Solana wallet (Phantom) is your OTT account. Viewing your credit does not need a signature.');
  await expect(settings.getByRole('link', { name: 'View on Solscan ↗' })).toHaveAttribute('href', 'https://solscan.io/account/' + ADDRESS);
  await settings.getByRole('button', { name: 'Disconnect wallet' }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  expect(wallet.calls().map((c) => c.method)).toEqual(['connect', 'disconnect']);

  await page.reload();
  await expect(page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  // Not even a quiet reconnection after the holder disconnected.
  expect(wallet.calls()).toHaveLength(2);
});

test('switching accounts in the wallet reloads My data for the new account, and revoking access asks to connect again', async ({ page }) => {
  const asked = await launchedSite(page);
  const wallet = await installWallet(page, { trusted: true });
  await page.goto('/index.html#/data');
  const panel = page.locator('.data-mine');
  await expect(panel.locator('.data-addr')).toHaveText(ADDRESS);

  await wallet.switchTo(page, 'second account');
  await expect(panel.locator('.data-addr')).toHaveText(NEXT);
  await expect(page.locator('#wallet-slot .wallet-addr')).toHaveText(short(NEXT));
  await expect(panel).not.toContainText(ADDRESS);
  expect(asked).toEqual([ADDRESS, NEXT]);

  await wallet.switchTo(page, null);
  await expect(panel.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(page.locator('#wallet-slot').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(panel).not.toContainText(NEXT);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  // Account changes never ask the wallet for anything; only the first quiet reconnection did.
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
});
