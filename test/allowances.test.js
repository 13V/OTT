#!/usr/bin/env node
'use strict';
/**
 * scripts/allowances.js, without the chain.
 *
 * The ledger it writes decides who gets free data, so the arithmetic is checked here against logs
 * whose answer is known by hand: buys, sells, a wallet on both sides, the escrow sweep that must not
 * count, and the rounding. The scan itself runs against a fake node that honours topic filters and
 * block ranges and refuses a chunk wider than the real endpoints will, so the chunking logic is
 * exercised rather than assumed. The empty-coin path writes to a temp dir, because that is the
 * file every consumer reads until the launch.
 *
 *   node test/allowances.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require(path.join(__dirname, '..', 'scripts', 'allowances.js'));
const chain = require(path.join(__dirname, '..', 'scripts', 'chain.js'));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${what}`);
}
function checkThat(what, cond, detail) {
  if (!cond) { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
  else console.log(`  ok   ${what}`);
}
async function rejects(what, promise, pattern) {
  try { await promise; failures++; console.error(`  FAIL ${what}\n       resolved instead of throwing`); }
  catch (e) { checkThat(what, pattern.test(e.message), e.message); }
}

// Addresses are made up but well-formed; the aggregate never looks past their shape.
const CURVE = '0xC4eed34C4fA1690Cf7206906e9A19cE076Aa3254';   // mixed case on purpose: keys must come out lowercase
const COIN = '0x1fefc04bcb777c615b887297168c57e67a2c8192';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const ALICE = '0xe9f89a769f234f6cc75e1c1c6b1fd9963d72c652';
const BOB = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const CAROL = '0xe33e9e479df8802cb0866d5d05258bec4cf62948';

const usdg = (n) => '0x' + BigInt(Math.round(n * 1e6)).toString(16).padStart(64, '0');
/** An eth_getLogs entry for USDG.Transfer(from, to, amount), as a node would return it. */
let logIndex = 0;
const transfer = (from, to, amountUsd, block = 100) => ({
  address: USDG.toLowerCase(),
  topics: [A.TRANSFER, A.pad(from), A.pad(to)],
  data: usdg(amountUsd),
  blockNumber: '0x' + block.toString(16),
  logIndex: '0x' + (logIndex++).toString(16),
});
const terms = { curve: CURVE, exclude: [ESCROW, FACTORY, HOOK], rebateBps: 800 };

console.log('aggregate() folds transfers into gross volume and banked gigabytes');
const logs = [
  transfer(ALICE, CURVE, 100),          // alice buys $100
  transfer(CURVE, BOB, 30),             // bob sells for $30
  transfer(CURVE, ESCROW, 6.5),         // the curve sweeps creator tax to escrow — not a trade
  transfer(ALICE, CURVE, 50),           // alice buys again
  transfer(CURVE, ALICE, 25),           // and sells some: volume is gross, so this adds
  transfer(FACTORY, CURVE, 1000),       // the factory seeding or graduating — not a trade
  transfer(CURVE, HOOK, 1000),          // nor the hook
  transfer(CAROL, CURVE, 0.002503),     // a dust buy from the launch tx itself
];
const wallets = A.aggregate(logs, terms);
check('one row per trader, lowercase, sorted, and no row for the escrow, factory or hook',
  Object.keys(wallets), [BOB, CAROL, ALICE].sort());
check('a wallet on both sides is credited for what it bought plus what it sold', wallets[ALICE].tradedUsd, 175);
check('$175 at 8% is $14 of credit', wallets[ALICE].earnedUsd, 14);
check('a seller earns on the USDG it received', wallets[BOB], { tradedUsd: 30, earnedUsd: 2.4 });
check('dust is kept at the token\'s precision and rounded to four decimals of data',
  wallets[CAROL], { tradedUsd: 0.002503, earnedUsd: 0.0002 });

console.log('\nthe edges of the arithmetic');
check('rounding is to four decimals, half up', A.aggregate([transfer(BOB, CURVE, 12.345678)], terms)[BOB].earnedUsd, 0.9877);
check('a rebate of zero banks nothing but still records the volume',
  A.aggregate([transfer(BOB, CURVE, 10)], Object.assign({}, terms, { rebateBps: 0 }))[BOB], { tradedUsd: 10, earnedUsd: 0 });
check('a transfer between two strangers is not the curve\'s business', A.aggregate([transfer(ALICE, BOB, 10)], terms), {});
check('the curve sending to itself is not a trader', A.aggregate([transfer(CURVE, CURVE, 10)], terms), {});
check('no logs is an empty ledger, not a crash', A.aggregate([], terms), {});
// Many small trades: summed as integers, so the float is formed once. 0.1 added a thousand times
// in floating point is not 100.
const many = Array.from({ length: 1000 }, () => transfer(BOB, CURVE, 0.1));
check('a thousand ten-cent trades are exactly $100', A.aggregate(many, terms)[BOB], { tradedUsd: 100, earnedUsd: 8 });

console.log('\nemptyAllowances() is the contract shape with nothing in it');
check('shape', A.emptyAllowances({ asOf: 1700000000, block: 42, rebateBps: 800 }),
  { asOf: 1700000000, block: 42, coin: '', curve: '', rebateBps: 800, wallets: {} });

