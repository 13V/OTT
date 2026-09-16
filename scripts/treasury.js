#!/usr/bin/env node
'use strict';
/**
 * treasury.js — is the pool funded, and for how long?
 *
 * The one promise the Data page makes that a trader cannot check on chain is that the balance
 * behind the redeem button is real. So this writes it down, in public, every half hour:
 * site/data/treasury.json carries the pool's balance (the Lightning wallet that pays nadanada, or
 * the reseller account for eSIM Access), what the last thirty days of redemptions
 * cost, the runway those two numbers imply, what is still claimable in Pons's escrow, what the
 * treasury wallet holds, and when it was last paid. The page shows it as a card; the workflow
 * opens an issue when it turns low. A balance nobody can see is a promise; one everybody can is a
 * number.
 *
 *   node scripts/treasury.js                       # writes site/data/treasury.json
 *   ESIM_PROVIDER=nadanada BLINK_API_KEY=… KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/treasury.js
 *   ESIM_PROVIDER=esimaccess ESIMACCESS_ACCESS_CODE=… node scripts/treasury.js
 *
 * Without a provider the pool side is null and the status is "unknown" — the chain side is still
 * written, so a fork of this repository produces an honest file rather than none.
 */
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const ADDRESSES_PATH = path.join(SITE, 'config', 'addresses.json');
const CLAIMS_PATH = path.join(SITE, 'data', 'claims.json');
const ALLOWANCES_PATH = path.join(SITE, 'data', 'allowances.json');
// The one place week arithmetic lives, so this file and the indexer can never disagree on when a
// week started — which is the boundary "what has been spent this week" is measured from.
const { weekStart } = require(path.join(SITE, 'api', 'lib', 'week.js'));
const OUT_PATH = path.join(SITE, 'data', 'treasury.json');

const DAYS = 30;
const LOW_BALANCE_USD = 50;
const LOW_DAYS = 14;
// How far the pool may sit under this week's outstanding allowances before that is the headline.
// Some gap is ordinary — the whole week's budget is published on Monday and spent over seven days,
// and the keeper only tops up once a day — so this is not a hair trigger.
const BEHIND_RATIO = 0.5;

const lower = (a) => String(a || '').toLowerCase();
const round2 = (x) => Math.round(x * 100) / 100;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

// ---------------------------------------------------------------------------
// The pure part.
// ---------------------------------------------------------------------------

/** What a redeemed package cost, from the catalogue, dearest-in-catalogue if it has left it. */
function priceOf(order, config) {
  const code = String(order && order.packageCode || '');
  const pkg = (config.packages || []).find((p) => p && (p.code === code || p.packageCode === code));
  if (pkg && Number.isFinite(Number(pkg.priceUsd))) return Number(pkg.priceUsd);
  return (config.packages || []).reduce((m, p) => Math.max(m, Number(p && p.priceUsd) || 0), 0);
}

/**
 * What this week's holders can still spend, and whether the pool could pay if they all did.
 *
 * The two numbers had nothing to do with each other until now, which was the single worst thing
 * about this system: scripts/allowances.js publishes a budget computed purely from tax collected
 * on chain, unbounded and growing with volume, while the Lightning wallet that actually pays for
 * the eSIMs was topped up to a flat hundred dollars. A good week published thousands of dollars of
 * allowances against a hundred-dollar wallet, every holder saw a real balance on their dashboard,
 * and everyone after the first few got a 503 on the button. This is the figure that makes that
 * visible — to the funding keeper, which now aims at it, and to the alert, which now fires on it.
 *
 * Counted at the catalogue price the holder was charged rather than the discounted price the pool
 * pays, which errs toward funding slightly more than strictly needed. That is the safe direction.
 */
function owing({ orders, config, budgetUsd, weekStartMs }) {
  if (!Number.isFinite(Number(budgetUsd))) return { budgetUsd: null, redeemedUsd: null, owedUsd: null };
  const thisWeek = (orders || []).filter((o) => {
    const at = Date.parse(o && o.createdAt);
    return Number.isFinite(at) && at >= weekStartMs;
  });
  const redeemedUsd = round2(thisWeek.reduce((sum, o) => sum + priceOf(o, config), 0));
  return { budgetUsd: round2(Number(budgetUsd)), redeemedUsd, owedUsd: round2(Math.max(0, Number(budgetUsd) - redeemedUsd)) };
}

