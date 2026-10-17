#!/usr/bin/env node
'use strict';
/**
 * The funding keeper (scripts/fund.js), offline. FixedFloat is a node:http fake that speaks its
 * wire shapes (and checks the HMAC signature the way the real one does); Blink is the mock payer;
 * the Solana RPC is a fake behind the real scripts/solana-chain.js, so the transfer is really
 * built and signed. What is asserted is the order of operations and every place the run must
 * stop: a wrong key, a pool already funded, a treasury too poor to bother once its SOL keep-back is
 * set aside, a rate that does not match, an order that asks for more than was quoted or pays into
 * anything but a plain Solana address, a transfer that fails simulation — and that on the happy
 * path exactly what FixedFloat asked goes to its address, the journal names the transfer before it
 * is broadcast, and the log ends with the sats landed.
 *
 *   node test/fund.test.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require(path.join(__dirname, '..', 'scripts', 'fund.js'));
const C = require(path.join(__dirname, '..', 'scripts', 'solana-chain.js'));
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const mockPayer = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'payers', 'mock.js'));

let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
const check = (what, got, want) => {
  checks++;
  const ok = norm(got) === norm(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };
const rejects = async (what, p, re) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};

const newKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return C.keypairFromSecret(S.encodeBase58(new Uint8Array(Buffer.concat([seed, pub]))));
};
const KEY = newKey();
const TREASURY = KEY.address;
const FF_DEPOSIT = newKey().address;
const config = { treasury: TREASURY };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-'));
const SOL_USD = 100;

// --------------------------------------------------------------------------- FixedFloat
const FF_KEY = 'ff-key', FF_SECRET = 'ff-secret';
// rate: dollars per sat at FixedFloat; solUsd: its idea of SOL's price. With both matching the
// wallet's ($0.0008 a sat) and the market's ($100), a dollar of SOL buys 1,250 sats.
const ff = { rate: 0.0008, solUsd: SOL_USD, askFactor: 1.0, from: {}, statuses: ['PENDING', 'EXCHANGE', 'DONE'], orders: new Map(), log: [] };
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
      const btc = b.direction === 'from' ? (Number(b.amount) * ff.solUsd / ff.rate) / 1e8 : Number(b.amount);
      return reply({ code: 0, msg: 'OK', data: { from: { code: b.fromCcy, amount: Number(b.amount) }, to: { code: b.toCcy, amount: Number(btc.toFixed(8)) } } });
    }
    if (req.url === '/create') {
      if (b.direction !== 'to' || b.type !== 'fixed' || !/^lnbc/.test(b.toAddress)) return reply({ code: 301, msg: 'Invalid address', data: null });
      const sats = Math.round(Number(b.amount) * 1e8);
      const askSol = (sats * ff.rate / ff.solUsd) * ff.askFactor;
      const id = 'FF' + String(ff.orders.size + 1).padStart(4, '0');
      const order = { id, token: 'tok-' + id, type: 'fixed', status: 'NEW', polls: 0,
        from: Object.assign({ code: 'SOL', coin: 'SOL', network: 'SOL', amount: askSol.toFixed(8), address: FF_DEPOSIT, tag: null }, ff.from),
        to: { code: 'BTCLN', amount: (sats / 1e8).toFixed(8), address: b.toAddress }, time: { expiration: Math.floor(Date.now() / 1000) + 1800 } };
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

// --------------------------------------------------------------------------- the chain
/** A fake RPC: the treasury holds `lamports`; simulations, sends and confirmations are recorded. */
function fakeRpc({ lamports, simulateErr = null, confirm = 'confirmed', onSend = null, landed = null } = {}) {
  const log = { simulated: [], sent: [], calls: [] };
  const rpc = async (method, params) => {
    log.calls.push(method);
    switch (method) {
      case 'getBalance': return { value: lamports };
      case 'getLatestBlockhash': return { value: { blockhash: S.encodeBase58(new Uint8Array(32).fill(3)), lastValidBlockHeight: 500 } };
      case 'simulateTransaction': log.simulated.push(params); return { value: simulateErr ? { err: simulateErr, logs: ['Program log: insufficient lamports'] } : { err: null, unitsConsumed: 450, logs: [] } };
      case 'sendTransaction': { if (onSend) onSend(params); log.sent.push(params[0]); return S.encodeBase58(S.decodeBase64(params[0]).subarray(1, 65)); }
      case 'getSignatureStatuses': return { value: [confirm === 'failed' ? { err: { InstructionError: [1, 'x'] } } : confirm === 'pending' ? null : { confirmationStatus: 'confirmed', err: null }] };
      case 'getTransaction': return landed === 'ok' ? { meta: { err: null } } : landed === 'failed' ? { meta: { err: { InstructionError: [1, 'x'] } } } : null;
      case 'getBlockHeight': return 10;
      default: throw new Error('unexpected rpc ' + method);
    }
  };
  return { rpc, log };
}
/** The instructions of a sent legacy transaction: [{ program, accounts, data }]. */
function decodeSent(wire64) {
  const bytes = S.decodeBase64(wire64);
  const message = bytes.subarray(1 + 64);
  const { value: keyCount, next } = S.readCompactLength(message, 3);
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(S.encodeBase58(message.subarray(next + i * 32, next + (i + 1) * 32)));
  let at = next + keyCount * 32 + 32;
  const { value: ixCount, next: n2 } = S.readCompactLength(message, at);
  at = n2;
  const out = [];
  for (let i = 0; i < ixCount; i++) {
    const program = keys[message[at++]];
    const { value: accCount, next: n3 } = S.readCompactLength(message, at); at = n3;
    const accounts = Array.from(message.subarray(at, at + accCount)).map((k) => keys[k]); at += accCount;
    const { value: dataLen, next: n4 } = S.readCompactLength(message, at); at = n4;
    out.push({ program, accounts, data: Array.from(message.subarray(at, at + dataLen)) }); at += dataLen;
  }
  return out;
}
const SOL = (n) => Math.round(n * 1e9);

