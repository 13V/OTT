#!/usr/bin/env node
'use strict';
/**
 * loop.test.js — the whole promise, in order, once.
 *
 * The founder's words: "we just need to make sure we have a system that claims fees then buys
 * sims for holders to claim on the dashboard and be able to claim data as well." Every stage of
 * that loop already has its own test suite (test/claim's arithmetic in test/treasury.test.js,
 * test/fund.test.js, test/allowances.test.js, test/redeem.test.js, test/redeem-nadanada.test.js,
 * test/treasury.test.js again for the report) — but none of them runs the whole thing in order,
 * against one consistent world, and follows a dollar all the way through. This file does:
 *
 *   1. Tax accrues (fixture): a 10% creator tax lands in Pons's fee escrow, last week.
 *   2. scripts/claim.js sweeps the escrow into the treasury wallet.
 *   3. scripts/fund.js turns treasury USDG into sats in the Lightning wallet, via a Blink
 *      invoice, a FixedFloat order and an Across deposit.
 *   4. scripts/allowances.js computes the week's budget (last week's tax) and every wallet's
 *      allowance (its share of the circulating supply at the week's first block).
 *   5. site/api/redeem.js serves a holder's dashboard.
 *   6. The holder redeems: nadanada is ordered, the Lightning wallet pays, an eSIM comes back.
 *   7. That eSIM shows up in the dashboard's numbers; the allowance has gone down.
 *   8. scripts/treasury.js reports the pool's balance and what redemptions cost.
 *
 * Then the clock is moved a week forward and 4-7 happen again, to prove the allowance actually
 * expires rather than just going up.
 *
 * One fake chain (see "THE WORLD" below) backs every stage: escrow balances, the treasury's USDG
 * balance, the coin's Transfer logs and the curve-to-escrow tax transfers all live in one mutable
 * object, so a number scripts/claim.js moves is the same number scripts/fund.js reads a moment
 * later, and the same number scripts/treasury.js reports at the end. The existing suites each
 * invent their own chain, their own week, their own wallets — that is correct for testing a stage
 * in isolation, but it means no test can answer "does the loop actually add up?". This one is
 * built to answer exactly that, and only that; it duplicates as little of the other suites' error-
 * path coverage as possible.
 *
 * The eSIM side is not a stub: test/support/fake-nadanada.js (the same fake test/nadanada.test.js
 * and test/redeem-nadanada.test.js drive), site/api/lib/payers/mock.js (LN_PAYER=mock) and the
 * real in-memory store (STORE=memory) stand in for nadanada.me, Blink and Upstash respectively —
 * everything upstream of those three sockets is the real code, unmodified, run through
 * require(), exactly as it runs in production.
 *
 *   node test/loop.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const API = path.join(SITE, 'api');

const C = require(path.join(ROOT, 'scripts', 'claim.js'));
const F = require(path.join(ROOT, 'scripts', 'fund.js'));
const A = require(path.join(ROOT, 'scripts', 'allowances.js'));
const T = require(path.join(ROOT, 'scripts', 'treasury.js'));
const chainLib = require(path.join(ROOT, 'scripts', 'chain.js'));

const secp = require(path.join(API, 'lib', 'secp256k1.js'));
const eip191 = require(path.join(API, 'lib', 'eip191.js'));
const mockPayer = require(path.join(API, 'lib', 'payers', 'mock.js'));
const providers = require(path.join(API, 'lib', 'providers'));
const fakeNadanada = require(path.join(__dirname, 'support', 'fake-nadanada.js'));

// ---------------------------------------------------------------------------------------------
// House-style check helpers — identical in shape to every other suite in test/.
// ---------------------------------------------------------------------------------------------
let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };

const round2 = (x) => Math.round(x * 100) / 100;
const usd = (n) => '$' + Number(n).toFixed(2);

// ---------------------------------------------------------------------------------------------
// A real wall clock, replaced with one this file drives by hand. `Date.now` alone is not enough:
// site/api/redeem.js and site/api/lib/providers/nadanada.js both call `new Date()` (for `week`,
// for a sign-in message's freshness, for an order's `createdAt`), and V8 does not route `new
// Date()` through `Date.now()` — so both have to be replaced together, or "the week rolls" would
// move scripts/allowances.js's clock and leave redeem.js reading the real one. The class extends
// the real Date so every other method (toISOString, getUTCDay, …) and every `instanceof Date`
// check keeps working exactly as it does today; only "what time is it right now" is fixed to a
// value this file controls, jumped forward exactly once, at "the week rolls" below.
// ---------------------------------------------------------------------------------------------
const RealDate = Date;
let clockMs = 0;
function installClock(startMs) {
  clockMs = startMs;
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(clockMs); else super(...args); }
    static now() { return clockMs; }
  };
}
const setClock = (ms) => { clockMs = ms; };
const restoreClock = () => { global.Date = RealDate; };

// A fixed moment, not "whenever this happens to run" — so the fixture below (which week is
// "last week", which block is the snapshot) is reproducible on any machine, any day.
const NOW0 = RealDate.parse('2026-09-14T12:00:00.000Z');
installClock(NOW0);

const WEEK = A.weekOf(Math.floor(NOW0 / 1000));
const wS = A.weekStart(WEEK), wE = A.weekEnd(WEEK);
const prevS = A.weekStart(WEEK - 1);
const nextS = wE, nextE = A.weekEnd(WEEK + 1);

// ---------------------------------------------------------------------------------------------
// THE WORLD — one fake chain, shared by claim.js, fund.js, allowances.js and treasury.js.
//
// Blocks are one Unix second apart, block number == timestamp, starting at the real epoch: it is
// the simplest bijection that satisfies scripts/allowances.js's block/timestamp binary search
// (firstBlockAtOrAfter), and — because every fixture block below is chosen close to the week
// boundaries it needs to bracket, never at block 0 — every eth_getLogs scan this test triggers
// stays under scripts/allowances.js's MAX_CHUNK (1,000,000 blocks), so the scan never sleeps
// between chunks and the whole test runs in well under a second of real chunking.
//
// `world` holds the two numbers a stage moves and the next stage reads: the escrow's USDG balance
// claimable by the treasury, and the treasury's own USDG wallet balance. Everything else (the coin
// Transfer logs, the curve -> escrow tax transfers) is an append-only fixture, because a historical
// log does not change after the fact — only a balance does.
// ---------------------------------------------------------------------------------------------
const hex = (n) => '0x' + BigInt(n).toString(16);
const hexWord = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const wordOf = (v) => (typeof v === 'string' ? A.pad(v).slice(2) : BigInt(v).toString(16).padStart(64, '0'));
const wordAt = (data, i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));
const wordHex = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';       // real — site/config/addresses.json
const USDG_DECIMALS = 6;
const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';     // real Pons factory
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';      // real Pons fee escrow
const MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';   // real Pons memeHook
const TREASURY = '0x3333333333333333333333333333333333333333';   // made up, well-formed
const COIN = '0x1111111111111111111111111111111111111111';       // made up, well-formed
const CURVE = '0x2222222222222222222222222222222222222222';      // made up, well-formed
const COIN_DECIMALS = 18;
const FF_ADDRESS = '0x9999999999999999999999999999999999999999';           // FixedFloat's one-off Base address
const BRIDGE_TO = '0xD29C85F15DF544bA632C9E25829fd29d767d7978';             // Across's spoke pool, as fund.test.js fakes it
const ZERO = '0x0000000000000000000000000000000000000000';

const ADDRESSES = { chainId: 4663, usdg: USDG, usdgDecimals: USDG_DECIMALS, pons: { factory: FACTORY, feeEscrow: ESCROW, memeHook: MEME_HOOK } };

const SEL = {
  getLaunchedToken: chainLib.selector('getLaunchedToken(address)'),
  decimals: chainLib.selector('decimals()'),
  balanceOfToken: chainLib.selector('balanceOfToken(address,address)'),
  balanceOf: chainLib.selector('balanceOf(address)'),
  claimToken: chainLib.selector('claimToken(address)'),
};
const APPROVE_SEL = '0x095ea7b3';   // the real ERC-20 approve(address,uint256) selector
const DEPOSIT_SEL = '0xad5425c6';   // a stand-in for Across's deposit call, as fund.test.js fakes it

// getLaunchedToken(coin)'s fifteen words — see scripts/allowances.js's launchedToken(). Word 4 is
// the pair (USDG, so the tax sweep this test relies on is meaningful in dollars); word 8 is the
// creator tax rate (1000 bps = 10%, matching the founder's "10% creator tax" and config.taxBps
// below); word 14 is the exists flag.
const LAUNCHED_ROW = '0x' + [COIN, CURVE, TREASURY, TREASURY, USDG, 500000000000n, 0, 0, 1000, 0, 0, 0, 0, 0, 1].map(wordOf).join('');

const HEAD = A.weekStart(WEEK + 3);              // a chain tip comfortably past everything below
const LAUNCH_BLOCK = wS - 100;                    // --from-block: close to the snapshot, so no chunk is ever wide
const MINT_BLOCK = wS - 50;                       // when the coin's holders got their tokens

let logIndex = 0;
const xfer = (from, to, amountBaseUnits, block) => ({
  topics: [A.TRANSFER, A.pad(from), A.pad(to)],
  data: '0x' + BigInt(amountBaseUnits).toString(16).padStart(64, '0'),
  blockNumber: hex(block),
  logIndex: hex(logIndex++),
});
const usdgXfer = (from, to, amountUsd, block) => xfer(from, to, BigInt(Math.round(amountUsd * 1e6)), block);

// Two holders. Tokens, not dollars, is what the chain moves — RICH holds 60% of the circulating
// supply, POORER holds 40%, and (see "the curve holds unsold supply" below) neither figure is the
// whole 10,000-token mint.
const RICH_KEY = secp.newPrivateKey(), POORER_KEY = secp.newPrivateKey();
const RICH = secp.addressOf(RICH_KEY).toLowerCase();
const POORER = secp.addressOf(POORER_KEY).toLowerCase();
const RICH_TOKENS = 600n * 10n ** 18n, POORER_TOKENS = 400n * 10n ** 18n, CURVE_TOKENS = 9000n * 10n ** 18n;

const world = {
  // Last week's tax (see the two curve -> escrow transfers below), sitting in escrow, unswept
  // until stage 2 claims it. This is the number claim.js is about to sweep, checked against it
  // directly in "STAGE 2" below.
  escrowUsdgUnits: 500000000n,
  treasuryUsdgUnits: 0n,
  coinTransfers: [
    xfer(ZERO, RICH, RICH_TOKENS, MINT_BLOCK),
    xfer(ZERO, POORER, POORER_TOKENS, MINT_BLOCK),
    xfer(ZERO, CURVE, CURVE_TOKENS, MINT_BLOCK),   // the curve's unsold supply — inventory, not a holding
  ],
  // Every curve -> escrow USDG transfer this test will ever need, for both weeks at once: a
  // historical log does not depend on when it is read, only a live balance does. $320 + $180 =
  // $500 lands in week WEEK-1 (this week's budget); $130 + $80 = $210 lands in week WEEK (next
  // week's budget, once the clock moves on).
  usdgTransfers: [
    usdgXfer(CURVE, ESCROW, 320, prevS + 1000),
    usdgXfer(CURVE, ESCROW, 180, prevS + 2000),
    usdgXfer(CURVE, ESCROW, 130, wS + 1000),
    usdgXfer(CURVE, ESCROW, 80, wS + 2000),
  ],
};

/** The one eth_call/eth_getLogs/eth_getBlockByNumber/eth_blockNumber surface every stage reads. */
async function rawRpc(method, params) {
  if (method === 'eth_blockNumber') return hex(HEAD);
  if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: hex(Number(BigInt(params[0]))) };
  if (method === 'eth_getLogs') {
    const f = params[0];
    const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
    const addrL = String(f.address).toLowerCase();
    const pool = addrL === COIN.toLowerCase() ? world.coinTransfers : addrL === USDG.toLowerCase() ? world.usdgTransfers : [];
    return pool.filter((l) => {
      const b = Number(BigInt(l.blockNumber));
      if (b < from || b > to) return false;
      return f.topics.every((t, i) => t == null || String(l.topics[i] || '').toLowerCase() === String(t).toLowerCase());
    });
  }
  if (method === 'eth_call') {
    const { to, data } = params[0];
    const toL = String(to).toLowerCase();
    const sel = data.slice(0, 10);
    if (toL === FACTORY.toLowerCase() && sel === SEL.getLaunchedToken) return LAUNCHED_ROW;
    if (toL === COIN.toLowerCase() && sel === SEL.decimals) return hexWord(COIN_DECIMALS);
    if (toL === ESCROW.toLowerCase() && sel === SEL.balanceOfToken) return hexWord(world.escrowUsdgUnits);
    if (toL === ESCROW.toLowerCase() && sel === SEL.balanceOf) return hexWord(0n); // no native ETH ever claimable here
    if (toL === USDG.toLowerCase() && sel === SEL.balanceOf) return hexWord(world.treasuryUsdgUnits);
    if (toL === ESCROW.toLowerCase() && sel === SEL.claimToken) return '0x';       // simulated only — no revert modeled
    if (toL === BRIDGE_TO.toLowerCase() && sel === DEPOSIT_SEL) return '0x';       // simulated only
    throw new Error('fake chain: unexpected eth_call to ' + to + ' selector ' + sel);
  }
  throw new Error('fake chain: unexpected rpc method ' + method);
}