// ---------------------------------------------------------------------------
// A fake node: enough of eth_call / eth_getLogs / eth_blockNumber to run the real scan against.
// ---------------------------------------------------------------------------
const addresses = { usdg: USDG, usdgDecimals: 6, pons: { factory: FACTORY, feeEscrow: ESCROW, memeHook: HOOK } };
const GET_LAUNCHED = chain.selector('getLaunchedToken(address)');
const wordOf = (v) => (typeof v === 'string' ? A.pad(v).slice(2) : BigInt(v).toString(16).padStart(64, '0'));
/** getLaunchedToken's fifteen words for a coin the factory knows. */
const launchedRow = (pair) => '0x' + [COIN, CURVE, ALICE, ALICE, pair, 500000000000n, 0, 200, 1000, 0, 0, 0, 0, 0, 1].map(wordOf).join('');
const launchLog = (block) => ({
  address: FACTORY, topics: [A.LAUNCHED, A.pad(COIN), A.pad(CURVE), A.pad(ALICE)],
  data: '0x' + [USDG, 0, 500000000000n].map(wordOf).join(''), blockNumber: '0x' + block.toString(16), logIndex: '0x0',
});

// Block timestamps on the fake chain: one every ten seconds from an epoch, so a launchedAt() of
// T0 + 10 * n is unambiguously block n.
const T0 = 1789390000;
const LAUNCHED_AT = chain.selector('launchedAt()');

/** Enough of a node to run the scan against. `archive` is whether it will answer a getLogs over the
 *  whole chain, which the official endpoint does and the others do not; the chunk limit applies to
 *  every USDG query regardless, as it does on every real endpoint. */
