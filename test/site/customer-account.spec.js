'use strict';
/**
 * The customer journey against the real API. scripts/serve-api.js runs site/api in a child process
 * with the development mock provider, the mock Lightning payer and an in-memory store; a small
 * local server hands it a launched Solana config and this week's ledger. The page is the real
 * front end, and the only stand-in is the wallet: the shared fake signs with real ed25519 keys, so
 * the API checks every signature exactly as it would a Phantom one. Nothing here is funded, saved
 * or sent anywhere but 127.0.0.1.
 */
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { stubNetwork } = require('./support/network');
const { installWallet, walletAddress, keyFor } = require('./support/wallet');
const { S, COIN, TREASURY, TOKEN_2022, BURN_ACCOUNT, INCINERATOR, signatureFrom } = require('./support/solana');
const week = require('../../site/api/_lib/week');

test.use({ serviceWorkers: 'block' });

const HOLDER = walletAddress('holder');
const WELCOMER = walletAddress('welcome member');
const VISITOR = walletAddress('visitor');
const WEEK = week.weekOf(Math.floor(Date.now() / 1000));
const catalogue = require('../../site/config/esim.json');
// The development mock records an order under its place, so each fixture package's code is its
// place; wholesale checkout and its supplier SKUs have their own provider tests.
const asMockPackage = (code) => { const pkg = catalogue.packages.find((p) => p.code === code); return { ...pkg, code: pkg.slug }; };
const CFG = { ...catalogue, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, provider: 'mock',
  membership: { ...catalogue.membership, burnAccount: BURN_ACCOUNT },
  packages: ['fixed_5GB_30D_US', 'fixed_1GB_7D_DE', 'fixed_1GB_7D_EUROPE'].map(asMockPackage) };
const JOIN_UNITS = '180000000000';
const since = (label) => ({ at: Math.floor(Date.now() / 1000) - 86400, slot: 399000000, tx: signatureFrom(label) });
// This week's ledger, in docs/membership.md's shape: two members sharing this week, nobody else.
const ALLOWANCES = {
  asOf: Math.floor(Date.now() / 1000), slot: 400000000, chain: 'solana',
  week: WEEK, weekStart: week.weekEnd(WEEK) - 604800, weekEnd: week.weekEnd(WEEK),
  coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, treasury: TREASURY,
  budgetUsd: 30, budgetSource: 'creator fees collected in week ' + (WEEK - 1),
  membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3,
    requirement: { week: WEEK, burnTokens: '180000', burnUnits: JOIN_UNITS, priceUsd: 0.0000278 },
    requirements: { [WEEK]: JOIN_UNITS }, members: 2, cursor: { signature: signatureFrom('cursor'), slot: 400000000 } },
  members: { [HOLDER]: { burned: JOIN_UNITS, since: since('holder join') }, [WELCOMER]: { burned: JOIN_UNITS, since: since('welcome join') } },
  joins: {}, holders: 2, memberTokens: '2000000000',
  wallets: {
    [HOLDER]: { tokens: '1000000000', share: 0.5, allowanceUsd: 20, member: true },
    [WELCOMER]: { tokens: '1000000000', share: 0.5, allowanceUsd: 10, member: true },
  },
};
let ledger, backend, apiOrigin, frontendOrigin, host;
const json = (value) => ({ contentType: 'application/json', body: JSON.stringify(value) });
const sign = (label, message) => S.encodeBase58(crypto.sign(null, Buffer.from(message, 'utf8'), keyFor(label).privateKey));

test.beforeAll(async ({ baseURL }) => {
  frontendOrigin = new URL(baseURL).origin;
  host = new URL(baseURL).host;
  ledger = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const data = pathname === '/config.json' ? CFG : pathname === '/allowances.json' ? ALLOWANCES : null;
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise((resolve) => ledger.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ledger.address().port;
  backend = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/serve-api.js')], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true,
    // Never inherit production credentials or purchase-capable services.
    env: { SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'development', ESIM_PROVIDER: 'mock', LN_PAYER: 'mock', STORE: 'memory',
      REDEMPTIONS_ENABLED: '1', FRONTEND_ORIGINS: frontendOrigin, SIGNIN_HOST: host,
      ESIM_CONFIG_URL: origin + '/config.json', ALLOWANCES_URL: origin + '/allowances.json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.setEncoding('utf8');
  apiOrigin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Isolated customer API did not start')), 10000);
    backend.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('error', (error) => { clearTimeout(timer); reject(error); });
    backend.once('exit', (code) => { clearTimeout(timer); reject(new Error('Customer fixture API exited: ' + code)); });
  });
});

test.afterAll(async () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const stopped = new Promise((resolve) => backend.once('exit', resolve));
    backend.kill();
    await stopped;
  }
  if (ledger) await new Promise((resolve) => ledger.close(resolve));
});

