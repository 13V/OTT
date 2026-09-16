#!/usr/bin/env node
'use strict';
/**
 * scripts/allowances.js, without the chain.
 *
 * The ledger this writes decides who gets free data, so every piece of arithmetic is checked here
 * against fixtures whose answer is known by hand: the week boundaries, balances folded from mints,
 * burns and a wallet that empties itself, circulating supply excluding the operational addresses,
 * shares, and the tax window that must land on exactly last week and nowhere else. The scan itself
 * runs against a fake node that honours topic filters and block ranges and refuses a chunk wider
 * than the real endpoints will, so the chunking logic is exercised rather than assumed. The
 * unlaunched-coin path writes to a temp dir, because that is the file every consumer reads until
 * the launch.
 *
 *   node test/allowances.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require(path.join(__dirname, '..', 'scripts', 'allowances.js'));
const chain = require(path.join(__dirname, '..', 'scripts', 'chain.js'));

let failures = 0;
let total = 0;
function check(what, got, want) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${what}`);
}
function checkThat(what, cond, detail) {
  total++;
  if (!cond) { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
  else console.log(`  ok   ${what}`);
}
async function rejects(what, promise, pattern) {
  try { await promise; total++; failures++; console.error(`  FAIL ${what}\n       resolved instead of throwing`); }
  catch (e) { checkThat(what, pattern.test(e.message), e.message); }
}
const lower = (a) => String(a).toLowerCase();
/** A foldBalances() Map has BigInt values, which JSON.stringify refuses outright — turn it into a
 *  plain { addr: "digits" } object so check() can compare it like anything else. */
const balancesToObj = (map) => { const o = {}; for (const [k, v] of map) o[k] = v.toString(); return o; };

// Addresses are made up but well-formed; the code never looks past their shape. The four Pons
// addresses and USDG are the real ones from site/config/addresses.json, so a reader who knows this
// repo recognizes them; the wallets (and the made-up treasury) are hashed out so their hex is
// guaranteed valid without hand-counting characters.
const addr = (seed) => '0x' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
const CURVE = '0xC4eed34C4fA1690Cf7206906e9A19cE076Aa3254';   // mixed case on purpose: keys must come out lowercase
const COIN = '0x1fefc04bcb777c615b887297168c57e67a2c8192';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const TREASURY = addr('treasury');
const ALICE = '0xe9f89a769f234f6cc75e1c1c6b1fd9963d72c652';
const BOB = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const CAROL = '0xe33e9e479df8802cb0866d5d05258bec4cf62948';
const DAVE = addr('dave');
const ZERO = '0x0000000000000000000000000000000000000000';

let logIndex = 0;
/** An eth_getLogs entry for Transfer(from, to, amount) in raw base units, as a node would return
 *  it. Base units rather than a human amount, so a fixture's numbers are exactly the "tokens"
 *  string the output is expected to contain — no decimals scaling to keep straight by hand. */
const xfer = (from, to, amountBaseUnits, block) => ({
  topics: [A.TRANSFER, A.pad(from), A.pad(to)],
  data: '0x' + BigInt(amountBaseUnits).toString(16).padStart(64, '0'),
  blockNumber: '0x' + block.toString(16),
  logIndex: '0x' + (logIndex++).toString(16),
});
/** Same, but for a USDG transfer, where the fixture amount is dollars and USDG is 6 decimals. */
const usdgXfer = (from, to, amountUsd, block) => xfer(from, to, BigInt(Math.round(amountUsd * 1e6)), block);

console.log('weekOf/weekStart/weekEnd — the arithmetic every file in the contract shares');
checkThat('weekStart(0) is exactly Monday 5 Jan 1970 00:00 UTC',
  new Date(A.weekStart(0) * 1000).toISOString() === '1970-01-05T00:00:00.000Z');
