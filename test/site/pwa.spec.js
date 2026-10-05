'use strict';
let pwTest;
try { pwTest = require('@playwright/test'); } catch (_) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '../../site');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
let server;
let origin;
let base;

test.beforeAll(async () => {
  // The real site under the GitHub project prefix, without a purchase-capable backend.
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/OTT/')) { res.writeHead(404).end(); return; }
    const rel = decodeURIComponent(url.pathname.slice(5)) || 'index.html';
    if (rel.startsWith('api/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: true, fixture: true, activation: 'not-a-real-esim' }));
      return;
    }
    if (rel === 'activation/fixture.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, body) => {
      res.writeHead(err ? 404 : 200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
        .end(err ? 'Not found' : body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  base = origin + '/OTT/';
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function visitApp(page) {
  // Real external services are not involved in this installation/offline test.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  await page.goto(base + '#/app');
  await expect.poll(() => page.evaluate(() => !!window.OTTPwa && !!window.OTTMobileApp)).toBe(true);
}

async function controlled(page) {
  const scope = await page.evaluate(async () => {
    const registration = await window.OTTPwa.register();
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    });
    return registration.scope;
  });
  expect(scope).toBe(base);
}

async function cacheUrls(page) {
  return page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('ott-pwa-')) continue;
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
}

test('the manifest and real icons launch the installed app inside the /OTT/ project scope', async ({ page }) => {
  await visitApp(page);
  const manifestResponse = await page.request.get(base + 'manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(new URL(manifest.start_url, base).href).toBe(base + '#/app');
  expect(new URL(manifest.scope, base).href).toBe(base);
  expect(new URL(manifest.id, base).href).toBe(base);
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBe('#172F31');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', './manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', './assets/app/icon-180.png');
  for (const size of [180, 192, 512]) {
    const response = await page.request.get(base + 'assets/app/icon-' + size + '.png');
    expect(response.status()).toBe(200);
    const bytes = await response.body();
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  expect(manifest.icons.filter((icon) => icon.purpose.includes('maskable')).map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
});

test('installation is user initiated and uses manual guidance when no browser prompt is available', async ({ page }) => {
  await visitApp(page);
  const manual = await page.evaluate(() => window.OTTPwa.install());
  expect(['manual', 'accepted']).toContain(manual.outcome);
  expect(manual.instructions).toContain('browser menu');
  await page.evaluate(() => {
    window.__promptCalls = 0;
    window.__pwaChanges = [];
    window.addEventListener('ott:pwa', (event) => window.__pwaChanges.push(event.detail));
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => { window.__promptCalls++; return Promise.resolve({ outcome: 'accepted' }); };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  expect(await page.evaluate(() => window.__promptCalls)).toBe(0);
  expect(await page.evaluate(() => window.OTTPwa.capability().canPrompt)).toBe(true);
  expect(await page.evaluate(() => window.OTTPwa.install())).toMatchObject({ outcome: 'accepted' });
  expect(await page.evaluate(() => window.__promptCalls)).toBe(1);
  expect(await page.evaluate(() => window.OTTPwa.capability().canPrompt)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  expect(await page.evaluate(() => window.OTTPwa.install())).toMatchObject({ outcome: 'installed' });
  expect(await page.evaluate(() => window.__pwaChanges.at(-1).installed)).toBe(true);
});

test('iPhone installation guidance explains Safari Share rather than offering an unavailable native prompt', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  try {
    const page = await context.newPage();
    await visitApp(page);
    const result = await page.evaluate(() => window.OTTPwa.install());
    expect(result.outcome).toBe('manual');
    expect(result.instructions).toContain('Safari');
    expect(result.instructions).toContain('Share');
    expect(result.instructions).toContain('Add to Home Screen');
    expect(await page.evaluate(() => window.OTTPwa.capability().platform)).toBe('ios');
  } finally { await context.close(); }
});

test('the service worker caches public release files but never configuration, ledgers, account APIs, arbitrary queries or activation images', async ({ page, context }) => {
  await visitApp(page);
  await controlled(page);
  const result = await page.evaluate(async (base) => {
    const privatePaths = ['config/addresses.json', 'config/esim.json', 'data/allowances.json', 'data/treasury.json', 'api/status', 'api/redeem?address=0xfixture', 'ui.js?wallet=private-marker', 'activation/fixture.svg'];
    for (const rel of privatePaths) await fetch(new URL(rel, base), { cache: 'no-store' });
    await fetch(new URL('api/redeem', base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'fixture only', signature: 'not-a-wallet-signature' }),
      cache: 'no-store',
    });
    await fetch(new URL('assets/flags/jp.svg', base));
    await fetch(new URL('fonts/InstrumentSans-latin-variable.woff2', base));
    return privatePaths.map((rel) => new URL(rel, base).href);
  }, base);
  const urls = await cacheUrls(page);
  expect(urls).toContain(base + 'index.html');
  expect(urls).toContain(base + 'assets/flags/jp.svg');
  expect(urls).toContain(base + 'fonts/InstrumentSans-latin-variable.woff2');
  for (const url of result) expect(urls).not.toContain(url);
  const publicVersions = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll(elements => elements
    .map(el => el.src || el.href).filter(url => new URL(url).search));
  expect(publicVersions.map(url => new URL(url).pathname.split('/').pop()).sort()).toEqual(['esim.js', 'mobile-app.css', 'mobile-app.js']);
  for (const url of publicVersions) expect(urls).toContain(url);
  expect(urls.some(url => (new URL(url).search && !publicVersions.includes(url)) || /\/(api|config|data|activation)\//.test(new URL(url).pathname))).toBe(false);
  expect(urls.every((url) => new URL(url).origin === origin && new URL(url).pathname.startsWith('/OTT/'))).toBe(true);
  await context.setOffline(true);
  const failures = await page.evaluate(async (base) => Promise.all(['config/esim.json', 'data/allowances.json', 'api/status'].map(async (rel) => {
    try { await fetch(new URL(rel, base), { cache: 'no-store' }); return false; } catch (_) { return true; }
  })), base);
  expect(failures).toEqual([true, true, true]);
});

test('an installed shell opens /OTT/#/app offline without replaying financial requests or inventing a balance', async ({ page, context }) => {
  await visitApp(page);
  await controlled(page);
  await context.setOffline(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.OTTMobileApp && !!window.OTTPwa)).toBe(true);
  await expect(page.locator('#view')).toContainText(/offline/i);
  const text = await page.locator('#view').innerText();
  expect(text).not.toMatch(/\$15\.00|Available credit\s*\$0\.00/);
  expect(await page.evaluate(() => window.OTTPwa.capability().online)).toBe(false);
  expect((await cacheUrls(page)).some((url) => /\/(api|config|data)\//.test(new URL(url).pathname))).toBe(false);
});
