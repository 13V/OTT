#!/usr/bin/env node
'use strict';
/**
 * allowances.js — how much data credit every wallet has this week, just for holding the coin.
 *
 * The product promise changed: trading no longer earns anything (the old 8% USDG rebate is
 * retired), and holding is the plan instead. Every week the creator tax the coin collected
 * **last** week becomes **this** week's data budget, and a wallet's allowance is its share of the
 * circulating supply times that budget — dollars of credit, spent on eSIM packages at the
 * reseller's wholesale price, expiring at the end of the week. Like the file this replaces, there
 * is no database: this script re-derives the whole thing from chain on every run and writes it to
 * site/data/allowances.json, which the site reads directly and the redeem API reads over HTTP from
 * its own deployment. Nothing downstream can drift from chain because nothing downstream holds
 * state of its own.
 *
 * Two numbers have to be pulled from chain history, both anchored to week boundaries (see
 * weekOf/weekStart/weekEnd below, identical to every other file that needs the week contract):
 *
 *   1. Balances at the snapshot block (the last block at or before this week's start), to work out
 *      each wallet's share of the circulating supply. These come from folding the coin's own
 *      Transfer logs from its launch block up to the snapshot, NOT from an archive eth_call — see
 *      foldBalances() for why that is the important design decision in this file.
 *   2. The tax collected last week, from summing the USDG Transfer events the curve sent to the fee
 *      escrow with block timestamps inside last week. The two boundary blocks are found by binary
 *      search over eth_getBlockByNumber timestamps (the same search the snapshot uses), and logs are
 *      then filtered by block *number*, which is exact and only costs two searches — fetching a
 *      timestamp per log would be far more calls for no better an answer.
 *
 *   node scripts/allowances.js                        # writes site/data/allowances.json for "now"
 *   node scripts/allowances.js --week 2959             # rebuild a specific week
 *   node scripts/allowances.js --from-block 62826841   # skip the launch-block lookup
 *   node scripts/allowances.js --to-block 62900000     # a reproducible chain head
 *   node scripts/allowances.js --out /tmp/a.json
 *
 * Read-only, no key, no dependency beyond scripts/chain.js. v1 is pre-graduation and USDG-paired
 * only: the tax sweep this script sums is only meaningful in dollars if it is paid in USDG, so a
 * native-ETH pair (which moves ether, not an ERC-20, and so has no Transfer events for the sweep
 * either) is refused rather than indexed as a ledger of zeros that looks like nobody was taxed.
 *
 * Until the coin is launched, site/config/esim.json carries an empty coin address; this script then
 * writes a valid, empty ledger and exits 0, so the site and the API always have a file to read.
 *
 * The pure parts (weekOf/weekStart/weekEnd, foldBalances, buildWallets, sumTaxUsd, round4,
 * emptyAllowances, run) are exported for test/allowances.test.js; the CLI runs only under
 * require.main === module.
 */
const fs = require('fs');
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));

const SITE = path.join(__dirname, '..', 'site');
const ADDRESSES_PATH = path.join(SITE, 'config', 'addresses.json');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const DEFAULT_OUT = path.join(SITE, 'data', 'allowances.json');

// Both topics are computed rather than pasted: a hand-copied topic hash is one silent typo away
// from a scan that finds nothing and reports it as "nobody holds anything".
const TRANSFER = chain.topic('Transfer(address,address,uint256)');
// TokenLaunched(address token indexed, address curve indexed, address deployer indexed,
//               address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
const LAUNCHED = chain.topic('TokenLaunched(address,address,address,address,uint256,uint256)');

