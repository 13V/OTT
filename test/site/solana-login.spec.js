'use strict';
const { test, expect } = require('@playwright/test');
const { generateKeyPairSync, sign } = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
function message(input) {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
}
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
    const timer = setTimeout(() => reject(new Error('Solana fixture API did not start')), 10000);
    backend.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error('Solana fixture API exited: ' + code)); });
  });
});
test.afterEach(async () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const stopped = new Promise(resolve => backend.once('exit', resolve));
    backend.kill(); await stopped;
  }
});
async function customer(page, { active = false, restoreRace = false } = {}) {
  // Disposable unfunded key generated exclusively inside this local test.
  const keys = generateKeyPairSync('ed25519');
  const address = base58(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  const other = base58(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  stubNetwork(page);
  await page.route(apiOrigin + '/**', route => route.continue());
  await page.route('**/config/app.json', route => route.fulfill({ json: { walletConnect: { projectId: '' }, apiBaseUrl: apiOrigin } }));
  if (active) {
    const cfg = { ...require('../../site/config/esim.json'), coin: '0x1111111111111111111111111111111111111111',
      curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' };
    await page.route('**/config/esim.json', route => route.fulfill({ json: cfg }));
  }
  await page.exposeFunction('signSolanaFixture', input => {
    const bytes = Buffer.from(message(input));
    return { signedMessage: [...bytes], signature: [...sign(null, bytes, keys.privateKey)] };
  });
  await page.addInitScript(({ address, other, restoreRace }) => {
    const events = new Map();
    window.solanaMethods = [];
    const provider = {
      isPhantom: true, selected: address, publicKey: null,
      on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
      off(name, callback) { events.get(name)?.delete(callback); },
      async connect(options) {
        window.solanaMethods.push(options?.onlyIfTrusted ? 'restore' : 'connect');
        const selected = provider.selected;
        provider.publicKey = { toString: () => selected };
        if (options?.onlyIfTrusted && restoreRace) queueMicrotask(() => queueMicrotask(() => window.changeSolana()));
        return { publicKey: provider.publicKey };
      },
      async disconnect() { window.solanaMethods.push('disconnect'); provider.publicKey = null; },
      async signIn(input) {
        window.solanaMethods.push('signIn');
        if (window.rejectSolana) throw new Error('User rejected the request.');
        const signed = await window.signSolanaFixture(input);
        return { account: { address: window.wrongSolanaOutput ? other : input.address },
          signedMessage: new Uint8Array(signed.signedMessage), signature: new Uint8Array(signed.signature), signatureType: 'ed25519' };
      },
    };
    window.changeSolana = () => {
      provider.selected = other; provider.publicKey = { toString: () => other };
      for (const callback of events.get('accountChanged') || []) callback(provider.publicKey);
    };
    window.phantom = { solana: provider };
    if (restoreRace) localStorage.setItem('ott-wallet-transport:/', 'solana');
  }, { address, other, restoreRace });
  const requests = [];
  page.on('request', request => { if (request.url() === apiOrigin + '/api/auth') requests.push(request.postDataJSON()); });
  await page.goto('/#/app');
  return { address, other, requests };
}
async function signInButton(page) {
  await page.getByRole('button', { name: 'Sign in with Solana', exact: true }).click();
}

test('Phantom login verifies real Ed25519 bytes and never enters EVM redemption', async ({ page }) => {
  const { address, requests } = await customer(page, { active: true });
  const financialRequests = [];
  page.on('request', request => { if (/\/api\/redeem/.test(request.url())) financialRequests.push(request.url()); });
  const verified = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'verify');
  await signInButton(page);
  const response = await verified, body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body.account).toEqual({ address, chain: 'solana', verified: true, credit: 0, eligible: false });
  await expect(page.locator('.om-home-context')).toHaveText('Signed in with Solana. Your wallet ownership is verified.');
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  expect(requests.map(request => request.action)).toEqual(['challenge', 'verify']);
  expect(await page.evaluate(() => window.solanaMethods)).toEqual(['connect', 'signIn']);
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, state: window.OTTSolanaLogin.state() }));
  expect(JSON.stringify(stored)).not.toContain(body.token);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your Solana account', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toHaveCount(0);
  await page.goto('/#/data');
  await expect(page.getByRole('heading', { name: 'Your Solana account', exact: true })).toBeVisible();
  expect(financialRequests).toEqual([]);
  await page.goto('/#/app/plans');
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Solana wallet linking is not available yet.');
  await expect(review.getByRole('button', { name: 'Continue in My data' })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Use Robinhood wallet' })).toBeVisible();
});