/**
 * Spend over the trailing window, from the provider's order records. A record that says what the
 * pool actually paid (nadanada's `paidUsd`, the Lightning price) is counted at that; one that does
 * not (eSIM Access) is counted at the catalogue price.
 */
function summarise({ orders, config, now, days = DAYS }) {
  const since = now - days * 86400 * 1000;
  let spendUsd = 0, count = 0;
  for (const o of orders || []) {
    const t = o && o.createdAt ? Date.parse(o.createdAt) : NaN;
    if (!Number.isFinite(t) || t < since) continue;
    spendUsd += Number.isFinite(Number(o.paidUsd)) && Number(o.paidUsd) > 0 ? Number(o.paidUsd) : priceOf(o, config);
    count++;
  }
  return { spendUsd: round2(spendUsd), count, perDayUsd: round2(spendUsd / days), days };
}

/** Days of balance at the trailing rate; null when nothing has been spent (no rate to divide by). */
function runway({ balanceUsd, perDayUsd }) {
  if (!Number.isFinite(balanceUsd) || !(perDayUsd > 0)) return null;
  return Math.floor(balanceUsd / perDayUsd);
}

/**
 * One word for the card and the alert. "unknown" is the honest answer without a reseller
 * reading; "empty" is a balance of nothing; "low" is either under the floor or under two weeks
 * at the current rate; everything else is funded.
 */
function statusOf({ balanceUsd, runwayDays, owedUsd = null, lowBalanceUsd = LOW_BALANCE_USD, lowDays = LOW_DAYS, behindRatio = BEHIND_RATIO }) {
  if (!Number.isFinite(balanceUsd)) return 'unknown';
  if (balanceUsd <= 0) return 'empty';
  if (balanceUsd < lowBalanceUsd) return 'low';
  // Enough money by the old measure, and still not enough to pay what this week has promised.
  // Ranked under 'low' and 'empty' because those are worse, but above 'funded' because a pool
  // that cannot cover its own published allowances is not a healthy one, however full it looks.
  if (Number.isFinite(owedUsd) && owedUsd > 0 && balanceUsd < owedUsd * behindRatio) return 'behind';
  if (runwayDays !== null && runwayDays < lowDays) return 'low';
  return 'funded';
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function run({ rpc, config, addresses, provider = null, claims = [], now = () => Date.now(), out = OUT_PATH, allowancesPath = ALLOWANCES_PATH, log = () => {} }) {
  const chain = require(path.join(__dirname, 'chain.js'));
  const treasury = lower(config.treasury);
  const usdg = addresses.usdg;
  const decimals = Number(addresses.usdgDecimals || 6);
  const escrow = addresses.pons && addresses.pons.feeEscrow;
  const asOf = Math.floor(now() / 1000);

  // Chain side: public, always attempted, each read allowed to fail on its own.
  let escrowClaimableUsd = null, walletUsd = null;
  if (treasury && escrow && usdg) {
    const read = async (to, sig, args) => {
      const raw = await rpc('eth_call', [{ to, data: chain.encodeCall(sig, args) }, 'latest']);
      return Number(BigInt(raw)) / 10 ** decimals;
    };
    try { escrowClaimableUsd = round2(await read(escrow, 'balanceOfToken(address,address)', [treasury, usdg])); } catch (e) { log(`  escrow read failed: ${e.message}`); }
    try { walletUsd = round2(await read(usdg, 'balanceOf(address)', [treasury])); } catch (e) { log(`  wallet read failed: ${e.message}`); }
  } else {
    log('  no treasury in esim.json yet; chain side skipped');
  }

  // Provider side: only with a provider that can answer. For nadanada the balance is the Lightning
  // wallet's (Blink), in sats at its own price, and the sats are written down beside the dollars.
  let reseller = null, spend = { spendUsd: 0, count: 0, perDayUsd: 0, days: DAYS }, orderList = [];
  if (provider && typeof provider.balanceUsd === 'function') {
    try {
      const bal = typeof provider.balance === 'function' ? await provider.balance() : { usd: await provider.balanceUsd() };
      const balanceUsd = round2(Number(bal.usd));
      orderList = typeof provider.listOrders === 'function'
        ? await provider.listOrders({ sinceIso: new Date(now() - DAYS * 86400 * 1000).toISOString().replace(/:\d\d\.\d{3}Z$/, '+00:00') })
        : [];
      spend = summarise({ orders: orderList, config, now: now() });
      reseller = { name: provider.name, balanceUsd, asOf };
      if (Number.isFinite(Number(bal.sats))) reseller.sats = Math.round(Number(bal.sats));
      if (provider.name === 'nadanada') reseller.wallet = process.env.LN_PAYER || 'blink';
    } catch (e) {
      log(`  reseller read failed: ${e.message}`);
      reseller = { name: provider.name, balanceUsd: null, asOf, error: String(e.message || e).slice(0, 120) };
    }
  }

  const balanceUsd = reseller && Number.isFinite(reseller.balanceUsd) ? reseller.balanceUsd : NaN;
  const runwayDays = runway({ balanceUsd, perDayUsd: spend.perDayUsd });
  // This week's promise, against the wallet that has to keep it.
  const allow = readJson(allowancesPath, null) || {};
  const wk = Number(allow.week);
  const owed = Number.isFinite(wk)
    ? owing({ orders: orderList, config, budgetUsd: allow.budgetUsd, weekStartMs: weekStart(wk) * 1000 })
    : { budgetUsd: null, redeemedUsd: null, owedUsd: null };
  const last = Array.isArray(claims) && claims.length ? claims[claims.length - 1] : null;

  const data = {
    asOf,
    treasury: config.treasury || '',
    escrowClaimableUsd,
    walletUsd,
    reseller,
    spend30dUsd: spend.spendUsd,
    redemptions30d: spend.count,
    perDayUsd: spend.perDayUsd,
    runwayDays,
    weekBudgetUsd: owed.budgetUsd,
    weekRedeemedUsd: owed.redeemedUsd,
    owedUsd: owed.owedUsd,
    lastClaim: last ? { at: last.at, kind: last.kind, amount: last.amount, txHash: last.txHash || null } : null,
    status: statusOf({ balanceUsd, runwayDays, owedUsd: owed.owedUsd }),
  };
  // Same reasoning as writeAllowances(): asOf moves every run, and rewriting the file for that
  // alone turned both workflows' "commit only if something changed" into a commit every time.
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { existing = null; }
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'asOf' || k === 'block' ? undefined : v));
  if (!existing || strip(existing) !== strip(data)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  }
  const summary = `treasury: ${data.status}` +
    (reseller ? `, reseller $${reseller.balanceUsd === null ? '?' : reseller.balanceUsd.toFixed(2)}` : ', no reseller reading') +
    `, ${spend.count} redemption(s) / $${spend.spendUsd.toFixed(2)} in ${DAYS}d` +
    (runwayDays === null ? '' : `, runway ${runwayDays}d`) +
    (owed.owedUsd === null ? '' : `, $${owed.owedUsd.toFixed(2)} still promised this week`) +
    (escrowClaimableUsd === null ? '' : `, escrow $${escrowClaimableUsd.toFixed(2)}`) +
    ` -> ${path.relative(process.cwd(), out)}`;
  return { data, summary };
}

