#!/usr/bin/env node
'use strict';
/**
 * catalogue.js — the eSIM menu in site/config/esim.json, taken from nadanada's public portfolio.
 *
 * The provider sells eSIMs per country and per region, paid by Lightning. Its portfolio endpoint
 * lists every bundle it has, priced in dollars. This
 * script picks the places a traveller is likely to want and the sizes that make sense as a rebate
 * (1 GB for a week, 5 and 10 GB for a month) and writes them, dated, into the config the page and
 * the redeem function read. The rest of the config — the coin, the terms — is kept as it is.
 *
 *   node scripts/catalogue.js            # print what would change
 *   node scripts/catalogue.js --write    # write site/config/esim.json
 *
 * The price written is wholesale's list price. A Lightning payment gets 5% off at the till, and that
 * 5% is the margin the treasury keeps for routing fees and the swap into sats — so a redemption
 * charges the trader the list price and costs the pool a little less.
 */
const fs = require('fs');
const path = require('path');

const ESIM_PATH = path.join(__dirname, '..', 'site', 'config', 'esim.json');
const PUBLIC_PORTFOLIO_URL = 'https://nadanada.me/api/v2/esim/portfolio';
function portfolioUrl() {
  const direct = String(process.env.WHOLESALE_PORTFOLIO_URL || '').trim();
  if (direct) return direct;
  const base = String(process.env.WHOLESALE_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) return base + '/esim/portfolio';
  return PUBLIC_PORTFOLIO_URL;
}
const { timedFetch } = require(path.join(__dirname, 'chain.js'));

// Regions first (one eSIM for a whole trip), then the countries people actually fly to.
const REGIONS = ['europe', 'north-america', 'oceania', 'south-east-asia', 'middle-east', 'asia', 'latam', 'global'];
const COUNTRIES = ['united-states', 'united-kingdom', 'germany', 'france', 'spain', 'italy', 'portugal', 'greece', 'turkey',
  'united-arab-emirates', 'japan', 'singapore', 'thailand', 'vietnam', 'indonesia', 'india', 'australia', 'mexico', 'brazil', 'canada'];
const SIZES_GB = [1, 5, 10];
const positiveNumber = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
  Number.isFinite(Number(value)) && Number(value) > 0;

/** The packages, from a portfolio object. Pure, so it is testable without the network. */
function pick(portfolio, { regions = REGIONS, countries = COUNTRIES, sizes = SIZES_GB } = {}) {
  const out = [];
  portfolio = portfolio && typeof portfolio === 'object' ? portfolio : {};
  const take = (place, kind) => {
    if (!place || typeof place.slug !== 'string' || !place.slug.trim() || typeof place.name !== 'string' || !place.name.trim()) return;
    const bundles = (Array.isArray(place.bundles) ? place.bundles : []).filter((b) => b &&
      typeof b.name === 'string' && b.name.trim() && !b.unlimited &&
      positiveNumber(b.price) && Number.isSafeInteger(Math.round(Number(b.price) * 100)) && Math.round(Number(b.price) * 100) > 0 &&
      positiveNumber(b.dataInGB) &&
      positiveNumber(b.durationInDays) &&
      Number.isSafeInteger(Number(b.durationInDays)) && Number(b.durationInDays) > 0);
    for (const gb of sizes) {
      // The cheapest bundle of exactly this size, carrying its actual provider duration.
      const b = bundles.filter((x) => Number(x.dataInGB) === gb).sort((a, c) => Number(a.price) - Number(c.price))[0];
      if (!b) continue;
      out.push({
        code: b.name,
        slug: place.slug,
        name: place.name,
        // The flag is wholesale's own, and only countries have one — the coverage grid on the site
        // shows it beside the place, and falls back to the name alone for a region.
        flag: typeof place.flag === 'string' ? place.flag : '',
        kind,
        gb,
        days: Number(b.durationInDays),
        priceUsd: Math.round(Number(b.price) * 100) / 100,
        regions: kind === 'region'
          ? (Array.isArray(b.roamingEnabled) && b.roamingEnabled.length ? b.roamingEnabled.length + ' countries' : place.name)
          : (place.code || place.name),
      });
    }
  };
  const bySlug = (list) => new Map((Array.isArray(list) ? list : []).filter((p) => p && typeof p.slug === 'string').map((p) => [p.slug, p]));
  const R = bySlug(portfolio.regions), C = bySlug(portfolio.countries);
  for (const slug of regions) if (R.has(slug)) take(R.get(slug), 'region');
  for (const slug of countries) if (C.has(slug)) take(C.get(slug), 'country');
  return out;
}