for (const w of [0, 1, 2960, 123456]) {
  const d = new Date(A.weekStart(w) * 1000);
  checkThat(`weekStart(${w}) falls on a Monday at 00:00:00 UTC`,
    d.getUTCDay() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0, d.toISOString());
  check(`weekOf(weekStart(${w})) === ${w}`, A.weekOf(A.weekStart(w)), w);
  check(`weekOf(weekEnd(${w}) - 1) === ${w}: the last second of a week is still that week`, A.weekOf(A.weekEnd(w) - 1), w);
  check(`weekEnd(${w}) === weekStart(${w + 1}): weeks are contiguous`, A.weekEnd(w), A.weekStart(w + 1));
}
checkThat('weekOf(weekStart(w)) is false for the wrong week, so the check above is not vacuous',
  A.weekOf(A.weekStart(5)) !== 6);

console.log('\nfoldBalances() folds Transfer logs into balances: credit to, debit from');
{
  const logs = [
    xfer(ZERO, ALICE, 1000, 1),   // mint
    xfer(ALICE, BOB, 300, 2),     // ordinary transfer
    xfer(BOB, ZERO, 100, 3),      // burn
    xfer(ALICE, CAROL, 700, 4),   // alice sends the rest away (alice nets to exactly 0)
    xfer(CAROL, BOB, 700, 5),     // carol, who just received it, sends all of it away again
  ];
  const balances = A.foldBalances(logs);
  check('bob is the only wallet left standing: 300 - 100 (burn) + 700 = 900',
    balancesToObj(balances), { [lower(BOB)]: '900' });
  checkThat('alice and carol each received tokens and later sent all of them away, and are absent, not present at zero',
    !balances.has(lower(ALICE)) && !balances.has(lower(CAROL)));
  checkThat('the zero address itself never appears as a balance key', !balances.has(ZERO));
}
check('a mint alone credits only the recipient', balancesToObj(A.foldBalances([xfer(ZERO, ALICE, 500, 1)])), { [lower(ALICE)]: '500' });
check('a mint immediately followed by a full burn nets to nothing, and leaves no entry',
  balancesToObj(A.foldBalances([xfer(ZERO, ALICE, 500, 1), xfer(ALICE, ZERO, 500, 2)])), {});
check('no logs is an empty map, not a crash', balancesToObj(A.foldBalances([])), {});

console.log('\nbuildWallets() computes circulating supply, shares and allowances from a balance map');
{
  const balances = new Map([
    [lower(ALICE), 600n], [lower(BOB), 400n],
    [lower(CURVE), 9000n], [lower(ESCROW), 500n], [lower(FACTORY), 10n], [lower(HOOK), 20n], [lower(TREASURY), 300n],
  ]);
  const exclude = [CURVE, ESCROW, FACTORY, HOOK, TREASURY];
  const r = A.buildWallets({ balances, exclude, budgetUsd: 1000 });
  check('circulating is only the public balances (600 + 400), none of the five operational ones', r.circulating.toString(), '1000');
  check('holders counts only the public wallets', r.holders, 2);
  checkThat('none of the curve, escrow, factory, hook or treasury has a wallets entry, even though each holds tokens',
    [CURVE, ESCROW, FACTORY, HOOK, TREASURY].every((a) => !(lower(a) in r.wallets)));
  // Key order matters to this comparison (check() does a plain JSON.stringify), and that is used
  // deliberately here: bob (0x650…) sorts before alice (0xe9f…), so listing bob first also proves
  // the wallets object comes back sorted rather than in balance-map insertion order.
  check('the public wallets get tokens, share and allowanceUsd, sorted by address', r.wallets, {
    [lower(BOB)]: { tokens: '400', share: 0.4, allowanceUsd: 400 },
    [lower(ALICE)]: { tokens: '600', share: 0.6, allowanceUsd: 600 },
  });
  checkThat('shares across the public holders sum to 1, within floating-point tolerance',
    Math.abs(Object.values(r.wallets).reduce((s, w) => s + w.share, 0) - 1) < 1e-9);
}
{
  const r = A.buildWallets({ balances: new Map([[lower(ALICE), 12345n]]), exclude: [], budgetUsd: 250 });
  check('a single holder has a share of exactly 1', r.wallets[lower(ALICE)].share, 1);
  check('and gets the entire budget', r.wallets[lower(ALICE)].allowanceUsd, 250);
}
{
  const r = A.buildWallets({ balances: new Map(), exclude: [CURVE], budgetUsd: 500 });
  checkThat('an empty balance map is 0 circulating, not a crash', r.circulating === 0n);
  check('and an empty wallets object', r.wallets, {});
  check('and 0 holders', r.holders, 0);
}

