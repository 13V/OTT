#!/usr/bin/env node
'use strict';
/**
 * The claim keeper and the treasury monitor, offline.
 *
 * Both scripts have a pure core and a thin shell around chain.js; the core is what is tested. The
 * claim run is driven with a fake chain that records what it was asked to simulate and send, so the
 * two things that matter — that a wrong key is refused before any call, and that a claim shape
 * which reverts in simulation is never sent — are asserted rather than hoped.
 *
 *   node test/treasury.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require(path.join(__dirname, '..', 'scripts', 'claim.js'));
const T = require(path.join(__dirname, '..', 'scripts', 'treasury.js'));
const chainLib = require(path.join(__dirname, '..', 'scripts', 'chain.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const rejects = async (what, p, re) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};

const TREASURY = '0x3333333333333333333333333333333333333333';
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const addresses = { usdg: USDG, usdgDecimals: 6, pons: { feeEscrow: ESCROW } };
const config = {
  treasury: TREASURY,
  packages: [
    { code: 'EU-35_1_7', packageCode: 'P2CYMUS93', priceUsd: 0.62 },
    { code: 'GL-120_1_7', packageCode: 'PHS30M6EZ', priceUsd: 4.6 },
  ],
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-'));

/** A chain that holds `usd` and `eth` claimable and either accepts or reverts a given claim shape. */
function fakeChain({ usd = 0, eth = 0, revert = [] }) {
  const log = { simulated: [], sent: [] };
  return {
    log,
    encodeCall: chainLib.encodeCall,
    async call(to, sig) {
      if (sig === 'balanceOfToken(address,address)') return [BigInt(Math.round(usd * 1e6))];
      if (sig === 'balanceOf(address)') return [BigInt(Math.round(eth * 1e18))];
      throw new Error('unexpected call ' + sig);
    },
    async rpc(method, params) {
      if (method !== 'eth_call') throw new Error('unexpected rpc ' + method);
      const sel = params[0].data.slice(0, 10);
      log.simulated.push(sel);
      if (revert.includes(sel)) throw new Error('execution reverted');
      return '0x';
    },
    async send({ to, data }) {
      log.sent.push({ to, sel: data.slice(0, 10) });
      return { transactionHash: '0x' + 'ab'.repeat(32), status: '0x1' };
    },
  };
}
const SEL = {
  claimToken1: chainLib.selector('claimToken(address)'),
  claimToken2: chainLib.selector('claimToken(address,uint256)'),
  claim0: chainLib.selector('claim()'),
};