// The official endpoint refuses ranges much wider than this, and the probe that sized it found the
// others either refusing older blocks outright or answering "busy" — so the chunk is small and the
// pause between chunks is real, not decorative.
// Robinhood Chain produces a block roughly every 0.1 seconds, so a week is about six MILLION
// blocks. A 10,000-block chunk — the right size for a broad scan — would need six hundred requests
// to cover one week's tax window, which does not finish inside a scheduled job.
//
// Measured against all three endpoints on 16 Sep 2026: a *narrow* filter (one address, one or two
// topics, which is every query this file makes) is served over a 1,000,000-block range in about
// 70ms by two of the three, and the third refuses every range as it is rate-limited anyway. So the
// scan starts wide and only narrows when an endpoint complains, rather than paying for the worst
// case on every request.
const MAX_CHUNK = 1000000;
const MIN_CHUNK = 10000;
const CHUNK = MAX_CHUNK;
const PAUSE_MS = 120;
// What an endpoint says when a range is too wide for it. Anything else is a real error and is
// rethrown — narrowing the window would only hide it.
const TOO_WIDE = /timed out|too many|range|limit exceeded|exceeds|query returned more than|block range/i;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => String(a || '').toLowerCase();
const pad = (a) => '0x' + lower(a).replace(/^0x/, '').padStart(64, '0');
const unpad = (word) => '0x' + String(word).slice(-40).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const word = (data, i) => BigInt('0x' + String(data).slice(2 + i * 64, 2 + (i + 1) * 64));
// Four decimal places — a hundredth of a cent — is finer than any package price and coarse enough
// that two runs over the same chain state agree; used for every dollar figure in the output.
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** site/config/esim.json, or — if the route owner has not written it yet — the same shape with an
 *  empty coin, so a fresh checkout still produces a valid empty ledger instead of a stack trace. */
function loadConfig(p = ESIM_PATH) {
  if (!fs.existsSync(p)) {
    return { coin: '', curve: '', treasury: '', missing: true };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Week arithmetic, imported rather than restated. A week is Monday 00:00 UTC through the following
// Monday 00:00 UTC, anchored to the first Monday after the Unix epoch so it needs no calendar
// library and no timezone. This file and the redeem API must agree on the week to the second — a
// wallet's allowance is written here and spent there — so there is exactly one definition, in
// site/api/lib/week.js, and this script reaches across for it. The dependency only goes this way:
// the API is deployed on its own and can never reach into scripts/.
// ---------------------------------------------------------------------------
const { WEEK_S, ANCHOR, weekOf, weekStart, weekEnd } = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'week.js'));

// ---------------------------------------------------------------------------
// The pure part: logs in, ledger out.
// ---------------------------------------------------------------------------

/**
 * Fold Transfer(address,address,uint256) logs into { lowercase address -> BigInt balance }.
 *
 * This is the important design decision in this file: balances come from summing every Transfer
 * the coin ever emitted, not from an archive eth_call. Summing transfers gives an exact historical
 * balance at any block using nothing but eth_getLogs, which every endpoint in the rotation
 * supports; the public endpoints for this chain cannot be relied on to answer a historical
 * balanceOf() at all — some refuse a past block tag outright, others silently answer against
 * `latest` regardless of what was asked, and either way there is no way to tell from the response
 * alone. A sum of logs has no such failure mode: it is exact by construction, or it visibly is not
 * (a missing chunk shows up as a wrong total, not a wrong-but-plausible one).
 *
 * Each log credits `to` and debits `from`. The zero address is not a counterparty — a mint's `from`
 * and a burn's `to` are both the zero address, and it is not a wallet that can hold a data
 * allowance — so it is never credited or debited: a mint only adds to `to`'s balance and a burn
 * only removes from `from`'s, which is exactly "mints add to supply, burns remove". Addresses whose
 * net balance comes out to exactly zero (received tokens and later sent all of them away) are
 * dropped from the result entirely rather than kept as a zero entry, because "holds tokens" and
 * "used to hold tokens" must not look alike to anything reading this map.
 */
function foldBalances(logs) {
  const balances = new Map();
  for (const log of logs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    const from = unpad(log.topics[1]);
    const to = unpad(log.topics[2]);
    const amount = BigInt(log.data);
    if (from !== ZERO_ADDR) balances.set(from, (balances.get(from) || 0n) - amount);
    if (to !== ZERO_ADDR) balances.set(to, (balances.get(to) || 0n) + amount);
  }
  for (const [addr, bal] of balances) {
    if (bal === 0n) balances.delete(addr);
  }
  return balances;
}