(async () => {
  await new Promise((r) => ffServer.listen(0, '127.0.0.1', r));
  const ffClient = F.fixedFloat({ key: FF_KEY, secret: FF_SECRET, api: 'http://127.0.0.1:' + ffServer.address().port });
  const base = (over) => Object.assign({ rpc: fakeRpc({ lamports: SOL(5) }).rpc, chain: C, config, key: KEY, payer: mockPayer, ff: ffClient,
    solUsd: async () => SOL_USD, waitMs: 2000, pollMs: 20, confirmOptions: { pollMs: 1 }, out: path.join(tmp, 'funding.json'), treasuryPath: path.join(tmp, 'none.json') }, over);

  console.log('the plan');
  check('a pool at target is nothing to do', F.plan({ walletUsd: 500, poolUsd: 95 }).amountUsd, 0);
  check('a pool under target is filled from the treasury, capped', F.plan({ walletUsd: 500, poolUsd: 10 }).amountUsd, 90);
  check('a poor treasury moves what it has', F.plan({ walletUsd: 35.5, poolUsd: 0 }).amountUsd, 35.5);
  check('under the floor moves nothing', F.plan({ walletUsd: 12, poolUsd: 0 }).amountUsd, 0);
  check('never more than the cap in one run', F.plan({ walletUsd: 5000, poolUsd: 0, targetUsd: 1000 }).amountUsd, 500);
  // The target follows what the week has actually promised.
  const owed = (o, over) => F.plan(Object.assign({ walletUsd: 5000, poolUsd: 0, owedUsd: o }, over));
  check('nothing promised: the flat floor still applies', owed(0).targetUsd, 100);
  check('less promised than the floor: still the floor', owed(40).targetUsd, 100);
  check('more promised than the floor: aim at the promise', owed(420).targetUsd, 420);
  check('and move toward it, within one run\'s cap', owed(420).amountUsd, 420);
  check('a promise past the ceiling is held there on purpose', owed(9000).targetUsd, 1000);
  checkThat('and the reason says it was the ceiling that stopped it', /ceiling/.test(owed(9000).reason), owed(9000).reason);
  check('a big promise still moves only one run\'s worth', owed(9000).amountUsd, 500);
  checkThat('and says it is short, and why', /short of the aim this run, capped per run/.test(owed(9000).reason), owed(9000).reason);
  checkThat('a treasury too poor to cover the promise says that instead',
    /short of the aim this run, all the treasury has/.test(owed(900, { walletUsd: 300 }).reason), owed(900, { walletUsd: 300 }).reason);
  check('an unknown promise is the flat target, not a promise of nothing', [owed(null).targetUsd, /promised/.test(owed(null).reason)], [100, false]);
  check('an unreadable treasury file falls back to the flat target', [F.owedFrom(null), F.owedFrom({}), F.owedFrom({ owedUsd: null }), F.owedFrom({ owedUsd: 12.5 })], [null, null, null, 12.5]);
  // Welcome eSIMs come out of the same pool, so with membership on the aim leaves room for them.
  check('a welcome reserve is added to what the week owes', owed(420, { reserveUsd: 20 }).targetUsd, 440);
  check('it can lift a week just under the floor above it', owed(90, { reserveUsd: 20 }).targetUsd, 110);
  check('the floor still applies when owed plus reserve is under it', owed(40, { reserveUsd: 20 }).targetUsd, 100);
  check('the ceiling still holds with a reserve', owed(995, { reserveUsd: 20 }).targetUsd, 1000);
  checkThat('the reason names the reserve', /plus a \$20\.00 welcome reserve/.test(owed(420, { reserveUsd: 20 }).reason), owed(420, { reserveUsd: 20 }).reason);
  check('the reserve is five welcome eSIMs at the dearest welcome price',
    [F.welcomeReserveFor({ membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: '', capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } } }), F.welcomeReserveFor({})], [20, 0]);
  check('the log keeps the newest hundred', F.appendLog(Array.from({ length: 120 }, (_, i) => ({ i })), { i: 'new' }).length, 100);
  check('SOL for dollars, to the microSOL, never rounded up', [F.solFor(100, 100), F.solFor(10, 104.17)], [1, 0.095996]);

  console.log('\nchecking FixedFloat\'s order');
  const order = (from) => ({ id: 'FF1', from: Object.assign({ code: 'SOL', network: 'SOL', amount: '1.00000000', address: FF_DEPOSIT, tag: null }, from) });
  check('a plain Solana deposit within tolerance', F.checkOrder(order({}), { quotedSol: 1, treasury: TREASURY }), { to: FF_DEPOSIT, lamports: 1000000000n, ask: 1 });
  for (const [what, from, why] of [
    ['an order for another currency', { code: 'USDCSOL' }, /is for USDCSOL/],
    ['a deposit on another network', { network: 'BSC' }, /deposits on BSC/],
    ['a deposit that needs a memo', { tag: '123456' }, /needs a memo/],
    ['an EVM deposit address', { address: '0x9999999999999999999999999999999999999999' }, /without a Solana deposit address/],
    ['a deposit into the treasury itself', { address: TREASURY }, /the treasury itself/],
    ['an amount with more places than SOL has', { amount: '1.0000000001' }, /without an amount it can be paid in/],
    ['an ask 5% over the quote', { amount: '1.05' }, /asks 1\.05 SOL/],
  ]) {
    let err = null;
    try { F.checkOrder(order(from), { quotedSol: 1, treasury: TREASURY }); } catch (e) { err = e.message; }
    checkThat(what + ' is refused', err && why.test(err), err);
  }

  console.log('\nrefusals before anything moves');
  mockPayer._reset(); mockPayer._state.sats = 0;
  let chain = fakeRpc({ lamports: SOL(5) });
  await rejects('a key that is not the treasury is refused', F.run(base({ rpc: chain.rpc, key: newKey() })), /wrong wallet/);
  check('before any call', chain.log.calls.length, 0);
  await rejects('no treasury configured is refused', F.run(base({ config: { treasury: '' } })), /no treasury/);
  mockPayer._state.sats = 200000;   // $160 at $0.0008/sat
  let r = await F.run(base({}));
  check('a pool over target moves nothing', [r.action, /pool \$160\.00, aiming at \$100\.00/.test(r.reason)], ['none', true]);
  mockPayer._state.sats = 0;
  // 0.12 SOL is $12, and the 0.05 SOL keep-back leaves $7 to spend: under the $20 floor.
  r = await F.run(base({ rpc: fakeRpc({ lamports: SOL(0.12) }).rpc }));
  check('a treasury under the floor once its keep-back is set aside moves nothing', [r.action, /treasury holds \$7\.00 of spendable SOL/.test(r.reason)], ['none', true]);
  r = await F.run(base({ rpc: fakeRpc({ lamports: SOL(0.04) }).rpc }));
  check('a treasury holding less than its keep-back has nothing to spend', [r.action, /treasury holds \$0\.00/.test(r.reason)], ['none', true]);
  ff.rate = 0.0008 * 1.3;   // FixedFloat says a dollar buys 30% more sats than Blink's price implies
  chain = fakeRpc({ lamports: SOL(5) });
  await rejects('a FixedFloat rate 30% off the wallet\'s price is refused', F.run(base({ rpc: chain.rpc })), /rate is off/);
  check('with no invoice, no order and no transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.sent.length], [0, 0, 0]);
  ff.rate = 0.0008;
  await rejects('no SOL price, no plan', F.run(base({ solUsd: async () => NaN })), /no SOL price/);

  console.log('\na dry run');
  chain = fakeRpc({ lamports: SOL(5) });
  r = await F.run(base({ rpc: chain.rpc, dryRun: true }));
  check('prices the move and stops', [r.action, r.amountUsd, r.sats, r.sol], ['plan', 100, 125000, 1]);
  check('with no invoice, no order and no transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.sent.length, chain.log.simulated.length], [0, 0, 0, 0]);
  check('and no log', fs.existsSync(path.join(tmp, 'funding.json')), false);
  check('the quote asked was SOL to Lightning, for the SOL the dollars buy', ff.log.find((l) => l.path === '/price').body, { type: 'fixed', fromCcy: 'SOL', toCcy: 'BTCLN', direction: 'from', amount: 1 });

  console.log('\nthe order is wrong');
  ff.askFactor = 1.05;
  chain = fakeRpc({ lamports: SOL(5) });
  await rejects('5% over the quote is refused and the order left to expire', F.run(base({ rpc: chain.rpc })), /asks 1\.05 SOL/);
  check('after the invoice and the order, before any transaction', [mockPayer._state.invoices.length, ff.orders.size, chain.log.simulated.length, chain.log.sent.length], [1, 1, 0, 0]);
  ff.askFactor = 1.0;
  ff.from = { address: '0x9999999999999999999999999999999999999999' };
  chain = fakeRpc({ lamports: SOL(5) });
  await rejects('an order paying into an EVM address is refused', F.run(base({ rpc: chain.rpc })), /Solana deposit address/);
  check('and nothing was signed or sent', [chain.log.simulated.length, chain.log.sent.length], [0, 0]);
  ff.from = { tag: 'MEMO1' };
  await rejects('an order that needs a memo is refused', F.run(base({})), /needs a memo/);
  ff.from = {};
  // A 3% richer ask is within tolerance, but 1.03 SOL is more than a treasury of 1.07 SOL can
  // spare above its 0.05 SOL keep-back (1.02).
  ff.askFactor = 1.03;
  chain = fakeRpc({ lamports: SOL(1.07) });
  await rejects('an ask the treasury cannot spare above its keep-back is refused', F.run(base({ rpc: chain.rpc })), /can spare 1\.020000/);
  check('before any transaction', chain.log.sent.length, 0);
  ff.askFactor = 1.0;
  chain = fakeRpc({ lamports: SOL(5), simulateErr: { InstructionError: [1, { Custom: 1 }] } });
  await rejects('a transfer that fails in simulation is refused', F.run(base({ rpc: chain.rpc })), /would fail/);
  check('and is never sent nor journaled', [chain.log.sent.length, fs.existsSync(path.join(tmp, 'funding.json'))], [0, false]);

  console.log('\nthe whole way through');
  mockPayer._reset(); mockPayer._state.sats = 0; ff.log.length = 0;
  let journalAtSend = null;
  chain = fakeRpc({ lamports: SOL(5), onSend: () => { journalAtSend = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8')); } });
  const t = 1800000000000;
  r = await F.run(base({ rpc: chain.rpc, now: () => t }));
  check('the result: $100 moved as 125,000 sats, done', [r.action, r.amountUsd, r.sats, r.status], ['funded', 100, 125000, 'done']);
  const inv = mockPayer._state.invoices[0];
  check('one invoice on the pool\'s wallet for the sats, with a memo', [mockPayer._state.invoices.length, inv.sats, inv.memo, inv.status], [1, 125000, 'OT+T data pool top-up', 'PAID']);
  const created = ff.log.find((l) => l.path === '/create').body;
  check('the FixedFloat order is fixed-rate, SOL to Lightning, for that many sats, paying that invoice',
    [created.type, created.fromCcy, created.toCcy, created.direction, created.amount, created.toAddress === inv.paymentRequest], ['fixed', 'SOL', 'BTCLN', 'to', '0.00125000', true]);
  check('the transfer was simulated, signed, before it was sent once', [chain.log.simulated.length, chain.log.simulated[0][1].sigVerify, chain.log.sent.length], [1, true, 1]);
  const ixs = decodeSent(chain.log.sent[0]);
  check('it is a priority fee and one plain SOL transfer', ixs.map((i) => i.program), [S.PROGRAMS.computeBudget, S.PROGRAMS.system]);
  check('from the treasury to FixedFloat\'s address, for exactly the 1 SOL it asked', [ixs[1].accounts, ixs[1].data],
    [[TREASURY, FF_DEPOSIT], Array.from(S.systemTransfer({ from: TREASURY, to: FF_DEPOSIT, lamports: 1000000000n }).data)]);
  const signature = S.encodeBase58(S.decodeBase64(chain.log.sent[0]).subarray(1, 65));
  check('the journal named the transfer before it was broadcast', [journalAtSend.length, journalAtSend[0].status, journalAtSend[0].depositTx], [1, 'sending', signature]);
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8'));
  check('the log has the one entry, complete', [written.length, written[0].amountUsd, written[0].solSent, written[0].lamports, written[0].sats, written[0].fixedFloatOrder,
    written[0].invoiceHash === inv.paymentHash, written[0].depositTx, written[0].status, written[0].dryRun, written[0].at, written[0].finishedAt],
  [1, 100, 1, '1000000000', 125000, 'FF' + String(ff.orders.size).padStart(4, '0'), true, signature, 'done', false, 1800000000, 1800000000]);
  check('FixedFloat was polled until DONE', ff.log.filter((l) => l.path === '/order').length, 3);

  console.log('\nafter the transfer');
  ff.statuses = ['PENDING', 'EMERGENCY'];
  mockPayer._state.sats = 0;
  await rejects('EMERGENCY is an error naming the order and the transfer', F.run(base({ now: () => t })), /EMERGENCY.*needs a hand/);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8'));
  check('and is recorded as such', [after.length, after[1].status, F.FF_FROM], [2, 'emergency', 'SOL']);
  ff.statuses = ['PENDING'];
  let clock = t;   // a clock that moves, or the deadline never comes
  r = await F.run(base({ now: () => (clock += 30000), waitMs: 60000, pollMs: 5 }));
  check('a slow order is recorded as sent, not failed', [r.action, r.status, r.entry.lastSeen], ['funded', 'sent', 'PENDING']);
  ff.statuses = ['PENDING', 'EXCHANGE', 'DONE'];
  chain = fakeRpc({ lamports: SOL(5), confirm: 'failed' });
  await rejects('a transfer that fails on chain is an error naming it', F.run(base({ rpc: chain.rpc })), /was not confirmed.*check it on chain/);
  const last = JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8')).pop();
  check('and is journaled as unconfirmed, with the reason', [last.status, /failed/.test(last.error)], ['unconfirmed', true]);
  mockPayer._state.sats = 0;
  r = await F.run(base({ rpc: fakeRpc({ lamports: SOL(5), confirm: 'pending', landed: 'ok' }).rpc, confirmOptions: { pollMs: 1, timeoutMs: 5 } }));
  check('a transfer whose confirmation times out but is on chain carries on to the sats', [r.action, r.status], ['funded', 'done']);
  mockPayer._state.sats = 0;
  await rejects('one that is not on chain is journaled unconfirmed and stops', F.run(base({ rpc: fakeRpc({ lamports: SOL(5), confirm: 'pending', landed: null }).rpc, confirmOptions: { pollMs: 1, timeoutMs: 5 } })), /was not confirmed/);
  check('with its status', JSON.parse(fs.readFileSync(path.join(tmp, 'funding.json'), 'utf8')).pop().status, 'unconfirmed');

  ffServer.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