let receiptSeq = 0;
const receipt = () => { receiptSeq += 1; return { transactionHash: '0x' + String(receiptSeq).padStart(64, '0'), status: '0x1' }; };

/** send() is the only place `world`'s two balances actually move. */
function applySend(to, data) {
  const toL = String(to).toLowerCase();
  const sel = data.slice(0, 10);
  if (toL === ESCROW.toLowerCase() && sel === SEL.claimToken) {
    const amt = world.escrowUsdgUnits;
    world.treasuryUsdgUnits += amt;
    world.escrowUsdgUnits = 0n;
    return receipt();
  }
  if (toL === USDG.toLowerCase() && sel === APPROVE_SEL) return receipt();  // a precondition for the bridge pull, no balance effect on its own
  if (toL === BRIDGE_TO.toLowerCase() && sel === DEPOSIT_SEL) {
    const inUnits = wordAt(data, 4);
    if (inUnits > world.treasuryUsdgUnits) throw new Error(`fake chain: deposit of ${inUnits} exceeds treasury balance ${world.treasuryUsdgUnits}`);
    world.treasuryUsdgUnits -= inUnits;
    return receipt();
  }
  throw new Error('fake chain: unexpected send to ' + to + ' selector ' + sel);
}

// The `chain` object scripts/claim.js and scripts/fund.js expect: call/rpc/send/encodeCall.
// encodeCall is the real, pure ABI encoder (scripts/chain.js) — nothing about how a call is built
// is faked, only what answers it. `rpc`/`send` both funnel through rawRpc/applySend above, so a
// balance claim.js or fund.js changes is the exact number allowances.js and treasury.js read next.
const chainLog = { simulated: [], sent: [] };
const chainAdapter = {
  log: chainLog,
  encodeCall: chainLib.encodeCall,
  async call(to, sig, args = []) {
    const raw = await rawRpc('eth_call', [{ to, data: chainLib.encodeCall(sig, args) }, 'latest']);
    return [BigInt(raw)];
  },
  async rpc(method, params) {
    if (method !== 'eth_call') throw new Error('fake chain: unexpected rpc ' + method);
    chainLog.simulated.push(params[0].data.slice(0, 10));
    return rawRpc(method, params);
  },
  async send({ to, data }) {
    chainLog.sent.push({ to, sel: data.slice(0, 10) });
    return applySend(to, data);
  },
};

