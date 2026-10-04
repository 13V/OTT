'use strict';
/**
 * whatever.fun — /api/status
 *
 * A read-only health page for the operator, not the trader: it answers "what is wired up, and is
 * it actually working" for everything /api/redeem depends on — the static config, the eSIM
 * provider, the Lightning payer, and (when the provider needs one) the durable store — plus the
 * allowances file the Data page reads. It exists so a broken deployment shows up as a red light on
 * a dashboard rather than as a trader's failed redemption.
 *
 * What it refuses to do: return a secret, or any fragment of one, no matter how a check fails.
 * Every field below is a name, a count, a boolean, or a short sentence describing what happened.
 * Before any of it leaves this file it passes through scrub(), which strips out the current value
 * of every environment variable whose name looks like a credential (…_KEY, …_TOKEN, …_SECRET,
 * …_PASSWORD, …_CODE). This matters most for Blink: a GraphQL error message is text the *other
 * end* composed, and if a future error ever echoed the key back — malformed input, a proxy's own
 * complaint — scrub() is what stands between that and this page. blink.js's ordinary errors
 * ("Blink answered HTTP 401") never contain a key, but nothing here assumes that stays true.
 *
 * It also never orders anything, never spends anything, and never signs in as anyone. The provider
 * check is a plain catalogue GET (wholesale's own bundle listing), never purchase or complete; the
 * payer check is a balance read, never a payment; the store check writes and deletes one throwaway
 * key of its own rather than touching an order record.
 *
 * Every check — config, store, payer, provider, allowances — runs concurrently and independently
 * (Promise.allSettled, each under its own timeout), so one slow or broken upstream can neither hold
 * up the response nor take another check down with it. The endpoint always answers 200 once the
 * method checks out: a failing check is data for the dashboard to show in red, not a reason for
 * this endpoint to fail too. A 20-second in-memory cache keeps a dashboard left open, or a refresh
 * loop, from hammering Blink or wholesale on every tick. ?fresh=1 is for an operator who wants past
 * that cache right now; it is not authenticated, so it cannot be allowed to cost more than an
 * operator actually asking a few times in a row would. FRESH_MIN_MS is the floor under it: a real
 * computation happens at most that often, however many requests — fresh or not — arrive while one
 * is already due. A looping ?fresh=1 degrades to costing exactly what leaving the cache alone
 * would; a person who genuinely wants a new read still gets one, just not on every single request.
 *
 * Same file-tracing constraint as redeem.js: Vercel's bundler only follows a literal
 * readFileSync(path.join(__dirname, …)), so esim.json is read that way here too, with the same
 * ESIM_CONFIG_URL override and HTTP fallback. allowances.json is only ever fetched over HTTP, for
 * the same reason redeem.js fetches it: the indexer rewrites it far more often than this function
 * is deployed.
 */
const fs = require('fs');
const path = require('path');
const { provider: chooseProvider } = require('./lib/providers');
const { payer: choosePayer } = require('./lib/payers');
const { store: chooseStore } = require('./lib/store');
const { weekOf } = require('./lib/week');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'esim.json');
const FETCH_TIMEOUT_MS = 4500;     // the raw HTTP layer: aborts before a check's own race does
const CHECK_TIMEOUT_MS = 5000;     // how long any one check may take before it counts as failed
const RESPONSE_CACHE_MS = 20 * 1000;
// The floor under ?fresh=1: a real computation happens at most this often no matter how many
// requests ask for one. Deliberately shorter than RESPONSE_CACHE_MS — an operator asking for a
// fresh read should get one sooner than the passive cache would turn over — but the shipped
// default is never zero, which is what let an unauthenticated ?fresh=1 loop cost the store, Blink
// and wholesale a fresh hit each on every request. env-overridable, the same idea as e.g.
// WHOLESALE_COMPLETE_WAIT_MS, so a test can shrink it rather than sleep through a production-sized
// window — Number.isFinite rather than `|| 5000` so a test can set it to exactly 0, too.
const FRESH_MIN_MS = () => { const n = Number(process.env.STATUS_FRESH_MIN_MS); return Number.isFinite(n) ? n : 5000; };
const PROBE_KEY = 'status:probe';
const DETAIL_MAX = 200;