/**
 * Turn a balance map into the week's public ledger: circulating supply (everyone in `balances`
 * except `exclude`), and each surviving wallet's tokens/share/allowanceUsd.
 *
 * `exclude` is not "the public" and gets no allowance at all even if the balance map shows a
 * nonzero amount for it — each entry is excluded for a different reason:
 *   - the curve:     holds the unsold supply pre-graduation; that is inventory, not a holding.
 *   - the fee escrow: holds tax already collected but not yet turned into this week's budget;
 *                     paying it an allowance out of its own collected tax would be circular.
 *   - the factory:    can hold dust in transit during launch/graduation bookkeeping; operational,
 *                     not a holder.
 *   - the memeHook:   Pons's hook can hold tokens transiently around a graduation; same reason.
 *   - the treasury:   the project's own wallet; it is the payer of the budget, not a claimant on it.
 *
 * share is tokens/circulating as a plain float, 0 when circulating is 0 so an all-empty week never
 * divides by zero. allowanceUsd is share * budgetUsd rounded to four decimal places (round4, the
 * same rounding the old rebate ledger used for earnedUsd) — computed from the already-rounded
 * budgetUsd so the number on a wallet's row visibly reconciles against the number at the top of the
 * file. Keys come back lowercase and sorted so two runs over the same chain state produce
 * byte-identical files, which is what lets the workflow commit only on change.
 */
function buildWallets({ balances, exclude = [], budgetUsd = 0 }) {
  const skip = new Set(exclude.map(lower));
  let circulating = 0n;
  for (const [addr, bal] of balances) {
    if (!skip.has(addr)) circulating += bal;
  }
  const circulatingNum = Number(circulating);
  const addrs = Array.from(balances.keys()).filter((a) => !skip.has(a)).sort();
  const wallets = {};
  for (const addr of addrs) {
    const bal = balances.get(addr);
    const share = circulating === 0n ? 0 : Number(bal) / circulatingNum;
    wallets[addr] = { tokens: bal.toString(), share, allowanceUsd: round4(share * budgetUsd) };
  }
  return { circulating, wallets, holders: addrs.length };
}

/**
 * Sum a set of USDG Transfer logs into a raw dollar amount (before budgetBps). The caller is
 * responsible for scoping `logs` to the right block range (the curve -> feeEscrow topic filter over
 * last week's two boundary blocks) — this only adds up what it is given, so "which week" is
 * entirely a matter of which logs were fetched, not of any per-log filtering here.
 */
function sumTaxUsd(logs, decimals = 6) {
  let units = 0n;
  for (const log of logs) {
    if (!log || log.data == null) continue;
    units += BigInt(log.data);
  }
  return Number(units) / 10 ** decimals;
}

/** The contract shape with nothing in it: what the site and the API read before the launch, or for
 *  a week whose budget is zero because there was no tax to collect. 18 is a placeholder — there is
 *  no token to ask — and harmless, since circulating is "0" regardless of what it is divided by. */
function emptyAllowances({ asOf, block = 0, week }) {
  return {
    asOf, block, week,
    weekStart: weekStart(week), weekEnd: weekEnd(week),
    snapshotBlock: 0, coin: '', curve: '',
    budgetUsd: 0, budgetSource: 'the coin is not launched yet',
    circulating: '0', decimals: 18, holders: 0,
    wallets: {},
  };
}

function writeAllowances(out, data) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
}

// ---------------------------------------------------------------------------
// JSON-RPC, rotated across site/config/addresses.json's endpoints the way menu.js does it.
// ---------------------------------------------------------------------------

/**
 * One call, on the next endpoint in the rotation, retried on the others when it fails. A 429 is
 * the official endpoint asking for patience, and it gets a longer sleep than a plain error; a
 * `null` result for a method that should return an array or a hex string is a lagging endpoint,
 * not an answer, and is retried the same way (see menu.js's getBlockRetry for the history).
 */
function makeRpc(endpoints, { pause = PAUSE_MS, log = () => {} } = {}) {
  let turn = 0;
  const tries = endpoints.length * 3;
  return async function rpc(method, params, attempt = 0) {
    const url = endpoints[turn++ % endpoints.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429) { await sleep(pause * 4); throw new Error('HTTP 429'); }
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (j.result === null || j.result === undefined) throw new Error('empty result');
      return j.result;
    } catch (e) {
      log(`  rpc ${method} on ${url}: ${e.message}`);
      if (attempt >= tries) throw new Error(`${method} failed on every endpoint: ${e.message}`);
      await sleep(pause * (attempt + 1));
      return rpc(method, params, attempt + 1);
    }
  };
}

/** factory.getLaunchedToken(coin) as the fifteen words the factory returns, or null if it does not
 *  know the coin (word 14 is the exists flag; an unknown coin reads as all zeros). */
