'use strict';

const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stubNetwork } = require('./support/network');
const solana = require('../../site/api/_lib/solana-auth');
const secp = require('../../site/api/_lib/secp256k1');
const eip191 = require('../../site/api/_lib/eip191');
const { weekOf, weekEnd } = require('../../site/api/_lib/week');

test.use({ serviceWorkers: 'block' });
let backend, apiOrigin, frontendOrigin;
test.beforeEach(async ({ baseURL }) => {
  frontendOrigin = new URL(baseURL).origin;
  backend = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/serve-api.js')], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'development', STORE: 'memory',
      FRONTEND_ORIGINS: frontendOrigin, SIGNIN_HOST: new URL(baseURL).host },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiOrigin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Linked-account fixture API did not start')), 10000);
    backend.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error('Linked-account fixture API exited: ' + code)); });
  });
});
test.afterEach(async () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const stopped = new Promise(resolve => backend.once('exit', resolve));
    backend.kill(); await stopped;
  }
});

async function customer(page) {
  // Disposable keys prove the production browser/backend protocol; no real wallet is connected.
  const solKeys = crypto.generateKeyPairSync('ed25519');
  const solAddress = solana.encodeAddress(solKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const evmKey = secp.newPrivateKey(), evmAddress = secp.addressOf(evmKey).toLowerCase();
  stubNetwork(page);
  await page.route(apiOrigin + '/**', route => route.continue());
  await page.route('**/config/app.json', route => route.fulfill({ json: { walletConnect: { projectId: '' }, apiBaseUrl: apiOrigin } }));
  const cfg = { ...require('../../site/config/esim.json'), coin: '0x' + '1'.repeat(40), curve: '0x' + '2'.repeat(40), treasury: '0x' + '3'.repeat(40) };
  await page.route('**/config/esim.json', route => route.fulfill({ json: cfg }));
  const requests = [], creditRequests = [], evmMessages = [], solInputs = [], readRequests = [];
  const privateCode = 'EXPLICIT-HOLDER-READ-ONLY';
  let holdCredit = false, releaseCredit, creditArrived;
  const heldCredit = () => new Promise(resolve => { creditArrived = resolve; });
  page.on('request', request => {
    if (request.url() === apiOrigin + '/api/auth') requests.push(request.postDataJSON());
    if (request.url().includes(apiOrigin + '/api/redeem')) creditRequests.push({ method: request.method(), address: new URL(request.url()).searchParams.get('address') });
  });
  await page.route(apiOrigin + '/api/redeem**', async route => {
    const request = route.request();
    const read = request.method() === 'POST' ? request.postDataJSON() : null;
    expect(['GET', 'POST']).toContain(request.method());
    if (read) {
      expect(read.address).toBe(evmAddress);
      expect(read.packageCode).toBeUndefined();
      expect(read.n).toBeUndefined();
      expect(read.message).toMatch(/^OT\+T — show my eSIM codes\n/);
      expect(eip191.recoverAddress(read.message, read.signature)).toBe(evmAddress);
      readRequests.push(read);
    } else expect(new URL(request.url()).searchParams.get('address')).toBe(evmAddress);
    if (holdCredit) { holdCredit = false; creditArrived?.(); await new Promise(resolve => { releaseCredit = resolve; }); }
    const week = weekOf(Math.floor(Date.now() / 1000));
    // Public holder standing is the only stub. Login/link/unlink use the actual local API.
    await route.fulfill({ headers: { 'access-control-allow-origin': frontendOrigin, 'cache-control': 'no-store' }, json: {
      ok: true, address: evmAddress, week, weekEnd: weekEnd(week), allowancesWeek: week, stale: false,
      tokens: '1000000000000000000', share: 0.01, allowanceUsd: 10, redeemedUsd: 2.5, remainingUsd: 7.5,
      orders: [], history: [], sims: [{ iccid: '8990000000000000001', slug: 'australia', codes: !!read,
        ac: read ? 'LPA:1$smdp.fixture$' + privateCode : '', createdAt: new Date().toISOString() }],
    } });
  });
  await page.exposeFunction('holderSignSolana', input => {
    expect(input.address).toBe(solAddress); solInputs.push(input);
    const bytes = solana.messageBytes(input);
    return { signedMessage: [...bytes], signature: [...crypto.sign(null, bytes, solKeys.privateKey)] };
  });
  await page.exposeFunction('holderSignEvm', ({ message, address }) => {
    expect(address).toBe(evmAddress);
    const text = Buffer.from(message.slice(2), 'hex').toString('utf8');
    expect(text).toMatch(/^OT\+T — (link wallets|show my eSIM codes)\n/); evmMessages.push(text);
    return eip191.sign(evmKey, text);
  });
  await page.addInitScript(({ solAddress, evmAddress }) => {
    const listeners = new Map();
    window.holderWalletMethods = [];
    const events = {
      on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      off(name, callback) { listeners.get(name)?.delete(callback); },
    };
    window.phantom = { solana: {
      ...events, isPhantom: true, publicKey: null,
      async connect() { window.holderWalletMethods.push('solana:connect'); this.publicKey = { toString: () => solAddress }; return { publicKey: this.publicKey }; },
      async disconnect() { this.publicKey = null; },
      async signIn(input) {
        window.holderWalletMethods.push('solana:signIn');
        const out = await window.holderSignSolana(input);
        return { account: { address: solAddress }, signedMessage: new Uint8Array(out.signedMessage), signature: new Uint8Array(out.signature), signatureType: 'ed25519' };
      },
    } };
    window.ethereum = {
      ...events,
      async request({ method, params }) {
        window.holderWalletMethods.push('evm:' + method);
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') return [evmAddress.toUpperCase().replace('0X', '0x')];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') return window.holderSignEvm({ message: params[0], address: params[1] });
        throw new Error('No transaction is authorized in this wallet fixture: ' + method);
      },
    };
  }, { solAddress, evmAddress });
  await page.goto('/#/app');
  const login = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'verify');
  await page.getByRole('button', { name: 'Sign in with Solana', exact: true }).click();
  const loginResponse = await login;
  expect(loginResponse.status()).toBe(200);
  const loginBody = await loginResponse.json();
  await expect(page.getByRole('heading', { name: 'Link for holder credit.', exact: true })).toBeVisible();
  return { solAddress, evmAddress, loginBody, requests, creditRequests, evmMessages, solInputs, readRequests, privateCode, cfg,
    holdNextCredit() { holdCredit = true; return heldCredit(); }, releaseCredit() { releaseCredit?.(); } };
}

