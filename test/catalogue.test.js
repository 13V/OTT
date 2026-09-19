#!/usr/bin/env node
'use strict';
/**
 * The catalogue builder's choosing, against a portfolio shaped like wholesale's (15 Sep 2026):
 * countries and regions with a slug, a name, and bundles named fixed_<GB>GB_<D>D_<CODE> with a
 * dollar price. What is asserted is the policy: the places asked for, in the order asked, regions
 * first; one bundle per size, the cheapest of that exact size; unlimited and unpriced bundles
 * skipped; a place or size the portfolio does not have simply absent rather than invented.
 *
 *   node test/catalogue.test.js
 */
const path = require('path');
const C = require(path.join(__dirname, '..', 'scripts', 'catalogue.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const bundle = (name, gb, days, price, extra) => Object.assign({ name, dataInGB: gb, durationInDays: days, price, unlimited: false, roamingEnabled: [] }, extra || {});
const portfolio = {
  countries: [
    { code: 'DE', name: 'Germany', slug: 'germany', flag: '🇩🇪', bundles: [
      bundle('fixed_1GB_7D_DE', 1, 7, 1.99), bundle('fixed_2GB_15D_DE', 2, 15, 2.99), bundle('fixed_5GB_30D_DE', 5, 30, 4.99),
      bundle('fixed_10GB_30D_DE', 10, 30, 7.99), bundle('fixed_10GB_15D_DE', 10, 15, 6.49),          // a cheaper 10 GB: it wins
      bundle('unlimited_7D_DE', 0, 7, 19.99, { unlimited: true }), bundle('fixed_100GB_30D_DE', 100, 30, 0), // skipped
    ] },
    { code: 'JP', name: 'Japan', slug: 'japan', flag: '🇯🇵', bundles: [bundle('fixed_1GB_7D_JP', 1, 7, 2.99), bundle('fixed_3GB_30D_JP', 3, 30, 4.99)] },
  ],
  regions: [
    { name: 'Europe', slug: 'europe', bundles: [
      bundle('fixed_1GB_7D_EUROPE', 1, 7, 1.19, { roamingEnabled: Array.from({ length: 38 }, (_, i) => ({ iso: 'C' + i })) }),
      bundle('fixed_5GB_30D_EUROPE', 5, 30, 5.99, { roamingEnabled: Array.from({ length: 38 }, (_, i) => ({ iso: 'C' + i })) }),
    ] },
  ],
};

console.log('choosing');
const out = C.pick(portfolio, { regions: ['europe', 'atlantis'], countries: ['japan', 'germany'], sizes: [1, 5, 10] });
check('regions first, then countries, in the order asked; sizes ascending', out.map((p) => p.code),
  ['fixed_1GB_7D_EUROPE', 'fixed_5GB_30D_EUROPE', 'fixed_1GB_7D_JP', 'fixed_1GB_7D_DE', 'fixed_5GB_30D_DE', 'fixed_10GB_15D_DE']);
check('a place the portfolio lacks is absent, not invented', out.some((p) => p.slug === 'atlantis'), false);
check('a size a place lacks is absent (Japan has no 5 or 10)', out.filter((p) => p.slug === 'japan').length, 1);
check('the cheapest bundle of a size wins, whatever its duration', out.find((p) => p.code === 'fixed_10GB_15D_DE').priceUsd, 6.49);
check('unlimited and unpriced bundles are never chosen', out.some((p) => /unlimited|100GB/.test(p.code)), false);
check('a region entry: name, kind, days, price, and how many countries', out[0],
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', flag: '', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' });
check('a country entry carries its ISO code and its flag', out[3], { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', flag: '🇩🇪', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' });
// wholesale gives regions no flag of their own, so the field is present and empty rather than absent —
// the coverage grid on the site falls back to the place's name when it is.
check('a region has no flag, and says so with an empty string rather than nothing', out[0].flag, '');
check('the defaults name the places the site sells', [C.REGIONS.length, C.COUNTRIES.length, C.SIZES_GB], [8, 20, [1, 5, 10]]);
check('an empty portfolio is an empty menu', C.pick({}), []);

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
