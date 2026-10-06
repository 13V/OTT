'use strict';
/** Public files only. Financial/account data and eSIM credentials always go to the network. */
const ROOT = new URL('./', self.registration.scope);
const CACHE_PREFIX = 'ott-pwa-' + encodeURIComponent(ROOT.pathname) + '-';
const CACHE_NAME = CACHE_PREFIX + 'v10';
const SHELL = [
  'index.html', 'fonts.css', 'style.css?v=20261006-design', 'ui.css', 'home.css?v=20261006-design', 'account-preview.css',
  'mobile-app.css?v=20261006-product', 'ui.js', 'qr.js', 'esim.js?v=20261006-account', 'clay-type.js', 'account-preview.js?v=20261006-design',
  'home.js?v=20261006-design', 'status.js', 'holders.js', 'mobile-app.js?v=20261006-account', 'app.js?v=20261006-account', 'pwa.js',
  'client-config.js', 'wallet.js?v=20261006-account',
  'manifest.webmanifest',
];
const ART = [
  'hero-touch-grass', 'hero-touch-grass-lettering', 'journey-trading-world',
  'journey-budget-world', 'journey-share-world', 'journey-connection-world',
  'shibuya-clay', 'everyday-dog-world', 'mydata-lounge-world',
  'coverage-airport-world', 'clay-alphabet', 'faq-clay-help',
].map((name) => 'assets/ott/' + name + '.webp');
const FLAGS = [
  'ae', 'au', 'br', 'ca', 'de', 'es', 'fr', 'gb', 'gr', 'id',
  'in', 'it', 'jp', 'mx', 'pt', 'sg', 'th', 'tr', 'us', 'vn',
].map((code) => 'assets/flags/' + code + '.svg');
const FONTS = [
  'BricolageGrotesque-latin-variable', 'BricolageGrotesque-latin-ext-variable',
  'InstrumentSans-latin-variable', 'InstrumentSans-latin-ext-variable',
].map((name) => 'fonts/' + name + '.woff2');
const ICONS = ['assets/app/icon.svg', 'assets/app/icon-180.png', 'assets/app/icon-192.png', 'assets/app/icon-512.png'];
const APP_ART = ['app-home-world', 'app-japan-world', 'app-kit-world', 'app-clay-logo'].map((name) => 'assets/app/' + name + '.webp');
const urls = (files) => files.map((file) => new URL(file, ROOT).href);
const shellUrls = new Set(urls(SHELL));
const assetUrls = new Set(urls([...ART, ...APP_ART, ...FLAGS, ...FONTS, ...ICONS, 'vendor/walletconnect.js']));
const indexUrl = new URL('index.html', ROOT).href;

self.addEventListener('install', (event) => {
  // Artwork and fonts are saved only after viewing them, rather than downloading every scene.
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    for (const url of urls([...SHELL, 'assets/app/icon-192.png'])) {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.status !== 200) throw new Error('App shell unavailable');
      await cache.put(url, response);
    }
  }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.status === 200) {
      try { await cache.put(fallbackUrl, response.clone()); } catch (_) { /* Full storage must not hide a network response. */ }
    }
    return response;
  } catch (_) {
    const cached = await cache.match(fallbackUrl);
    if (cached) return cached;
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200) {
    try { await cache.put(request, response.clone()); } catch (_) { /* The asset still works when storage is unavailable. */ }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Navigation requests can include the hash route, although the shell file is the same.
  url.hash = '';
  // Only the exact public release URLs above may have a query. Account requests,
  // arbitrary queries, other apps and external services always bypass this cache.
  if (request.method !== 'GET' || url.origin !== ROOT.origin || (url.search && !shellUrls.has(url.href))) return;
  if (url.href === ROOT.href || url.href === indexUrl) {
    event.respondWith(networkFirst(request, indexUrl));
  } else if (shellUrls.has(url.href)) {
    event.respondWith(networkFirst(request, url.href));
  } else if (assetUrls.has(url.href)) {
    event.respondWith(cacheFirst(request));
  }
});