// ---------------------------------------------------------------------------------------------
// FixedFloat and Across, faked exactly as test/fund.test.js fakes them: real HTTP, real signature
// checking, on localhost. ff.rate matches the mock payer's own usdPerSat (0.0008) so the "quote
// matches the wallet's own price" check in fund.js passes without special-casing anything.
// ---------------------------------------------------------------------------------------------
const FF_KEY = 'ff-key', FF_SECRET = 'ff-secret';
const ffWorld = { rate: 0.0008, askFactor: 1.0, statuses: ['PENDING', 'EXCHANGE', 'DONE'], orders: new Map() };
const ffServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (j) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    const sign = crypto.createHmac('sha256', FF_SECRET).update(body).digest('hex');
    if (req.headers['x-api-key'] !== FF_KEY || req.headers['x-api-sign'] !== sign) return reply({ code: 501, msg: 'Not have permission', data: null });
    const b = JSON.parse(body);
    if (req.url === '/price') {
      const btc = b.direction === 'from' ? (Number(b.amount) / ffWorld.rate) / 1e8 : Number(b.amount);
      return reply({ code: 0, msg: 'OK', data: { from: { code: b.fromCcy, amount: String(b.amount) }, to: { code: b.toCcy, amount: btc.toFixed(8) } } });
    }
    if (req.url === '/create') {
      if (b.direction !== 'to' || b.type !== 'fixed' || !/^lnbc/.test(b.toAddress)) return reply({ code: 301, msg: 'Invalid address', data: null });
      const sats = Math.round(Number(b.amount) * 1e8);
      const ask = sats * ffWorld.rate * ffWorld.askFactor;
      const id = 'FF' + String(ffWorld.orders.size + 1).padStart(4, '0');
      const order = { id, token: 'tok-' + id, type: 'fixed', status: 'NEW', polls: 0, from: { code: 'USDCBASE', amount: ask.toFixed(2), address: FF_ADDRESS }, to: { code: 'BTCLN', amount: (sats / 1e8).toFixed(8), address: b.toAddress }, time: { expiration: Math.floor(Date.now() / 1000) + 1800 } };
      ffWorld.orders.set(id, order);
      return reply({ code: 0, msg: 'OK', data: order });
    }
    if (req.url === '/order') {
      const o = ffWorld.orders.get(b.id);
      if (!o || o.token !== b.token) return reply({ code: 401, msg: 'Order not found', data: null });
      o.status = ffWorld.statuses[Math.min(o.polls, ffWorld.statuses.length - 1)];
      o.polls++;
      if (o.status === 'DONE') mockPayer._markPaid(mockPayer._state.invoices[mockPayer._state.invoices.length - 1].paymentHash);
      return reply({ code: 0, msg: 'OK', data: o });
    }
    reply({ code: 404, msg: 'no such method', data: null });
  });
});

