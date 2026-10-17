#!/usr/bin/env node
'use strict';
/**
 * allowances.js — OT+T's weekly ledger on Solana: this week's join amount, who has joined, what
 * each member held at the Monday snapshot, the creator fees collected last week, and each
 * member's capped share of this week's budget. docs/membership.md states the rules and the file
 * format; this writes site/data/allowances.json, which the site reads directly and the redeem API
 * reads over HTTP.
 *
 * Every number is re-derivable from public chain data, but unlike the Robinhood version this one
 * does not re-derive everything on each run. Solana has no cheap way to list every transfer of a
 * coin, so the ledger carries its own state from file to file and reads only what is new:
 *
 *   - Joins: the incinerator's OTT account (`burnAccount`) is touched by nothing but joins, so its
 *     transaction history after `membership.cursor` is exactly the new sends to judge.
 *   - Fees: the treasury's history after `fees.cursor`; a transaction that drew down one of its
 *     pump.fun creator vaults and left the treasury richer is a collection.
 *   - Holdings: what each member held at the snapshot, read from each member's own token accounts'
 *     history (balanceAt in scripts/solana-chain.js), once per week.
 *   - The join amount: priced once, at the first run of each week, and then never again.
 *
 *   node scripts/allowances.js                                   # writes site/data/allowances.json
 *   node scripts/allowances.js --out /tmp/a.json
 *   node scripts/allowances.js --rehearse <mint> --out /tmp/r.json [--history-limit 300]
 *
 * Rehearsal is read-only practice against a real pump.fun coin before launch: the coin's token
 * program, its pump.fun creator (standing in for the treasury) and its incinerator account are
 * read from chain, everything else comes from site/config/esim.json, and it must write somewhere
 * other than site/data/. It reads only the newest --history-limit transactions of each history.
 *
 * Until the coin is launched (coin, tokenProgram, treasury and membership.burnAccount not all
 * filled in), this writes a valid empty ledger for the current week and exits 0, so the site and
 * the API always have a file to read.
 *
 * History calls go only to endpoints that keep the chain's full history (deepHistoryEndpoints): a
 * public node that keeps two days of ledger answers an older account's history with an empty list,
 * which would read as "nobody joined" and "held nothing". They are paced for the public endpoint's
 * per-method limit and retried through rate limits (patient). SOLANA_RPC_URL, tried first, can name
 * a faster archive endpoint.
 *
 * What fails the run (nothing is written, the previous ledger stays): an RPC that cannot read the
 * coin, no endpoint with full history, a coin that is not the configured one (wrong token program,
 * a pump.fun creator that is not the treasury, an incinerator account that does not derive, a
 * holder rewards coin), and a member's snapshot holding that cannot be read — a split published
 * with someone missing would be wrong for everyone. What only warns: a join amount that cannot be
 * priced (joins of this week wait for it), and a history or a price that cannot be read just now
 * (the cursor stays put and the next run carries on).
 */
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const M = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'membership.js'));
const C = require(path.join(__dirname, 'solana-chain.js'));
// One definition of the week, shared with the API (and checked against the browser's copy by
// test/week.test.js). The dependency only goes this way: the API never reaches into scripts/.
const { WEEK_S, ANCHOR, weekOf, weekStart, weekEnd } = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'week.js'));

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const DEFAULT_OUT = path.join(SITE, 'data', 'allowances.json');
// Collections are kept for the current week and the two before it: enough to compute last week's
// budget and to show the trend. Weekly totals are kept longer, since they are one number a week.
const KEEP_COLLECTION_WEEKS = 3;
const KEEP_FEE_WEEKS = 8;
const DEFAULT_HISTORY_LIMIT = 300;

const round4 = M.round4;
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** A copy of a plain object with its keys sorted, so identical state gives identical bytes. */
const sorted = (o) => Object.fromEntries(Object.keys(o || {}).sort(byKey).map((k) => [k, o[k]]));
const sortedByWeek = (o) => Object.fromEntries(Object.keys(o || {}).sort((a, b) => Number(a) - Number(b)).map((k) => [k, o[k]]));
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } };

