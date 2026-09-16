#!/usr/bin/env node
'use strict';
/**
 * The funding keeper, offline. FixedFloat and Across are node:http fakes that speak their wire
 * shapes (FixedFloat checks the HMAC signature the way the real one does); Blink is the mock payer;
 * the chain is a double that records what it was asked to simulate and send. What is asserted is
 * the order of operations and every place the run must stop: a wrong key, a wallet that is already
 * funded, a treasury too poor to bother, a rate that does not match, an order that asks for more
 * than was quoted, a bridge that would deliver short — and that on the happy path the deposit goes
 * to FixedFloat's address for exactly the USDC it asked, and the log ends with the sats landed.
 *
 *   node test/fund.test.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require(path.join(__dirname, '..', 'scripts', 'fund.js'));
const chainLib = require(path.join(__dirname, '..', 'scripts', 'chain.js'));
const mockPayer = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'payers', 'mock.js'));

const T0 = Date.now();
let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };
const rejects = async (what, p, re) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};

const TREASURY = '0x3333333333333333333333333333333333333333';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const FF_ADDRESS = '0x9999999999999999999999999999999999999999';
const addresses = { chainId: 4663, usdg: USDG, usdgDecimals: 6 };
const config = { treasury: TREASURY };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-'));

// --------------------------------------------------------------------------- fakes
const FF_KEY = 'ff-key', FF_SECRET = 'ff-secret';
const ff = { rate: 0.0008, askFactor: 1.0, statuses: ['PENDING', 'EXCHANGE', 'DONE'], orders: new Map(), log: [] };
const ffServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (j) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    const sign = crypto.createHmac('sha256', FF_SECRET).update(body).digest('hex');
    if (req.headers['x-api-key'] !== FF_KEY || req.headers['x-api-sign'] !== sign) return reply({ code: 501, msg: 'Not have permission', data: null });
    const b = JSON.parse(body);
    ff.log.push({ path: req.url, body: b });
    if (req.url === '/price') {
      // ff.rate is dollars per sat: $amount buys amount/rate sats.
      const btc = b.direction === 'from' ? (Number(b.amount) / ff.rate) / 1e8 : Number(b.amount);
      return reply({ code: 0, msg: 'OK', data: { from: { code: b.fromCcy, amount: String(b.amount) }, to: { code: b.toCcy, amount: btc.toFixed(8) } } });
    }
    if (req.url === '/create') {
      if (b.direction !== 'to' || b.type !== 'fixed' || !/^lnbc/.test(b.toAddress)) return reply({ code: 301, msg: 'Invalid address', data: null });
      const sats = Math.round(Number(b.amount) * 1e8);
      const ask = sats * ff.rate * ff.askFactor;
      const id = 'FF' + String(ff.orders.size + 1).padStart(4, '0');
      const order = { id, token: 'tok-' + id, type: 'fixed', status: 'NEW', polls: 0, from: { code: 'USDCBASE', amount: ask.toFixed(2), address: FF_ADDRESS }, to: { code: 'BTCLN', amount: (sats / 1e8).toFixed(8), address: b.toAddress }, time: { expiration: Math.floor(Date.now() / 1000) + 1800 } };
      ff.orders.set(id, order);
      return reply({ code: 0, msg: 'OK', data: order });
    }
    if (req.url === '/order') {
      const o = ff.orders.get(b.id);
      if (!o || o.token !== b.token) return reply({ code: 401, msg: 'Order not found', data: null });
      o.status = ff.statuses[Math.min(o.polls, ff.statuses.length - 1)];
      o.polls++;
      if (o.status === 'DONE') mockPayer._markPaid(mockPayer._state.invoices[mockPayer._state.invoices.length - 1].paymentHash);
      return reply({ code: 0, msg: 'OK', data: o });
    }
    reply({ code: 404, msg: 'no such method', data: null });
  });
});

const bridge = { feeFactor: 1.003, shortFactor: 1.0, log: [] };
const acrossServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams.entries());
  bridge.log.push(q);
  res.setHeader('content-type', 'application/json');
  if (url.pathname !== '/swap/approval') { res.statusCode = 404; return res.end(JSON.stringify({ message: 'nope' })); }
  const outUnits = BigInt(q.amount);
  const inUnits = (outUnits * BigInt(Math.round(bridge.feeFactor * 1e6))) / 1000000n;
  const minOut = (outUnits * BigInt(Math.round(bridge.shortFactor * 1e6))) / 1000000n;
  const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  res.end(JSON.stringify({
    amountType: q.tradeType, inputAmount: inUnits.toString(), maxInputAmount: inUnits.toString(), expectedOutputAmount: outUnits.toString(), minOutputAmount: minOut.toString(),
    approvalTxns: [{ chainId: 4663, to: USDG, data: '0x095ea7b3' + word('0xd29c85f15df544ba632c9e25829fd29d767d7978') + 'f'.repeat(64) }],
    swapTx: { ecosystem: 'evm', chainId: 4663, to: '0xD29C85F15DF544bA632C9E25829fd29d767d7978', data: '0xad5425c6' + word(q.depositor) + word(q.recipient) + word(USDG) + word(q.outputToken) + word('0x' + inUnits.toString(16)) + word('0x' + outUnits.toString(16)), value: '0' },
    quoteExpiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
  }));
});

/** A chain holding `usd` USDG for the treasury, recording simulations and sends. */
function fakeChain({ usd }) {
  const log = { simulated: [], sent: [] };
  return {
    log,
    encodeCall: chainLib.encodeCall,
    async call(to, sig) { if (sig === 'balanceOf(address)') return [BigInt(Math.round(usd * 1e6))]; throw new Error('unexpected call ' + sig); },
    async rpc(method, params) { if (method !== 'eth_call') throw new Error('unexpected rpc ' + method); log.simulated.push(params[0]); return '0x'; },
    async send({ to, data, value }) { log.sent.push({ to, sel: data.slice(0, 10), data, value: value === undefined ? null : String(value) }); return { transactionHash: '0x' + String(log.sent.length).padStart(64, '0'), status: '0x1' }; },
  };
}

