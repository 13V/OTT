#!/usr/bin/env node
'use strict';
/**
 * treasury.js — is the pool funded, and for how long?
 *
 * The one promise the Data page makes that a trader cannot check on chain is that the balance
 * behind the redeem button is real. So this writes it down, in public, every half hour:
 * site/data/treasury.json carries the pool's balance (the Lightning wallet that pays wholesale, or
 * the reseller account for eSIM Access), what the last thirty days of redemptions cost, the runway
 * those two numbers imply, what the treasury wallet holds in SOL, the creator fees still waiting in
 * pump.fun's vaults, and when the treasury was last paid. The page shows it as a card; the workflow
 * opens an issue when it turns low. A balance nobody can see is a promise; one everybody can is a
 * number.
 *
 *   node scripts/treasury.js                       # writes site/data/treasury.json
 *   node scripts/treasury.js --out /tmp/t.json     # somewhere else
 *   ESIM_PROVIDER=wholesale BLINK_API_KEY=… KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/treasury.js
 *   ESIM_PROVIDER=esimaccess ESIMACCESS_ACCESS_CODE=… node scripts/treasury.js
 *
 * Without a provider the pool side is null and the status is "unknown" — the chain side is still
 * written, so a fork of this repository produces an honest file rather than none. Before launch
 * (no treasury or coin in site/config/esim.json) the chain side is skipped and left null.
 */
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const CLAIMS_PATH = path.join(SITE, 'data', 'claims.json');
const ALLOWANCES_PATH = path.join(SITE, 'data', 'allowances.json');
// The one place week arithmetic lives, so this file and the indexer can never disagree on when a
// week started — which is the boundary "what has been spent this week" is measured from.
const { weekStart } = require(path.join(SITE, 'api', '_lib', 'week.js'));
const { isWelcomeOrder } = require(path.join(SITE, 'api', '_lib', 'order-ids.js'));
const OUT_PATH = path.join(SITE, 'data', 'treasury.json');

const DAYS = 30;
const LOW_BALANCE_USD = 50;
const LOW_DAYS = 14;
// How far the pool may sit under this week's outstanding allowances before that is the headline.
// Some gap is ordinary — the whole week's budget is published on Monday and spent over seven days,
// and the keeper only tops up once a day — so this is not a hair trigger.
const BEHIND_RATIO = 0.5;

const round2 = (x) => Math.round(x * 100) / 100;
const solOf = (lamports) => Number(lamports) / 1e9;

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
 * scripts/allowances.js publishes a budget computed from fees collected on chain, unbounded and
 * growing with volume, while the Lightning wallet that actually pays for the eSIMs is topped up by
 * a keeper once a day. A good week can publish more allowance than the wallet holds, and every
 * holder past the first few would get a 503 on the button while their dashboard showed a real
 * balance. This is the figure that makes that visible — to the funding keeper, which aims at it,
 * and to the alert, which fires on it.
 *
 * Counted at the catalogue price the holder was charged rather than the discounted price the pool
 * pays, which errs toward funding slightly more than strictly needed. That is the safe direction.
 */
function owing({ orders, config, budgetUsd, weekStartMs }) {
  if (!Number.isFinite(Number(budgetUsd))) return { budgetUsd: null, redeemedUsd: null, owedUsd: null };
  // A welcome eSIM is paid from the reserve, not from anyone's weekly credit, so it doesn't reduce
  // what the week still owes (docs/membership.md). It still counts as spend in summarise().
  const thisWeek = (orders || []).filter((o) => {
    const at = Date.parse(o && o.createdAt);
    return Number.isFinite(at) && at >= weekStartMs && !isWelcomeOrder(o);
  });
  const redeemedUsd = round2(thisWeek.reduce((sum, o) => sum + priceOf(o, config), 0));
  return { budgetUsd: round2(Number(budgetUsd)), redeemedUsd, owedUsd: round2(Math.max(0, Number(budgetUsd) - redeemedUsd)) };
}