const acrossWorld = { feeFactor: 1.003, shortFactor: 1.0 };
const acrossServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams.entries());
  res.setHeader('content-type', 'application/json');
  if (url.pathname !== '/swap/approval') { res.statusCode = 404; return res.end(JSON.stringify({ message: 'nope' })); }
  const outUnits = BigInt(q.amount);
  const inUnits = (outUnits * BigInt(Math.round(acrossWorld.feeFactor * 1e6))) / 1000000n;
  const minOut = (outUnits * BigInt(Math.round(acrossWorld.shortFactor * 1e6))) / 1000000n;
  res.end(JSON.stringify({
    amountType: q.tradeType, inputAmount: inUnits.toString(), maxInputAmount: inUnits.toString(), expectedOutputAmount: outUnits.toString(), minOutputAmount: minOut.toString(),
    approvalTxns: [{ chainId: ADDRESSES.chainId, to: USDG, data: APPROVE_SEL + wordHex(BRIDGE_TO) + 'f'.repeat(64) }],
    swapTx: { ecosystem: 'evm', chainId: ADDRESSES.chainId, to: BRIDGE_TO, data: DEPOSIT_SEL + wordHex(q.depositor) + wordHex(q.recipient) + wordHex(USDG) + wordHex(q.outputToken) + wordHex('0x' + inUnits.toString(16)) + wordHex('0x' + outUnits.toString(16)), value: '0' },
    quoteExpiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
  }));
});

// ---------------------------------------------------------------------------------------------
// site/api/redeem.js reads its config and its allowances over HTTP (see the header comment in
// redeem.js for why) — this is that HTTP, on localhost, with `served.allowances` swapped out
// between the two weeks so the same URL answers differently once the clock has moved on.
// ---------------------------------------------------------------------------------------------
const PACKAGES = [
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 5, days: 30, priceUsd: 5.99, regions: '38 countries' },
];
const CONFIG = { coin: COIN, curve: CURVE, treasury: TREASURY, pair: USDG, taxBps: 1000, budgetBps: 10000, provider: 'nadanada', packages: PACKAGES };
const served = { allowances: null };
const fileServer = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const body = p === '/config/esim.json' ? CONFIG : p === '/data/allowances.json' ? served.allowances : null;
  if (!body) { res.statusCode = 404; return res.end('nope'); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
});