(async () => {
  await new Promise((r) => ffServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => acrossServer.listen(0, '127.0.0.1', r));
  const ffClient = F.fixedFloat({ key: FF_KEY, secret: FF_SECRET, api: 'http://127.0.0.1:' + ffServer.address().port });
  const bridgeClient = F.across({ api: 'http://127.0.0.1:' + acrossServer.address().port });
  const base = (over) => Object.assign({ chain: fakeChain({ usd: 500 }), config, addresses, treasury: TREASURY, payer: mockPayer, ff: ffClient, bridge: bridgeClient, waitMs: 2000, pollMs: 20, out: path.join(tmp, 'funding.json') }, over);

  console.log('the plan');
  check('a pool at target is nothing to do', F.plan({ walletUsd: 500, poolUsd: 95 }).amountUsd, 0);
  check('a pool under target is filled from the treasury, capped', F.plan({ walletUsd: 500, poolUsd: 10 }).amountUsd, 90);
  check('a poor treasury moves what it has', F.plan({ walletUsd: 35.5, poolUsd: 0 }).amountUsd, 35.5);
  check('under the floor moves nothing', F.plan({ walletUsd: 12, poolUsd: 0 }).amountUsd, 0);
  check('never more than the cap', F.plan({ walletUsd: 5000, poolUsd: 0, targetUsd: 1000 }).amountUsd, 200);
  check('the log keeps the newest hundred', F.appendLog(Array.from({ length: 120 }, (_, i) => ({ i })), { i: 'new' }).length, 100);

  console.log('\nrefusals before anything moves');
  mockPayer._reset(); mockPayer._state.sats = 0;
  await rejects('a key that is not the treasury is refused', F.run(base({ treasury: '0x4444444444444444444444444444444444444444' })), /wrong wallet/);
  await rejects('no treasury configured is refused', F.run(base({ config: { treasury: '' } })), /no treasury/);
  mockPayer._state.sats = 200000;   // $160 at $0.0008/sat
  let r = await F.run(base({}));
  check('a pool over target moves nothing', [r.action, /pool holds \$160\.00/.test(r.reason)], ['none', true]);
  mockPayer._state.sats = 0;
  r = await F.run(base({ chain: fakeChain({ usd: 7 }) }));
  check('a treasury under the floor moves nothing', [r.action, /treasury holds \$7\.00/.test(r.reason)], ['none', true]);
  ff.rate = 0.0008 * 1.3;   // FixedFloat says a dollar buys 30% more sats than Blink's price implies
  let chain = fakeChain({ usd: 500 });
  await rejects('a FixedFloat rate 30% off the wallet\'s price is refused', F.run(base({ chain })), /rate is off/);
  check('with no invoice, no order and no transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.sent.length], [0, 0, 0]);
  ff.rate = 0.0008;

  console.log('\na dry run');
  chain = fakeChain({ usd: 500 });
  r = await F.run(base({ chain, dryRun: true }));
  check('prices the move and stops', [r.action, r.amountUsd, r.sats], ['plan', 100, 125000]);
  check('with no invoice, no order and no transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.sent.length], [0, 0, 0]);
  check('and no log', fs.existsSync(path.join(tmp, 'funding.json')), false);

  console.log('\nthe order asks for more than was quoted');
  ff.askFactor = 1.05;
  chain = fakeChain({ usd: 500 });
  await rejects('5% over is refused and the order left to expire', F.run(base({ chain })), /asks \$105\.00 USDC/);
  check('after the invoice and the order, before any transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.sent.length], [1, 1, 0]);
  ff.askFactor = 1.0;

  console.log('\nthe bridge would deliver short');
  bridge.shortFactor = 0.99;
  chain = fakeChain({ usd: 500 });
  await rejects('a min output under the ask is refused', F.run(base({ chain })), /would deliver/);
  check('before any transaction', chain.log.sent.length, 0);
  bridge.shortFactor = 1.0;
  bridge.feeFactor = 1.05;
  chain = fakeChain({ usd: 500 });
  await rejects('a bridge fee over the tolerance is refused', F.run(base({ chain })), /more than 2% over/);
  bridge.feeFactor = 1.003;

  console.log('\nthe whole way through');
  mockPayer._reset(); mockPayer._state.sats = 0; ff.log.length = 0; bridge.log.length = 0;
  chain = fakeChain({ usd: 500 });
  const logLines = [];
  const t = 1_800_000_000_000;
  r = await F.run(base({ chain, now: () => t, log: (m) => logLines.push(m) }));
  check('the result: $100 moved as 125,000 sats, done', [r.action, r.amountUsd, r.sats, r.status], ['funded', 100, 125000, 'done']);
  const inv = mockPayer._state.invoices[0];
  check('one invoice on the pool\'s wallet for the sats, with a memo', [mockPayer._state.invoices.length, inv.sats, inv.memo, inv.status], [1, 125000, 'OT+T data pool top-up', 'PAID']);
  const created = ff.log.find((l) => l.path === '/create').body;
  check('the FixedFloat order is fixed-rate, USDC on Base to Lightning, for that many sats, paying that invoice', [created.type, created.fromCcy, created.toCcy, created.direction, created.amount, created.toAddress === inv.paymentRequest], ['fixed', 'USDCBASE', 'BTCLN', 'to', '0.00125000', true]);
  const q = bridge.log[0];
  check('the bridge quote asks for exactly the USDC FixedFloat wants, delivered to its address', [q.tradeType, q.amount, q.recipient, q.depositor, q.originChainId, q.destinationChainId, q.outputToken], ['exactOutput', '100000000', FF_ADDRESS, TREASURY, '4663', '8453', F.USDC_BASE]);
  check('approval then deposit, in that order', chain.log.sent.map((s) => s.sel), ['0x095ea7b3', '0xad5425c6']);
  check('the deposit was simulated from the treasury first', [chain.log.simulated.length, chain.log.simulated[0].from, chain.log.simulated[0].to], [1, TREASURY, '0xD29C85F15DF544bA632C9E25829fd29d767d7978']);
  checkThat('and carries FixedFloat\'s address as the recipient', chain.log.sent[1].data.includes(FF_ADDRESS.slice(2)), chain.log.sent[1].data);
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8'));
  check('the log has the one entry, complete', [written.length, written[0].amountUsd, written[0].usdcSent, written[0].usdgIn, written[0].sats, written[0].fixedFloatOrder, written[0].invoiceHash === inv.paymentHash, written[0].depositTx, written[0].status, written[0].at, written[0].finishedAt],
    [1, 100, 100, 100.3, 125000, 'FF' + String(ff.orders.size).padStart(4, '0'), true, '0x' + '2'.padStart(64, '0'), 'done', 1800000000, 1800000000]);
  check('FixedFloat was polled until DONE', ff.log.filter((l) => l.path === '/order').length, 3);

  console.log('\nan order that goes wrong after the deposit');
  ff.statuses = ['PENDING', 'EMERGENCY'];
  mockPayer._state.sats = 0;
  chain = fakeChain({ usd: 500 });
  await rejects('EMERGENCY is an error naming the order and the deposit', F.run(base({ chain, now: () => t })), /EMERGENCY.*needs a hand/);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8'));
  check('and is recorded as such', [after.length, after[1].status, after[1].depositTx], [2, 'emergency', '0x' + '2'.padStart(64, '0')]);
  ff.statuses = ['PENDING'];
  chain = fakeChain({ usd: 500 });
  let clock = t;   // a clock that moves, or the deadline never comes
  r = await F.run(base({ chain, now: () => (clock += 30000), waitMs: 60000, pollMs: 5 }));
  check('a slow order is recorded as sent, not failed', [r.action, r.status, r.entry.lastSeen], ['funded', 'sent', 'PENDING']);

  ffServer.close(); acrossServer.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