console.log('\nsumTaxUsd() adds up a set of USDG transfer logs at 6 decimals');
check('two transfers sum to their dollar total', A.sumTaxUsd([usdgXfer(CURVE, ESCROW, 100, 1), usdgXfer(CURVE, ESCROW, 0.5, 2)]), 100.5);
check('no logs is $0', A.sumTaxUsd([]), 0);

console.log('\nemptyAllowances() is the contract shape with nothing in it');
check('shape', A.emptyAllowances({ asOf: 1700000000, block: 42, week: 100 }), {
  asOf: 1700000000, block: 42, week: 100,
  weekStart: A.weekStart(100), weekEnd: A.weekEnd(100),
  snapshotBlock: 0, coin: '', curve: '',
  budgetUsd: 0, budgetSource: 'the coin is not launched yet',
  circulating: '0', decimals: 18, holders: 0,
  wallets: {},
});

// ---------------------------------------------------------------------------
// A fake node: enough of eth_call / eth_getLogs / eth_blockNumber / eth_getBlockByNumber to run
// the real scan and binary searches against.
//
// Blocks are one hour apart (BLOCK_S) starting at the contract's own week epoch (A.ANCHOR), so a
// week is exactly WEEK_BLOCKS blocks and a week boundary lands exactly on a block number — which
// is what lets the tests below assert the snapshot and tax-window block numbers precisely instead
// of just trusting whatever the binary search returns.
// ---------------------------------------------------------------------------
const BLOCK_S = 3600;
const T0 = A.ANCHOR;
const WEEK_BLOCKS = A.WEEK_S / BLOCK_S; // 168
const blockOfWeek = (w) => w * WEEK_BLOCKS;

const addresses = { usdg: USDG, usdgDecimals: 6, pons: { factory: FACTORY, feeEscrow: ESCROW, memeHook: HOOK } };
const GET_LAUNCHED = chain.selector('getLaunchedToken(address)');
const LAUNCHED_AT = chain.selector('launchedAt()');
const DECIMALS_SEL = chain.selector('decimals()');
const SUPPLY_SEL = chain.selector('totalSupply()');
const wordOf = (v) => (typeof v === 'string' ? A.pad(v).slice(2) : BigInt(v).toString(16).padStart(64, '0'));
/** getLaunchedToken's fifteen words for a coin the factory knows. */
const launchedRow = (pair) => '0x' + [COIN, CURVE, ALICE, ALICE, pair, 500000000000n, 0, 200, 1000, 0, 0, 0, 0, 0, 1].map(wordOf).join('');
const launchLog = (block) => ({
  address: FACTORY, topics: [A.LAUNCHED, A.pad(COIN), A.pad(CURVE), A.pad(ALICE)],
  data: '0x' + [USDG, 0, 500000000000n].map(wordOf).join(''), blockNumber: '0x' + block.toString(16), logIndex: '0x0',
});

/** Enough of a node to run run() against. `archive` is whether it will answer a getLogs over the
 *  whole chain for the factory's TokenLaunched log, which the official endpoint does and the
 *  others do not; the CHUNK limit applies to every other query regardless, as it does on every
 *  real endpoint. */