// ---------------------------------------------------------------------------------------------
// Reading the deployment's own files, the same way redeem.js does.
// ---------------------------------------------------------------------------------------------
function selfUrl(p) {
  // Where this deployment serves its own static files from. VERCEL_PROJECT_PRODUCTION_URL is the
  // project's production domain and is preferred, because VERCEL_URL is the *deployment's* host —
  // and a project with deployment protection turned on answers 401 there, even to itself, which
  // is exactly how this was found. Locally, or on another host, the explicit env overrides
  // (ESIM_CONFIG_URL, ALLOWANCES_URL) are the only way to say where the files are.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) throw new Error('no VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL');
  return 'https://' + host + p;
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function readConfig() {
  if (process.env.ESIM_CONFIG_URL) return fetchJson(process.env.ESIM_CONFIG_URL);
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* fall through to HTTP */ }
  return fetchJson(selfUrl('/config/esim.json'));
}

async function readAllowances() {
  return fetchJson(process.env.ALLOWANCES_URL || selfUrl('/data/allowances.json'));
}

// ---------------------------------------------------------------------------------------------
// A race with a timeout that never leaves an unhandled rejection behind: the loser is still
// awaited, quietly, in case it settles after we have already moved on.
// ---------------------------------------------------------------------------------------------
function withTimeout(promise, ms, label) {
  promise.catch(() => {});
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------------------------
// scrub() — the one gate every detail string passes through before it is serialised. It does not
// try to recognise which messages are "safe"; it removes the current value of anything that looks
// like a credential, from whatever env var it lives in, so a message is safe by construction
// rather than by review.
// ---------------------------------------------------------------------------------------------
const SECRET_NAME_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CODE)$/i;
function secretValues() {
  return Object.keys(process.env)
    .filter((k) => SECRET_NAME_RE.test(k))
    .map((k) => process.env[k])
    .filter((v) => typeof v === 'string' && v.length >= 6);
}
function scrub(text) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const v of secretValues()) out = out.split(v).join('[redacted]');
  return out.slice(0, DETAIL_MAX);
}
const messageOf = (e) => (e && e.message) || String(e || 'failed');

// ---------------------------------------------------------------------------------------------
// Small pure helpers on the config.
// ---------------------------------------------------------------------------------------------
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

function summariseConfig(config) {
  const packages = Array.isArray(config.packages) ? config.packages : [];
  const places = new Set(packages.map((p) => p && p.slug).filter(Boolean)).size;
  return {
    launched: isAddress(config.coin) && isAddress(config.curve),
    coin: String(config.coin || ''),
    curve: String(config.curve || ''),
    treasury: String(config.treasury || ''),
    provider: String(config.provider || ''),
    packages: packages.length,
    places,
    catalogueAt: String(config.catalogueAt || ''),
    // Trading's rebate (rebateBps) is retired; budgetBps is its replacement, the share of last
    // week's tax that becomes this week's data budget. It defaults to 10000 (all of it) when the
    // config is silent on it, exactly as the indexer treats a missing value, so this reports what
    // is actually in effect rather than a bare zero that would read as "no budget at all".
    budgetBps: Number.isFinite(Number(config.budgetBps)) ? Number(config.budgetBps) : 10000,
    taxBps: Number.isFinite(Number(config.taxBps)) ? Number(config.taxBps) : 0,
  };
}

// What is actually selected, by env var, right now — as opposed to what esim.json merely says.
// Each chooser only throws for an unknown name; `wiredName` is for the informational `wiring`
// field, where a bad env var falls back to naming itself rather than this function throwing.
// The checks below call the choosers again, on their own, so that same throw is a failed check
// rather than something this fallback quietly hid from them.
function wiredName(choose, envVar, fallback) {
  try { return choose().name; } catch (e) { return String(process.env[envVar] || fallback).toLowerCase(); }
}
function storeWiredName() {
  try { return chooseStore().name; } catch (e) { return 'none'; }
}
function tryChoose(choose) {
  try { return { name: choose().name, error: null }; } catch (e) { return { name: '', error: e }; }
}