/** Reject an error-shaped or incomplete response before it can replace the public menu. */
function validatePortfolio(portfolio) {
  if (!portfolio || !Array.isArray(portfolio.countries) || !Array.isArray(portfolio.regions) ||
      portfolio.countries.length + portfolio.regions.length === 0) {
    throw new Error('wholesale portfolio has no country and region catalogue');
  }
  for (const list of [portfolio.countries, portfolio.regions]) {
    const slugs = new Set();
    for (const place of list) {
      if (!place || typeof place.name !== 'string' || !place.name.trim() ||
          typeof place.slug !== 'string' || !place.slug.trim() || !Array.isArray(place.bundles) || slugs.has(place.slug)) {
        throw new Error('wholesale portfolio contains an invalid or duplicate destination');
      }
      slugs.add(place.slug);
    }
  }
  return portfolio;
}

function prepareConfig(current, portfolio, date = new Date().toISOString().slice(0, 10)) {
  const packages = pick(validatePortfolio(portfolio));
  if (!packages.length) throw new Error('wholesale portfolio has no usable packages for the selected places');
  const nextSlugs = new Set(packages.map((p) => p.slug));
  const currentSlugs = new Set((Array.isArray(current.packages) ? current.packages : []).map((p) => p.slug));
  if ([...currentSlugs].some((slug) => !nextSlugs.has(slug))) {
    throw new Error('wholesale portfolio is missing a currently listed destination; review the selection before replacing the catalogue');
  }
  return Object.assign({}, current, { provider: 'wholesale', catalogueAt: date, packages });
}

async function fetchPortfolio(url, fetcher = timedFetch) {
  url = url || portfolioUrl();
  const res = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('wholesale portfolio answered HTTP ' + res.status);
  const j = await res.json();
  if (!j || j.success !== true || j.error || !j.data) throw new Error('wholesale portfolio has no data');
  return validatePortfolio(j.data);
}

module.exports = { pick, fetchPortfolio, portfolioUrl, validatePortfolio, prepareConfig, PUBLIC_PORTFOLIO_URL, REGIONS, COUNTRIES, SIZES_GB };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--write') || args.filter((arg) => arg === '--write').length > 1) {
    console.error('usage: node scripts/catalogue.js [--write]');
    process.exit(1);
  }
  const write = process.argv.includes('--write');
  fetchPortfolio().then((portfolio) => {
    const current = JSON.parse(fs.readFileSync(ESIM_PATH, 'utf8'));
    const next = prepareConfig(current, portfolio);
    const packages = next.packages;
    const perGb = packages.map((p) => p.priceUsd / p.gb);
    console.log(`${packages.length} packages from ${new Set(packages.map((p) => p.slug)).size} places; ` +
      `$${Math.min(...perGb).toFixed(2)}–$${Math.max(...perGb).toFixed(2)} per GB; ` +
      `cheapest entry $${Math.min(...packages.map((p) => p.priceUsd)).toFixed(2)}`);
    if (JSON.stringify(current.packages) === JSON.stringify(packages)) console.log('catalogue unchanged');
    if (write) {
      const text = JSON.stringify(next, null, 1).replace(/\{\n\s+"code"/g, '{ "code"').replace(/,\n\s+"(slug|name|kind|gb|days|priceUsd|regions)"/g, ', "$1"').replace(/"\n\s+\}/g, '" }').replace(/(\d)\n\s+\}/g, '$1 }');
      fs.writeFileSync(ESIM_PATH, text + '\n');
      console.log('wrote ' + path.relative(process.cwd(), ESIM_PATH));
    }
  }).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