function fakeNode({ head, launchBlockNum = 900, pair = USDG, coinDecimals = 9, coinTransfers = [], taxTransfers = [], factoryKnows = true, archive = true, totalSupply = 'from-transfers' }) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(params[0]));
      return { number: params[0], timestamp: '0x' + (T0 + BLOCK_S * n).toString(16) };
    }
    if (method === 'eth_call') {
      const { to, data } = params[0];
      const toL = to.toLowerCase();
      if (toL === FACTORY && data.startsWith(GET_LAUNCHED)) return factoryKnows ? launchedRow(pair) : '0x' + '0'.repeat(15 * 64);
      if (toL === CURVE.toLowerCase() && data.startsWith(LAUNCHED_AT)) return '0x' + wordOf(T0 + BLOCK_S * launchBlockNum);
      if (toL === COIN.toLowerCase() && data.startsWith(DECIMALS_SEL)) return '0x' + wordOf(coinDecimals);
      // The coin's own account of how much of it exists: mints less burns, unless a test says
      // otherwise. 'silent' stands for a node that will not answer the call at all.
      if (toL === COIN.toLowerCase() && data.startsWith(SUPPLY_SEL)) {
        if (totalSupply === 'silent') throw new Error('fake node: totalSupply() not supported here');
        if (totalSupply !== 'from-transfers') return '0x' + BigInt(totalSupply).toString(16).padStart(64, '0');
        let supply = 0n;
        for (const l of coinTransfers) {
          const from = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
          if (from === ZERO) supply += BigInt(l.data);
          if (to === ZERO) supply -= BigInt(l.data);
        }
        return '0x' + supply.toString(16).padStart(64, '0');
      }
      throw new Error(`fake node: unexpected eth_call ${to} ${data.slice(0, 10)}`);
    }
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      const wide = to - from + 1 > A.CHUNK;
      if (wide && !(archive && f.address.toLowerCase() === FACTORY)) throw new Error(`fake node: range ${from}-${to} is wider than ${A.CHUNK}`);
      const addrL = f.address.toLowerCase();
      const pool = addrL === FACTORY ? [launchLog(launchBlockNum)]
        : addrL === COIN.toLowerCase() ? coinTransfers
        : addrL === USDG.toLowerCase() ? taxTransfers
        : [];
      return pool.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        if (b < from || b > to) return false;
        return f.topics.every((t, i) => t == null || (l.topics[i] || '').toLowerCase() === t.toLowerCase());
      });
    }
    throw new Error(`fake node: unexpected ${method}`);
  };
  return { rpc, calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allowances-'));
const readBack = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  console.log('\nscanTransfers() chunks a wide range at CHUNK and de-dupes an overlapping answer');
  {
    const pool = [xfer(ALICE, BOB, 1, 5), xfer(ALICE, BOB, 2, 10005), xfer(ALICE, BOB, 3, 20005)];
    const ranges = [];
    const chunkRpc = async (method, params) => {
      if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      if (to - from + 1 > A.CHUNK) throw new Error(`range ${from}-${to} is wider than CHUNK`);
      ranges.push([from, to]);
      const found = pool.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to; });
      return found.concat(found); // answer every log twice, so de-dupe has something to do
    };
    const { logs, chunks } = await A.scanTransfers({ rpc: chunkRpc, address: USDG, topics: [A.TRANSFER], fromBlock: 0, toBlock: 25000, pause: 0, chunk: 10000 });
    check('a 25,001-block range at a 10,000 span takes three chunks', chunks, 3);
    check('the duplicated answer de-dupes down to one copy of each log', logs.length, 3);
    checkThat('no chunk asked for more than the span it was given', ranges.every(([f, t]) => t - f + 1 <= 10000), JSON.stringify(ranges));
  }

  // This chain makes a block every tenth of a second, so a week is about six million blocks and a
  // fixed narrow chunk turns one week's scan into six hundred requests — slow enough that the
  // scheduled job does not finish. The window therefore starts wide and only narrows when an
  // endpoint actually complains, which is the behaviour these three checks pin down.
  console.log('\nscanTransfers() adapts its window to what the endpoint will serve');
  {
    check('the default span is a million blocks, not ten thousand', [A.CHUNK, A.MAX_CHUNK, A.MIN_CHUNK], [1000000, 1000000, 10000]);
    const spans = [];
    // An endpoint that refuses anything wider than 250,000 the way a real one does.
    const fussy = async (method, params) => {
      const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
      const span = to - from + 1;
      spans.push(span);
      if (span > 250000) throw new Error('log query timed out');
      return [];
    };
    const r = await A.scanTransfers({ rpc: fussy, address: USDG, topics: [A.TRANSFER], fromBlock: 0, toBlock: 2000000, pause: 0 });
    checkThat('it halves until the endpoint accepts the range', spans.slice(0, 3).join(',') === '1000000,500000,250000', spans.slice(0, 5).join(','));
    // Every window it *chooses* is at or above the floor; the one short range at the end is simply
    // what was left of the span, which is not the scan narrowing.
    const chosen = spans.slice(0, -1);
    checkThat('and never chooses a window below the floor', chosen.every((n) => n >= A.MIN_CHUNK), spans.join(','));
    checkThat('the last request is just the remainder of the range', spans[spans.length - 1] <= 250000, spans.join(','));
    checkThat('it covers the whole range exactly once', r.chunks >= 8, 'chunks=' + r.chunks);

    // The two refusals these endpoints actually send, captured verbatim on 16 Sep 2026. The first
    // is a result-count cap rather than a range cap, which is the one that would otherwise slip
    // past a regex written only for ranges and crash the scan instead of narrowing it.
    for (const msg of ['logs matched by query exceeds limit of 10000', 'log query timed out']) {
      const seen = [];
      const capped = async (method, params) => {
        const span = Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1;
        seen.push(span);
        if (span > 100000) throw new Error(msg);
        return [];
      };
      await A.scanTransfers({ rpc: capped, address: USDG, topics: [A.TRANSFER], fromBlock: 0, toBlock: 300000, pause: 0 });
      checkThat('"' + msg + '" narrows the window instead of throwing', seen.some((n) => n <= 100000), seen.join(','));
    }

    // A real error is not a range complaint and must not be swallowed by narrowing forever.
    let threw = null;
    try {
      await A.scanTransfers({ rpc: async () => { throw new Error('execution reverted'); }, address: USDG, topics: [A.TRANSFER], fromBlock: 0, toBlock: 100, pause: 0 });
    } catch (e) { threw = e.message; }
    check('an error that is not about the range is rethrown, not retried smaller', threw, 'execution reverted');
  }

  console.log('\nrun() with no coin writes a valid empty ledger for the current week, and does not need the chain to be up');
  const NOW_S = 1700000000;
  const NOW_WEEK = A.weekOf(NOW_S);
  const idle = fakeNode({ head: 777 });

  const out1 = path.join(tmp, 'empty', 'allowances.json');
  const r1 = await A.run({ config: { coin: '', curve: '', treasury: '' }, addresses, rpc: idle.rpc, out: out1, now: () => NOW_S * 1000 });
  check('the file on disk is the contract-shaped empty ledger for the current week',
    readBack(out1), A.emptyAllowances({ asOf: NOW_S, block: 777, week: NOW_WEEK }));
  check('what run() returns is what it wrote', r1.data, readBack(out1));
  checkThat('the summary says so in one line', /empty ledger/.test(r1.summary) && !/\n/.test(r1.summary), r1.summary);
  checkThat('the file ends with a newline', fs.readFileSync(out1, 'utf8').endsWith('}\n'));

  const out2 = path.join(tmp, 'offline.json');
  const r2 = await A.run({ config: { coin: '' }, addresses, rpc: async () => { throw new Error('no route to host'); }, out: out2 });
  check('with no RPC reachable the block is 0 and the file is still written', readBack(out2).block, 0);
  checkThat('asOf defaults to now, in seconds', Math.abs(r2.data.asOf - Date.now() / 1000) < 5, String(r2.data.asOf));

  const out3 = path.join(tmp, 'noconfig.json');
  const r3 = await A.run({ config: A.loadConfig(path.join(tmp, 'does-not-exist.json')), addresses, rpc: idle.rpc, out: out3, now: () => NOW_S * 1000 });
  check('a missing esim.json is treated as "not launched yet"', r3.data.coin, '');

  console.log('\nrun() with a coin: balances at the week-9 snapshot, and week 9\'s tax as the week-10 budget');
  // Launch at block 900 (mid week 5). Target week 10 starts at block 1680 and ends at 1848; last
  // week (9) is blocks [1512, 1680); the week before that (8) is [1344, 1512). The chain head sits
  // at 1750 — inside week 10, as if the indexer were run partway through it.
  const HEAD = 1750;
  const coinTransfers = [
    xfer(ZERO, ALICE, 1000, 950),      // mint
    xfer(ZERO, CURVE, 5000, 960),      // the curve's own bonding-curve inventory
    xfer(ZERO, CAROL, 500, 970),
    xfer(ZERO, TREASURY, 400, 980),
    xfer(ALICE, BOB, 400, 1100),
    xfer(CAROL, ZERO, 500, 1200),      // carol burns everything she has
    xfer(ALICE, DAVE, 300, 1300),
    xfer(DAVE, BOB, 300, 1400),        // dave immediately sends it all on to bob
    xfer(ZERO, ALICE, 777, 800),       // before the launch block (900): must never be seen
    xfer(ALICE, BOB, 999999, 1690),    // after the snapshot block (1680): must never be seen
  ];
  const taxTransfers = [
    usdgXfer(CURVE, ESCROW, 100, 1600),    // in week 9: this is the only one that should count
    usdgXfer(CURVE, ESCROW, 99999, 1680),  // exactly week 10's first block (the current week): excluded
    usdgXfer(CURVE, ESCROW, 88888, 1500),  // in week 8 (the week before last): excluded
    usdgXfer(CURVE, BOB, 77, 1650),        // curve money moving, but not to the escrow: excluded regardless of week
  ];
  const mainNode = fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers });
  const outMain = path.join(tmp, 'main.json');
  const rMain = await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: mainNode.rpc, out: outMain, week: 10, now: () => 1700000000000 });

  check('decimals is read from the token\'s decimals(), not assumed to be 18', rMain.data.decimals, 9);
  check('week/weekStart/weekEnd', [rMain.data.week, rMain.data.weekStart, rMain.data.weekEnd], [10, A.weekStart(10), A.weekEnd(10)]);
  check('snapshotBlock is the last block at or before week 10\'s start', rMain.data.snapshotBlock, blockOfWeek(10));
  check('block is the chain head at run time', rMain.data.block, HEAD);
  check('circulating is only alice (300) + bob (700) = 1000, not the curve\'s 5000 or the treasury\'s 400', rMain.data.circulating, '1000');
  check('holders counts only the public wallets', rMain.data.holders, 2);
  check('alice and bob are the only wallets with an allowance', Object.keys(rMain.data.wallets).sort(), [lower(ALICE), lower(BOB)].sort());
  check('alice: 300 tokens, 30% share, $30 of the $100 budget', rMain.data.wallets[lower(ALICE)], { tokens: '300', share: 0.3, allowanceUsd: 30 });
  check('bob: 700 tokens, 70% share, $70 of the $100 budget', rMain.data.wallets[lower(BOB)], { tokens: '700', share: 0.7, allowanceUsd: 70 });
  checkThat('the curve and the treasury hold real balances on chain but neither has a wallets entry',
    !(lower(CURVE) in rMain.data.wallets) && !(lower(TREASURY) in rMain.data.wallets));
  checkThat('carol and dave both emptied themselves and are absent, not present at zero',
    !(lower(CAROL) in rMain.data.wallets) && !(lower(DAVE) in rMain.data.wallets));
  check('the budget is exactly week 9\'s $100 — the current week\'s $99999, the week-before-last\'s $88888, '
    + 'and the curve\'s non-escrow $77 are all excluded', rMain.data.budgetUsd, 100);
  check('budgetSource names the week the tax came from', rMain.data.budgetSource, 'tax collected in week 9');

  const rangesFor = (node, address) => node.calls
    .filter((c) => c.method === 'eth_getLogs' && c.params[0].address.toLowerCase() === lower(address))
    .map((c) => [Number(BigInt(c.params[0].fromBlock)), Number(BigInt(c.params[0].toBlock))]);
  checkThat('the balance scan runs from the launch block through the snapshot block, inclusive on both ends',
    JSON.stringify(rangesFor(mainNode, COIN)) === JSON.stringify([[900, blockOfWeek(10)]]), JSON.stringify(rangesFor(mainNode, COIN)));
  checkThat('the tax scan covers exactly week 9\'s blocks and nothing from week 8 or week 10',
    JSON.stringify(rangesFor(mainNode, USDG)) === JSON.stringify([[blockOfWeek(9), blockOfWeek(10) - 1]]), JSON.stringify(rangesFor(mainNode, USDG)));

  console.log('\nbudgetBps holds back a reserve');
  const bpsNode = fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers });
  const rBps = await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY, budgetBps: 5000 }, addresses, rpc: bpsNode.rpc, out: path.join(tmp, 'bps.json'), week: 10, now: () => 1700000000000 });
  check('5000 bps halves the $100 tax to a $50 budget', rBps.data.budgetUsd, 50);
  check('and halves every wallet\'s allowanceUsd along with it', [rBps.data.wallets[lower(ALICE)].allowanceUsd, rBps.data.wallets[lower(BOB)].allowanceUsd], [15, 35]);
  await rejects('a budgetBps outside 0-10000 makes no sense',
    A.run({ config: { coin: COIN, budgetBps: 20000 }, addresses, rpc: fakeNode({ head: HEAD }).rpc, out: path.join(tmp, 'badbps.json'), week: 10 }), /budgetBps/);

  console.log('\na zero-tax week produces a valid file with every allowance at 0, not a crash or a NaN');
  const zeroTaxNode = fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers: [] });
  const rZero = await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: zeroTaxNode.rpc, out: path.join(tmp, 'zerotax.json'), week: 10, now: () => 1700000000000 });
  check('budgetUsd is 0', rZero.data.budgetUsd, 0);
  check('shares are unchanged — the wallets still hold their coin, they just have nothing to spend this week',
    [rZero.data.wallets[lower(ALICE)].share, rZero.data.wallets[lower(BOB)].share], [0.3, 0.7]);
  check('every allowanceUsd is exactly 0', [rZero.data.wallets[lower(ALICE)].allowanceUsd, rZero.data.wallets[lower(BOB)].allowanceUsd], [0, 0]);
  checkThat('and neither is NaN', !Number.isNaN(rZero.data.wallets[lower(ALICE)].allowanceUsd) && !Number.isNaN(rZero.data.wallets[lower(BOB)].allowanceUsd));

  console.log('\nrun() over the same inputs twice produces byte-identical files');
  const outA = path.join(tmp, 'repeat-a.json');
  const outB = path.join(tmp, 'repeat-b.json');
  await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers }).rpc, out: outA, week: 10, now: () => 1700000000000 });
  await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers }).rpc, out: outB, week: 10, now: () => 1700000000000 });
  check('the two runs\' files are byte-identical', fs.readFileSync(outA, 'utf8'), fs.readFileSync(outB, 'utf8'));

  console.log('\n--from-block and --to-block still work: they skip the launch lookup and pin the head');
  const explicitNode = fakeNode({ head: 999999, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers });
  const rExplicit = await A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: explicitNode.rpc, out: path.join(tmp, 'explicit.json'), week: 10, fromBlock: '900', toBlock: String(HEAD) });
  check('the same wallets come out when the launch block and head are given explicitly', rExplicit.data.wallets, rMain.data.wallets);
  checkThat('no TokenLaunched log lookup was needed since --from-block was given',
    !explicitNode.calls.some((c) => c.method === 'eth_getLogs' && c.params[0].address.toLowerCase() === lower(FACTORY)));
  checkThat('no eth_blockNumber call was needed since --to-block was given',
    !explicitNode.calls.some((c) => c.method === 'eth_blockNumber'));
  check('block is pinned to --to-block (999999 was on the node but never asked for)', rExplicit.data.block, HEAD);

  // An endpoint can answer eth_getLogs with a short list and HTTP 200 — no error for the retry
  // loop to catch, nothing for the chunk-width heuristic to notice. The tell is arithmetic: a
  // token can only be sent by someone who received it, so an address folding to a negative
  // balance proves a Transfer INTO it was never seen. That matters far past the one wallet,
  // because a negative balance is summed into `circulating` like any other and shrinks the
  // denominator every share is divided by — one missing log would inflate every OTHER holder's
  // allowance, in a file that otherwise looks entirely reasonable.
  console.log('\na scan that came back short is caught by the arithmetic, not trusted');
  const missedMint = [
    xfer(ZERO, ALICE, 1000, 950),
    xfer(ALICE, BOB, 400, 1100),
    xfer(BOB, CAROL, 900, 1200),   // bob only ever received 400: his mint of 500 was not in the answer
  ];
  await rejects('a fold with a negative balance is refused rather than published',
    A.run({ config: { coin: COIN, curve: '', treasury: TREASURY }, addresses, rpc: fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers: missedMint, taxTransfers }).rpc, out: path.join(tmp, 'short.json'), week: 10, now: () => 1700000000000 }),
    /negative balance/);
  check('and nothing was written', fs.existsSync(path.join(tmp, 'short.json')), false);

  console.log('\nrun() still refuses what it cannot index rather than write a ledger that lies');
  await rejects('a coin the factory does not know',
    A.run({ config: { coin: COIN }, addresses, rpc: fakeNode({ head: HEAD, factoryKnows: false }).rpc, out: path.join(tmp, 'x1.json'), week: 10 }), /does not know/);
  await rejects('a curve in esim.json that disagrees with the factory',
    A.run({ config: { coin: COIN, curve: BOB }, addresses, rpc: fakeNode({ head: HEAD }).rpc, out: path.join(tmp, 'x2.json'), week: 10 }), /factory says/);
  await rejects('a native-ether pair has no Transfer events to sum a tax sweep from',
    A.run({ config: { coin: COIN }, addresses, rpc: fakeNode({ head: HEAD, pair: '0x' + '0'.repeat(40) }).rpc, out: path.join(tmp, 'x3.json'), week: 10 }), /native ether/);

  // A coin with no curve beside it indexes fine — the factory knows the curve. The SITE does not:
  // redeem.js and status.js both read "launched" as coin AND curve, so this half-filled state
  // publishes a real ledger that nobody is allowed to spend. run() has to say so, and say which
  // address is missing, because from the outside it looks like everything worked.
  console.log('\ncoin filled in, curve left blank: the ledger is real but the site is still shut');
  const half = await A.run({ config: { coin: COIN, treasury: TREASURY }, addresses, rpc: fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers }).rpc, out: path.join(tmp, 'half.json'), week: 10, now: () => 1700000000000 });
  check('run() flags it rather than reporting a clean run', half.curveMissing, true);
  checkThat('the summary names the curve to paste and says the site is still closed',
    /still closed/.test(half.summary) && half.summary.includes(CURVE.toLowerCase()), half.summary);
  check('and the ledger it wrote is a real one, with the curve the factory gave it', [half.data.curve, half.data.holders > 0], [CURVE.toLowerCase(), true]);
  const whole = await A.run({ config: { coin: COIN, curve: CURVE, treasury: TREASURY }, addresses, rpc: fakeNode({ head: HEAD, launchBlockNum: 900, coinDecimals: 9, coinTransfers, taxTransfers }).rpc, out: path.join(tmp, 'whole.json'), week: 10, now: () => 1700000000000 });
  check('with the curve filled in, nothing is flagged and the ledger is identical', [!!whole.curveMissing, whole.data.curve], [false, CURVE.toLowerCase()]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${total} check(s) failed` : `\nall ${total} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
