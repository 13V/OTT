'use strict';
/**
 * Races between the page and the wallet. A wallet prompt can stay open for as long as a person
 * likes, and the account can change or be revoked while it is open, so whatever the prompt answers
 * must still be about the account the page is showing by then. The shared fake wallet's 'hold'
 * behaviour keeps a prompt open until the spec releases it.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const { installWallet, walletAddress, STORAGE_KEY } = require('./support/wallet.js');
const { COIN, TREASURY, TOKEN_2022, BURN_ACCOUNT, INCINERATOR } = require('./support/solana.js');
const catalogue = require('../../site/config/esim.json');

test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress('holder');
const NEXT = walletAddress('second account');
const WEEK_S = 604800;
const ANCHOR = 345600;
const WEEK = Math.floor((Math.floor(Date.now() / 1000) - ANCHOR) / WEEK_S);
const WEEK_END = ANCHOR + (WEEK + 1) * WEEK_S;
const CONFIG = { ...catalogue, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { ...catalogue.membership, burnAccount: BURN_ACCOUNT } };
const REQUIREMENT = { week: WEEK, burnTokens: '180000', burnUnits: '180000000000', priceUsd: 0.0000278 };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const membership = (member) => ({ configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT,
  burnUsd: 5, requirement: REQUIREMENT, burned: member ? REQUIREMENT.burnUnits : '0', welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3,
  member, memberSince: null, sharing: member, welcomeOrder: member ? { n: 0, week: null, welcome: true, transactionId: 'ott-' + 'a'.repeat(32),
    packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99, pending: false, stage: 'done', codes: false } : null, enrolment: { open: true, reason: '' } });
const standing = (address, { member = true, remainingUsd = 12 } = {}) => ({
  ok: true, address, week: WEEK, weekEnd: WEEK_END, tokens: '250000000000', share: 0.5, decimals: 6,
  allowanceUsd: member ? remainingUsd : 0, redeemedUsd: 0, remainingUsd: member ? remainingUsd : 0, stale: false, allowancesWeek: WEEK, poolUsd: 500,
  orders: [], history: [], sims: [], membership: membership(member),
});

/**
 * A launched site whose /api/redeem answers each wallet's standing. `answers` overrides one
 * address's GET (a function may return a promise, to hold it back). POSTs are recorded, never
 * answered with an order: none should happen in these races.
 */
async function launchedSite(page, { answers = {} } = {}) {
  stubNetwork(page, { balance: '250000000000' });
  const api = { gets: [], posts: [] };
  await page.route('**/config/esim.json', (route) => route.fulfill(json(CONFIG)));
  await page.route('**/data/allowances.json', (route) => route.fulfill(json({ week: WEEK, weekEnd: WEEK_END, coin: COIN, decimals: 6, wallets: {}, members: {} })));
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  await page.route('**/api/redeem**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') { api.posts.push(request.postDataJSON()); return route.fulfill(json({ ok: false, error: 'no order in this test' }, 500)); }
    const address = new URL(request.url()).searchParams.get('address');
    api.gets.push(address);
    const answer = answers[address] ? await answers[address]() : standing(address);
    return route.fulfill(json(answer));
  });
  return api;
}

