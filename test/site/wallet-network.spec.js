'use strict';
/**
 * How the browser talks to Solana. Pages read the chain only through `browserRpcs` in
 * config/addresses.json, because Solana's own public endpoint refuses requests from web pages, and
 * the site's Content-Security-Policy must allow exactly those endpoints. The reads go through
 * OTTSolana.createRpc, which moves on from an endpoint that fails and believes a "nothing here"
 * (null) answer only when every endpoint gives it. The join is where this matters most: when the
 * chain can't be read, nothing is sent.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const fs = require('fs');
const path = require('path');
const { stubNetwork } = require('./support/network.js');
const { installWallet, walletAddress } = require('./support/wallet.js');
const { COIN, TREASURY, TOKEN_2022, BURN_ACCOUNT, INCINERATOR, ata, signatureFrom, joinTransactionResult } = require('./support/solana.js');
const catalogue = require('../../site/config/esim.json');

test.use({ serviceWorkers: 'block' });

const SITE = path.join(__dirname, '..', '..', 'site');
const ADDRESSES = JSON.parse(fs.readFileSync(path.join(SITE, 'config', 'addresses.json'), 'utf8'));
const ADDRESS = walletAddress('holder');
const PUBLICNODE = 'https://solana-rpc.publicnode.com';
// A second browser endpoint for the rotation tests; support/network.js answers it like PublicNode.
const SECOND = 'http://127.0.0.1:8991';
const WEEK = Math.floor((Math.floor(Date.now() / 1000) - 345600) / 604800);
const WEEK_END = 345600 + (WEEK + 1) * 604800;
const CONFIG = { ...catalogue, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { ...catalogue.membership, burnAccount: BURN_ACCOUNT } };
const REQUIREMENT = { week: WEEK, burnTokens: '180000', burnUnits: '180000000000', priceUsd: 0.0000278 };
const STANDING = { ok: true, address: ADDRESS, week: WEEK, weekEnd: WEEK_END, tokens: '0', share: 0, decimals: 6,
  allowanceUsd: 0, redeemedUsd: 0, remainingUsd: 0, stale: false, allowancesWeek: WEEK, poolUsd: 500, orders: [], history: [], sims: [],
  membership: { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, burnUsd: 5,
    requirement: REQUIREMENT, burned: '0', welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3, member: false, memberSince: null,
    sharing: false, welcomeOrder: null, enrolment: { open: true, reason: '' } } };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * The data page for a wallet that has not joined, with `browserRpcs` set as given, up to the join's
 * confirmation step. Records each RPC call's endpoint and method. `override` adds routes on top of
 * the network stub (Playwright tries the last-registered route first).
 */
async function joinPage(page, { browserRpcs, network = {}, override } = {}) {
  stubNetwork(page, Object.assign({ balance: '250000000000' }, network));
  if (override) await override(page);
  const calls = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    let body = null;
    try { body = request.postDataJSON(); } catch (_) { body = null; }
    if (body && body.jsonrpc === '2.0') calls.push({ origin: new URL(request.url()).origin, method: body.method });
  });
  if (browserRpcs) await page.route('**/config/addresses.json', (route) => route.fulfill(json(Object.assign({}, ADDRESSES, { browserRpcs }))));
  await page.route('**/config/esim.json', (route) => route.fulfill(json(CONFIG)));
  await page.route('**/data/allowances.json', (route) => route.fulfill(json({ week: WEEK, weekEnd: WEEK_END, coin: COIN, decimals: 6, wallets: {}, members: {} })));
  await page.route('**/data/treasury.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  await page.route('**/api/redeem**', (route) => route.fulfill(json(STANDING)));
  const wallet = await installWallet(page, { trusted: true });
  await page.goto('/index.html#/data');
  const card = page.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 180,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  return { calls, wallet, card, send: () => card.getByRole('button', { name: 'Burn 180,000 OTT' }).click() };
}

test('the browser endpoints are reachable from the published site: allowed by its Content-Security-Policy, and never Solana’s own public endpoint', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(SITE, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.flatMap((rule) => rule.headers).find((header) => header.key === 'Content-Security-Policy').value;
  const connectSrc = csp.split(';').map((part) => part.trim().split(/\s+/)).find((parts) => parts[0] === 'connect-src').slice(1);
  expect(ADDRESSES.chain).toBe('solana');
  expect(ADDRESSES.browserRpcs.length).toBeGreaterThan(0);
  for (const url of ADDRESSES.browserRpcs) {
    expect(new URL(url).protocol).toBe('https:');
    expect(connectSrc).toContain(new URL(url).origin);
    expect(new URL(url).host).not.toBe('api.mainnet-beta.solana.com');
  }
});