test('boot cannot overwrite a Solana account changed as trusted restoration resolves', async ({ page }) => {
  const { other, requests } = await customer(page, { restoreRace: true });
  await expect(page.getByRole('heading', { name: 'Finish signing in.', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.OTTWallet.state().accounts[0])).toBe(other);
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(other);
  expect(requests).toEqual([]);
});

test('rejecting Phantom approval leaves a connected but unverified account', async ({ page }) => {
  const { requests } = await customer(page);
  await page.evaluate(() => { window.rejectSolana = true; });
  await signInButton(page);
  await expect(page.locator('#toasts')).toContainText('User rejected the request.');
  await expect(page.getByRole('heading', { name: 'Finish signing in.', exact: true })).toBeVisible();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(requests.map(request => request.action)).toEqual(['challenge']);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBe(null);
});

test('a different wallet returned by Phantom cannot become the verified identity', async ({ page }) => {
  const { requests } = await customer(page);
  await page.evaluate(() => { window.wrongSolanaOutput = true; });
  await signInButton(page);
  await expect(page.locator('#toasts')).toContainText('Solana sign-in failed');
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBe(null);
  expect(requests.map(request => request.action)).toEqual(['challenge']);
});

test('refresh restores only a trusted connection and requires a new login signature', async ({ page }) => {
  await customer(page);
  await signInButton(page);
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Finish signing in.', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.solanaMethods)).toEqual(['restore']);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBe(null);
});

test('disconnect clears the page and revokes the backend session', async ({ page }) => {
  await customer(page);
  const verification = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'verify');
  await signInButton(page);
  const { token } = await (await verification).json();
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  const logout = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'logout');
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  expect((await logout).status()).toBe(200);
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBe(null);
  const expired = await page.request.post(apiOrigin + '/api/auth', { headers: { origin: frontendOrigin }, data: { action: 'session', token } });
  expect(expired.status()).toBe(401);
});

test('a late verified response is revoked after switching Solana accounts', async ({ page }) => {
  const { other } = await customer(page);
  let release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let token;
  await page.route(apiOrigin + '/api/auth', async route => {
    if (route.request().postDataJSON().action !== 'verify') return route.continue();
    const response = await route.fetch();
    token = (await response.json()).token;
    arrived(); await hold; await route.fulfill({ response });
  });
  await signInButton(page);
  await waiting;
  await expect(page.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
  await page.evaluate(() => window.changeSolana());
  const logout = page.waitForResponse(response => response.url() === apiOrigin + '/api/auth' && response.request().postDataJSON().action === 'logout');
  release();
  expect((await logout).status()).toBe(200);
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(other);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBe(null);
  await expect(page.locator('.om-balance')).toHaveCount(0);
  const revoked = await page.request.post(apiOrigin + '/api/auth', { headers: { origin: frontendOrigin }, data: { action: 'session', token } });
  expect(revoked.status()).toBe(401);
});

test('visitors without Phantom get usable install and mobile instructions', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app');
  await signInButton(page);
  const dialog = page.getByRole('dialog', { name: 'Sign in with Phantom', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Phantom’s browser');
  await expect(dialog.getByRole('link', { name: 'Get Phantom' })).toHaveAttribute('href', 'https://phantom.com/download');
});
