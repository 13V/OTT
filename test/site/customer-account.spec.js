'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stubNetwork } = require('./support/network');
const secp = require('../../site/api/_lib/secp256k1');
const eip191 = require('../../site/api/_lib/eip191');
const week = require('../../site/api/_lib/week');

test.use({ serviceWorkers: 'block' });

// Disposable keys generated for this isolated process. They are never funded,
// saved, or used against a real wallet, relay, supplier or deployed API.
const holderKey = secp.newPrivateKey();
const visitorKey = secp.newPrivateKey();
const HOLDER = secp.addressOf(holderKey).toLowerCase();
const VISITOR = secp.addressOf(visitorKey).toLowerCase();
const WEEK = week.weekOf(Math.floor(Date.now() / 1000));
const catalogue = require('../../site/config/esim.json');
const fixturePackage = catalogue.packages.find(pkg => pkg.code === 'fixed_5GB_30D_US');
const CFG = { ...require('../../site/config/esim.json'),
  coin: '0x1111111111111111111111111111111111111111',
  curve: '0x2222222222222222222222222222222222222222',
  treasury: '0x3333333333333333333333333333333333333333', provider: 'mock',
  // The development mock records its legacy place identifier. Give this auth
  // fixture one explicit package with that identifier; wholesale checkout and
  // its supplier SKU contract have separate provider tests.
  packages: [{ ...fixturePackage, code: fixturePackage.slug }] };
const ALLOWANCES = { week: WEEK, weekEnd: week.weekEnd(WEEK), decimals: 18,
  coin: CFG.coin, curve: CFG.curve, holders: 1, budgetUsd: 20,
  wallets: { [HOLDER]: { tokens: '1000000000000000000000', share: 1, allowanceUsd: 20 } } };
let ledger, backend, apiOrigin, frontendOrigin;
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });

test.beforeAll(async ({ baseURL }) => {
  frontendOrigin = new URL(baseURL).origin;
  ledger = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const data = pathname === '/config.json' ? CFG : pathname === '/allowances.json' ? ALLOWANCES : null;
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise(resolve => ledger.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ledger.address().port;
  backend = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/serve-api.js')], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true,
    // Never inherit production credentials or purchase-capable services.
    env: { SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'development', ESIM_PROVIDER: 'mock', LN_PAYER: 'mock', STORE: 'memory',
      REDEMPTIONS_ENABLED: '1', FRONTEND_ORIGINS: frontendOrigin, SIGNIN_HOST: new URL(baseURL).host,
      ESIM_CONFIG_URL: origin + '/config.json', ALLOWANCES_URL: origin + '/allowances.json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.setEncoding('utf8');
  apiOrigin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Isolated customer API did not start')), 10000);
    backend.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error('Customer fixture API exited: ' + code)); });
  });
});

test.afterAll(async () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const stopped = new Promise(resolve => backend.once('exit', resolve));
    backend.kill();
    await stopped;
  }
  if (ledger) await new Promise(resolve => ledger.close(resolve));
});

async function customer(page, address, key) {
  stubNetwork(page);
  await page.route(apiOrigin + '/**', route => route.continue());
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  await page.route('**/data/allowances.json', route => route.fulfill(json(ALLOWANCES)));
  await page.route('**/config/app.json', route => route.fulfill(json({ walletConnect: { projectId: '' }, apiBaseUrl: apiOrigin })));
  // The real frontend sends its real personal_sign message to the real local API.
  // The only wallet substitute is a local EIP-1193 provider with disposable keys.
  await page.exposeFunction('signCustomerFixture', hex => eip191.sign(key, Buffer.from(hex.slice(2), 'hex').toString('utf8')));
  await page.addInitScript(address => {
    window.customerWalletMethods = [];
    const handlers = new Map();
    const provider = {
      accounts: [],
      on(event, callback) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(callback); },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async request({ method, params }) {
        window.customerWalletMethods.push(method);
        if (method === 'eth_accounts') return provider.accounts;
        if (method === 'eth_requestAccounts') { provider.accounts = [address]; return provider.accounts; }
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') {
          if (window.rejectCustomerSignature) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          return window.signCustomerFixture(params[0]);
        }
        throw new Error('Unexpected customer fixture wallet method: ' + method);
      },
    };
    window.ethereum = provider;
  }, address);
}

test('a visitor connects, approves one mock eSIM, unlocks private details, and disconnects through the real API', async ({ page }) => {
  await customer(page, HOLDER, holderKey);
  const posts = [];
  page.on('request', request => {
    if (request.url() === apiOrigin + '/api/redeem' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.customerWalletMethods)).toEqual(['eth_accounts']);
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$20.00');
  expect(await page.evaluate(() => window.customerWalletMethods)).not.toContain('personal_sign');

  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.evaluate(() => { window.rejectCustomerSignature = true; });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('User rejected the request.');
  expect(posts).toEqual([]);
  await page.evaluate(() => { window.rejectCustomerSignature = false; });
  const issued = page.waitForResponse(response => response.url() === apiOrigin + '/api/redeem' && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Redeem / }).click();
  const issuedResponse = await issued;
  const issuedBody = await issuedResponse.json();
  expect(issuedResponse.status(), JSON.stringify(issuedBody)).toBe(200);
  expect(issuedBody.order.packageCode).toBe(posts[0].packageCode);
  await expect(page.locator('.data-ac')).toContainText('LPA:1$mock.invalid$');
  expect(posts).toHaveLength(1);
  expect(posts[0].message).toContain('authorise a data redemption');
  const selectedPrice = CFG.packages.find(pkg => pkg.code === posts[0].packageCode).priceUsd;
  const privateCode = await page.locator('.data-ac').first().innerText();

  const publicResponse = await page.request.get(apiOrigin + '/api/redeem?address=' + HOLDER);
  expect(publicResponse.status()).toBe(200);
  expect(publicResponse.headers()['cache-control']).toBe('no-store');
  const publicAccount = await publicResponse.json();
  expect(publicAccount.orders).toHaveLength(1);
  expect(publicAccount.orders[0].ac).toBe('');
  expect(publicAccount.sims[0].ac).toBe('');
  expect(JSON.stringify(publicAccount)).not.toContain('LPA:1$mock.invalid$');

  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(privateCode);
  await page.reload();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.customerWalletMethods)).toEqual([]);

  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$' + (20 - selectedPrice).toFixed(2));
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('LPA:1$mock.invalid$');
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toHaveProperty('packageCode');
  expect(posts[1].message).toContain('show my eSIM codes');
  const saved = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(saved).not.toContain('LPA:');
  for (const body of posts) expect(saved).not.toContain(body.signature);
});

test('a new wallet has no holder credit and another key cannot unlock an existing account', async ({ page }) => {
  await customer(page, VISITOR, visitorKey);
  await page.goto('/#/app');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Redeem / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my eSIM codes', exact: true })).toHaveCount(0);
  const message = ['OT+T — show my eSIM codes', 'Site: ' + new URL(frontendOrigin).host,
    'Wallet: ' + HOLDER, 'Issued: ' + Math.floor(Date.now() / 1000)].join('\n');
  const response = await page.request.post(apiOrigin + '/api/redeem', {
    data: { address: HOLDER, message, signature: eip191.sign(visitorKey, message) },
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: 'signature does not match address' });
  await expect(page.locator('.data-ac')).toHaveCount(0);
  expect(await page.evaluate(() => window.customerWalletMethods)).not.toContain('personal_sign');
});