test('a join reads the chain only through the configured browser endpoints', async ({ page }) => {
  const { calls, wallet, card, send } = await joinPage(page);
  await send();
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM', { timeout: 15000 });
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  expect([...new Set(calls.map((c) => c.origin))]).toEqual(ADDRESSES.browserRpcs.map((url) => new URL(url).origin));
  // The earlier-join check reads the wallet's own OTT account, then the incinerator's.
  expect(calls.map((c) => c.method)).toEqual(['getTokenSupply', 'getSignaturesForAddress', 'getSignaturesForAddress', 'getTokenAccountBalance', 'getLatestBlockhash', 'getSignatureStatuses']);
});

const refuse = (origin) => (page) => page.route(origin + '/**', (route) => route.abort('connectionrefused'));

test('an endpoint that fails is passed over for the next one, and the join still goes through', async ({ page }) => {
  const { calls, wallet, card, send } = await joinPage(page, { browserRpcs: [PUBLICNODE, SECOND], override: refuse(PUBLICNODE) });
  await send();
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM', { timeout: 20000 });
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  const answeredBy = (method) => calls.filter((c) => c.method === method).map((c) => c.origin);
  // Every read was tried on PublicNode first, refused, and answered by the second endpoint.
  for (const method of ['getTokenSupply', 'getTokenAccountBalance', 'getLatestBlockhash']) {
    expect(answeredBy(method)).toEqual([PUBLICNODE, SECOND]);
  }
});

test('when no endpoint answers, the join stops before the wallet is asked and says why', async ({ page }) => {
  const { wallet, card, send } = await joinPage(page, { override: refuse(PUBLICNODE) });
  await send();
  await expect(card.locator('.hint')).toHaveText('Could not burn: OTT’s supply could not be read to check the amount. Try again in a moment.');
  await expect(card.getByRole('button', { name: 'Burn 180,000 OTT' })).toBeEnabled();
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ott-membership-join:')))).toEqual([]);
});

test('an endpoint’s error answer is never taken for a result', async ({ page }) => {
  const { wallet, card, send } = await joinPage(page, { network: { methods: {
    getLatestBlockhash: { error: { code: -32005, message: 'Node is behind by 1200 slots' } },
  } } });
  await send();
  await expect(card.locator('.hint')).toHaveText('Could not burn: getLatestBlockhash failed on every Solana endpoint: Node is behind by 1200 slots');
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
});

test('an endpoint that is behind and has no record of a transaction is not believed while another one has it', async ({ page }) => {
  const earlier = signatureFrom('earlier join');
  const { calls, wallet, card, send } = await joinPage(page, {
    browserRpcs: [PUBLICNODE, SECOND],
    network: {
      // A join is in the history of both the wallet's own OTT account and the incinerator's.
      signatures: Object.fromEntries([BURN_ACCOUNT, ata(ADDRESS, COIN)].map((account) => [account, [{ signature: earlier, slot: 400000100, blockTime: Math.floor(Date.now() / 1000) - 600, err: null, confirmationStatus: 'confirmed' }]])),
      transactions: { [earlier]: joinTransactionResult({ signature: earlier, wallet: ADDRESS, amount: REQUIREMENT.burnUnits }) },
    },
    // PublicNode has not seen the transaction yet; the second endpoint has.
    override: (page) => page.route(PUBLICNODE + '/**', async (route) => {
      const body = route.request().postDataJSON();
      if (body.method !== 'getTransaction') return route.fallback();
      return route.fulfill(json({ jsonrpc: '2.0', id: body.id, result: null }));
    }),
  });
  await send();
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM');
  await expect(page.locator('#toasts')).toContainText('Membership found');
  // The earlier join was found, so nothing was sent.
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(calls.filter((c) => c.method === 'getTransaction').map((c) => c.origin)).toEqual([PUBLICNODE, SECOND]);
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-join:' + a), ADDRESS)).toBe(earlier);
});