(async () => {
  console.log('claim: the plan');
  check('nothing above the floors is nothing to do', C.plan({ claimableUsd: 0.5, claimableEth: 0.0001 }), []);
  check('both above the floors is both', C.plan({ claimableUsd: 12, claimableEth: 0.5 }), [{ kind: 'usdg', amount: 12 }, { kind: 'eth', amount: 0.5 }]);
  check('floors are settable', C.plan({ claimableUsd: 3, claimableEth: 0, minUsd: 5 }), []);
  check('the log keeps the newest hundred', C.appendClaims(Array.from({ length: 120 }, (_, i) => ({ i })), [{ i: 'new' }]).length, 100);

  console.log('\nclaim: the run');
  await rejects('a key that is not the treasury is refused before any call', C.run({ chain: fakeChain({ usd: 50 }), config, addresses, treasury: '0x4444444444444444444444444444444444444444' }), /wrong wallet/);
  await rejects('no treasury configured is refused', C.run({ chain: fakeChain({ usd: 50 }), config: { treasury: '' }, addresses, treasury: TREASURY }), /no treasury/);

  let chain = fakeChain({ usd: 0.2, eth: 0 });
  let r = await C.run({ chain, config, addresses, treasury: TREASURY, out: path.join(tmp, 'c1.json') });
  check('twenty cents claimable sends nothing', [r.claimed, chain.log.sent], [[], []]);

  chain = fakeChain({ usd: 41.7, eth: 0 });
  r = await C.run({ chain, config, addresses, treasury: TREASURY, out: path.join(tmp, 'c2.json'), now: () => 1_800_000_000_000 });
  check('the one-argument claim is simulated first, then sent', [chain.log.simulated, chain.log.sent.map((s) => s.sel)], [[SEL.claimToken1], [SEL.claimToken1]]);
  check('and logged with its hash', JSON.parse(fs.readFileSync(path.join(tmp, 'c2.json'), 'utf8')), [{ at: 1800000000, kind: 'usdg', amount: 41.7, call: 'claimToken(address)', txHash: '0x' + 'ab'.repeat(32), dryRun: false }]);

  chain = fakeChain({ usd: 41.7, eth: 0, revert: [SEL.claimToken1] });
  r = await C.run({ chain, config, addresses, treasury: TREASURY, out: path.join(tmp, 'c3.json') });
  check('a shape that reverts in simulation is never sent; the next shape is', [chain.log.simulated, chain.log.sent.map((s) => s.sel)], [[SEL.claimToken1, SEL.claimToken2], [SEL.claimToken2]]);

  chain = fakeChain({ usd: 41.7, eth: 0, revert: [SEL.claimToken1, SEL.claimToken2] });
  await rejects('every shape reverting is an error, not a silent nothing', C.run({ chain, config, addresses, treasury: TREASURY, out: path.join(tmp, 'c4.json') }), /every claim shape reverts/);

  chain = fakeChain({ usd: 9, eth: 0.02 });
  r = await C.run({ chain, config, addresses, treasury: TREASURY, dryRun: true, out: path.join(tmp, 'c5.json') });
  check('a dry run simulates both and sends neither', [chain.log.simulated, chain.log.sent, r.claimed.map((c) => c.kind)], [[SEL.claimToken1, SEL.claim0], [], ['usdg', 'eth']]);
  check('and writes no log', fs.existsSync(path.join(tmp, 'c5.json')), false);

  console.log('\ntreasury: the arithmetic');
  const now = Date.parse('2026-09-14T12:00:00Z');
  const day = 86400 * 1000;
  const orders = [
    { packageCode: 'EU-35_1_7', createdAt: new Date(now - 2 * day).toISOString() },
    { packageCode: 'GL-120_1_7', createdAt: new Date(now - 10 * day).toISOString() },
    { packageCode: 'P2CYMUS93', createdAt: new Date(now - 29 * day).toISOString() },   // by packageCode, not slug
    { packageCode: 'EU-35_1_7', createdAt: new Date(now - 31 * day).toISOString() },   // outside the window
    { packageCode: 'GONE_1_7', createdAt: new Date(now - 1 * day).toISOString() },     // no longer in the catalogue
  ];
  check('thirty days of spend, at catalogue prices, dearest for the unknown', T.summarise({ orders, config, now }), { spendUsd: 10.44, count: 4, perDayUsd: 0.35, days: 30 });
  const paid = orders.map((o) => Object.assign({ paidUsd: 1.89 }, o));
  check('a record that says what was actually paid is counted at that', T.summarise({ orders: paid, config, now }), { spendUsd: 7.56, count: 4, perDayUsd: 0.25, days: 30 });
  check('runway is balance over the daily rate, in whole days', T.runway({ balanceUsd: 412, perDayUsd: 0.35 }), 1177);
  check('no spend means no rate and no runway, not infinity', T.runway({ balanceUsd: 412, perDayUsd: 0 }), null);
  check('status: no reading', T.statusOf({ balanceUsd: NaN, runwayDays: null }), 'unknown');
  check('status: nothing there', T.statusOf({ balanceUsd: 0, runwayDays: null }), 'empty');
  check('status: under the floor', T.statusOf({ balanceUsd: 20, runwayDays: 400 }), 'low');
  check('status: under two weeks', T.statusOf({ balanceUsd: 200, runwayDays: 9 }), 'low');
  check('status: fine', T.statusOf({ balanceUsd: 200, runwayDays: 90 }), 'funded');
  check('status: fine with no spend yet', T.statusOf({ balanceUsd: 200, runwayDays: null }), 'funded');
  // A pool can be comfortably full by every backward-looking measure and still be unable to pay
  // what this week has already promised — which is the shape a good week takes, not a bad one.
  check('status: full by the old measure, short of what this week promised',
    T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 4000 }), 'behind');
  check('status: enough of the promise covered to be getting on with',
    T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 300 }), 'funded');
  check('status: nothing promised yet is not behind',
    T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 0 }), 'funded');
  check('status: empty still beats behind', T.statusOf({ balanceUsd: 0, runwayDays: null, owedUsd: 4000 }), 'empty');

  console.log('\ntreasury: the run');
  const rpc = async (method, params) => {
    const sel = params[0].data.slice(0, 10);
    if (sel === chainLib.selector('balanceOfToken(address,address)')) return '0x' + (123_450000n).toString(16).padStart(64, '0');
    if (sel === chainLib.selector('balanceOf(address)')) return '0x' + (67_890000n).toString(16).padStart(64, '0');
    throw new Error('unexpected ' + sel);
  };
  const provider = { name: 'fake', async balanceUsd() { return 412; }, async listOrders() { return orders; } };
  const lightning = { name: 'nadanada', async balanceUsd() { return 412; }, async balance() { return { sats: 515000, usd: 412, usdPerSat: 0.0008 }; }, async listOrders() { return orders; } };
  const claims = [{ at: 1789300000, kind: 'usdg', amount: 41.7, txHash: '0xabc' }];
  r = await T.run({ rpc, config, addresses, provider, claims, now: () => now, out: path.join(tmp, 't1.json') });
  check('the file has every number the card needs', r.data, {
    asOf: Math.floor(now / 1000), treasury: TREASURY, escrowClaimableUsd: 123.45, walletUsd: 67.89,
    reseller: { name: 'fake', balanceUsd: 412, asOf: Math.floor(now / 1000) },
    spend30dUsd: 10.44, redemptions30d: 4, perDayUsd: 0.35, runwayDays: 1177,
    weekBudgetUsd: 0, weekRedeemedUsd: 0, owedUsd: 0,
    lastClaim: { at: 1789300000, kind: 'usdg', amount: 41.7, txHash: '0xabc' }, status: 'funded',
  });
  process.env.LN_PAYER = 'blink';
  r = await T.run({ rpc, config, addresses, provider: lightning, claims, now: () => now, out: path.join(tmp, 't1b.json') });
  check('a Lightning-paid provider also writes the sats and the wallet', r.data.reseller, { name: 'nadanada', balanceUsd: 412, asOf: Math.floor(now / 1000), sats: 515000, wallet: 'blink' });
  r = await T.run({ rpc, config, addresses, provider: null, claims: [], now: () => now, out: path.join(tmp, 't2.json') });
  check('without a provider the reseller side is null and the status unknown', [r.data.reseller, r.data.status, r.data.escrowClaimableUsd], [null, 'unknown', 123.45]);
  const broken = { name: 'fake', async balanceUsd() { throw new Error('HTTP 503'); } };
  r = await T.run({ rpc, config, addresses, provider: broken, claims: [], now: () => now, out: path.join(tmp, 't3.json') });
  check('a reseller that cannot answer is recorded as such, not thrown', [r.data.reseller.balanceUsd, r.data.reseller.error, r.data.status], [null, 'HTTP 503', 'unknown']);
  r = await T.run({ rpc: async () => { throw new Error('no route'); }, config, addresses, provider, claims: [], now: () => now, out: path.join(tmp, 't4.json') });
  check('a chain that cannot answer leaves nulls and keeps the reseller reading', [r.data.escrowClaimableUsd, r.data.walletUsd, r.data.reseller.balanceUsd], [null, null, 412]);

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