/** The real front end, pointed at the isolated API, with the wallet for `label`. Records the signed POSTs. */
async function customer(page, label) {
  stubNetwork(page);
  await page.route(apiOrigin + '/**', (route) => route.continue());
  await page.route('**/config/esim.json', (route) => route.fulfill(json(CFG)));
  await page.route('**/data/allowances.json', (route) => route.fulfill(json(ALLOWANCES)));
  await page.route('**/config/app.json', (route) => route.fulfill(json({ apiBaseUrl: apiOrigin })));
  const wallet = await installWallet(page, { account: label });
  const posts = [];
  page.on('request', (request) => {
    if (request.url() === apiOrigin + '/api/redeem' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  return { wallet, posts };
}
const tab = (page, name) => page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name, exact: true }).click();
const storage = (page) => page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));

test('a member connects, redeems one eSIM through the real API, and sees its codes only in signed answers', async ({ page }) => {
  const { wallet, posts } = await customer(page, 'holder');
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  // Nothing is asked of the wallet until the visitor connects.
  expect(wallet.calls()).toEqual([]);
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$20.00');
  // Reading the credit needs no signature.
  expect(wallet.calls('signMessage')).toEqual([]);

  await tab(page, 'eSIMs');
  // A declined signature sends nothing.
  wallet.behave({ sign: 'reject' });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('Could not redeem: The request was not approved in your wallet.');
  expect(posts).toEqual([]);
  wallet.behave({ sign: 'approve' });
  const issued = page.waitForResponse((response) => response.url() === apiOrigin + '/api/redeem' && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Redeem / }).click();
  const issuedResponse = await issued;
  const issuedBody = await issuedResponse.json();
  expect(issuedResponse.status(), JSON.stringify(issuedBody)).toBe(200);
  expect(issuedBody.order.packageCode).toBe(posts[0].packageCode);
  await expect(page.locator('.data-ac')).toContainText('LPA:1$mock.invalid$');

  // The order was signed for exactly this plan, in this slot, by this wallet's key.
  expect(posts).toHaveLength(1);
  const lines = posts[0].message.split('\n');
  expect(lines.slice(0, 5)).toEqual(['OT+T — authorise a data redemption', 'Site: ' + host, 'Wallet: ' + HOLDER, 'Plan: ' + posts[0].packageCode, 'Slot: 0']);
  expect(lines[5]).toMatch(/^Issued: \d{10}$/);
  expect(lines).toHaveLength(6);
  expect(posts[0]).toEqual({ address: HOLDER, message: posts[0].message, signature: posts[0].signature, packageCode: posts[0].packageCode, n: 0 });
  expect(wallet.verify(posts[0].message, posts[0].signature)).toBe(true);
  const selectedPrice = CFG.packages.find((pkg) => pkg.code === posts[0].packageCode).priceUsd;
  const privateCode = await page.locator('.data-ac').first().innerText();

  // The public answer for the same wallet carries no installation details.
  const publicResponse = await page.request.get(apiOrigin + '/api/redeem?address=' + HOLDER);
  expect(publicResponse.status()).toBe(200);
  expect(publicResponse.headers()['cache-control']).toBe('no-store');
  const publicAccount = await publicResponse.json();
  expect(publicAccount.orders).toHaveLength(1);
  expect(publicAccount.orders[0].ac).toBe('');
  expect(publicAccount.sims[0].ac).toBe('');
  expect(JSON.stringify(publicAccount)).not.toContain('LPA:1$mock.invalid$');

  await tab(page, 'Home');
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(privateCode);
  const before = wallet.calls().length;
  await page.reload();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  // A disconnected wallet is not even reconnected quietly.
  expect(wallet.calls()).toHaveLength(before);

  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$' + (20 - selectedPrice).toFixed(2));
  await tab(page, 'eSIMs');
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('LPA:1$mock.invalid$');
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual({ address: HOLDER, message: posts[1].message, signature: posts[1].signature });
  const readLines = posts[1].message.split('\n');
  expect(readLines.slice(0, 3)).toEqual(['OT+T — show my eSIM codes', 'Site: ' + host, 'Wallet: ' + HOLDER]);
  expect(readLines[3]).toMatch(/^Issued: \d{10}$/);
  expect(readLines).toHaveLength(4);
  expect(wallet.verify(posts[1].message, posts[1].signature)).toBe(true);

  // A read signature is reused while it is fresh: showing the codes again asks the wallet nothing.
  const signs = wallet.calls('signMessage').length;
  await tab(page, 'Home');
  await tab(page, 'eSIMs');
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('LPA:1$mock.invalid$');
  expect(wallet.calls('signMessage')).toHaveLength(signs);
  expect(posts).toHaveLength(3);
  expect(posts[2]).toEqual(posts[1]);

  // Neither codes nor signatures are kept in browser storage.
  const saved = await storage(page);
  expect(saved).not.toContain('LPA:');
  for (const body of posts) expect(saved).not.toContain(body.signature);
});