async function launchedToken(rpc, factory, coin) {
  const raw = await rpc('eth_call', [{ to: factory, data: chain.encodeCall('getLaunchedToken(address)', [coin]) }, 'latest']);
  if (!raw || raw.length < 2 + 15 * 64) return null;
  const words = [];
  for (let i = 0; i < 15; i++) words.push(word(raw, i));
  if (words[14] === 0n) return null;
  return {
    token: unpad(words[0].toString(16).padStart(64, '0')),
    curve: unpad(words[1].toString(16).padStart(64, '0')),
    creator: unpad(words[2].toString(16).padStart(64, '0')),
    pair: unpad(words[4].toString(16).padStart(64, '0')),
    graduationThreshold: words[5],
    creatorTaxBps: Number(words[8]),
  };
}

/** token.decimals(), read from the token rather than assumed — a wrong assumption here would
 *  silently be wrong in the same direction for every wallet, and 18 is not universal. */
async function tokenDecimals(rpc, token) {
  const raw = await rpc('eth_call', [{ to: token, data: chain.encodeCall('decimals()') }, 'latest']);
  return Number(word(raw, 0));
}

/**
 * The smallest block number in [0, head] whose timestamp is >= `ts`, or head + 1 if every block up
 * to head is still earlier than `ts` (the boundary has not been mined yet — e.g. `ts` falls inside
 * a week still in progress). One binary search, used three ways: the snapshot block is the block
 * just before firstBlockAtOrAfter(weekStart(week) + 1); last week's tax window is the block range
 * [firstBlockAtOrAfter(weekStart(week - 1)), firstBlockAtOrAfter(weekStart(week)) - 1].
 */
async function firstBlockAtOrAfter(rpc, ts, head) {
  const timestamp = async (n) => Number(BigInt((await rpc('eth_getBlockByNumber', [hex(n), false])).timestamp));
  let lo = 0, hi = head + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await timestamp(mid)) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The block the coin was launched in — where the balance scan starts. The factory's TokenLaunched
 * log indexes the token, so one getLogs over the whole chain with the coin as topics[1] is a cheap
 * query for a node that will accept a wide range (the official endpoint does; the others refuse
 * older blocks or answer "busy"). If none of them will, the curve's own launchedAt() timestamp is
 * binary-searched against block timestamps instead (firstBlockAtOrAfter), so there is no range
 * limit to argue with, just about 20-something eth_getBlockByNumber calls.
 */
async function launchBlock({ rpc, factory, coin, curve, head, log = () => {} }) {
  try {
    const logs = await rpc('eth_getLogs', [{ address: factory, topics: [LAUNCHED, pad(coin)], fromBlock: '0x0', toBlock: hex(head) }]);
    if (logs.length) return Number(BigInt(logs[0].blockNumber));
    throw new Error('the factory has no TokenLaunched log for this coin');
  } catch (e) {
    log(`  launch log lookup failed (${e.message}); searching by launchedAt() instead`);
  }
  const at = Number(word(await rpc('eth_call', [{ to: curve, data: chain.encodeCall('launchedAt()') }, 'latest']), 0));
  if (!at) throw new Error(`curve ${curve} reports no launchedAt(); pass --from-block`);
  return firstBlockAtOrAfter(rpc, at, head);
}

/**
 * Every log matching `address`/`topics` from `fromBlock` to `toBlock` inclusive, in chunks of at
 * most `chunk` blocks, sleeping `pause` ms between chunks so as not to trip the public endpoints'
 * rate limits. One query per chunk: unlike the old rebate ledger (which had to OR two directions
 * together because "traded with the curve" meant either side), every caller here already knows
 * exactly which topics it wants — every Transfer of the coin, or specifically curve -> feeEscrow —
 * so a single precise filter replaces the old two-queries-and-dedupe.
 */
/**
 * Every matching log between two blocks, in as few requests as the endpoints will allow.
 *
 * The window adapts: it starts at `chunk` and halves whenever an endpoint says the range is too
 * wide, down to MIN_CHUNK, then widens again after a clean pass. That way one slow endpoint costs
 * a retry rather than forcing the whole scan to crawl, and a chain that speeds up later does not
 * need this constant re-tuned by hand.
 */
