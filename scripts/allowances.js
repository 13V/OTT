#!/usr/bin/env node
'use strict';
/**
 * allowances.js — how much data credit every wallet has earned by trading the coin.
 *
 * The product promise is simple: every trade against the coin's bonding curve earns the trader a
 * rebate of rebateBps of what they traded, banked as dollars of data credit and spent on eSIM
 * packages at the reseller's wholesale price — which is why the ledger is in dollars and not in
 * gigabytes: a gigabyte in Europe costs the treasury a seventh of a gigabyte worldwide, and a unit
 * that hid that would let every holder pick the dear one. "What they traded" is the
 * wallet's gross USDG volume against the curve — a buy is a USDG Transfer from the wallet to the
 * curve, a sell is one from the curve to the wallet — and the chain already records every one of
 * those, so there is no database to keep: this file re-derives the whole ledger from logs on every
 * run and writes it to site/data/allowances.json, which the site reads directly and the redeem API
 * reads over HTTP from its own deployment. Nothing downstream can drift from chain because nothing
 * downstream holds state of its own.
 *
 * Two kinds of USDG movement touch the curve and are NOT trades: the curve sweeping creator tax to
 * the fee escrow, and anything the factory or Pons's hook moves around a graduation. Those
 * counterparties are excluded by address (site/config/addresses.json), otherwise the escrow would
 * be the best-rewarded "trader" on the ledger.
 *
 *   node scripts/allowances.js                        # writes site/data/allowances.json
 *   node scripts/allowances.js --from-block 62826841  # skip the launch-block lookup
 *   node scripts/allowances.js --to-block 62900000    # a reproducible upper bound
 *   node scripts/allowances.js --out /tmp/a.json
 *
 * Read-only, no key, no dependency beyond scripts/chain.js. v1 is pre-graduation and USDG-paired
 * only: a native-ETH pair moves ether, not an ERC-20, so it has no Transfer events to read and this
 * script refuses it rather than write a ledger of zeros that looks like nobody traded.
 *
 * Until the coin is launched, site/config/esim.json carries an empty coin address; this script then
 * writes a valid, empty ledger and exits 0, so the site and the API always have a file to read.
 *
 * The pure parts (aggregate, emptyAllowances, run) are exported for test/allowances.test.js; the
 * CLI runs only under require.main === module.
 */
const fs = require('fs');
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));

const SITE = path.join(__dirname, '..', 'site');
const ADDRESSES_PATH = path.join(SITE, 'config', 'addresses.json');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const DEFAULT_OUT = path.join(SITE, 'data', 'allowances.json');

// Both topics are computed rather than pasted: a hand-copied topic hash is one silent typo away
// from a scan that finds nothing and reports it as "nobody traded".
const TRANSFER = chain.topic('Transfer(address,address,uint256)');
// TokenLaunched(address token indexed, address curve indexed, address deployer indexed,
//               address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
const LAUNCHED = chain.topic('TokenLaunched(address,address,address,address,uint256,uint256)');

// The official endpoint refuses ranges much wider than this, and the probe that sized it found the
// others either refusing older blocks outright or answering "busy" — so the chunk is small and the
// pause between chunks is real, not decorative.
const CHUNK = 10000;
const PAUSE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => String(a || '').toLowerCase();
const pad = (a) => '0x' + lower(a).replace(/^0x/, '').padStart(64, '0');
const unpad = (word) => '0x' + String(word).slice(-40).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const word = (data, i) => BigInt('0x' + String(data).slice(2 + i * 64, 2 + (i + 1) * 64));

/** site/config/esim.json, or — if the route owner has not written it yet — the same shape with an
 *  empty coin, so a fresh checkout still produces a valid empty ledger instead of a stack trace. */
