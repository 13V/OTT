'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

test.use({ serviceWorkers: 'block' });

const ADDRESS = '0x4444444444444444444444444444444444444444';
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const CFG = { ...require('../../site/config/esim.json'), coin: '', curve: '', treasury: '' };
const ALLOWANCES = { asOf: Math.floor(Date.now() / 1000), week: WEEK, weekEnd: 345600 + (WEEK + 1) * 604800,
  coin: '', curve: '', holders: 0, budgetUsd: 0, circulating: '0', decimals: 18, wallets: {} };
let ledger;
let ledgerOrigin;
let backend;
let apiOrigin;
let frontendOrigin;

test.beforeAll(async ({ baseURL }) => {
  frontendOrigin = new URL(baseURL).origin;
  ledger = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const data = pathname === '/config.json' ? CFG : pathname === '/allowances.json' ? ALLOWANCES : null;
    if (data) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      return;
    }
    // An unrelated local frontend exercises browser CORS without changing a live deployment.
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Untrusted frontend fixture</title>');
  });
  await new Promise(resolve => ledger.listen(0, '127.0.0.1', resolve));
  ledgerOrigin = 'http://127.0.0.1:' + ledger.address().port;
  backend = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/serve-api.js')], {
    cwd: path.resolve(__dirname, '../..'),
    // Explicitly isolated env: no wallet keys, account credentials or purchase-capable services.
    env: { SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '',
      HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'development', ESIM_PROVIDER: 'mock', LN_PAYER: 'mock', STORE: 'memory',
      REDEMPTIONS_ENABLED: '0', FRONTEND_ORIGINS: frontendOrigin,
      ESIM_CONFIG_URL: ledgerOrigin + '/config.json', ALLOWANCES_URL: ledgerOrigin + '/allowances.json' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  backend.stdout.setEncoding('utf8');
  backend.stderr.setEncoding('utf8');
  apiOrigin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local prelaunch API did not start')), 10000);
    backend.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error('Local prelaunch API exited: ' + code)); });
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

async function useBackend(page) {
  await page.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    return [frontendOrigin, apiOrigin, ledgerOrigin].includes(origin) ? route.continue() : route.abort();
  });
  await page.route('**/config/esim.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(CFG) }));
  await page.route('**/config/app.json', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ walletConnect: { projectId: '' }, apiBaseUrl: apiOrigin }) }));
}

test('the real local prelaunch API renders Status across origins and refuses browser purchase requests', async ({ page }) => {
  await useBackend(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(apiOrigin)) requests.push({ method: request.method(), url: request.url() }); });
  const statusResponse = page.waitForResponse(apiOrigin + '/api/status');
  await page.goto('/#/status');
  const response = await statusResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()['access-control-allow-origin']).toBe(frontendOrigin);
  expect(await response.json()).toMatchObject({ config: { launched: false }, redemption: { enabled: false, ready: false } });
  await expect(page.locator('.status-summary')).toContainText('PRELAUNCH');
  const gate = page.locator('.status-row').filter({ has: page.locator('b', { hasText: 'Data redemption' }) });
  await expect(gate).toContainText('Prelaunch. Data redemption is disabled.');
  await expect(gate.locator('.status-dot')).toHaveClass(/off/);
  await expect(page.locator('.status-row').filter({ has: page.locator('b', { hasText: 'Health check' }) })).toHaveCount(0);
  expect(requests.every(request => request.method === 'GET')).toBe(true);

  const result = await page.evaluate(async ({ apiOrigin, address }) => {
    const read = await fetch(apiOrigin + '/api/redeem?address=' + address, { credentials: 'omit' });
    const purchase = await fetch(apiOrigin + '/api/redeem', { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, packageCode: 'fixture-package', n: 0 }) });
    return { read: { status: read.status, body: await read.json() }, purchase: { status: purchase.status, body: await purchase.json() } };
  }, { apiOrigin, address: ADDRESS });
  expect(result.read).toEqual({ status: 409, body: { ok: false, error: 'coin not launched yet' } });
  expect(result.purchase).toEqual({ status: 409, body: { ok: false, error: 'coin not launched yet' } });
  expect(errors).toEqual([]);
});

test('an unrelated frontend cannot read the local prelaunch API through browser CORS', async ({ page }) => {
  await useBackend(page);
  await page.goto(ledgerOrigin + '/untrusted.html');
  const failed = await page.evaluate(async apiOrigin => {
    try { await fetch(apiOrigin + '/api/status'); return false; }
    catch (error) { return error instanceof TypeError; }
  }, apiOrigin);
  expect(failed).toBe(true);
  // Chromium hides the denied HTTP response from the page; an HTTP read checks its status.
  const response = await page.request.get(apiOrigin + '/api/status', { headers: { Origin: ledgerOrigin } });
  expect(response.status()).toBe(403);
  expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  expect(await response.json()).toEqual({ ok: false, error: 'origin not allowed' });
});