test('two Connect wallet taps while the wallet is asking share one prompt and connect once, without a false alarm', async ({ page }) => {
  const api = await launchedSite(page);
  const wallet = await installWallet(page, { connect: 'hold' });
  await page.goto('/index.html#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('.om-wallet-row').getByRole('button', { name: 'Connect wallet' }).click();
  await expect.poll(() => wallet.calls('connect').length).toBe(1);
  wallet.behave({ connect: 'approve' });
  wallet.release('connect');
  await expect(page.locator('.om-balance')).toHaveText('$12.00');
  expect(wallet.calls('connect')).toEqual([{ method: 'connect', silent: false }]);
  await expect(page.locator('#toasts')).not.toContainText('Could not connect');
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(ADDRESS);
  expect(api.posts).toEqual([]);
});

test('disconnecting while the wallet is still asking cancels the connection, and the late approval connects nothing', async ({ page }) => {
  const api = await launchedSite(page);
  const wallet = await installWallet(page, { connect: 'hold' });
  await page.goto('/index.html#/app');
  const connect = page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet' });
  await connect.click();
  await expect.poll(() => wallet.calls('connect').length).toBe(1);
  await page.evaluate(() => window.OTTWallet.disconnect());
  wallet.behave({ connect: 'approve' });
  wallet.release('connect');
  await expect(page.locator('#toasts')).toContainText('Could not connect');
  await expect(page.locator('#toasts')).toContainText('Wallet connection was cancelled. Please connect again.');
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await expect(connect).toBeEnabled();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(api.gets).toEqual([]);
});

test('an account change while a redemption signature is waiting discards that signature, and no order is sent', async ({ page }) => {
  const api = await launchedSite(page);
  const wallet = await installWallet(page, { trusted: true, sign: 'hold' });
  await page.goto('/index.html#/data');
  const panel = page.locator('.data-mine');
  await panel.getByRole('button', { name: /^Redeem / }).click();
  await expect.poll(() => wallet.calls('signMessage').length).toBe(1);
  expect(wallet.calls('signMessage')[0].message).toMatch(/^OT\+T — authorise a data redemption\n/);

  await wallet.switchTo(page, 'second account');
  await expect(panel.locator('.data-addr')).toHaveText(NEXT);
  // The old account's prompt is approved only now, after the page has moved on.
  wallet.behave({ sign: 'approve' });
  wallet.release('signMessage');
  await expect(panel.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(panel.locator('.data-addr')).toHaveText(NEXT);
  await page.waitForTimeout(300);
  expect(api.posts).toEqual([]);
  expect(api.gets).toEqual([ADDRESS, NEXT]);
});

test('revoking access while the join waits on the wallet records no join for anyone', async ({ page }) => {
  const api = await launchedSite(page, { answers: { [ADDRESS]: async () => standing(ADDRESS, { member: false }) } });
  const wallet = await installWallet(page, { trusted: true, send: 'hold' });
  await page.goto('/index.html#/data');
  const card = page.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 180,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 180,000 OTT' }).click();
  await expect.poll(() => wallet.calls('signAndSendTransaction').length).toBe(1);

  await wallet.switchTo(page, null);
  await expect(page.locator('.data-mine').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  wallet.behave({ send: 'approve' });
  wallet.release('signAndSendTransaction');
  await page.waitForTimeout(300);
  await expect(page.locator('.data-membership')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ott-membership-join:')))).toEqual([]);
  expect(api.posts).toEqual([]);
});

test('a join the wallet sends after the account switched is kept for the wallet that sent it, so switching back never offers a second burn', async ({ page }) => {
  const api = await launchedSite(page, { answers: {
    [ADDRESS]: async () => standing(ADDRESS, { member: false }),
    [NEXT]: async () => standing(NEXT, { member: false }),
  } });
  const wallet = await installWallet(page, { trusted: true, send: 'hold' });
  await page.goto('/index.html#/data');
  const card = page.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 180,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 180,000 OTT' }).click();
  await expect.poll(() => wallet.calls('signAndSendTransaction').length).toBe(1);

  // The person switches account while the burn waits in the wallet, then approves it there.
  await wallet.switchTo(page, 'second account');
  await expect(page.locator('.data-addr')).toHaveText(NEXT);
  wallet.behave({ send: 'approve' });
  wallet.release('signAndSendTransaction');
  // The other account was asked for nothing and is offered its own join as usual.
  await expect(card.getByRole('button', { name: 'Join: burn 180,000 OTT' })).toBeVisible();

  await wallet.switchTo(page, 'holder');
  await expect(page.locator('.data-addr')).toHaveText(ADDRESS);
  await expect(card.locator('h3')).toHaveText('Your burn is confirming');
  await expect(card).toContainText('Don’t burn again');
  await expect(card.getByRole('button', { name: /^(?:Join|Burn)/ })).toHaveCount(0);
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  // Nothing is stored until the burn is seen to confirm.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ott-membership-join:')))).toEqual([]);
  expect(api.posts).toEqual([]);
});

test('a standing that arrives after the account changed is dropped, never shown for the new account', async ({ page }) => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const api = await launchedSite(page, { answers: { [ADDRESS]: async () => { await first; return standing(ADDRESS, { remainingUsd: 99 }); } } });
  const wallet = await installWallet(page, { trusted: true });
  await page.goto('/index.html#/data');
  const panel = page.locator('.data-mine');
  await expect(panel).toContainText('Reading your balance…');
  await expect.poll(() => api.gets).toEqual([ADDRESS]);

  await wallet.switchTo(page, 'second account');
  await expect(panel.locator('.data-addr')).toHaveText(NEXT);
  await expect(panel.locator('.credit-summary strong')).toHaveText('$12.00');
  // The first account's answer lands late, with a figure only it has.
  releaseFirst();
  await page.waitForTimeout(500);
  await expect(panel.locator('.data-addr')).toHaveText(NEXT);
  await expect(panel.locator('.credit-summary strong')).toHaveText('$12.00');
  await expect(page.locator('#view')).not.toContainText('$99.00');
  expect(api.gets).toEqual([ADDRESS, NEXT]);
});