/** The same fake req/res shape test/redeem.test.js and test/redeem-nadanada.test.js drive the handler with. */
function call(handler, { method, url, body }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (body !== undefined) req.body = JSON.stringify(body);
    const headers = {};
    const res = { statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); } };
    handler(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
}
const now = () => Math.floor(Date.now() / 1000);
const message = (address) => 'OT+T data\n' + address + '\n' + now();
function signed(key, packageCode, n = 0) {
  const address = secp.addressOf(key).toLowerCase();
  const msg = message(address);
  const bodyObj = { address, message: msg, signature: eip191.sign(key, msg) };
  if (packageCode !== null) { bodyObj.packageCode = packageCode; bodyObj.n = n; }
  return bodyObj;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
const OUT = {
  claims: path.join(tmp, 'claims.json'),
  funding: path.join(tmp, 'funding.json'),
  allowances1: path.join(tmp, 'allowances-week1.json'),
  allowances2: path.join(tmp, 'allowances-week2.json'),
  treasury: path.join(tmp, 'treasury.json'),
};

// The real files this loop must never touch, no matter what — snapshotted now, compared at the end.
const REAL_DATA_FILES = ['allowances.json', 'claims.json', 'funding.json', 'treasury.json'].map((f) => path.join(SITE, 'data', f));
const realDataBefore = Object.fromEntries(REAL_DATA_FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));