function loadConfig(p = ESIM_PATH) {
  if (!fs.existsSync(p)) {
    return { coin: '', curve: '', treasury: '', pair: '', taxBps: 0, rebateBps: 800, missing: true };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// The pure part: logs in, ledger out.
// ---------------------------------------------------------------------------

/**
 * Fold USDG Transfer logs into { wallet: { tradedUsd, earnedUsd } }.
 *
 * `logs` are eth_getLogs entries as the node returns them (topics[1] = from, topics[2] = to, data =
 * amount), already filtered to the ones touching `curve` on either side. Amounts are summed as
 * integers in the token's smallest unit and only turned into a float once, at the end, so a wallet
 * that traded ten thousand times does not accumulate ten thousand rounding errors. earnedUsd is
 * rounded to four decimals — a hundredth of a cent — which is finer than any package price and
 * coarse enough that two runs agree; tradedUsd keeps the token's own precision.
 *
 * A counterparty in `exclude` (the fee escrow, the factory, the hook) is not a trader and is left
 * out entirely — the curve paying its creator tax into escrow is the one transfer that would
 * otherwise dominate the ledger. Keys come back lowercase and sorted so two runs over the same
 * chain produce byte-identical files, which is what lets the workflow commit only on change.
 */
function aggregate(logs, { curve, exclude = [], rebateBps, decimals = 6 }) {
  const c = lower(curve);
  const skip = new Set(exclude.map(lower).concat([c]));
  const units = new Map();
  for (const log of logs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    const from = unpad(log.topics[1]);
    const to = unpad(log.topics[2]);
    // Which side is the trader? Whichever side is not the curve. A log with the curve on neither
    // side is not ours (a filter that let one through would be a bug upstream), so it is ignored.
    const wallet = from === c ? to : to === c ? from : null;
    if (!wallet || skip.has(wallet)) continue;
    const amount = BigInt(log.data);
    units.set(wallet, (units.get(wallet) || 0n) + amount);
  }
  const scale = 10 ** decimals;
  const wallets = {};
  for (const wallet of Array.from(units.keys()).sort()) {
    const u = units.get(wallet);
    const tradedUsd = Number(u) / scale;
    // earnedUsd = tradedUsd * rebateBps / 10000, with the bps multiplication done on the integer
    // before the one division into floating point.
    const earnedUsd = Number(u * BigInt(rebateBps)) / 10000 / scale;
    wallets[wallet] = { tradedUsd, earnedUsd: Math.round(earnedUsd * 1e4) / 1e4 };
  }
  return wallets;
}

/** The contract shape with nothing in it: what the site and the API read before the launch. */
function emptyAllowances({ asOf, block = 0, rebateBps }) {
  return { asOf, block, coin: '', curve: '', rebateBps, wallets: {} };
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

/**
 * The block the coin was launched in — where the scan starts. The factory's TokenLaunched log
 * indexes the token, so one getLogs over the whole chain with the coin as topics[1] is a cheap
 * query for a node that will accept a wide range (the official endpoint does; the others refuse
 * older blocks or answer "busy"). If none of them will, the curve's own launchedAt() timestamp is
 * binary-searched against block timestamps instead: about 26 eth_getBlockByNumber calls, and no
 * range limits to argue with.
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
  const timestamp = async (n) => Number(BigInt((await rpc('eth_getBlockByNumber', [hex(n), false])).timestamp));
  let lo = 0, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await timestamp(mid) < at) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Every USDG Transfer with the curve on either side, from `fromBlock` to `toBlock` inclusive, in
 * chunks of at most CHUNK blocks. A topic filter is an AND across positions, so "from the curve" and
 * "to the curve" are two queries per chunk; a log that somehow matches both (the curve sending to
 * itself) is kept once, by block and index.
 */
async function scanTransfers({ rpc, usdg, curve, fromBlock, toBlock, chunk = CHUNK, pause = PAUSE_MS, onChunk = () => {} }) {
  const seen = new Set();
  const logs = [];
  let chunks = 0;
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    const range = { address: usdg, fromBlock: hex(from), toBlock: hex(to) };
    // Sequential on purpose: two requests in flight at once is exactly what the official endpoint
    // rate-limits.
    const outgoing = await rpc('eth_getLogs', [Object.assign({ topics: [TRANSFER, pad(curve)] }, range)]);
    const incoming = await rpc('eth_getLogs', [Object.assign({ topics: [TRANSFER, null, pad(curve)] }, range)]);
    for (const log of outgoing.concat(incoming)) {
      const key = `${log.blockNumber}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logs.push(log);
    }
    chunks++;
    onChunk({ from, to, count: logs.length });
    if (to < toBlock && pause) await sleep(pause);
  }
  return { logs, chunks };
}

// ---------------------------------------------------------------------------
// The run itself, with everything that touches the world (rpc, clock, disk) injectable.
// ---------------------------------------------------------------------------

/**
 * Build the ledger for `config` and write it to `out`. Returns { data, summary } so the test can
 * inspect what was written without parsing stdout. Throws with a plain message when the coin is
 * not something this script can index (unknown to the factory, or not paired with USDG).
 */
async function run({ config, addresses, rpc, out = DEFAULT_OUT, fromBlock, toBlock, now = () => Date.now(), log = () => {} }) {
  const rebateBps = Number(config.rebateBps);
  if (!(rebateBps >= 0 && rebateBps <= 10000)) throw new Error('esim.json needs a rebateBps between 0 and 10000');
  const asOf = Math.floor(now() / 1000);
  const rel = path.relative(process.cwd(), out);

  if (!config.coin) {
    // Not launched yet. The block number is a nicety here — it tells a reader when the empty file
    // was produced in chain time — so an unreachable RPC is not a reason to fail the run.
    let block = 0;
    try { block = Number(BigInt(await rpc('eth_blockNumber', []))); } catch (e) { log(`  eth_blockNumber unavailable (${e.message}); recording block 0`); }
    const data = emptyAllowances({ asOf, block, rebateBps });
    writeAllowances(out, data);
    const why = config.missing ? 'site/config/esim.json is not there yet' : 'no coin in site/config/esim.json yet';
    return { data, summary: `allowances: ${why} — wrote an empty ledger (block ${block}) to ${rel}` };
  }

  const coin = lower(config.coin);
  const usdg = lower(addresses.usdg);
  const decimals = Number(addresses.usdgDecimals || 6);
  const { factory, feeEscrow, memeHook } = addresses.pons;

  const launched = await launchedToken(rpc, factory, coin);
  if (!launched) throw new Error(`the factory ${factory} does not know ${coin}; is esim.json's coin right?`);
  if (launched.pair !== usdg) {
    const isNative = /^0x0{40}$/.test(launched.pair);
    throw new Error(`${coin} is paired with ${isNative ? 'native ether' : launched.pair}, not USDG. `
      + (isNative ? 'Ether moves without Transfer events, so there is nothing to index; ' : '')
      + 'v1 indexes USDG-paired coins only.');
  }
  const curve = config.curve ? lower(config.curve) : launched.curve;
  if (curve !== launched.curve) {
    throw new Error(`esim.json says the curve is ${curve} but the factory says ${launched.curve}; refusing to index the wrong one`);
  }

  const head = toBlock != null ? Number(toBlock) : Number(BigInt(await rpc('eth_blockNumber', [])));
  const start = fromBlock != null ? Number(fromBlock) : await launchBlock({ rpc, factory, coin, curve, head, log });
  if (start > head) throw new Error(`launch block ${start} is past the chain head ${head}`);

  const { logs, chunks } = await scanTransfers({
    rpc, usdg, curve, fromBlock: start, toBlock: head,
    onChunk: ({ from, to, count }) => log(`  blocks ${from}-${to}: ${count} transfers so far`),
  });
  const wallets = aggregate(logs, { curve, exclude: [feeEscrow, factory, memeHook], rebateBps, decimals });

  const data = { asOf, block: head, coin, curve, rebateBps, wallets };
  writeAllowances(out, data);

  const entries = Object.values(wallets);
  const usd = entries.reduce((s, w) => s + w.tradedUsd, 0);
  const earned = entries.reduce((s, w) => s + w.earnedUsd, 0);
  const summary = `allowances: ${coin} on curve ${curve}, blocks ${start}-${head} in ${chunks} chunk(s): `
    + `${logs.length} transfers, ${entries.length} wallet(s), $${usd.toFixed(2)} traded, $${earned.toFixed(4)} of data credit earned -> ${rel}`;
  return { data, summary };
}

module.exports = {
  aggregate,
  emptyAllowances,
  writeAllowances,
  loadConfig,
  makeRpc,
  launchedToken,
  launchBlock,
  scanTransfers,
  run,
  TRANSFER,
  LAUNCHED,
  CHUNK,
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
    fromBlock: arg('from-block'),
    toBlock: arg('to-block'),
    log: (m) => process.stderr.write(m + '\n'),
  })
    .then(({ summary }) => console.log(summary))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
