#!/usr/bin/env node
'use strict';
/**
 * Membership through /api/redeem (docs/membership.md): what a wallet's standing says about it,
 * when the app may offer the burn, and the signed welcome-eSIM claim — proven by the weekly
 * ledger, or for a burn newer than the ledger by that burn's receipt, read from a fake chain.
 *
 * Everything runs in this process: a node:http server for the deployment's files, a second one
 * standing in for the chain's JSON-RPC, and the mock eSIM provider.
 *
 *   node test/redeem-membership.test.js
 */
const http = require('node:http');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const secp = require(path.join(API, '_lib', 'secp256k1.js'));
const eip191 = require(path.join(API, '_lib', 'eip191.js'));
const mock = require(path.join(API, '_lib', 'providers', 'mock.js'));
const week = require(path.join(API, '_lib', 'week.js'));
const rules = require(path.join(API, '_lib', 'membership.js'));

let failures = 0, checks = 0;
function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${what}`);
}
function checkThat(what, cond, detail) {
  checks++;
  if (!cond) { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
  else console.log(`  ok   ${what}`);
}

const CUR = week.weekOf(Math.floor(Date.now() / 1000));
const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const UNITS = 100000n * 10n ** 18n;
const addr = (k) => secp.addressOf(k).toLowerCase();
const MEMBER = secp.newPrivateKey();     // in the ledger's members, and sharing this week
const FRESH = secp.newPrivateKey();      // burned after the ledger was written
const SHORT = secp.newPrivateKey();      // burned only half the amount
const STRANGER = secp.newPrivateKey();   // never burned

const PACKAGES = [
  { code: 'fixed_1GB_7D_AU', slug: 'australia', name: 'Australia', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'Australia' },
  { code: 'fixed_1GB_7D_JP', slug: 'japan', name: 'Japan', kind: 'country', gb: 1, days: 7, priceUsd: 2.99, regions: 'Japan' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '120+ countries' },
  { code: 'fixed_5GB_30D_AU', slug: 'australia', name: 'Australia', kind: 'country', gb: 5, days: 30, priceUsd: 7.99, regions: 'Australia' },
];
const MEMBERSHIP = { burnTokens: '100000', burnAddress: DEAD, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } };
const config = (membership = MEMBERSHIP) => Object.assign({ coin: COIN, curve: CURVE, treasury: '', taxBps: 1000, budgetBps: 8000, provider: 'mock', packages: PACKAGES },
  membership ? { membership } : {});
const allowances = (coin = COIN) => ({
  asOf: 1789600000, block: 64200000, week: CUR, weekStart: week.weekStart(CUR), weekEnd: week.weekEnd(CUR),
  snapshotBlock: 64100000, coin, curve: CURVE, budgetUsd: 100, budgetSource: 'test fixture',
  circulating: '2000000000000000000000000', decimals: 18, holders: 2,
  membership: { burnTokens: '100000', burnUnits: UNITS.toString(), burnAddress: DEAD.toLowerCase(), capMultiple: 3, members: 1, capUsd: 300, allocatedUsd: 3, unallocatedUsd: 97 },
  members: { [addr(MEMBER)]: { burned: UNITS.toString(), sinceBlock: 64000000, tx: '0x' + 'a'.repeat(64) } },
  wallets: {
    [addr(MEMBER)]: { tokens: '900000000000000000000000', share: 0.45, allowanceUsd: 3, member: true },
    [addr(STRANGER)]: { tokens: '1100000000000000000000000', share: 0.55, allowanceUsd: 0, member: false },
  },
});
const funded = { status: 'funded', reseller: { name: 'wholesale', balanceUsd: 50 }, owedUsd: 10 };
const FILES = {};
function serve(files) {
  for (const k of Object.keys(FILES)) delete FILES[k];
  Object.assign(FILES, files);
}

// The chain: receipts for a few transactions, and the coin's decimals().
const TX = (c) => '0x' + c.repeat(64);
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const burnLog = (from, units, { to = DEAD, token = COIN } = {}) => ({
  address: token, topics: [rules.TRANSFER_TOPIC, pad(from), pad(to)], data: '0x' + units.toString(16).padStart(64, '0'),
});
const RECEIPTS = {
  [TX('b')]: { status: '0x1', logs: [burnLog(addr(FRESH), UNITS)] },
  [TX('c')]: { status: '0x1', logs: [burnLog(addr(SHORT), UNITS / 2n)] },
  [TX('d')]: { status: '0x0', logs: [burnLog(addr(SHORT), UNITS)] },
  [TX('e')]: { status: '0x1', logs: [burnLog(addr(SHORT), UNITS, { token: CURVE })] },
};
const rpcCalls = [];

function call(handler, { method, url, body }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (body !== undefined) req.body = JSON.stringify(body);
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    handler(req, res).catch((e) => resolve({ status: 'THREW', body: { error: String(e && e.message) } }));
  });
}

const now = () => Math.floor(Date.now() / 1000);
const HEADS = { read: 'OT+T — show my eSIM codes', redeem: 'OT+T — authorise a data redemption', welcome: 'OT+T — claim my welcome eSIM' };
function message(address, action, packageCode, { n = 0, ts = now() } = {}) {
  const lines = [HEADS[action], 'Site: ott.test', 'Wallet: ' + address];
  if (action !== 'read') lines.push('Plan: ' + packageCode);
  if (action === 'redeem') lines.push('Slot: ' + n);
  lines.push('Issued: ' + ts);
  return lines.join('\n');
}
function welcome(key, packageCode, opts = {}) {
  const address = addr(key);
  const msg = opts.message || message(address, opts.action || 'welcome', opts.signedPlan || packageCode);
  const body = { address, message: msg, signature: eip191.sign(key, msg), welcome: true, packageCode };
  if (opts.burnTx !== undefined) body.burnTx = opts.burnTx;
  return body;
}

async function main() {
  const files = http.createServer((req, res) => {
    const file = FILES[new URL(req.url, 'http://x').pathname];
    if (!file) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(file));
  });
  const chain = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { method, params } = JSON.parse(raw);
      rpcCalls.push(method);
      let result = null;
      if (method === 'eth_getTransactionReceipt') result = RECEIPTS[String(params[0]).toLowerCase()] || null;
      if (method === 'eth_call' && params[0].data === '0x313ce567') result = '0x' + (18).toString(16).padStart(64, '0');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  await new Promise((r) => chain.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + files.address().port;
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';
  process.env.ALLOWANCES_URL = base + '/data/allowances.json';
  process.env.TREASURY_URL = base + '/data/treasury.json';
  process.env.CHAIN_RPC_URLS = 'http://127.0.0.1:' + chain.address().port;
  process.env.ESIM_PROVIDER = 'mock';
  process.env.SIGNIN_HOST = 'ott.test';
  delete process.env.REDEMPTIONS_ENABLED;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;

  const redeem = require(path.join(API, 'redeem.js'));
  const GET = async (key) => { redeem._resetCaches(); return call(redeem, { method: 'GET', url: '/api/redeem?address=' + addr(key) }); };
  const POST = async (body) => { redeem._resetCaches(); return call(redeem, { method: 'POST', url: '/api/redeem', body }); };
  serve({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded });

  console.log('the welcome id is fixed forever and never a weekly one');
  check('a known address has a known welcome id', redeem.welcomeIdFor('0x1111111111111111111111111111111111111111'), 'ott-c6b550bcaae31eea928f19b8fd4c6955');
  checkThat('it is not slot 0 of this week', redeem.welcomeIdFor(addr(MEMBER)) !== redeem.transactionIdFor(addr(MEMBER), CUR, 0));

  console.log('\nwhat a member\'s standing says');
  let r = await GET(MEMBER);
  check('GET answers 200', r.status, 200);
  check('the membership object', r.body.membership, {
    configured: true, burnTokens: '100000', burnUnits: UNITS.toString(), burnAddress: DEAD, coin: COIN,
    welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3,
    member: true, memberSinceBlock: 64000000, sharing: true, welcomeOrder: null,
    enrolment: { open: true, reason: '' },
  });
  check('weekly credit is the ledger\'s capped share', [r.body.allowanceUsd, r.body.remainingUsd], [3, 3]);
  r = await GET(STRANGER);
  check('a holder who never burned is not a member and does not share', [r.body.membership.member, r.body.membership.sharing, r.body.allowanceUsd], [false, false, 0]);
  check('and may be offered the burn', r.body.membership.enrolment, { open: true, reason: '' });

  console.log('\nthe burn is offered only when a welcome eSIM can be paid for');
  const enrolment = async (files, env = {}) => {
    serve(Object.assign({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded }, files));
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return (await GET(STRANGER)).body.membership; }
    finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  let m = await enrolment({}, { REDEMPTIONS_ENABLED: '0' });
  check('not while purchases are off', [m.enrolment.open, m.enrolment.reason], [false, 'Joining opens when eSIM purchases are switched on.']);
  m = await enrolment({ '/data/treasury.json': Object.assign({}, funded, { owedUsd: 47 }) });
  check('not when the pool less what this week owes is under the $4 welcome price', [m.enrolment.open, /too low/.test(m.enrolment.reason)], [false, true]);
  m = await enrolment({ '/data/treasury.json': Object.assign({}, funded, { status: 'low' }) });
  check('not when the treasury reports the pool low', m.enrolment.open, false);
  m = await enrolment({ '/data/treasury.json': undefined });
  check('not when the treasury cannot be read', [m.enrolment.open, /cannot be confirmed/.test(m.enrolment.reason)], [false, true]);
  m = await enrolment({ '/data/treasury.json': Object.assign({}, funded, { owedUsd: null }) });
  check('not when what this week owes is unknown', m.enrolment.open, false);
  m = await enrolment({ '/data/allowances.json': allowances('0x3333333333333333333333333333333333333333') });
  check('not before the ledger is about this coin, and no burn amount is offered', [m.enrolment.open, m.burnUnits, m.member], [false, null, false]);
  m = await enrolment({ '/config/esim.json': config(null) });
  check('without a membership block there is nothing to offer', m, { configured: false });
  serve({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded });

  console.log('\nthe welcome claim: what may be claimed, and by whom');
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_GLOBAL'));
  check('the $8.99 Global plan is not included', [r.status, r.body.error], [400, 'this plan is not included with membership']);
  r = await POST(welcome(MEMBER, 'fixed_5GB_30D_AU'));
  check('nor is a larger plan', [r.status, r.body.error], [400, 'this plan is not included with membership']);
  r = await POST(welcome(MEMBER, 'nope'));
  check('an unknown plan is refused', [r.status, r.body.error], [400, 'unknown package']);
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_AU'));
  check('a wallet that never burned is told to join first', [r.status, r.body.error], [409, 'burn 100,000 OTT to join first']);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU', { action: 'redeem' }));
  check('a redemption signature cannot claim a welcome eSIM', [r.status, r.body.error], [401, 'this signature does not authorise a welcome eSIM claim']);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU', { signedPlan: 'fixed_1GB_7D_JP' }));
  check('a signature for another plan cannot claim this one', [r.status, r.body.error], [401, 'this signature authorises a different plan']);
  const welcomeSigned = welcome(MEMBER, 'fixed_1GB_7D_AU');
  r = await POST({ address: welcomeSigned.address, message: welcomeSigned.message, signature: welcomeSigned.signature, packageCode: 'fixed_1GB_7D_AU', n: 0 });
  check('and a welcome signature cannot place a weekly order', [r.status, r.body.error], [401, 'this signature does not authorise a redemption']);
  check('none of that placed an order', await mock.find(redeem.welcomeIdFor(addr(MEMBER))), null);

  console.log('\na ledger member claims');
  rpcCalls.length = 0;
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('the claim succeeds', [r.status, r.body.ok, r.body.replayed], [200, true, undefined]);
  check('the order is marked as the welcome order, outside every week', [r.body.order.welcome, r.body.order.week, r.body.order.transactionId], [true, null, redeem.welcomeIdFor(addr(MEMBER))]);
  checkThat('its activation code comes back on this signed answer', /^LPA:1\$/.test(r.body.order.ac), r.body.order.ac);
  check('the new eSIM is listed with its codes', [r.body.sims.length, !!r.body.sims[0].ac], [1, true]);
  check('the ledger was proof enough: the chain was not asked', rpcCalls, []);
  r = await GET(MEMBER);
  check('the standing now shows the welcome order, without its code', [r.body.membership.welcomeOrder.welcome, r.body.membership.welcomeOrder.ac], [true, '']);
  check('and the welcome eSIM did not touch weekly credit', [r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.length], [0, 3, 0]);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('repeating the same claim returns the same order', [r.status, r.body.replayed, r.body.order.transactionId], [200, true, redeem.welcomeIdFor(addr(MEMBER))]);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_JP'));
  check('a second welcome eSIM for another place is refused', [r.status, r.body.error], [409, 'your welcome eSIM has already been claimed']);
  const readMsg = message(addr(MEMBER), 'read');
  r = await POST({ address: addr(MEMBER), message: readMsg, signature: eip191.sign(MEMBER, readMsg) });
  checkThat('a signed read shows the welcome order\'s code', r.status === 200 && /^LPA:1\$/.test(r.body.membership.welcomeOrder.ac), JSON.stringify(r.body.membership && r.body.membership.welcomeOrder));

  console.log('\na burn newer than the ledger is proven by its receipt');
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { burnTx: 'not-a-hash' }));
  check('a malformed transaction hash is refused', [r.status, r.body.error], [400, 'burnTx must be a transaction hash']);
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { burnTx: TX('f') }));
  check('an unknown transaction proves nothing', [r.status, r.body.error], [409, 'the burn transaction was not found or did not burn enough OTT']);
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_JP', { burnTx: TX('b') }));
  check('someone else\'s burn does not make this wallet a member', [r.status, r.body.error], [409, 'the burn transaction was not found or did not burn enough OTT']);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { burnTx: TX('c') }));
  check('half the amount is not enough', r.status, 409);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { burnTx: TX('d') }));
  check('a reverted burn is not a burn', r.status, 409);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { burnTx: TX('e') }));
  check('burning a different token is not joining', r.status, 409);
  rpcCalls.length = 0;
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { burnTx: TX('b').toUpperCase().replace('0X', '0x') }));
  check('the fresh member\'s claim succeeds', [r.status, r.body.order && r.body.order.welcome], [200, true]);
  check('one receipt read, no decimals read because the ledger knows the coin', rpcCalls, ['eth_getTransactionReceipt']);
  serve({ '/config/esim.json': config(), '/data/allowances.json': allowances('0x3333333333333333333333333333333333333333'), '/data/treasury.json': funded });
  rpcCalls.length = 0;
  const later = secp.newPrivateKey();
  RECEIPTS[TX('9')] = { status: '0x1', logs: [burnLog(addr(later), UNITS)] };
  r = await POST(welcome(later, 'fixed_1GB_7D_AU', { burnTx: TX('9') }));
  check('before the ledger knows the coin, its decimals are read from the chain', [r.status, rpcCalls.slice().sort()], [200, ['eth_call', 'eth_getTransactionReceipt']]);
  serve({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded });

  console.log('\nthe switches still apply');
  process.env.REDEMPTIONS_ENABLED = '0';
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_AU'));
  check('no welcome claims while purchases are off', [r.status, r.body.error], [503, 'data redemption is not enabled yet']);
  delete process.env.REDEMPTIONS_ENABLED;
  serve({ '/config/esim.json': config(null), '/data/allowances.json': allowances(), '/data/treasury.json': funded });
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('no welcome claims without a membership block', [r.status, r.body.error], [503, 'membership is not configured']);
  r = await GET(MEMBER);
  check('and the standing says membership is off', r.body.membership, { configured: false });
  delete process.env.CHAIN_RPC_URLS;
  serve({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded });

  files.close();
  chain.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