/**
 * Spend over the trailing window, from the provider's order records. A record that says what the
 * pool actually paid (wholesale's `paidUsd`, the Lightning price) is counted at that; one that does
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

/** The newest claims.json entry as the card shows it, or null. */
function lastClaimOf(claims) {
  const last = Array.isArray(claims) && claims.length ? claims[claims.length - 1] : null;
  if (!last) return null;
  const solNum = Number(last.sol);
  const usdNum = Number(last.usd);
  return { at: last.at, sol: Number.isFinite(solNum) ? solNum : null, usd: last.usd === null || !Number.isFinite(usdNum) ? null : usdNum, tx: last.tx || null };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function run({ rpc, config, provider = null, claims = [], now = () => Date.now(), out = OUT_PATH, allowancesPath = ALLOWANCES_PATH,
  solUsd = null, fees = null, log = () => {} }) {
  const asOf = Math.floor(now() / 1000);
  const treasury = S.isAddress(config.treasury) ? config.treasury : '';
  const coin = S.isAddress(config.coin) ? config.coin : '';

  // Chain side: public, always attempted once there is a treasury, each read allowed to fail on
  // its own so one dead endpoint costs one figure, not the file.
  let walletSol = null, claimableSol = null, price = null;
  if (treasury) {
    try {
      const r = await rpc('getBalance', [treasury, { commitment: 'confirmed' }]);
      const lamports = r && r.value !== undefined ? BigInt(r.value) : null;
      walletSol = lamports === null ? null : solOf(lamports);
    } catch (e) { log(`  wallet read failed: ${e.message}`); }
    if (coin) {
      try {
        const reader = fees || require(path.join(__dirname, 'pump-fees.js'));
        const waiting = await reader.claimable(rpc, { mint: coin, creator: treasury });
        claimableSol = solOf(waiting.totalLamports);
      } catch (e) { log(`  creator-fee read failed: ${e.message}`); }
    }
    try {
      const priceNow = solUsd || (() => require(path.join(__dirname, 'solana-chain.js')).solUsdNow());
      price = await priceNow();
    } catch (e) { log(`  SOL price unavailable: ${e.message}`); }
  } else {
    log('  no treasury in esim.json yet; chain side skipped');
  }
  const inUsd = (amount) => (amount === null || !Number.isFinite(price) || price === null ? null : round2(amount * price));

  // Provider side: only with a provider that can answer. For wholesale the balance is the Lightning
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
      if (provider.name === 'wholesale') reseller.wallet = process.env.LN_PAYER || 'blink';
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

  const data = {
    asOf,
    treasury,
    solUsd: price,
    walletSol,
    walletUsd: inUsd(walletSol),
    claimableSol,
    claimableUsd: inUsd(claimableSol),
    reseller,
    spend30dUsd: spend.spendUsd,
    redemptions30d: spend.count,
    perDayUsd: spend.perDayUsd,
    runwayDays,
    weekBudgetUsd: owed.budgetUsd,
    weekRedeemedUsd: owed.redeemedUsd,
    owedUsd: owed.owedUsd,
    lastClaim: lastClaimOf(claims),
    status: statusOf({ balanceUsd, runwayDays, owedUsd: owed.owedUsd }),
  };
  // asOf moves every run, and the SOL price nearly every run; rewriting the file for those alone
  // would turn both workflows' "commit only if something changed" into a commit every time. The
  // dollar figures derived from the price still change the file when the price moves them a cent.
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { existing = null; }
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'asOf' || k === 'solUsd' ? undefined : v));
  if (!existing || strip(existing) !== strip(data)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  }
  const summary = `treasury: ${data.status}` +
    (reseller ? `, reseller $${reseller.balanceUsd === null ? '?' : reseller.balanceUsd.toFixed(2)}` : ', no reseller reading') +
    `, ${spend.count} redemption(s) / $${spend.spendUsd.toFixed(2)} in ${DAYS}d` +
    (runwayDays === null ? '' : `, runway ${runwayDays}d`) +
    (owed.owedUsd === null ? '' : `, $${owed.owedUsd.toFixed(2)} still promised this week`) +
    (walletSol === null ? '' : `, treasury ${walletSol.toFixed(4)} SOL`) +
    (claimableSol === null ? '' : `, ${claimableSol.toFixed(4)} SOL of creator fees waiting`) +
    ` -> ${path.relative(process.cwd(), out)}`;
  return { data, summary };
}

module.exports = { priceOf, owing, summarise, runway, statusOf, lastClaimOf, run, OUT_PATH, LOW_BALANCE_USD, LOW_DAYS, DAYS };

if (require.main === module) {
  const C = require(path.join(__dirname, 'solana-chain.js'));
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 && argv[outIndex + 1] ? path.resolve(process.cwd(), argv[outIndex + 1]) : OUT_PATH;
  // Which provider: ESIM_PROVIDER names it (wholesale needs BLINK_API_KEY and the store's
  // KV_REST_API_* pair; esimaccess needs ESIMACCESS_ACCESS_CODE). Without one the reseller side is
  // left unknown rather than guessed.
  let provider = null;
  const name = process.env.ESIM_PROVIDER || (process.env.ESIMACCESS_ACCESS_CODE ? 'esimaccess' : '');
  if (name && name !== 'mock') {
    process.env.ESIM_PROVIDER = name;
    provider = require(path.join(SITE, 'api', '_lib', 'providers')).provider();
  }
  const log = (m) => process.stderr.write(m + '\n');
  run({
    rpc: C.makeRpc({ log }),
    config: readJson(ESIM_PATH, {}),
    provider,
    claims: readJson(CLAIMS_PATH, []),
    out,
    log,
  })
    .then(({ summary }) => console.log(summary))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