// ---------------------------------------------------------------------------------------------
// The checks. Each one returns { ok, detail, ...extra } and is written so it never throws past
// its own boundary — but computeStatus() wraps every one in Promise.allSettled anyway, because a
// check that is supposed to never throw is exactly the kind that eventually does.
// ---------------------------------------------------------------------------------------------
async function checkStore() {
  const chosen = tryChoose(chooseProvider);
  if (chosen.error) return { ok: false, detail: messageOf(chosen.error) };
  if (chosen.name !== 'wholesale') return { ok: true, detail: 'not needed by the ' + chosen.name + ' provider' };
  try {
    return await withTimeout((async () => {
      const s = chooseStore();
      const value = 'probe-' + Date.now();
      await s.set(PROBE_KEY, value);
      const got = await s.get(PROBE_KEY);
      await s.del(PROBE_KEY);
      if (got !== value) throw new Error('store did not return what was just written');
      return { ok: true, detail: 'read and wrote a probe key' };
    })(), CHECK_TIMEOUT_MS, 'store');
  } catch (e) { return { ok: false, detail: messageOf(e) }; }
}

async function checkPayer() {
  try {
    const bal = await withTimeout(choosePayer().balance(), CHECK_TIMEOUT_MS, 'payer');
    const usd = Number(bal.usd), sats = Number(bal.sats);
    const pool = { usd: Number.isFinite(usd) ? usd : 0, sats: Number.isFinite(sats) ? sats : 0 };
    return { ok: true, detail: 'reached the wallet: $' + pool.usd.toFixed(2) + ' (' + pool.sats + ' sats)', pool };
  } catch (e) { return { ok: false, detail: messageOf(e), pool: null }; }
}

/** How many bundles came back, whichever of the plausible response shapes wholesale used. */
function countBundles(json) {
  const data = json && json.data;
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.bundles)) return data.bundles.length;
  if (Array.isArray(json)) return json.length;
  return 0;
}

async function checkProvider() {
  const chosen = tryChoose(chooseProvider);
  if (chosen.error) return { ok: false, detail: messageOf(chosen.error) };
  if (chosen.name === 'mock') return { ok: true, detail: 'the mock provider: nothing to check' };
  if (chosen.name !== 'wholesale') return { ok: true, detail: chosen.name + ': no liveness probe defined for this provider' };
  try {
    const base = String(process.env.WHOLESALE_BASE_URL || '').trim().replace(/\/$/, '');
    if (!base) throw new Error('the private provider endpoint is not configured');
    const json = await withTimeout(fetchJson(base + '/esim/bundles?country=DE', { timeoutMs: CHECK_TIMEOUT_MS }), CHECK_TIMEOUT_MS, 'provider');
    if (!json || json.success === false) throw new Error('the network partner answered with no data');
    return { ok: true, detail: 'catalogue answered, ' + countBundles(json) + ' bundles for germany' };
  } catch (e) { return { ok: false, detail: messageOf(e) }; }
}

/**
 * Is the published allowance actually this week's? Holding is the whole promise now, so the one
 * failure this check exists to catch is the indexer falling behind the clock: a file still naming
 * last week is not a lesser version of the truth, it is wrong, and every redemption against it is
 * refused (see redeem.js). `week` is the current week, computed here once and shared with the rest
 * of computeStatus() so this check and the top-level `allowances` field never disagree.
 */
async function checkAllowances(week) {
  try {
    const allowances = await withTimeout(readAllowances(), CHECK_TIMEOUT_MS, 'allowances');
    const fileWeek = Number(allowances && allowances.week);
    const wallets = allowances && allowances.wallets && typeof allowances.wallets === 'object' ? Object.keys(allowances.wallets).length : 0;
    const holders = Number.isFinite(Number(allowances && allowances.holders)) ? Number(allowances.holders) : wallets;
    const budgetUsd = Number(allowances && allowances.budgetUsd) || 0;
    const stale = !Number.isFinite(fileWeek) || fileWeek !== week;
    const info = { week: Number.isFinite(fileWeek) ? fileWeek : null, currentWeek: week, stale, budgetUsd, holders };
    if (stale) {
      const detail = 'allowance file is for week ' + (Number.isFinite(fileWeek) ? fileWeek : 'unknown') + ', not the current week ' + week + ' — not published yet';
      return { ok: false, detail, info };
    }
    return { ok: true, detail: holders + ' holder' + (holders === 1 ? '' : 's') + ', $' + budgetUsd.toFixed(2) + ' budget, week ' + week, info };
  } catch (e) { return { ok: false, detail: messageOf(e), info: null }; }
}

