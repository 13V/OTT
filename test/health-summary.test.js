#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summary } = require('../scripts/health-summary');
const { weekOf } = require('../site/api/_lib/week');
const { catalogueFingerprint } = require('../site/api/_lib/catalogue');
const now = Date.now();
const config = { coin: '0x' + '1'.repeat(40), curve: '0x' + '2'.repeat(40), treasury: '0x' + '3'.repeat(40), provider: 'wholesale',
  catalogueAt: '2026-10-05', packages: [{ code: 'fixed_1GB_7D_AU', slug: 'australia', name: 'Australia', kind: 'country', regions: 'AU', gb: 1, days: 7, priceUsd: 1.99 }] };
const healthy = { ok: true, asOf: Math.floor(now / 1000), config: { ...config, packages: 1, catalogueFingerprint: catalogueFingerprint(config), launched: true }, redemption: { enabled: true, ready: true },
  ready: { config: true, provider: true, payer: true, store: true, allowances: true },
  wiring: { provider: 'wholesale', payer: 'blink', store: 'upstash' },
  allowances: { week: weekOf(Math.floor(now / 1000)), stale: false }, pool: { usd: 100, sats: 100000 } };

assert.equal(summary(healthy, config, now), '');
const differentPrice = { ...config, packages: [{ ...config.packages[0], priceUsd: 2.49 }] };
assert.match(summary(healthy, differentPrice, now), /Backend config/);
assert.match(summary({ ...healthy, config: { ...healthy.config, catalogueFingerprint: undefined } }, config, now), /Backend config/);
for (const dependency of Object.keys(healthy.ready)) {
  const body = { ...healthy, ready: { ...healthy.ready, [dependency]: false } };
  assert.match(summary(body, config, now), new RegExp('Backend ' + dependency));
}
assert.match(summary({ ...healthy, redemption: { enabled: false, ready: false } }, config, now), /Redemption enabled/);
assert.match(summary({ ...healthy, pool: { usd: 0, sats: 0 } }, config, now), /Funded Lightning wallet/);
assert.match(summary({ ...healthy, asOf: healthy.asOf - 181 }, config, now), /Backend status response/);
assert.notEqual(summary({ ok: true }, config, now), '');
assert.equal(summary({ ...healthy, error: 'private-token-value', ready: { ...healthy.ready, payer: false } }, config, now).includes('private-token-value'), false);
const script = path.resolve(__dirname, '../scripts/health-summary.js');
for (const input of ['not-json', '<h1>Website only</h1>', 'x'.repeat(65537)]) {
  const output = execFileSync(process.execPath, [script], { input, encoding: 'utf8' });
  assert.match(output, /could not be validated/);
  assert.equal(output.includes(input), false);
}
console.log('Health alerts use actual readiness, reject invalid responses and never echo upstream errors.');