async function main() {
  console.log('the loop, start to finish — claim, fund, allowances, redeem, and back around a week later');
  console.log('what is simulated and what is real, so the numbers below are read honestly:');
  console.log('  REAL:      scripts/claim.js, scripts/fund.js, scripts/allowances.js, scripts/treasury.js,');
  console.log('             site/api/redeem.js, site/api/lib/providers/nadanada.js, site/api/lib/store.js');
  console.log('             (STORE=memory), lib/bolt11.js, lib/eip191.js, lib/secp256k1.js, lib/keccak.js,');
  console.log('             and scripts/chain.js\'s ABI encoder — all unmodified, run through require().');
  console.log('  SIMULATED: the Robinhood Chain RPC (one in-process fake, below), the Pons escrow and the');
  console.log('             coin/USDG contracts on it, the FixedFloat and Across APIs (localhost HTTP),');
  console.log('             the nadanada.me API (test/support/fake-nadanada.js), and the Lightning wallet');
  console.log('             (LN_PAYER=mock — no sats ever really move).');
  console.log('  NOT PROVEN by this test or any other in this repo: that a real Blink wallet pays a real');
  console.log('             Lightning invoice that the real nadanada.me accepts. Everything on our side of');
  console.log('             that one socket is exercised for real; the socket itself is not.');

  await new Promise((r) => ffServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => acrossServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
  const fake = await fakeNadanada.start({ mockPayer });

  try {
    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 1 — tax accrues (fixture)');
    // Trading against the curve pays its 10% creator tax into the escrow; scripts/allowances.js
    // never reads this balance directly (see STAGE 4), only the Transfer logs it left behind —
    // but the escrow's live claimable balance is what claim.js sweeps, so both are set up here,
    // to the same $500.00, so the two independent views of "last week's tax" have something to
    // agree on below.
    // -------------------------------------------------------------------------------------
    checkThat('the escrow starts holding exactly last week\'s tax ($320 + $180)', world.escrowUsdgUnits === 500000000n, world.escrowUsdgUnits.toString());
    checkThat('the treasury wallet starts empty', world.treasuryUsdgUnits === 0n, world.treasuryUsdgUnits.toString());

    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 2 — scripts/claim.js sweeps the escrow');
    // -------------------------------------------------------------------------------------
    const escrowBeforeClaim = world.escrowUsdgUnits;
    const claimResult = await C.run({ chain: chainAdapter, config: CONFIG, addresses: ADDRESSES, treasury: TREASURY, out: OUT.claims, log: (m) => console.log('  ' + m) });
    check('the amount claimed is exactly what the escrow held ($500.00, one item: usdg)', claimResult.claimed.map((c) => [c.kind, c.amount]), [['usdg', Number(escrowBeforeClaim) / 1e6]]);
    checkThat('it was simulated before it was sent', chainLog.simulated.includes(SEL.claimToken) && chainLog.sent.some((s) => s.sel === SEL.claimToken), JSON.stringify(chainLog));
    checkThat('the escrow is now empty and the treasury holds exactly what was claimed', world.escrowUsdgUnits === 0n && world.treasuryUsdgUnits === escrowBeforeClaim, `escrow=${world.escrowUsdgUnits} treasury=${world.treasuryUsdgUnits}`);
    const claimedUsd = claimResult.claimed.reduce((s, c) => s + (c.kind === 'usdg' ? c.amount : 0), 0);
    checkThat('claims.json was written under the temp dir, not site/data', fs.existsSync(OUT.claims), OUT.claims);

    // Monday's claim swept last week clean. Trading resumes immediately, and by the time week
    // WEEK itself ends it will have paid another $210.00 ($130 + $80) into the escrow — this is
    // what funds WEEK+1's budget in "the week rolls" below. claim.js is not run a second time for
    // it (only the indexer is re-run, per the brief), so it is left sitting there on purpose:
    // treasury.js's final report, at the very end of this file, shows it as still-claimable.
    world.escrowUsdgUnits += 210000000n;

    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 3 — scripts/fund.js turns treasury USDG into Lightning sats');
    // -------------------------------------------------------------------------------------
    mockPayer._reset();
    mockPayer._state.sats = 0;   // the pool starts with nothing funded
    const ffClient = F.fixedFloat({ key: FF_KEY, secret: FF_SECRET, api: 'http://127.0.0.1:' + ffServer.address().port });
    const bridgeClient = F.across({ api: 'http://127.0.0.1:' + acrossServer.address().port });
    const treasuryBeforeFund = world.treasuryUsdgUnits;
    const fundResult = await F.run({
      chain: chainAdapter, config: CONFIG, addresses: ADDRESSES, treasury: TREASURY,
      payer: mockPayer, ff: ffClient, bridge: bridgeClient,
      targetUsd: 80, minUsd: 5, maxUsd: 200, waitMs: 2000, pollMs: 20,
      out: OUT.funding, log: (m) => console.log('  ' + m),
    });
    check('the pool is filled to its $80 target', [fundResult.action, fundResult.amountUsd, fundResult.sats, fundResult.status], ['funded', 80, 100000, 'done']);
    const written = JSON.parse(fs.readFileSync(OUT.funding, 'utf8'));
    checkThat('the on-chain treasury balance dropped by exactly what fund.js says it moved (usdgIn)', treasuryBeforeFund - world.treasuryUsdgUnits === BigInt(Math.round(written[0].usdgIn * 1e6)), `delta=${treasuryBeforeFund - world.treasuryUsdgUnits} usdgIn=${written[0].usdgIn}`);
    checkThat('the pool\'s Lightning wallet now holds exactly the sats fund.js says it funded', mockPayer._state.sats === fundResult.sats, mockPayer._state.sats);
    const fundedUsd = fundResult.amountUsd;
    const poolSatsAfterFund = mockPayer._state.sats;
    checkThat('funding.json was written under the temp dir, not site/data', fs.existsSync(OUT.funding), OUT.funding);

    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 4 — scripts/allowances.js computes week ' + WEEK + '\'s budget and allowances');
    // -------------------------------------------------------------------------------------
    const week1 = await A.run({ config: CONFIG, addresses: ADDRESSES, rpc: rawRpc, out: OUT.allowances1, fromBlock: LAUNCH_BLOCK, log: (m) => console.log('  ' + m) });
    check('the week is ' + WEEK + ' and the budget is exactly last week\'s tax ($320 + $180)', [week1.data.week, week1.data.budgetUsd], [WEEK, 500]);
    check('the budget agrees with what claim.js actually claimed', week1.data.budgetUsd, claimedUsd);
    const w1 = week1.data.wallets;
    check('RICH holds 600 of the 1000-token circulating supply: a 0.6 share, $300.00 of the $500 budget', [w1[RICH].tokens, w1[RICH].share, w1[RICH].allowanceUsd], [RICH_TOKENS.toString(), 0.6, 300]);
    check('POORER holds the other 400: a 0.4 share, $200.00', [w1[POORER].tokens, w1[POORER].share, w1[POORER].allowanceUsd], [POORER_TOKENS.toString(), 0.4, 200]);
    checkThat('the curve\'s 9000 unsold tokens are excluded: not a wallets entry', !(CURVE.toLowerCase() in w1), Object.keys(w1));
    const shareSum = Object.values(w1).reduce((s, w) => s + w.share, 0);
    const allowanceSum = Object.values(w1).reduce((s, w) => s + w.allowanceUsd, 0);
    check('every wallet\'s share sums to exactly 1', shareSum, 1);
    check('every wallet\'s allowance sums to exactly the budget', allowanceSum, week1.data.budgetUsd);
    checkThat('allowances-week1.json was written under the temp dir, not site/data', fs.existsSync(OUT.allowances1), OUT.allowances1);
    served.allowances = week1.data;

    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 5/6/7 — site/api/redeem.js: the dashboard, the redemption, the eSIM');
    // -------------------------------------------------------------------------------------
    process.env.ESIM_CONFIG_URL = 'http://127.0.0.1:' + fileServer.address().port + '/config/esim.json';
    process.env.ALLOWANCES_URL = 'http://127.0.0.1:' + fileServer.address().port + '/data/allowances.json';
    process.env.ESIM_PROVIDER = 'nadanada';
    process.env.LN_PAYER = 'mock';
    process.env.STORE = 'memory';
    process.env.NADANADA_ALLOW_MEMORY_STORE = '1';
    process.env.NADANADA_BASE_URL = fake.base;
    process.env.NADANADA_COMPLETE_WAIT_MS = '3000';
    delete process.env.VERCEL_URL;
    const redeem = require(path.join(API, 'redeem.js'));
    const GET = (address) => call(redeem, { method: 'GET', url: '/api/redeem?address=' + address });
    const POST = (body) => call(redeem, { method: 'POST', url: '/api/redeem', body });

    let r = await GET(RICH);
    check('RICH\'s dashboard before redeeming: tokens, share, $300 allowance, $0 used, $300 left', [r.body.tokens, r.body.share, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders], [RICH_TOKENS.toString(), 0.6, 300, 0, 300, []]);

    const europe = await POST(signed(RICH_KEY, 'fixed_5GB_30D_EUROPE', 0));
    check('RICH redeems Europe ($5.99): order n=0, done, $294.01 left', [europe.status, europe.body.order.n, europe.body.order.stage, europe.body.remainingUsd], [200, 0, 'done', 294.01]);
    checkThat('a real eSIM record: 19-digit ICCID, an LPA activation code, an https QR', /^\d{19}$/.test(europe.body.order.iccid) && europe.body.order.ac.startsWith('LPA:1$') && /^https/.test(europe.body.order.qrCodeUrl), JSON.stringify(europe.body.order));
    check('the Lightning wallet paid exactly one invoice for it', mockPayer._state.log.length, 1);

    const germany = await POST(signed(RICH_KEY, 'fixed_1GB_7D_DE', 1));
    check('RICH redeems Germany too ($1.99): order n=1, $292.02 left', [germany.status, germany.body.order.n, germany.body.remainingUsd], [200, 1, 292.02]);
    check('two invoices paid so far, one per eSIM', mockPayer._state.log.length, 2);

    const purchasesBeforeReplay = fake.purchases();
    const replay = await POST(signed(RICH_KEY, 'fixed_5GB_30D_EUROPE', 0));
    check('redeeming slot n=0 again mints nothing new: the same order comes back, flagged replayed', [replay.status, replay.body.replayed, replay.body.order.iccid, replay.body.remainingUsd], [200, true, europe.body.order.iccid, 292.02]);
    check('nadanada was not asked again and the wallet did not pay again', [fake.purchases() - purchasesBeforeReplay, mockPayer._state.log.length], [0, 2]);

    const poorerOrder = await POST(signed(POORER_KEY, 'fixed_1GB_7D_DE', 0));
    check('POORER, a different holder with a different share, redeems from its OWN $200 allowance: $198.01 left', [poorerOrder.status, poorerOrder.body.order.n, poorerOrder.body.remainingUsd], [200, 0, 198.01]);

    r = await GET(RICH);
    check('RICH is unaffected by POORER\'s redemption: still $292.02 left, two orders', [r.body.remainingUsd, r.body.orders.length], [292.02, 2]);
    check('and RICH\'s used + left still equal its allowance', round2(r.body.redeemedUsd + r.body.remainingUsd), 300);
    r = await GET(POORER);
    check('POORER\'s own dashboard agrees: $1.99 used, $198.01 left, its own allowance untouched by RICH', [r.body.tokens, r.body.share, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd], [POORER_TOKENS.toString(), 0.4, 200, 1.99, 198.01]);

    // -------------------------------------------------------------------------------------
    console.log('\nMONEY CONSERVATION — follow one dollar through every stage');
    // -------------------------------------------------------------------------------------
    // What the pool actually paid nadanada is read from the wallet's own ledger, not
    // recomputed by hand: nadanada charges 95% of the catalogue price in sats (see
    // site/api/lib/providers/nadanada.js's header comment), and hand-predicting the sat
    // rounding would just be re-deriving the same arithmetic the real code already did. The
    // wallet's own before/after balance is the ground truth.
    const paidSats = mockPayer._state.log.reduce((s, l) => s + l.sats, 0);
    const paidUsd = round2(paidSats * mockPayer._state.usdPerSat);
    const creditSpentUsd = round2(europe.body.order.priceUsd + germany.body.order.priceUsd + poorerOrder.body.order.priceUsd);
    console.log(`  tax collected last week:  ${usd(500)}`);
    console.log(`  claimed by claim.js:      ${usd(claimedUsd)}`);
    console.log(`  moved to Lightning:       ${usd(fundedUsd)} (${fundResult.sats} sats)`);
    console.log(`  actually paid nadanada:   ${usd(paidUsd)} (${paidSats} sats, for ${mockPayer._state.log.length} eSIMs)`);
    console.log(`  catalogue credit charged: ${usd(creditSpentUsd)} (what the holders' allowances were debited)`);
    checkThat('the wallet\'s own bookkeeping is exact: sats before minus sats after equals sats actually paid', poolSatsAfterFund - mockPayer._state.sats === paidSats, `${poolSatsAfterFund} - ${mockPayer._state.sats} != ${paidSats}`);
    checkThat('what was actually paid to nadanada is covered by what was funded', paidUsd <= fundedUsd, `paid ${paidUsd} > funded ${fundedUsd}`);
    checkThat('what was funded is covered by what was claimed', fundedUsd <= claimedUsd, `funded ${fundedUsd} > claimed ${claimedUsd}`);
    checkThat('nadanada\'s 5% Lightning discount means the pool paid less than the credit it charged holders', paidUsd < creditSpentUsd, `paid ${paidUsd} >= charged ${creditSpentUsd}`);
    checkThat('no stage lost or invented money: nothing here is negative', escrowBeforeClaim >= 0n && world.treasuryUsdgUnits >= 0n && mockPayer._state.sats >= 0, 'a balance went negative');

    // -------------------------------------------------------------------------------------
    console.log('\nTHE WEEK ROLLS — one week later, the indexer runs again');
    // -------------------------------------------------------------------------------------
    // Only the clock moves and the indexer re-runs, exactly as the brief asks: claim.js and
    // fund.js are not re-invoked (that is a separate, unrelated cron in production too).
    setClock(NOW0 + A.WEEK_S * 1000);
    checkThat('the clock actually moved a week: weekOf(now) is WEEK+1', A.weekOf(now()) === WEEK + 1, now());

    const week2 = await A.run({ config: CONFIG, addresses: ADDRESSES, rpc: rawRpc, out: OUT.allowances2, fromBlock: LAUNCH_BLOCK, log: (m) => console.log('  ' + m) });
    check('week WEEK+1\'s budget is week WEEK\'s tax ($130 + $80), not last week\'s $500', [week2.data.week, week2.data.budgetUsd], [WEEK + 1, 210]);
    const w2 = week2.data.wallets;
    check('RICH still holds the same tokens and the same 0.6 share (redeeming an eSIM never moves the coin)', [w2[RICH].tokens, w2[RICH].share], [RICH_TOKENS.toString(), 0.6]);
    check('but RICH\'s allowance is recomputed from the new, smaller budget: $126.00, not $300 and not $292.02 carried over', w2[RICH].allowanceUsd, 126);
    check('POORER\'s allowance is recomputed too: $84.00', w2[POORER].allowanceUsd, 84);
    served.allowances = week2.data;

    r = await GET(RICH);
    check('RICH\'s new-week dashboard: $126.00 allowance, $0 used, nothing carried over from last week\'s $292.02', [r.body.week, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders], [WEEK + 1, 126, 0, 126, []]);
    check('last week\'s two eSIMs are still in history, most recent week first, still without codes on a plain GET', r.body.history.map((o) => [o.week, o.n, o.packageCode, o.iccid, o.ac]), [[WEEK, 0, 'fixed_5GB_30D_EUROPE', europe.body.order.iccid, ''], [WEEK, 1, 'fixed_1GB_7D_DE', germany.body.order.iccid, '']]);

    const germanyAgain = await POST(signed(RICH_KEY, 'fixed_1GB_7D_DE', 0));
    check('RICH can redeem again in the new week, at n=0 of a fresh sequence: $124.01 left', [germanyAgain.status, germanyAgain.body.order.n, germanyAgain.body.remainingUsd], [200, 0, 124.01]);
    checkThat('it is a genuinely new eSIM, not last week\'s Germany order replayed under a new week number', germanyAgain.body.order.iccid !== germany.body.order.iccid, germanyAgain.body.order.iccid);

    r = await GET(POORER);
    check('POORER\'s new-week allowance is recomputed the same way: $84.00, untouched by RICH\'s new redemption', [r.body.week, r.body.allowanceUsd, r.body.remainingUsd], [WEEK + 1, 84, 84]);

    // -------------------------------------------------------------------------------------
    console.log('\nSTAGE 8 — scripts/treasury.js reports the pool');
    // -------------------------------------------------------------------------------------
    const nadanadaProvider = providers.provider();   // ESIM_PROVIDER=nadanada, still set from STAGE 5/6/7
    const claimsWritten = JSON.parse(fs.readFileSync(OUT.claims, 'utf8'));
    const treasuryResult = await T.run({ rpc: rawRpc, config: CONFIG, addresses: ADDRESSES, provider: nadanadaProvider, claims: claimsWritten, out: OUT.treasury, log: (m) => console.log('  ' + m) });
    const td = treasuryResult.data;
    console.log(`  treasury: ${td.status}, wallet ${usd(td.walletUsd)}, escrow ${usd(td.escrowClaimableUsd)}, pool ${usd(td.reseller.balanceUsd)} (${td.reseller.sats} sats), ${td.redemptions30d} redemption(s) / ${usd(td.spend30dUsd)}`);
    check('the still-unclaimed week-WEEK tax shows up as claimable escrow: exactly $210.00', td.escrowClaimableUsd, 210);
    check('the treasury\'s own USDG wallet reflects exactly what fund.js left behind', td.walletUsd, round2(Number(world.treasuryUsdgUnits) / 1e6));
    checkThat('the pool\'s Lightning balance reflects exactly what is left after every redemption', td.reseller.balanceUsd === round2(mockPayer._state.sats * mockPayer._state.usdPerSat) && td.reseller.sats === mockPayer._state.sats, JSON.stringify(td.reseller));
    check('all four redemptions across both weeks are counted (30 days is wider than the one week between them)', td.redemptions30d, 4);
    checkThat('the 30-day spend is the pool\'s real Lightning cost, not the catalogue credit charged to holders', td.spend30dUsd < creditSpentUsd + germanyAgain.body.order.priceUsd, `spend30dUsd=${td.spend30dUsd}`);
    check('statusOf(), fed the report\'s own numbers, agrees with the status the report wrote down', T.statusOf({ balanceUsd: td.reseller.balanceUsd, runwayDays: td.runwayDays }), td.status);
    checkThat('treasury.json was written under the temp dir, not site/data', fs.existsSync(OUT.treasury), OUT.treasury);

    // -------------------------------------------------------------------------------------
    console.log('\nHOUSEKEEPING');
    // -------------------------------------------------------------------------------------
    const realDataAfter = Object.fromEntries(REAL_DATA_FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    check('the repo\'s own site/data/*.json were never touched by any stage above', realDataAfter, realDataBefore);
  } finally {
    restoreClock();
    await Promise.all([
      fake.close(),
      new Promise((r) => fileServer.close(r)),
      new Promise((r) => ffServer.close(r)),
      new Promise((r) => acrossServer.close(r)),
    ]);
  }

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { restoreClock(); console.error(e); process.exit(1); });