// ---------------------------------------------------------------------------------------------
// The response, assembled from whichever checks came back and whichever timed out or threw.
// ---------------------------------------------------------------------------------------------
async function computeStatus() {
  const asOf = Math.floor(Date.now() / 1000);
  const week = weekOf(asOf);
  const providerName = wiredName(chooseProvider, 'ESIM_PROVIDER', 'mock');
  const payerName = wiredName(choosePayer, 'LN_PAYER', 'blink');
  const storeName = storeWiredName();

  const [configR, storeR, payerR, providerR, allowancesR] = await Promise.allSettled([
    withTimeout(readConfig(), CHECK_TIMEOUT_MS, 'config'),
    checkStore(),
    checkPayer(),
    checkProvider(),
    checkAllowances(week),
  ]);

  // config is not one of the four checks the dashboard shows a line for — the top-level `config`
  // object below is already its detail — but it is still one of the five things `ready` reports,
  // so whether it loaded (a real object with a packages array) is kept as a plain boolean.
  const configOk = configR.status === 'fulfilled' && configR.value && Array.isArray(configR.value.packages);
  const config = configOk ? configR.value : {};
  const checks = {
    store: storeR.status === 'fulfilled' ? storeR.value : { ok: false, detail: messageOf(storeR.reason) },
    payer: payerR.status === 'fulfilled' ? payerR.value : { ok: false, detail: messageOf(payerR.reason), pool: null },
    provider: providerR.status === 'fulfilled' ? providerR.value : { ok: false, detail: messageOf(providerR.reason) },
    allowances: allowancesR.status === 'fulfilled' ? allowancesR.value : { ok: false, detail: messageOf(allowancesR.reason), info: null },
  };

  const pool = checks.payer.ok && checks.payer.pool ? checks.payer.pool : null;
  // The structured numbers behind the allowances check — week, whether it is stale, the budget,
  // the holder count — live at the top level the same way the payer's `pool` does, so a dashboard
  // can show them without parsing the detail sentence.
  const allowances = checks.allowances.info || null;
  const brand = config.brand || {};

  // Every detail string, from whatever it came from, passes through scrub() exactly once, here,
  // so there is one place to trust rather than one per check.
  for (const key of Object.keys(checks)) checks[key].detail = scrub(checks[key].detail);

  return {
    ok: true,
    asOf,
    brand: { name: String(brand.name || ''), full: String(brand.full || ''), ticker: String(brand.ticker || '') },
    config: summariseConfig(config),
    wiring: { provider: providerName, payer: payerName, store: storeName },
    ready: { config: configOk, provider: checks.provider.ok, payer: checks.payer.ok, store: checks.store.ok, allowances: checks.allowances.ok },
    checks: {
      store: { ok: checks.store.ok, detail: checks.store.detail },
      payer: { ok: checks.payer.ok, detail: checks.payer.detail },
      provider: { ok: checks.provider.ok, detail: checks.provider.detail },
      allowances: { ok: checks.allowances.ok, detail: checks.allowances.detail },
    },
    pool,
    allowances,
  };
}

function send(res, status, body) {
  // No Access-Control-Allow-Origin, deliberately, and for the same reason as redeem.js: this page
  // and this function share an origin, and withholding the header keeps another site's JavaScript
  // from reading it.
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { ok: false, error });

let cached = null; // { at, body } — the entire response, kept for RESPONSE_CACHE_MS; `at` is also
                    // the one clock ?fresh=1's own floor is measured against, below.

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return fail(res, 405, 'method not allowed');
  }
  try {
    const url = new URL(req.url || '/', 'http://local');
    const fresh = url.searchParams.get('fresh') === '1';
    const age = cached ? Date.now() - cached.at : Infinity;
    // Ordinary traffic is happy with anything under RESPONSE_CACHE_MS old. ?fresh=1 asks for less
    // than that, but never for a computation that already happened within FRESH_MIN_MS — otherwise
    // it would be an unauthenticated way to force the very fan-out to Blink and wholesale the cache
    // exists to prevent, simply by asking twice.
    if (age < (fresh ? FRESH_MIN_MS() : RESPONSE_CACHE_MS)) return send(res, 200, cached.body);
    const body = await computeStatus();
    cached = { at: Date.now(), body };
    return send(res, 200, body);
  } catch (e) {
    // Nothing above should throw — every check is caught on its own — but a status page that goes
    // down is worse than one that admits it could not finish, so this still answers 200.
    return send(res, 200, { ok: true, asOf: Math.floor(Date.now() / 1000), error: scrub(messageOf(e)) });
  }
};