/** site/config/esim.json, or — before anyone has written it — the same shape with nothing launched. */
function loadConfig(p = ESIM_PATH) {
  if (!fs.existsSync(p)) return { chain: 'solana', coin: '', tokenProgram: '', treasury: '', missing: true };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Launched means all four launch addresses are filled in (lint checks they agree with each other). */
function isLaunched(config) {
  const m = (config && config.membership) || {};
  return !!(config && config.coin && config.tokenProgram && config.treasury && m.burnAccount);
}

/** The ledger with nothing in it: what the site and the API read before the launch. */
function emptyAllowances({ asOf, slot = 0, week }) {
  return {
    asOf, slot, chain: 'solana',
    week, weekStart: weekStart(week), weekEnd: weekEnd(week),
    coin: '', tokenProgram: '', decimals: null, treasury: '',
    budgetUsd: 0, budgetSource: 'the coin is not launched yet',
    fees: null, membership: null,
    members: {}, joins: {},
    holders: 0, memberTokens: '0',
    wallets: {},
  };
}

/**
 * Whether two ledgers differ in anything but bookkeeping. Ignored: when the run was (`asOf`), the
 * chain head (`slot`), and the two history cursors. A cursor moves whenever any transaction lands
 * on the treasury or the incinerator account — spam included — and committing for that alone would
 * redeploy the site on every run, which is what this comparison exists to prevent. Not writing a
 * cursor that moved over nothing is safe: the next run reads those transactions again and finds
 * nothing again. Whenever a join or a collection did change the ledger, the file is written with
 * the new cursors.
 */
function sameButForTheClock(a, b) {
  if (!a || !b) return false;
  const strip = (o) => {
    const copy = Object.assign({}, o);
    delete copy.asOf;
    delete copy.slot;
    if (copy.fees && typeof copy.fees === 'object') copy.fees = Object.assign({}, copy.fees, { cursor: null });
    if (copy.membership && typeof copy.membership === 'object') copy.membership = Object.assign({}, copy.membership, { cursor: null });
    return JSON.stringify(copy);
  };
  return strip(a) === strip(b);
}

function writeAllowances(out, data) {
  if (sameButForTheClock(readJson(out, null), data)) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  return true;
}

/** The state a previous ledger hands on, or a fresh start when it is about another coin (or none). */
function carried(previous, coin) {
  const same = previous && previous.chain === 'solana' && previous.coin === coin && previous.membership && typeof previous.membership === 'object';
  if (!same) return { fresh: true, requirements: {}, requirement: null, members: {}, joins: {}, joinCursor: null, collections: [], weekUsd: {}, feeCursor: null, week: null, wallets: {} };
  const fees = previous.fees && typeof previous.fees === 'object' ? previous.fees : {};
  return {
    fresh: false,
    requirements: Object.assign({}, previous.membership.requirements || {}),
    requirement: previous.membership.requirement || null,
    members: Object.assign({}, previous.members || {}),
    joins: Object.assign({}, previous.joins || {}),
    joinCursor: previous.membership.cursor || null,
    collections: Array.isArray(fees.collections) ? fees.collections.slice() : [],
    weekUsd: Object.assign({}, fees.weekUsd || {}),
    feeCursor: fees.cursor || null,
    week: Number(previous.week),
    wallets: Object.assign({}, previous.wallets || {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The join amount
// ---------------------------------------------------------------------------------------------

/**
 * This week's join amount, priced from `priceSol` (SOL per whole token) and `solUsd`, rounded up
 * to two significant figures (membership.burnTokensFor) and held to at most MAX_BURN_SHARE_BPS of
 * the supply — on a coin so cheap that $5 buys more than that, the cap applies instead, and says so.
 */
function priceRequirement({ week, burnUsd, priceSol, solUsd, decimals, supply, source, at }) {
  const priceUsd = Number(priceSol) * Number(solUsd);
  let burnTokens = M.burnTokensFor(burnUsd, priceUsd);
  let burnUnits = S.unitsOf(burnTokens, decimals);
  const cap = (BigInt(supply) * BigInt(M.MAX_BURN_SHARE_BPS)) / 10000n;
  const base = 10n ** BigInt(decimals);
  const requirement = { week, burnTokens, burnUnits: '', priceUsd, solUsd: Number(solUsd), source, at };
  if (cap > 0n && burnUnits > cap) {
    burnTokens = (cap / base).toString();
    burnUnits = BigInt(burnTokens) * base;
    requirement.burnTokens = burnTokens;
    requirement.capped = true;
  }
  requirement.burnUnits = burnUnits.toString();
  return requirement;
}

/**
 * Amounts for past weeks the keeper never priced (it did not run that week, or every price source
 * was down all week). A send that landed in such a week is judged against the most recent earlier
 * week's amount (docs/membership.md); a send before the first week ever priced, against that first
 * amount. Without this, a send in an unpriced past week could never be judged at all. The current
 * week is never filled: its sends wait for it to be priced.
 */
function fillPastWeeks(requirements, weeks, currentWeek) {
  const out = Object.assign({}, requirements);
  const missing = [...new Set(weeks.map(Number))].filter((w) => Number.isFinite(w) && w < currentWeek && M.weekAmount(out, w) === null).sort((a, b) => a - b);
  for (const w of missing) {
    const priced = Object.keys(out).map(Number).filter((k) => M.weekAmount(out, k) !== null).sort((a, b) => a - b);
    const earlier = priced.filter((k) => k < w).pop();
    const from = earlier !== undefined ? earlier : priced.find((k) => k > w);
    if (from !== undefined) out[String(w)] = out[String(from)];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading histories
// ---------------------------------------------------------------------------------------------

// About 400 days of slots at 0.4s each. A node that remembers less than this cannot be trusted to
// list an account's history: asked about an account whose transactions are older than what it
// keeps, it answers with an empty list rather than an error.
const DEEP_HISTORY_SLOTS = 400 * 216000;

/**
 * The endpoints that keep the chain's full history, out of `urls`. Each is asked for its first
 * available block (getFirstAvailableBlock) and its head; it qualifies when the first is 0 or at
 * least DEEP_HISTORY_SLOTS behind the head. This matters: a public node that keeps two days of
 * ledger answers getSignaturesForAddress for an older account with [] — which reads as "no sends"
 * to the join scan and as "held nothing" to the snapshot — so every history call must go to a node
 * that remembers.
 */
async function deepHistoryEndpoints(urls, { makeCall = (url) => S.createRpc([url], { rounds: 2, pauseMs: 750, timeoutMs: 20000 }), log = () => {} } = {}) {
  const deep = [];
  for (const url of urls) {
    const call = makeCall(url);
    try {
      const first = Number(await call('getFirstAvailableBlock', []));
      const head = Number(await call('getSlot', [{ commitment: 'confirmed' }]));
      if (Number.isFinite(first) && Number.isFinite(head) && (first === 0 || head - first >= DEEP_HISTORY_SLOTS)) deep.push(url);
      else log(`  ${url.replace(/[?#].*$/, '')} keeps history only from slot ${first}; not used for history`);
    } catch (e) { log(`  ${url.replace(/[?#].*$/, '')} could not say how much history it keeps (${e.message}); not used for history`); }
  }
  return deep;
}

// The public mainnet endpoint allows about 40 calls of one method per 10 seconds, and a history
// read is mostly getTransaction, so history calls are spaced a little wider than that.
const HISTORY_INTERVAL_MS = 260;
const TRANSIENT = /HTTP (429|5\d\d)|too many requests|rate.?limit|timed? ?out|aborted|ECONNRESET|socket hang up|fetch failed/i;

/**
 * An RPC caller that waits out rate limits and brief outages: a call that fails with one of those
 * is tried again after 2, 4, 8, 16 and 30 seconds before the error stands. Anything else (a bad
 * parameter, say) fails at once. A run that gives up on a member's holding fails outright, so
 * patience here is what keeps a busy public endpoint from failing the week's ledger.
 */
function patient(call, { tries = 6, baseMs = 2000, maxMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  return async function rpc(method, params) {
    for (let attempt = 1; ; attempt++) {
      try { return await call(method, params); }
      catch (e) {
        if (attempt >= tries || !TRANSIENT.test(String(e && e.message))) throw e;
        const wait = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
        log(`  ${method} was refused (${String(e.message).slice(0, 80)}); trying again in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  };
}

/** The complete history after `until`, oldest first: what production reads. */
const completeHistory = (rpc) => (address, until) => C.signaturesAfter(rpc, address, { until });

/** Only the newest `limit` transactions after `until`, oldest first: what a rehearsal reads. */
const newestHistory = (rpc, limit) => async (address, until) => {
  const opts = { limit: Math.max(1, Math.min(1000, limit)), commitment: 'confirmed' };
  if (until) opts.until = until;
  const list = await rpc('getSignaturesForAddress', [address, opts]);
  if (!Array.isArray(list)) throw new Error('getSignaturesForAddress returned no list for ' + address);
  return list.slice().reverse();
};

const cursorOf = (sig) => ({ signature: sig.signature, slot: Number(sig.slot) });

/**
 * New sends to the incinerator account, folded into members and joins. Reads every transaction
 * after the cursor in chain order, stops at the first one it cannot read, and folds what it read
 * with membership.foldJoins, which in turn stops at the first send whose week has no amount yet.
 * The cursor moves through exactly what was judged, so nothing is ever skipped past.
 */
async function scanJoins({ rpc, list, coin, burnAccount, treasury, cursor, requirements, members, joins, currentWeek, log = () => {} }) {
  const warnings = [];
  let sigs;
  try { sigs = await list(burnAccount, cursor && cursor.signature); }
  catch (e) {
    warnings.push('the incinerator account\'s history could not be read (' + e.message + '); joins wait for the next run');
    return { members, joins, requirements, cursor, read: 0, warnings };
  }
  const items = [];
  for (const sig of sigs) {
    if (sig.err) { items.push({ sig, event: null }); continue; }
    let tx = null;
    try { tx = await C.getTransaction(rpc, sig.signature); } catch (e) { tx = null; }
    if (!tx) { warnings.push('transaction ' + sig.signature + ' on the incinerator account could not be read; joins resume from it next run'); break; }
    const join = M.joinFromTransaction(tx, { coin, burnAccount, exclude: [treasury] });
    if (join && join.skip) log(`  join skipped in ${sig.signature}: ${join.skip}${join.wallet ? ' (' + join.wallet + ')' : ''}`);
    items.push({ sig, event: join && !join.skip ? join : null });
  }
  const events = items.filter((i) => i.event).map((i) => i.event);
  const filled = fillPastWeeks(requirements, events.map((e) => weekOf(e.at)), currentWeek);
  const folded = M.foldJoins({ members, joins }, events, filled);
  let judged = items.length;
  if (folded.stoppedAt < events.length) {
    const first = events[folded.stoppedAt];
    judged = items.findIndex((i) => i.event === first);
    warnings.push(`a send in ${first.tx} waits for week ${weekOf(first.at)}'s join amount`);
  }
  const last = judged > 0 ? items[judged - 1].sig : null;
  return { members: folded.members, joins: folded.joins, requirements: filled, cursor: last ? cursorOf(last) : cursor, read: judged, warnings };
}

/**
 * How many lamports a treasury transaction collected in creator fees, or null when it is not a
 * collection. It is one when it succeeded, touched one of the treasury's pump.fun creator vaults,
 * did not take OTT out of the treasury (a sale is not a fee), and left the treasury richer: its
 * lamports, plus the fee if it paid it, plus any wrapped SOL it gained.
 */
function collectedLamports(tx, { treasury, coin, vaults }) {
  if (!S.succeeded(tx)) return null;
  const keys = S.accountKeys(tx);
  if (!vaults.some((v) => keys.includes(v))) return null;
  if (S.tokenChanges(tx, coin).some((c) => c.owner === treasury && c.post < c.pre)) return null;
  const lamports = S.lamportsChange(tx, treasury);
  if (lamports === null) return null;
  const fee = S.feePayer(tx) === treasury ? BigInt((tx.meta && tx.meta.fee) || 0) : 0n;
  const wrapped = S.tokenChanges(tx, S.MINTS.wsol).filter((c) => c.owner === treasury).reduce((n, c) => n + (c.post - c.pre), 0n);
  const gain = lamports + fee + wrapped;
  return gain > 0n ? gain : null;
}

/**
 * New creator-fee collections into the treasury, each valued at SOL's price in the hour it landed.
 * Stops (cursor unmoved past it) at a transaction it cannot read or a collection it cannot price.
 */
async function scanFees({ rpc, list, coin, treasury, cursor, priceAt, log = () => {} }) {
  const warnings = [];
  const vaults = [await C.creatorVaultAddress(treasury), await C.ammCreatorVaultAccount(treasury)];
  let sigs;
  try { sigs = await list(treasury, cursor && cursor.signature); }
  catch (e) {
    warnings.push('the treasury\'s history could not be read (' + e.message + '); fees wait for the next run');
    return { found: [], cursor, warnings };
  }
  const found = [];
  const prices = new Map();
  let last = null;
  for (const sig of sigs) {
    if (sig.err) { last = sig; continue; }
    let tx = null;
    try { tx = await C.getTransaction(rpc, sig.signature); } catch (e) { tx = null; }
    if (!tx) { warnings.push('treasury transaction ' + sig.signature + ' could not be read; fees resume from it next run'); break; }
    const lamports = collectedLamports(tx, { treasury, coin, vaults });
    if (lamports !== null) {
      const at = Number(tx.blockTime);
      const hour = Math.floor(at / 3600);
      let solUsd = prices.get(hour);
      if (solUsd === undefined) {
        try { solUsd = await priceAt(at); } catch (e) { warnings.push('the collection in ' + sig.signature + ' could not be priced (' + e.message + '); fees resume from it next run'); break; }
        prices.set(hour, solUsd);
      }
      found.push({ tx: sig.signature, at, slot: Number(tx.slot), lamports: lamports.toString(), solUsd, usd: round4(Number(lamports) / 1e9 * solUsd) });
      log(`  fee collection ${sig.signature}: ${(Number(lamports) / 1e9).toFixed(6)} SOL at $${solUsd}`);
    }
    last = sig;
  }
  return { found, cursor: last ? cursorOf(last) : cursor, warnings };
}

/** Collections merged and pruned, and the weekly dollar totals recomputed from them. */
function mergeFees({ collections, weekUsd, found, week }) {
  const all = new Map();
  for (const c of [...collections, ...found]) if (c && c.tx) all.set(c.tx, c);
  const list = [...all.values()].sort((a, b) => Number(a.slot) - Number(b.slot) || byKey(a.tx, b.tx));
  const totals = Object.assign({}, weekUsd);
  const sums = new Map();
  for (const c of list) { const w = weekOf(c.at); sums.set(w, (sums.get(w) || 0) + Number(c.usd || 0)); }
  for (const [w, usd] of sums) totals[String(w)] = round4(usd);
  const keptTotals = {};
  for (const [w, usd] of Object.entries(totals)) if (Number(w) > week - KEEP_FEE_WEEKS) keptTotals[w] = usd;
  return { collections: list.filter((c) => weekOf(c.at) > week - KEEP_COLLECTION_WEEKS), weekUsd: sortedByWeek(keptTotals) };
}

// ---------------------------------------------------------------------------------------------
// The coin
// ---------------------------------------------------------------------------------------------

/** The mint account: its program, decimals and supply (the base mint layout is the same in Token-2022). */
async function readMint(rpc, coin) {
  const info = await rpc('getAccountInfo', [coin, { encoding: 'base64', commitment: 'confirmed' }]);
  const value = info && info.value;
  if (!value) throw new Error(`the mint ${coin} does not exist`);
  const data = Buffer.from(value.data[0], 'base64');
  if (data.length < 82) throw new Error(`${coin} is not a token mint`);
  return { owner: value.owner, decimals: data[44], supply: data.readBigUInt64LE(36) };
}

/**
 * Everything about the coin this ledger depends on, checked against the config: the mint's token
 * program, the incinerator account, that it is a SOL-paired pump.fun coin whose creator fees reach
 * the treasury, and its price now. Throws with the value the operator needs when something is off.
 */
async function checkCoin(rpc, { coin, tokenProgram, treasury, burnAccount }) {
  const mint = await readMint(rpc, coin);
  if (mint.owner !== tokenProgram) throw new Error(`the mint ${coin} belongs to ${mint.owner}, but esim.json says tokenProgram is ${tokenProgram}`);
  const want = await S.associatedTokenAddress(S.INCINERATOR, coin, tokenProgram);
  if (burnAccount !== want) throw new Error(`membership.burnAccount must be the incinerator's account for the coin, ${want}, not ${burnAccount}`);
  const state = await C.coinState(rpc, coin, { decimals: mint.decimals });
  if (state.curveState.isHolderReward || (state.poolState && state.poolState.isHolderReward)) {
    throw new Error(`${coin} is a pump.fun holder rewards coin: its creator fee goes to holders, not to the treasury`);
  }
  if (state.creator !== treasury) {
    throw new Error(`the coin's pump.fun creator is ${state.creator}, but esim.json says the treasury is ${treasury}; `
      + 'creator fees go to the creator, so they must be the same wallet (fee sharing is not supported)');
  }
  return { mint, state };
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/**
 * Build the ledger for `config` and write it to `out` (only when it changed). Returns
 * { data, written, warnings, summary }. Throws, writing nothing, on the failures listed at the top.
 * `prices`, `rpc` and `historyRpc` are injectable. Every history call (the incinerator account,
 * the treasury, members' token accounts) goes to `historyRpc`, which must reach only nodes that keep
 * full history (deepHistoryEndpoints); `historyLimit` reads only the newest few (rehearsal).
 */
async function run({ config, rpc, historyRpc = rpc, out = DEFAULT_OUT, now = () => Date.now(), prices = { now: () => C.solUsdNow(), at: (t) => C.solUsdAt(t) }, historyLimit = null, log = () => {} }) {
  const asOf = Math.floor(now() / 1000);
  const wk = weekOf(asOf);
  const rel = path.relative(process.cwd(), out);
  let slot = 0;
  const headSlot = async () => { try { const s = await rpc('getSlot', [{ commitment: 'confirmed' }]); return Number.isFinite(Number(s)) ? Number(s) : 0; } catch (e) { return 0; } };

  if (!isLaunched(config)) {
    slot = await headSlot();
    const data = emptyAllowances({ asOf, slot, week: wk });
    const written = writeAllowances(out, data);
    const why = config && config.missing ? 'site/config/esim.json is not there yet' : 'the coin is not launched yet';
    return { data, written, warnings: [], summary: `allowances: ${why} — wrote an empty ledger for week ${wk} to ${rel}` };
  }

  const budgetBps = config.budgetBps != null ? Number(config.budgetBps) : 10000;
  if (!(budgetBps >= 0 && budgetBps <= 10000)) throw new Error('esim.json needs a budgetBps between 0 and 10000');
  const m = M.membershipConfig(config);
  if (!m) throw new Error('esim.json has no membership block; the Solana ledger needs one');
  const coin = config.coin, tokenProgram = config.tokenProgram, treasury = config.treasury, burnAccount = m.burnAccount;
  for (const [name, value] of Object.entries({ coin, tokenProgram, treasury, 'membership.burnAccount': burnAccount })) {
    if (!S.isAddress(value)) throw new Error(`esim.json ${name} is not a Solana address`);
  }
  if (!S.TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error('esim.json tokenProgram must be the Token or Token-2022 program');

  const { mint, state } = await checkCoin(rpc, { coin, tokenProgram, treasury, burnAccount });
  slot = await headSlot();
  const keep = carried(readJson(out, null), coin);
  const warnings = [];
  if (state.curveState.isCashbackCoin) warnings.push(`${coin} is a pump.fun cashback coin: part of its creator fee may go to traders instead of the treasury`);
  const list = historyLimit ? newestHistory(historyRpc, historyLimit) : completeHistory(historyRpc);

  // 1. This week's join amount: priced once, at the first run of the week.
  let requirements = Object.assign({}, keep.requirements);
  let requirement = keep.requirement && Number(keep.requirement.week) === wk ? keep.requirement : null;
  if (M.weekAmount(requirements, wk) !== null && !requirement) {
    const units = M.weekAmount(requirements, wk);
    requirement = { week: wk, burnTokens: S.tokensOf(units, mint.decimals), burnUnits: units.toString() };
  }
  if (M.weekAmount(requirements, wk) === null) {
    try {
      const solUsd = await prices.now();
      requirement = priceRequirement({ week: wk, burnUsd: m.burnUsd, priceSol: state.priceSol, solUsd, decimals: mint.decimals, supply: mint.supply, source: state.source, at: asOf });
      requirements[String(wk)] = requirement.burnUnits;
      log(`  week ${wk}'s join amount: ${requirement.burnTokens} OTT at $${requirement.priceUsd.toPrecision(3)} a token${requirement.capped ? ' (held at the supply cap)' : ''}`);
    } catch (e) {
      requirement = null;
      warnings.push(`week ${wk}'s join amount could not be priced (${e.message}); joining stays closed and this week's sends wait`);
    }
  }

  // 2. New joins.
  const joinScan = await scanJoins({ rpc: historyRpc, list, coin, burnAccount, treasury, cursor: keep.joinCursor, requirements, members: keep.members, joins: keep.joins, currentWeek: wk, log });
  warnings.push(...joinScan.warnings);
  requirements = joinScan.requirements;
  const members = joinScan.members, joins = joinScan.joins;

  // 3. Who shares this week, and what each held at the snapshot. A holding is a fact about a past
  // moment, so one already read this week is reused; any that cannot be read fails the run.
  const snapshot = weekStart(wk);
  const sharing = Object.keys(members).filter((w) => members[w] && members[w].since && Number(members[w].since.at) < snapshot).sort(byKey);
  const known = keep.week === wk ? keep.wallets : {};
  const holdings = new Map();
  for (const wallet of sharing) {
    const prior = known[wallet];
    if (prior && typeof prior.tokens === 'string' && /^\d+$/.test(prior.tokens)) { holdings.set(wallet, BigInt(prior.tokens)); continue; }
    try { holdings.set(wallet, await C.holdingAt(historyRpc, wallet, coin, tokenProgram, snapshot)); }
    catch (e) { throw new Error(`what ${wallet} held at the week ${wk} snapshot could not be read (${e.message}); nothing written, the previous ledger stays`); }
  }

  // 4. Fees collected, and last week's budget.
  const feeScan = await scanFees({ rpc: historyRpc, list, coin, treasury, cursor: keep.feeCursor, priceAt: prices.at, log });
  warnings.push(...feeScan.warnings);
  const fees = mergeFees({ collections: keep.collections, weekUsd: keep.weekUsd, found: feeScan.found, week: wk });
  const budgetUsd = round4(Number(fees.weekUsd[String(wk - 1)] || 0) * budgetBps / 10000);
  const budgetSource = `creator fees collected in week ${wk - 1}`;

  // 5. The capped split among the members at the snapshot.
  const memberTokens = sharing.reduce((n, w) => n + holdings.get(w), 0n);
  const split = M.cappedShares({ members: sharing, weights: holdings, budgetUsd, capMultiple: m.capMultiple });
  const wallets = {};
  for (const wallet of sharing) {
    const tokens = holdings.get(wallet);
    wallets[wallet] = { tokens: tokens.toString(), share: memberTokens > 0n ? Number(tokens) / Number(memberTokens) : 0, allowanceUsd: split.allocations.get(wallet), member: true };
  }

  const data = {
    asOf, slot, chain: 'solana',
    week: wk, weekStart: weekStart(wk), weekEnd: weekEnd(wk),
    coin, tokenProgram, decimals: mint.decimals, treasury,
    budgetUsd, budgetSource,
    fees: { weekUsd: fees.weekUsd, collections: fees.collections, cursor: feeScan.cursor },
    membership: {
      burnUsd: m.burnUsd, burnOwner: m.burnOwner, burnAccount, capMultiple: m.capMultiple,
      requirement, requirements: sortedByWeek(requirements),
      members: sharing.length, capUsd: split.capUsd, allocatedUsd: split.allocatedUsd, unallocatedUsd: split.unallocatedUsd,
      cursor: joinScan.cursor,
    },
    members: sorted(members), joins: sorted(joins),
    holders: sharing.length, memberTokens: memberTokens.toString(),
    wallets: sorted(wallets),
  };
  const written = writeAllowances(out, data);
  const summary = `allowances: ${coin} week ${wk}: ${Object.keys(members).length} member(s), ${sharing.length} sharing; `
    + (requirement ? `join amount ${Number(requirement.burnTokens).toLocaleString('en-US')} OTT; ` : 'join amount not set; ')
    + `$${budgetUsd.toFixed(4)} budget (${budgetSource}) -> ${rel}${written ? '' : ' (unchanged)'}`
    + (warnings.length ? '\n' + warnings.map((w) => '  ! ' + w).join('\n') : '');
  return { data, written, warnings, summary };
}

// ---------------------------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------------------------

/** Where a rehearsal may write: anywhere it is told to, except site/data/. */
function rehearsalOut(out) {
  if (!out) throw new Error('a rehearsal needs --out: it never writes the real ledger');
  const resolved = path.resolve(out);
  const data = path.join(SITE, 'data');
  if (resolved === data || resolved.startsWith(data + path.sep)) throw new Error('a rehearsal never writes into site/data/; choose another --out');
  return resolved;
}

/** The config a rehearsal runs with: the real membership rules, and the named coin's own addresses. */
async function rehearsalConfig(rpc, base, mintAddress) {
  if (!S.isAddress(mintAddress)) throw new Error('--rehearse needs a mint address');
  const mint = await readMint(rpc, mintAddress);
  if (!S.TOKEN_PROGRAMS.includes(mint.owner)) throw new Error(`${mintAddress} is not a token mint`);
  const state = await C.coinState(rpc, mintAddress, { decimals: mint.decimals });
  const burnAccount = await S.associatedTokenAddress(S.INCINERATOR, mintAddress, mint.owner);
  return Object.assign({}, base, {
    coin: mintAddress, tokenProgram: mint.owner, treasury: state.creator,
    membership: Object.assign({}, base.membership, { burnAccount }),
  });
}

function parseArgs(argv) {
  const value = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  const limit = value('history-limit');
  return { out: value('out'), rehearse: value('rehearse'), historyLimit: limit === undefined ? undefined : Number(limit) };
}

/** Backwards-compatible: an RPC caller over these endpoints (or the configured ones). */
function makeRpc(endpoints, { log = () => {} } = {}) {
  return C.makeRpc({ urls: Array.isArray(endpoints) && endpoints.length ? endpoints : C.endpoints(), log });
}

module.exports = {
  WEEK_S, ANCHOR, weekOf, weekStart, weekEnd, round4,
  KEEP_COLLECTION_WEEKS, KEEP_FEE_WEEKS, DEFAULT_OUT,
  loadConfig, isLaunched, emptyAllowances, sameButForTheClock, writeAllowances, carried,
  DEEP_HISTORY_SLOTS, HISTORY_INTERVAL_MS, deepHistoryEndpoints, patient, priceRequirement, fillPastWeeks, scanJoins, collectedLamports, scanFees, mergeFees, readMint, checkCoin,
  run, rehearsalOut, rehearsalConfig, parseArgs, makeRpc,
};

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const log = (msg) => process.stderr.write(msg + '\n');
  const urls = C.endpoints();
  const rpc = patient(C.makeRpc({ urls, log }), { log });
  (async () => {
    let config = loadConfig();
    // Before launch the ledger is empty and reads no history, so it needs no full-history endpoint.
    if (!args.rehearse && !isLaunched(config)) {
      const { summary } = await run({ config, rpc, out: args.out ? path.resolve(process.cwd(), args.out) : DEFAULT_OUT, log });
      console.log(summary);
      return;
    }
    const deep = await deepHistoryEndpoints(urls, { log });
    if (!deep.length) throw new Error('none of the configured Solana endpoints keeps full history (getFirstAvailableBlock); set SOLANA_RPC_URL to one that does, such as api.mainnet-beta.solana.com or an archive provider');
    const historyRpc = patient(C.makeRpc({ urls: deep, minIntervalMs: HISTORY_INTERVAL_MS, log }), { log });
    let out = args.out ? path.resolve(process.cwd(), args.out) : DEFAULT_OUT;
    let historyLimit = null;
    if (args.rehearse) {
      out = rehearsalOut(args.out);
      config = await rehearsalConfig(rpc, config, args.rehearse);
      historyLimit = Number.isFinite(args.historyLimit) && args.historyLimit > 0 ? args.historyLimit : DEFAULT_HISTORY_LIMIT;
      log(`rehearsal: ${config.coin} (creator ${config.treasury}, ${config.tokenProgram === S.PROGRAMS.token2022 ? 'Token-2022' : 'Token'}), newest ${historyLimit} transactions of each history`);
    }
    const { summary } = await run({ config, rpc, historyRpc, out, historyLimit, log });
    console.log(summary);
  })().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