function fakeNode({ head, pair = USDG, launchBlock = 5, transfers = [], factoryKnows = true, archive = true }) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(params[0]));
      return { number: params[0], timestamp: '0x' + (T0 + 10 * n).toString(16) };
    }
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (to.toLowerCase() === FACTORY && data.startsWith(GET_LAUNCHED)) return factoryKnows ? launchedRow(pair) : '0x' + '0'.repeat(15 * 64);
      if (to.toLowerCase() === CURVE.toLowerCase() && data.startsWith(LAUNCHED_AT)) return '0x' + wordOf(T0 + 10 * launchBlock);
      throw new Error(`fake node: unexpected eth_call ${to} ${data.slice(0, 10)}`);
    }
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      const wide = to - from + 1 > A.CHUNK;
      if (wide && !(archive && f.address.toLowerCase() === FACTORY)) throw new Error(`fake node: range ${from}-${to} is wider than ${A.CHUNK} blocks`);
      const pool = f.address.toLowerCase() === FACTORY ? [launchLog(launchBlock)] : transfers;
      return pool.filter((log) => {
        const b = Number(BigInt(log.blockNumber));
        if (b < from || b > to) return false;
        return f.topics.every((t, i) => t == null || (log.topics[i] || '').toLowerCase() === t.toLowerCase());
      });
    }
    throw new Error(`fake node: unexpected ${method}`);
  };
  return { rpc, calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allowances-'));
const readBack = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  console.log('\nrun() with no coin writes a valid empty ledger and does not need the chain to be up');
  const out1 = path.join(tmp, 'empty', 'allowances.json');
  const node = fakeNode({ head: 777 });
  const r1 = await A.run({ config: { coin: '', curve: '', rebateBps: 800 }, addresses, rpc: node.rpc, out: out1, now: () => 1700000000123 });
  check('the file on disk is the empty contract shape', readBack(out1),
    { asOf: 1700000000, block: 777, coin: '', curve: '', rebateBps: 800, wallets: {} });
  check('what run() returns is what it wrote', r1.data, readBack(out1));
  checkThat('the summary says so in one line', /empty ledger/.test(r1.summary) && !/\n/.test(r1.summary), r1.summary);
  checkThat('the file ends with a newline', fs.readFileSync(out1, 'utf8').endsWith('}\n'));

  const out2 = path.join(tmp, 'offline.json');
  const r2 = await A.run({ config: { coin: '', rebateBps: 800 }, addresses, rpc: async () => { throw new Error('no route to host'); }, out: out2 });
  check('with no RPC reachable the block is 0 and the file is still written', readBack(out2).block, 0);
  checkThat('asOf defaults to now, in seconds', Math.abs(r2.data.asOf - Date.now() / 1000) < 5, String(r2.data.asOf));

  const out3 = path.join(tmp, 'noconfig.json');
  const r3 = await A.run({ config: A.loadConfig(path.join(tmp, 'does-not-exist.json')), addresses, rpc: node.rpc, out: out3 });
  check('a missing esim.json is treated as "not launched yet" with the default terms', [r3.data.coin, r3.data.rebateBps], ['', 800]);

  console.log('\nrun() with a coin scans from the launch block in chunks and writes the ledger');
  const head = 25000;
  const transfers = [
    transfer(CAROL, CURVE, 0.5, 5),          // in the launch block itself
    transfer(ALICE, CURVE, 100, 9000),
    transfer(CURVE, ESCROW, 6.5, 9001),      // excluded
    transfer(CURVE, BOB, 30, 12000),         // second chunk
    transfer(ALICE, CURVE, 50, 24999),       // last chunk, last block
    transfer(ALICE, CURVE, 1e6, 25001),      // past the head: must not be seen
    transfer(ALICE, CURVE, 1e6, 2),          // before the launch: must not be seen
  ];
  const live = fakeNode({ head, transfers });
  const out4 = path.join(tmp, 'live.json');
  const r4 = await A.run({ config: { coin: COIN, curve: '', rebateBps: 800 }, addresses, rpc: live.rpc, out: out4, now: () => 1700000000000 });
  check('the curve is resolved from the factory when esim.json leaves it empty', r4.data.curve, CURVE.toLowerCase());
  check('the ledger', readBack(out4), {
    asOf: 1700000000, block: head, coin: COIN, curve: CURVE.toLowerCase(), rebateBps: 800,
    wallets: { [BOB]: { tradedUsd: 30, earnedUsd: 2.4 }, [CAROL]: { tradedUsd: 0.5, earnedUsd: 0.04 }, [ALICE]: { tradedUsd: 150, earnedUsd: 12 } },
  });
  const ranges = live.calls.filter((c) => c.method === 'eth_getLogs' && c.params[0].address.toLowerCase() === USDG.toLowerCase())
    .map((c) => [Number(BigInt(c.params[0].fromBlock)), Number(BigInt(c.params[0].toBlock))]);
  check('blocks 5..25000 are covered in three chunks of at most 10,000, two queries each',
    ranges, [[5, 10004], [5, 10004], [10005, 20004], [10005, 20004], [20005, 25000], [20005, 25000]]);
  checkThat('the summary is one line naming the coin and the count', !/\n/.test(r4.summary) && r4.summary.includes(COIN) && /3 wallet/.test(r4.summary), r4.summary);

  console.log('\nwhen no endpoint will answer a whole-chain getLogs, the launch block comes from launchedAt()');
  const noArchive = fakeNode({ head, transfers, archive: false });
  const notes = [];
  const r4b = await A.run({ config: { coin: COIN, rebateBps: 800 }, addresses, rpc: noArchive.rpc, out: path.join(tmp, 'noarchive.json'), now: () => 1700000000000, log: (m) => notes.push(m) });
  check('the same ledger comes out', r4b.data, r4.data);
  checkThat('launchedAt() was consulted', noArchive.calls.some((c) => c.method === 'eth_call' && c.params[0].data.startsWith(LAUNCHED_AT)));
  const blockReads = noArchive.calls.filter((c) => c.method === 'eth_getBlockByNumber').length;
  checkThat('by a binary search over block timestamps, not a linear walk', blockReads > 0 && blockReads <= 20, `${blockReads} block reads for a ${head}-block chain`);
  checkThat('and the fallback was announced', notes.some((m) => /launchedAt/.test(m)), notes.join(' | '));

  console.log('\nrun() refuses what it cannot index rather than write a ledger that lies');
  await rejects('a coin the factory does not know', A.run({ config: { coin: COIN, rebateBps: 800 }, addresses, rpc: fakeNode({ head, factoryKnows: false }).rpc, out: path.join(tmp, 'x.json') }), /does not know/);
  await rejects('a native-ether pair has no Transfer events', A.run({ config: { coin: COIN, rebateBps: 800 }, addresses, rpc: fakeNode({ head, pair: '0x' + '0'.repeat(40) }).rpc, out: path.join(tmp, 'x.json') }), /native ether.*USDG/);
  await rejects('a coin paired with some other token', A.run({ config: { coin: COIN, rebateBps: 800 }, addresses, rpc: fakeNode({ head, pair: HOOK }).rpc, out: path.join(tmp, 'x.json') }), /not USDG/);
  await rejects('a curve in esim.json that disagrees with the factory', A.run({ config: { coin: COIN, curve: BOB, rebateBps: 800 }, addresses, rpc: fakeNode({ head }).rpc, out: path.join(tmp, 'x.json') }), /factory says/);
  await rejects('terms that make no sense', A.run({ config: { coin: '', rebateBps: 20000 }, addresses, rpc: node.rpc, out: path.join(tmp, 'x.json') }), /rebateBps/);
  checkThat('nothing was written for any refused run', !fs.existsSync(path.join(tmp, 'x.json')));

  console.log('\n--from-block skips the launch lookup');
  const explicit = fakeNode({ head, transfers });
  const r5 = await A.run({ config: { coin: COIN, rebateBps: 800 }, addresses, rpc: explicit.rpc, out: path.join(tmp, 'from.json'), fromBlock: '9000', toBlock: '12000' });
  checkThat('no TokenLaunched query was made', !explicit.calls.some((c) => c.method === 'eth_getLogs' && c.params[0].address.toLowerCase() === FACTORY));
  check('only the window asked for is counted', r5.data.wallets, { [BOB]: { tradedUsd: 30, earnedUsd: 2.4 }, [ALICE]: { tradedUsd: 100, earnedUsd: 8 } });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