async function scanTransfers({ rpc, address, topics, fromBlock, toBlock, chunk = CHUNK, pause = PAUSE_MS, onChunk = () => {} }) {
  const seen = new Set();
  const logs = [];
  let chunks = 0;
  let span = Math.max(MIN_CHUNK, Math.min(chunk, MAX_CHUNK));
  let clean = 0;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + span - 1, toBlock);
    let found;
    try {
      found = await rpc('eth_getLogs', [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }]);
    } catch (e) {
      if (span > MIN_CHUNK && TOO_WIDE.test(String(e && e.message))) {
        span = Math.max(MIN_CHUNK, Math.floor(span / 2));
        clean = 0;
        continue;                         // same `from`, a narrower window
      }
      throw e;
    }
    for (const log of found) {
      // Belt and braces: real endpoints have occasionally answered an overlapping chunk twice.
      const key = `${log.blockNumber}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logs.push(log);
    }
    chunks++;
    onChunk({ from, to, count: logs.length, span });
    from = to + 1;
    // After a run of clean passes the window opens back up: an endpoint that refused once is often
    // just busy, and staying narrow forever is how a scan silently becomes an hour long again. The
    // run is four rather than two because widening costs a refused request when the endpoint really
    // does have a hard ceiling, and probing for it every third chunk is most of that saving back.
    if (++clean >= 4 && span < MAX_CHUNK) { span = Math.min(MAX_CHUNK, span * 2); clean = 0; }
    if (from <= toBlock && pause) await sleep(pause);
  }
  return { logs, chunks };
}

// ---------------------------------------------------------------------------
// The run itself, with everything that touches the world (rpc, clock, disk) injectable.
// ---------------------------------------------------------------------------

/**
 * Build the week's ledger for `config` and write it to `out`. Returns { data, summary } so the test
 * can inspect what was written without parsing stdout. Throws with a plain message when the coin is
 * not something this script can index (unknown to the factory, not paired with USDG, or esim.json
 * disagrees with the factory about the curve).
 */
async function run({ config, addresses, rpc, out = DEFAULT_OUT, week, fromBlock, toBlock, now = () => Date.now(), log = () => {} }) {
  const asOf = Math.floor(now() / 1000);
  const wk = week != null ? Number(week) : weekOf(asOf);
  if (!Number.isFinite(wk)) throw new Error(`--week "${week}" is not a number`);
  const rel = path.relative(process.cwd(), out);

  if (!config.coin) {
    // Not launched yet. The block number is a nicety here — it tells a reader when the empty file
    // was produced in chain time — so an unreachable RPC is not a reason to fail the run.
    let block = 0;
    try { block = Number(BigInt(await rpc('eth_blockNumber', []))); } catch (e) { log(`  eth_blockNumber unavailable (${e.message}); recording block 0`); }
    const data = emptyAllowances({ asOf, block, week: wk });
    writeAllowances(out, data);
    const why = config.missing ? 'site/config/esim.json is not there yet' : 'no coin in site/config/esim.json yet';
    return { data, summary: `allowances: ${why} — wrote an empty ledger for week ${wk} (block ${block}) to ${rel}` };
  }

  if (config.budgetBps != null) {
    const b = Number(config.budgetBps);
    if (!(b >= 0 && b <= 10000)) throw new Error('esim.json needs a budgetBps between 0 and 10000');
  }

  const coin = lower(config.coin);
  const usdg = lower(addresses.usdg);
  const usdgDecimals = Number(addresses.usdgDecimals || 6);
  const { factory, feeEscrow, memeHook } = addresses.pons;
  const treasury = lower(config.treasury || '');

  const launched = await launchedToken(rpc, factory, coin);
  if (!launched) throw new Error(`the factory ${factory} does not know ${coin}; is esim.json's coin right?`);
  if (launched.pair !== usdg) {
    const isNative = /^0x0{40}$/.test(launched.pair);
    throw new Error(`${coin} is paired with ${isNative ? 'native ether' : launched.pair}, not USDG. `
      + (isNative ? 'Ether moves without Transfer events, so the tax sweep has nothing to sum in dollars; ' : '')
      + 'v1 indexes USDG-paired coins only.');
  }
  const curve = config.curve ? lower(config.curve) : launched.curve;
  if (curve !== launched.curve) {
    throw new Error(`esim.json says the curve is ${curve} but the factory says ${launched.curve}; refusing to index the wrong one`);
  }
  // A coin with no curve beside it indexes perfectly well — the factory knows the curve, and the
  // line above just took it. The site does not: site/api/redeem.js and site/api/status.js both
  // treat "launched" as coin AND curve, so with one filled in and not the other the ledger goes
  // live while every holder is still told the coin has not launched. That is a launch-day half
  // step nobody would guess at from the outside, so it is said here, where the operator is
  // looking, with the value they need to paste.
  const curveMissing = !config.curve;
  if (curveMissing) {
    log(`  ! esim.json has no curve. The factory says it is ${launched.curve} — put that in site/config/esim.json.`);
    log('    Until you do, this ledger is published but the site answers "coin not launched yet" and nobody can spend it.');
  }

  const head = toBlock != null ? Number(toBlock) : Number(BigInt(await rpc('eth_blockNumber', [])));
  const decimals = await tokenDecimals(rpc, coin);

  // The snapshot: the last block at or before this week's start, i.e. one block before the first
  // block whose timestamp is past it.
  const snapshotBlock = (await firstBlockAtOrAfter(rpc, weekStart(wk) + 1, head)) - 1;
  const launchBlk = fromBlock != null ? Number(fromBlock) : await launchBlock({ rpc, factory, coin, curve, head, log });

  let balances = new Map();
  if (snapshotBlock >= launchBlk) {
    const { logs } = await scanTransfers({
      rpc, address: coin, topics: [TRANSFER], fromBlock: launchBlk, toBlock: snapshotBlock,
      onChunk: ({ from, to, count }) => log(`  balances: blocks ${from}-${to}: ${count} transfers of the coin so far`),
    });
    balances = foldBalances(logs);
  }
  const exclude = [curve, feeEscrow, factory, memeHook, treasury].filter(Boolean);

  // The budget: last week's curve -> feeEscrow USDG only, found the same way as the snapshot.
  const budgetFromBlock = await firstBlockAtOrAfter(rpc, weekStart(wk - 1), head);
  const budgetToBlock = (await firstBlockAtOrAfter(rpc, weekStart(wk), head)) - 1;
  let rawTaxUsd = 0;
  if (budgetToBlock >= budgetFromBlock) {
    const { logs: taxLogs } = await scanTransfers({
      rpc, address: usdg, topics: [TRANSFER, pad(curve), pad(feeEscrow)], fromBlock: budgetFromBlock, toBlock: budgetToBlock,
      onChunk: ({ from, to, count }) => log(`  tax: blocks ${from}-${to}: ${count} transfers so far`),
    });
    rawTaxUsd = sumTaxUsd(taxLogs, usdgDecimals);
  }
  const budgetBps = config.budgetBps != null ? Number(config.budgetBps) : 10000;
  const budgetUsd = round4(rawTaxUsd * budgetBps / 10000);
  const budgetSource = `tax collected in week ${wk - 1}`;

  const { circulating, wallets, holders } = buildWallets({ balances, exclude, budgetUsd });

  const data = {
    asOf, block: head, week: wk, weekStart: weekStart(wk), weekEnd: weekEnd(wk),
    snapshotBlock, coin, curve,
    budgetUsd, budgetSource,
    circulating: circulating.toString(), decimals, holders,
    wallets,
  };
  writeAllowances(out, data);

  const summary = `allowances: ${coin} week ${wk}, snapshot block ${snapshotBlock}: ${holders} holder(s), `
    + `${chain.fromUnits(circulating, decimals)} tokens circulating, $${budgetUsd.toFixed(4)} budget (${budgetSource}) -> ${rel}`
    + (curveMissing ? `\n  ! the site is still closed: site/config/esim.json needs curve ${launched.curve}` : '');
  return { data, summary, curveMissing };
}

module.exports = {
  WEEK_S,
  ANCHOR,
  weekOf,
  weekStart,
  weekEnd,
  foldBalances,
  buildWallets,
  sumTaxUsd,
  round4,
  emptyAllowances,
  writeAllowances,
  loadConfig,
  makeRpc,
  launchedToken,
  tokenDecimals,
  firstBlockAtOrAfter,
  launchBlock,
  scanTransfers,
  run,
  TRANSFER,
  LAUNCHED,
  CHUNK,
  MAX_CHUNK,
  MIN_CHUNK,
  pad,
};

if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const addresses = JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
  const endpoints = addresses.rpcs && addresses.rpcs.length ? addresses.rpcs : [addresses.rpc];
  const outArg = arg('out');
  run({
    config: loadConfig(),
    addresses,
    rpc: makeRpc(endpoints, { log: (m) => process.stderr.write(m + '\n') }),
    out: outArg ? path.resolve(process.cwd(), outArg) : DEFAULT_OUT,
    week: arg('week'),
    fromBlock: arg('from-block'),
    toBlock: arg('to-block'),
    log: (m) => process.stderr.write(m + '\n'),
  })
    .then(({ summary }) => console.log(summary))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