test('a member claims the welcome eSIM through the real API, and a second claim cannot take another', async ({ page }) => {
  const { wallet, posts } = await customer(page, 'welcome member');
  await page.goto('/#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$10.00');
  await expect(page.locator('.om-welcome-banner')).toContainText('Your welcome eSIM is ready to claim.');
  await page.locator('.om-welcome-banner').getByRole('button', { name: 'Claim your welcome eSIM' }).click();
  const card = page.locator('.data-membership');
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM');
  // Only the plans membership includes: 1 GB for 7 days at up to $4.
  await expect(card.locator('#f-welcome-plan option')).toHaveText(['Europe · $1.19', 'Germany · $1.99']);
  await card.locator('#f-welcome-plan').selectOption('germany');
  await card.getByRole('button', { name: 'Claim Germany · 1 GB — $1.99' }).click();
  await expect(card.locator('h3')).toHaveText('You’re a member');
  await expect(page.locator('.data-sim .data-welcome-badge')).toHaveText('WELCOME');
  await expect(page.locator('.data-sim .data-ac')).toContainText('LPA:1$mock.invalid$');

  expect(posts).toHaveLength(1);
  const lines = posts[0].message.split('\n');
  expect(lines.slice(0, 4)).toEqual(['OT+T — claim my welcome eSIM', 'Site: ' + host, 'Wallet: ' + WELCOMER, 'Plan: germany']);
  expect(lines[4]).toMatch(/^Issued: \d{10}$/);
  // The ledger lists this member, so the claim needs no join transaction.
  expect(posts[0]).toEqual({ address: WELCOMER, message: posts[0].message, signature: posts[0].signature, welcome: true, packageCode: 'germany' });
  expect(wallet.verify(posts[0].message, posts[0].signature)).toBe(true);

  // The public answer shows the welcome order without its codes.
  const publicAccount = await (await page.request.get(apiOrigin + '/api/redeem?address=' + WELCOMER)).json();
  expect(publicAccount.membership).toMatchObject({ configured: true, member: true, sharing: true, burned: JOIN_UNITS });
  expect(publicAccount.membership.welcomeOrder).toMatchObject({ welcome: true, week: null, packageCode: 'germany', ac: '' });
  expect(JSON.stringify(publicAccount)).not.toContain('LPA:1$mock.invalid$');

  // Asking again for the same plan returns the same order; asking for another plan is refused.
  const claim = async (packageCode) => {
    const message = ['OT+T — claim my welcome eSIM', 'Site: ' + host, 'Wallet: ' + WELCOMER, 'Plan: ' + packageCode, 'Issued: ' + Math.floor(Date.now() / 1000)].join('\n');
    const response = await page.request.post(apiOrigin + '/api/redeem', { data: { address: WELCOMER, message, signature: sign('welcome member', message), welcome: true, packageCode } });
    return { status: response.status(), body: await response.json() };
  };
  const again = await claim('germany');
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ ok: true, replayed: true, order: { transactionId: publicAccount.membership.welcomeOrder.transactionId, packageCode: 'germany' } });
  expect(await claim('europe')).toEqual({ status: 409, body: { ok: false, error: 'your welcome eSIM has already been claimed' } });
});

test('a wallet that has not joined has no credit, and no other key can unlock a member’s account', async ({ page }) => {
  const { wallet } = await customer(page, 'visitor');
  await page.goto('/#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  // A wallet that has not joined has no weekly credit, so it is shown how to join, not a $0.00 balance.
  await expect(page.locator('.om-pass-title')).toHaveText('Not a member yet');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await tab(page, 'eSIMs');
  await expect(page.locator('.data-membership h3')).toHaveText('Join OT+T');
  await expect(page.getByRole('button', { name: /^Redeem / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my eSIM codes', exact: true })).toHaveCount(0);

  const message = ['OT+T — show my eSIM codes', 'Site: ' + new URL(frontendOrigin).host, 'Wallet: ' + HOLDER, 'Issued: ' + Math.floor(Date.now() / 1000)].join('\n');
  const post = (data) => page.request.post(apiOrigin + '/api/redeem', { data }).then(async (response) => ({ status: response.status(), body: await response.json() }));
  // The member's message, signed by the visitor's key.
  expect(await post({ address: HOLDER, message, signature: sign('visitor', message) })).toEqual({ status: 401, body: { ok: false, error: 'signature does not match address' } });
  // The visitor's own valid signature over a message naming someone else's wallet.
  expect(await post({ address: VISITOR, message, signature: sign('visitor', message) })).toEqual({ status: 401, body: { ok: false, error: 'sign-in message is for another address' } });
  await expect(page.locator('.data-ac')).toHaveCount(0);
  expect(wallet.calls('signMessage')).toEqual([]);
});