async function link(page) {
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await page.getByRole('button', { name: 'Link holder wallet', exact: true }).click();
  const verified = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'link-verify');
  await page.getByRole('button', { name: 'Link with browser wallet', exact: true }).click();
  const response = await verified;
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return response.json();
}
async function unlink(page) {
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  const unlinked = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'unlink');
  await page.getByRole('button', { name: 'Unlink holder wallet', exact: true }).click();
  const response = await unlinked;
  expect(response.status()).toBe(200);
  expect((await response.json()).linkedWallet).toBe(null);
  await expect(page.getByRole('heading', { name: 'Link for holder credit.', exact: true })).toBeVisible();
}

test('verified dual-wallet link shows existing holder credit without granting redemption or installation access', async ({ page }) => {
  const f = await customer(page);
  expect(f.creditRequests).toEqual([]);
  const linked = await link(page);
  expect(linked.linkedWallet).toEqual({ address: f.evmAddress, chain: 'evm', chainId: 4663 });
  await expect(page.locator('.om-balance')).toHaveText('$7.50');
  await expect(page.getByRole('heading', { name: 'Plans within your credit', exact: true })).toBeVisible();
  expect(f.creditRequests.length).toBeGreaterThan(0);
  expect(f.creditRequests.every(request => request.method === 'GET' && request.address === f.evmAddress)).toBe(true);
  expect(f.solInputs).toHaveLength(2);
  expect(f.solInputs[0].statement).toBe('Sign in to OTT. This does not move funds.');
  expect(f.solInputs[1].statement).toBe('Link this Solana account to Robinhood Chain wallet ' + f.evmAddress + ' on OTT. This does not move funds.');
  expect(f.evmMessages).toHaveLength(1);
  expect(f.evmMessages[0]).toContain('Solana Wallet: ' + f.solAddress);
  const state = await page.evaluate(() => ({ wallet: window.OTTWallet.state(), login: window.OTTSolanaLogin.state(), account: window.OTT_STATE.account }));
  expect(state.wallet.chain).toBe('solana');
  expect(state.account).toBe(f.solAddress);
  expect(state.login.account).toEqual({ address: f.solAddress, chain: 'solana', verified: true, credit: 0, eligible: false });
  const serverSession = await page.request.post(apiOrigin + '/api/auth', { headers: { origin: frontendOrigin }, data: { action: 'session', token: f.loginBody.token } });
  expect((await serverSession.json()).account).toEqual(f.loginBody.account);
  const linkRequest = f.requests.find(request => request.action === 'link-verify');
  expect(linkRequest.addressSOL).toBe(f.solAddress);
  expect(linkRequest.evmAddress).toBe(f.evmAddress);
  expect(linkRequest.signatureType).toBe('ed25519');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your Solana account', exact: true })).toBeVisible();
  await expect(page.getByText('approve a redemption or reveal private eSIM installation details.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Set up|Show .*codes|Redeem /i })).toHaveCount(0);
  await page.goto('/#/app/plans');
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Switch to that Robinhood Chain wallet to approve a redemption.');
  await expect(review.getByRole('button', { name: 'Use Robinhood wallet', exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Continue to eSIMs' })).toHaveCount(0);
  expect(f.creditRequests.every(request => request.method === 'GET' && request.address !== f.solAddress)).toBe(true);
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$7.50');
  await unlink(page);
  const readsAfterUnlink = f.creditRequests.length;
  await page.goto('/#/app/plans');
  await expect(page.locator('.om-plan-budget')).toContainText('Confirmed holder credit is required');
  await page.goto('/#/app');
  await expect(page.getByRole('heading', { name: 'Link for holder credit.', exact: true })).toBeVisible();
  expect(f.creditRequests).toHaveLength(readsAfterUnlink);
  const unlinkedSession = await page.request.post(apiOrigin + '/api/auth', { headers: { origin: frontendOrigin }, data: { action: 'link', token: f.loginBody.token } });
  expect((await unlinkedSession.json()).linkedWallet).toBe(null);
});

test('a delayed linked credit response cannot restore a balance after unlink', async ({ page }) => {
  const f = await customer(page);
  const creditStarted = f.holdNextCredit();
  await link(page);
  await creditStarted;
  await expect(page.getByRole('heading', { name: 'Reading your credit…', exact: true })).toBeVisible();
  await unlink(page);
  const readsAfterUnlink = f.creditRequests.length;
  f.releaseCredit();
  await expect(page.getByRole('heading', { name: 'Link for holder credit.', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plans within your credit', exact: true })).toHaveCount(0);
  await page.goto('/#/app/plans');
  await expect(page.locator('.om-plan-budget')).toContainText('Confirmed holder credit is required');
  expect(f.creditRequests).toHaveLength(readsAfterUnlink);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBe(null);
});

test('switching from a linked Solana package review preserves its selection without approving a purchase or private read', async ({ page }) => {
  const f = await customer(page);
  await link(page);
  await expect(page.locator('.om-balance')).toHaveText('$7.50');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByRole('button', { name: /^Choose coverage\./ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Australia', exact: true }).click();
  const selected = f.cfg.packages.find(pkg => pkg.slug === 'australia' && pkg.gb === 1);
  expect(selected).toBeTruthy();
  await page.locator('[data-package-code="' + selected.code + '"]').click();
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Australia data plan', exact: true });
  await expect(review).toContainText('1 GB');
  await review.getByRole('button', { name: 'Use Robinhood wallet', exact: true }).click();
  await expect(page).toHaveURL(/#\/app\/esims$/);
  await expect(page.locator('#f-place')).toHaveValue('australia');
  await expect(page.locator('#f-package')).toHaveValue(selected.code);
  await expect(page.locator('.data-redeem').getByRole('button', { name: /^Redeem Australia/ })).toContainText('1 GB');
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('evm');
  expect(f.evmMessages).toHaveLength(1);
  expect(f.evmMessages[0]).toMatch(/^OT\+T — link wallets\n/);
  expect(f.readRequests).toEqual([]);
  expect(f.creditRequests.every(request => request.method === 'GET')).toBe(true);
  expect(await page.locator('body').textContent()).not.toContain(f.privateCode);
  await expect(page.locator('.data-ac')).toHaveText('—');

  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText(f.privateCode);
  expect(f.readRequests).toHaveLength(1);
  expect(f.readRequests[0].packageCode).toBeUndefined();
  expect(f.evmMessages).toHaveLength(2);
  expect(f.evmMessages[1]).toMatch(/^OT\+T — show my eSIM codes\n/);
  expect(f.creditRequests.filter(request => request.method === 'POST')).toHaveLength(1);
});