module.exports = { priceOf, summarise, runway, statusOf, run, OUT_PATH, LOW_BALANCE_USD, LOW_DAYS, DAYS };

if (require.main === module) {
  const A = require(path.join(__dirname, 'allowances.js'));
  const addresses = readJson(ADDRESSES_PATH, {});
  const endpoints = addresses.rpcs && addresses.rpcs.length ? addresses.rpcs : [addresses.rpc];
  // Which provider: ESIM_PROVIDER names it (nadanada needs BLINK_API_KEY and the store's
  // KV_REST_API_* pair; esimaccess needs ESIMACCESS_ACCESS_CODE). Without one the reseller side is
  // left unknown rather than guessed.
  let provider = null;
  const name = process.env.ESIM_PROVIDER || (process.env.ESIMACCESS_ACCESS_CODE ? 'esimaccess' : '');
  if (name && name !== 'mock') {
    process.env.ESIM_PROVIDER = name;
    provider = require(path.join(SITE, 'api', 'lib', 'providers')).provider();
  }
  run({
    rpc: A.makeRpc(endpoints, { log: (m) => process.stderr.write(m + '\n') }),
    config: readJson(ESIM_PATH, {}),
    addresses,
    provider,
    claims: readJson(CLAIMS_PATH, []),
    log: (m) => process.stderr.write(m + '\n'),
  })
    .then(({ summary }) => console.log(summary))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
