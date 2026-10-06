'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the public helpers in isolated page-like contexts. No wallet, API or network is used.
const source = fs.readFileSync(path.join(__dirname, '../../site/holder-tools.js'), 'utf8');
const KEY = 'ott-saved-places:/ott/v1';
const catalogue = (count = 14) => ({ packages: Array.from({ length: count }, (_, i) => ({
  slug: 'place-' + i, code: 'P' + i, priceUsd: 1, gb: 1, days: 7,
})) });
function fixture({ storage = new Map(), readFails = false, writeFails = false, base = '/ott/' } = {}) {
  const writes = [];
  const window = {};
  vm.runInNewContext(source, {
    window, URL, document: { currentScript: { src: 'https://ott.fixture' + base + 'holder-tools.js' } },
    location: { href: 'https://ott.fixture' + base },
    localStorage: {
      getItem(key) { if (readFails) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
      setItem(key, value) {
        if (writeFails) throw new Error('Storage unavailable');
        storage.set(key, value); writes.push([key, value]);
      },
    },
  });
  return { tools: window.OTTHolderTools, storage, writes };
}

test('saved destinations persist only public slugs, toggle cleanly and stay scoped to the site path', () => {
  const cfg = catalogue(), { tools, storage, writes } = fixture();
  expect(tools.savedPlaces(cfg)).toEqual([]);
  expect(tools.toggleSaved(cfg, 'place-1')).toEqual({ saved: true, persisted: true, places: ['place-1'] });
  expect(tools.toggleSaved(cfg, 'place-2').places).toEqual(['place-1', 'place-2']);
  expect(JSON.parse(storage.get(KEY))).toEqual(['place-1', 'place-2']);
  expect(fixture({ storage }).tools.savedPlaces(cfg)).toEqual(['place-1', 'place-2']);
  expect(fixture({ storage, base: '/other/' }).tools.savedPlaces(cfg)).toEqual([]);
  expect(tools.toggleSaved(cfg, 'place-1')).toEqual({ saved: false, persisted: true, places: ['place-2'] });
  const copy = tools.savedPlaces(cfg); copy.push('place-3');
  expect(tools.savedPlaces(cfg)).toEqual(['place-2']);
  expect(writes.every(([key, value]) => key === KEY && JSON.parse(value).every(item => typeof item === 'string'))).toBe(true);
});

test('preferences prune removed destinations, reject injected values and cap an existing payload', () => {
  const cfg = catalogue(18);
  cfg.packages.push({ slug: 'https://private.fixture/install', code: 'BAD' }, { slug: 'UPPER', code: 'BAD2' });
  const malicious = [{ ac: 'private-activation-fixture', token: 'private-token-fixture' }, 'place-1', 'place-1',
    '__proto__', 'https://private.fixture/install', 'UPPER', '<img src=x>', 1, null, ...catalogue(18).packages.map(pkg => pkg.slug)];
  const { tools, storage } = fixture({ storage: new Map([[KEY, JSON.stringify(malicious)]]) });
  const saved = tools.savedPlaces(cfg);
  expect(saved).toHaveLength(12);
  expect(new Set(saved).size).toBe(12);
  expect(saved.every(slug => /^place-\d+$/.test(slug))).toBe(true);
  expect(tools.savedPlaces({ packages: [{ slug: 'place-1' }] })).toEqual(['place-1']);
  expect(() => tools.toggleSaved(cfg, 'https://private.fixture/install')).toThrow(/current catalogue/);
  expect(() => tools.toggleSaved(cfg, '__proto__')).toThrow(/current catalogue/);
  tools.toggleSaved(cfg, 'place-1');
  expect(storage.get(KEY)).not.toMatch(/private|token|__proto__|<img|https:/);
});

test('malformed, non-array and oversized preference payloads never become saved destinations', () => {
  const cfg = catalogue();
  for (const raw of ['{broken', JSON.stringify({ signature: 'private-signature-fixture' }), '"place-1"',
    JSON.stringify(['place-1', 'x'.repeat(2048)])]) {
    const { tools, storage } = fixture({ storage: new Map([[KEY, raw]]) });
    expect(tools.savedPlaces(cfg)).toEqual([]);
    expect(tools.toggleSaved(cfg, 'place-2').places).toEqual(['place-2']);
    expect(JSON.parse(storage.get(KEY))).toEqual(['place-2']);
  }
});

test('a full saved list refuses another destination without changing storage and permits replacement', () => {
  const cfg = catalogue(), { tools, storage } = fixture();
  for (let i = 0; i < 12; i++) tools.toggleSaved(cfg, 'place-' + i);
  const before = storage.get(KEY);
  expect(() => tools.toggleSaved(cfg, 'place-12')).toThrow(/up to 12/);
  expect(storage.get(KEY)).toBe(before);
  tools.toggleSaved(cfg, 'place-0');
  expect(tools.toggleSaved(cfg, 'place-12').places).toHaveLength(12);
  expect(tools.savedPlaces(cfg)).not.toContain('place-0');
});

for (const readFails of [true, false]) {
  test('unavailable ' + (readFails ? 'storage' : 'writes') + ' retain bounded temporary preferences without credential storage', () => {
    const cfg = catalogue(), storage = new Map([[KEY, '["place-0"]']]);
    const { tools, writes } = fixture({ storage, readFails, writeFails: true });
    const result = tools.toggleSaved(cfg, 'place-1');
    expect(result.persisted).toBe(false);
    expect(tools.savedPlaces(cfg)).toContain('place-1');
    expect(tools.savedPlaces({ packages: [{ slug: 'place-1' }] })).toEqual(['place-1']);
    expect(writes).toEqual([]);
    expect(storage.get(KEY)).toBe('["place-0"]');
  });
}

test('affordable plans use the supplied remaining budget and reject invalid purchase terms', () => {
  const plan = (code, priceUsd, extra = {}) => ({ code, slug: 'japan', priceUsd, gb: 1, days: 7, ...extra });
  const cfg = { allowanceUsd: 100, packages: [plan('EXACT', 1.25), plan('EXPENSIVE', 1.26), plan('CHEAP', 0.5),
    plan('TIE-B', 1, { gb: 2 }), plan('TIE-A', 1, { gb: 2 }), plan('TIE-C', 1),
    ...[undefined, null, '1', 0, -1, NaN, Infinity].map((price, i) => plan('BAD-PRICE-' + i, price)),
    plan('BAD-GB', 0.5, { gb: 0 }), plan('BAD-DAYS', 0.5, { days: 1.5 }),
    plan('OTHER-PLACE', 1, { slug: 'europe' })] };
  const { tools } = fixture();
  expect(tools.fitPlans(cfg, 1.25, 'japan').map(pkg => pkg.code)).toEqual(['CHEAP', 'TIE-A', 'TIE-B', 'TIE-C', 'EXACT']);
  expect(tools.fitPlans(cfg, 0.5).map(pkg => pkg.code)).toEqual(['CHEAP']);
  expect(tools.fitPlans(cfg, 1.25, 'europe').map(pkg => pkg.code)).toEqual(['OTHER-PLACE']);
  expect(tools.fitPlans(cfg, 1.25, 'absent')).toEqual([]);
  expect(tools.fitPlans({}, 1.25)).toEqual([]);
});

test('zero, negative and nonfinite budgets never inherit a static allowance or free plan', () => {
  const cfg = { allowanceUsd: 100, packages: [{ code: 'PAID', slug: 'japan', priceUsd: 1, gb: 1, days: 7 },
    { code: 'FREE', slug: 'japan', priceUsd: 0, gb: 1, days: 7 }] };
  const { tools } = fixture();
  for (const budget of [0, -1, NaN, Infinity, -Infinity, null, undefined, '100']) {
    expect(tools.fitPlans(cfg, budget)).toEqual([]);
  }
});

test('public SIM review strips every private field and keeps only the newest catalogue destination', () => {
  const cfg = { packages: [{ slug: 'japan' }, { slug: 'europe' }] }, { tools } = fixture();
  const privateFields = { ac: 'private-ac', manualCode: 'private-manual', smdpAddress: 'private-smdp',
    matchingId: 'private-matching', qrCodeUrl: 'https://private.fixture/qr', appleInstallUrl: 'https://private.fixture/apple',
    androidInstallUrl: 'https://private.fixture/android', token: 'private-token', signature: 'private-signature',
    paymentRequest: 'private-invoice', paymentHash: 'private-hash', preimage: 'private-preimage', codes: true };
  const sims = [
    { slug: 'japan', iccid: '8901000000000000001', createdAt: '2026-10-01T00:00:00Z', ...privateFields },
    { slug: 'japan', iccid: '8901000000000000002', createdAt: '2026-10-02T00:00:00Z', ...privateFields },
    { slug: 'japan', iccid: '8901000000000000003', createdAt: '2026-10-02T00:00:00Z', ...privateFields },
    { slug: 'europe', iccid: 'x'.repeat(81), createdAt: 'invalid', ...privateFields },
    { slug: 'unknown', iccid: '8901000000000000004', ...privateFields }, null, {},
  ];
  expect(tools.publicSims(sims, cfg)).toEqual([
    { slug: 'japan', createdAt: '2026-10-02T00:00:00Z', iccidTail: '0002' },
    { slug: 'europe', createdAt: null, iccidTail: '' },
  ]);
  expect(JSON.stringify(tools.publicSims(sims, cfg))).not.toMatch(/private|890100|codes|signature|token/);
  expect(sims[1].ac).toBe('private-ac');
});

test('SIM review rejects nonlists and bounds work to the first 200 public records', () => {
  const cfg = { packages: [{ slug: 'japan' }] }, { tools } = fixture();
  for (const invalid of [null, undefined, { slug: 'japan' }, 'japan']) expect(tools.publicSims(invalid, cfg)).toEqual([]);
  const sims = [...Array.from({ length: 200 }, () => ({ slug: 'unknown' })),
    { slug: 'japan', iccid: '8901000000000000001', createdAt: '2026-10-02T00:00:00Z' }];
  expect(tools.publicSims(sims, cfg)).toEqual([]);
});
