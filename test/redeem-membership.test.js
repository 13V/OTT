#!/usr/bin/env node
'use strict';
/**
 * Membership through /api/redeem (docs/membership.md): what a wallet's standing says about it,
 * this week's join amount, when the app may offer the join, and the signed welcome-eSIM claim —
 * proven by the weekly ledger, or for a join newer than the ledger by that transaction itself,
 * read from a fake Solana RPC and judged by the ledger's own rule.
 *
 * Everything runs in this process: a node:http server for the deployment's files, a second one
 * standing in for Solana's JSON-RPC, and the mock eSIM provider. The join transactions are the real
 * mainnet transfer in test/fixtures/solana/join-creates-account.json with this test's coin, wallets
 * and amounts put in. Every fetch outside those two servers is refused, so the configured public
 * endpoints are never reached.
 *
 *   node test/redeem-membership.test.js
 */
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const mock = require(path.join(API, '_lib', 'providers', 'mock.js'));
const week = require(path.join(API, '_lib', 'week.js'));
const FIXTURE = require(path.join(__dirname, 'fixtures', 'solana', 'join-creates-account.json'));

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

function newWallet() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const address = S.encodeBase58(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  return { address, sign: (text) => S.encodeBase58(new Uint8Array(crypto.sign(null, Buffer.from(text, 'utf8'), privateKey))) };
}
const randomSignature = () => S.encodeBase58(new Uint8Array(crypto.randomBytes(64)));

const CUR = week.weekOf(Math.floor(Date.now() / 1000));
const START = week.weekStart(CUR);
const TOKEN_2022 = S.PROGRAMS.token2022;
const COIN = newWallet().address;
const TREASURY_KEY = newWallet();
const TREASURY = TREASURY_KEY.address;
const BURN_ACCOUNT = newWallet().address;
const UNITS = 1800000000000n;          // 1,800,000 OTT at 6 decimals: this week's amount
const LAST_WEEK_UNITS = 1500000000000n;
const CURSOR_SLOT = 458000000;

const MEMBER = newWallet();     // in the ledger's members, and sharing this week
const PARTIAL = newWallet();    // the ledger counted half; a fresh join sends the other half
const FRESH = newWallet();      // joined after the ledger was written
const EARLY = newWallet();      // joined in the first minutes of the week, at last week's lower amount
const SHORT = newWallet();      // sent too little
const OLD = newWallet();        // names a transaction the ledger has already read
const STRANGER = newWallet();   // never joined
const LATER = newWallet();      // joins in a week the ledger has not priced
const MEMBER_SINCE = { at: START + 3600, slot: 457000000, tx: randomSignature() };

const PACKAGES = [
  { code: 'fixed_1GB_7D_AU', slug: 'australia', name: 'Australia', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'Australia' },
  { code: 'fixed_1GB_7D_JP', slug: 'japan', name: 'Japan', kind: 'country', gb: 1, days: 7, priceUsd: 2.99, regions: 'Japan' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '120+ countries' },
  { code: 'fixed_5GB_30D_AU', slug: 'australia', name: 'Australia', kind: 'country', gb: 5, days: 30, priceUsd: 7.99, regions: 'Australia' },
];
const MEMBERSHIP = { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } };
const config = (membership = MEMBERSHIP) => ({ chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, budgetBps: 8000, provider: 'mock', packages: PACKAGES, membership });
const REQUIREMENT = { week: CUR, burnTokens: '1800000', burnUnits: UNITS.toString(), priceUsd: 0.0000029, solUsd: 103.75, source: 'bonding-curve', at: START + 120 };
function allowances({ coin = COIN, fileWeek = CUR, requirement = REQUIREMENT, requirements = { [CUR - 1]: LAST_WEEK_UNITS.toString(), [CUR]: UNITS.toString() } } = {}) {
  return {
    asOf: 1792245000, slot: CURSOR_SLOT + 10, chain: 'solana', week: fileWeek, weekStart: week.weekStart(fileWeek), weekEnd: week.weekEnd(fileWeek),
    coin, tokenProgram: TOKEN_2022, decimals: 6, treasury: TREASURY,
    budgetUsd: 100, budgetSource: 'test fixture',
    membership: {
      burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3,
      requirement, requirements, members: 1, capUsd: 300, allocatedUsd: 3, unallocatedUsd: 97,
      cursor: { signature: randomSignature(), slot: CURSOR_SLOT },
    },
    members: { [MEMBER.address]: { burned: UNITS.toString(), since: MEMBER_SINCE } },
    joins: { [PARTIAL.address]: { burned: '900000000000', last: { at: START + 7200, slot: 457500000, tx: randomSignature() } } },
    holders: 1, memberTokens: '900000000000',
    wallets: { [MEMBER.address]: { tokens: '900000000000', share: 1, allowanceUsd: 3, member: true } },
  };
}
const funded = { status: 'funded', reseller: { name: 'wholesale', balanceUsd: 50 }, owedUsd: 10 };
const FILES = {};
function serve(files) {
  for (const k of Object.keys(FILES)) delete FILES[k];
  Object.assign(FILES, files);
}

// A join transaction: the real fixture with this test's coin, sender, incinerator account,
// signature, slot, time and amount substituted in.
const FX = {
  mint: 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump', sender: 'GWUESs5wHvAqLR9gNLS6G4BKPqnCZ2iCe91o311EqMpR',
  source: 'DyK5diJGfHrdE2DcwJimxG5brSJoEDMbpdG83JeB3rAT', burn: 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF', signature: FIXTURE.transaction.signatures[0],
};
const TXS = {};
function join({ from, amount, slot = CURSOR_SLOT + 5, at = START + 86400, coin = COIN, burnAccount = BURN_ACCOUNT, err = null }) {
  const signature = randomSignature();
  let text = JSON.stringify(FIXTURE);
  for (const [a, b] of [[FX.mint, coin], [FX.sender, from], [FX.source, newWallet().address], [FX.burn, burnAccount], [FX.signature, signature]]) text = text.split(a).join(b);
  const tx = JSON.parse(text);
  tx.slot = slot; tx.blockTime = at; tx.meta.err = err;
  const start = 10n ** 15n;
  tx.meta.preTokenBalances[0].uiTokenAmount.amount = String(start);
  tx.meta.postTokenBalances[0].uiTokenAmount.amount = String(start - amount);
  tx.meta.postTokenBalances[1].uiTokenAmount.amount = String(amount);
  TXS[signature] = tx;
  return signature;
}
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
  const msg = opts.message || message(key.address, opts.action || 'welcome', opts.signedPlan || packageCode);
  const body = { address: key.address, message: msg, signature: key.sign(msg), welcome: true, packageCode };
  if (opts.joinTx !== undefined) body.joinTx = opts.joinTx;
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
      if (method === 'getTransaction') {
        const opts = params[1] || {};
        result = opts.encoding === 'jsonParsed' && opts.maxSupportedTransactionVersion === 1 ? TXS[params[0]] || null : null;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  await new Promise((r) => chain.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + files.address().port;
  const chainUrl = 'http://127.0.0.1:' + chain.address().port;
  // Offline: the RPC list also names the public endpoints from config/addresses.json. They are
  // answered by a local chain too (normally the same one, so every node agrees), and nothing
  // leaves the machine.
  const realFetch = global.fetch;
  const PUBLIC_RPCS = require(path.join(__dirname, '..', 'config', 'addresses.json')).rpcs;
  let publicChain = chainUrl;
  global.fetch = (url, opts) => {
    if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, opts);
    if (PUBLIC_RPCS.includes(String(url))) return realFetch(publicChain, opts);
    return Promise.reject(new Error('offline test'));
  };
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';
  process.env.ALLOWANCES_URL = base + '/data/allowances.json';
  process.env.TREASURY_URL = base + '/data/treasury.json';
  process.env.SOLANA_RPC_URL = chainUrl;
  process.env.ESIM_PROVIDER = 'mock';
  process.env.SIGNIN_HOST = 'ott.test';
  delete process.env.REDEMPTIONS_ENABLED;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;

  const redeem = require(path.join(API, 'redeem.js'));
  const GET = async (key) => { redeem._resetCaches(); return call(redeem, { method: 'GET', url: '/api/redeem?address=' + key.address }); };
  const POST = async (body) => { redeem._resetCaches(); return call(redeem, { method: 'POST', url: '/api/redeem', body }); };
  const standardFiles = (more = {}) => Object.assign({ '/config/esim.json': config(), '/data/allowances.json': allowances(), '/data/treasury.json': funded }, more);
  serve(standardFiles());

  console.log('the welcome id is fixed forever and never a weekly one');
  check('a known 0x address keeps its known welcome id', redeem.welcomeIdFor('0x1111111111111111111111111111111111111111'), 'ott-c6b550bcaae31eea928f19b8fd4c6955');
  check('a known base58 address has a known welcome id', redeem.welcomeIdFor(S.INCINERATOR), 'ott-' + require(path.join(API, '_lib', 'keccak.js')).keccak256Hex(S.INCINERATOR.toLowerCase() + ':welcome:0').slice(2, 34));
  check('and it is this one, forever', redeem.welcomeIdFor(S.INCINERATOR), 'ott-867137433cecaa9e50a6b2770b852c24');
  checkThat('it is not slot 0 of this week', redeem.welcomeIdFor(MEMBER.address) !== redeem.transactionIdFor(MEMBER.address, CUR, 0));

  console.log('\nwhat a member\'s standing says');
  let r = await GET(MEMBER);
  check('GET answers 200, with the ledger\'s decimals', [r.status, r.body.decimals, r.body.tokens], [200, 6, '900000000000']);
  check('the membership object', r.body.membership, {
    configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6,
    burnOwner: S.INCINERATOR, burnAccount: BURN_ACCOUNT, burnUsd: 5,
    requirement: { week: CUR, burnTokens: '1800000', burnUnits: UNITS.toString(), priceUsd: 0.0000029 },
    burned: UNITS.toString(),
    welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3,
    member: true, memberSince: MEMBER_SINCE, sharing: true, welcomeOrder: null,
    enrolment: { open: true, reason: '' },
  });
  check('weekly credit is the ledger\'s capped share', [r.body.allowanceUsd, r.body.remainingUsd], [3, 3]);
  r = await GET(STRANGER);
  check('a holder who never joined is not a member, has sent nothing and does not share', [r.body.membership.member, r.body.membership.burned, r.body.membership.memberSince, r.body.membership.sharing, r.body.allowanceUsd], [false, '0', null, false, 0]);
  check('and may be offered the join', r.body.membership.enrolment, { open: true, reason: '' });
  r = await GET(PARTIAL);
  check('a partial join shows what the ledger has counted so far', [r.body.membership.member, r.body.membership.burned], [false, '900000000000']);

  console.log('\nthe join is offered only when this week\'s amount is known and a welcome eSIM can be paid for');
  const enrolment = async (files, env = {}) => {
    serve(standardFiles(files));
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
  m = await enrolment({ '/data/allowances.json': allowances({ coin: newWallet().address }) });
  check('not before the ledger is about this coin: no amount, no decimals, no membership read from it',
    [m.enrolment.open, m.enrolment.reason, m.requirement, m.decimals, m.member], [false, 'Joining opens once the weekly ledger includes the coin.', null, null, false]);
  m = await enrolment({ '/data/allowances.json': allowances({ fileWeek: CUR - 1, requirement: Object.assign({}, REQUIREMENT, { week: CUR - 1 }) }) });
  check('not while the ledger is last week\'s, and last week\'s amount is not offered', [m.enrolment.open, m.enrolment.reason, m.requirement], [false, 'Joining reopens once this week’s ledger is published.', null]);
  m = await enrolment({ '/data/allowances.json': allowances({ requirement: null }) });
  check('not before the keeper has priced this week', [m.enrolment.open, m.enrolment.reason, m.requirement], [false, 'This week’s join amount isn’t set yet. Try again shortly.', null]);
  m = await enrolment({ '/data/allowances.json': allowances({ requirement: Object.assign({}, REQUIREMENT, { week: CUR - 1 }) }) });
  check('an amount for another week is not this week\'s', [m.enrolment.open, m.requirement], [false, null]);
  m = await enrolment({ '/data/allowances.json': allowances({ requirement: Object.assign({}, REQUIREMENT, { burnUnits: '1800000000' }) }) });
  check('an amount whose tokens and base units disagree is not offered', [m.enrolment.open, m.requirement], [false, null]);
  m = await enrolment({ '/data/allowances.json': allowances({ requirements: { [CUR]: '2000000000000' } }) });
  check('nor one the weekly record disagrees with, since that record is what a join is judged by', [m.enrolment.open, m.requirement], [false, null]);
  m = await enrolment({ '/config/esim.json': config(Object.assign({}, MEMBERSHIP, { capMultiple: 0 })) });
  check('a malformed membership block means there is nothing to offer', m, { configured: false });
  serve(standardFiles());

  console.log('\nthe welcome claim: what may be claimed, and by whom');
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_GLOBAL'));
  check('the $8.99 Global plan is not included', [r.status, r.body.error], [400, 'this plan is not included with membership']);
  r = await POST(welcome(MEMBER, 'fixed_5GB_30D_AU'));
  check('nor is a larger plan', [r.status, r.body.error], [400, 'this plan is not included with membership']);
  r = await POST(welcome(MEMBER, 'nope'));
  check('an unknown plan is refused', [r.status, r.body.error], [400, 'unknown package']);
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_AU'));
  check('a wallet that never joined is told to join first', [r.status, r.body.error], [409, 'join OT+T first']);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU', { action: 'redeem' }));
  check('a redemption signature cannot claim a welcome eSIM', [r.status, r.body.error], [401, 'this signature does not authorise a welcome eSIM claim']);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU', { signedPlan: 'fixed_1GB_7D_JP' }));
  check('a signature for another plan cannot claim this one', [r.status, r.body.error], [401, 'this signature authorises a different plan']);
  const welcomeSigned = welcome(MEMBER, 'fixed_1GB_7D_AU');
  r = await POST({ address: welcomeSigned.address, message: welcomeSigned.message, signature: welcomeSigned.signature, packageCode: 'fixed_1GB_7D_AU', n: 0 });
  check('and a welcome signature cannot place a weekly order', [r.status, r.body.error], [401, 'this signature does not authorise a redemption']);
  r = await POST(Object.assign(welcome(MEMBER, 'fixed_1GB_7D_AU'), { signature: STRANGER.sign(welcomeSigned.message) }));
  check('another wallet\'s signature cannot claim for a member', [r.status, r.body.error], [401, 'signature does not match address']);
  check('none of that placed an order', await mock.find(redeem.welcomeIdFor(MEMBER.address)), null);

  console.log('\na ledger member claims');
  rpcCalls.length = 0;
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('the claim succeeds', [r.status, r.body.ok, r.body.replayed], [200, true, undefined]);
  check('the order is marked as the welcome order, outside every week', [r.body.order.welcome, r.body.order.week, r.body.order.transactionId], [true, null, redeem.welcomeIdFor(MEMBER.address)]);
  checkThat('its activation code comes back on this signed answer', /^LPA:1\$/.test(r.body.order.ac), r.body.order.ac);
  check('the new eSIM is listed with its codes', [r.body.sims.length, !!r.body.sims[0].ac], [1, true]);
  check('the ledger was proof enough: the chain was not asked', rpcCalls, []);
  r = await GET(MEMBER);
  check('the standing now shows the welcome order, without its code', [r.body.membership.welcomeOrder.welcome, r.body.membership.welcomeOrder.ac], [true, '']);
  check('and the welcome eSIM did not touch weekly credit', [r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.length], [0, 3, 0]);
  {
    // A weekly order from a wallet with nothing to spend says why, for each kind of wallet.
    const weekly = (key) => { const msg = message(key.address, 'redeem', 'fixed_1GB_7D_AU', { n: 0 }); return { address: key.address, message: msg, signature: key.sign(msg), packageCode: 'fixed_1GB_7D_AU', n: 0 }; };
    r = await POST(weekly(STRANGER));
    check('a wallet that never joined is told weekly credit is for members', [r.status, r.body.error], [409, 'weekly credit is for members, from the first Monday snapshot after they join']);
    const LATE = newWallet(), EMPTY = newWallet();
    const ledger = allowances();
    ledger.members[LATE.address] = { burned: UNITS.toString(), since: { at: START + 7200, slot: 457600000, tx: randomSignature() } };
    ledger.members[EMPTY.address] = { burned: UNITS.toString(), since: MEMBER_SINCE };
    ledger.wallets[EMPTY.address] = { tokens: '0', share: 0, allowanceUsd: 0, member: true };
    serve(standardFiles({ '/data/allowances.json': ledger }));
    r = await POST(weekly(LATE));
    check('a member who joined after the snapshot shares from the next one', [r.status, r.body.error], [409, 'your weekly share starts at the next Monday snapshot']);
    r = await POST(weekly(EMPTY));
    check('a member who held no OTT at the snapshot is told so', [r.status, r.body.error], [409, 'this wallet held no OTT at this week’s snapshot']);
    serve(standardFiles());
  }
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('repeating the same claim returns the same order', [r.status, r.body.replayed, r.body.order.transactionId], [200, true, redeem.welcomeIdFor(MEMBER.address)]);
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_JP'));
  check('a second welcome eSIM for another place is refused', [r.status, r.body.error], [409, 'your welcome eSIM has already been claimed']);
  const readMsg = message(MEMBER.address, 'read');
  r = await POST({ address: MEMBER.address, message: readMsg, signature: MEMBER.sign(readMsg) });
  checkThat('a signed read shows the welcome order\'s code', r.status === 200 && /^LPA:1\$/.test(r.body.membership.welcomeOrder.ac), JSON.stringify(r.body.membership && r.body.membership.welcomeOrder));

  console.log('\na join newer than the ledger is proven by the transaction itself');
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { joinTx: 'not-a-signature' }));
  check('a malformed signature is refused', [r.status, r.body.error], [400, 'joinTx must be a transaction signature']);
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { joinTx: '0x' + 'ab'.repeat(32) }));
  check('so is an EVM transaction hash', [r.status, r.body.error], [400, 'joinTx must be a transaction signature']);
  const NOT_FOUND = 'the join transaction was not found or did not send enough OTT';
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { joinTx: randomSignature() }));
  check('an unknown transaction proves nothing', [r.status, r.body.error], [409, NOT_FOUND]);
  const freshJoin = join({ from: FRESH.address, amount: UNITS });
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_JP', { joinTx: freshJoin }));
  check('someone else\'s join does not make this wallet a member', [r.status, r.body.error], [409, NOT_FOUND]);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: join({ from: SHORT.address, amount: UNITS - 1n }) }));
  check('one base unit short of this week\'s amount is not enough', [r.status, r.body.error], [409, NOT_FOUND]);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: join({ from: SHORT.address, amount: UNITS, err: { InstructionError: [1, { Custom: 1 }] } }) }));
  check('a failed transaction is not a join', r.status, 409);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: join({ from: SHORT.address, amount: UNITS, coin: newWallet().address }) }));
  check('sending another token is not joining', r.status, 409);
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: join({ from: SHORT.address, amount: UNITS, burnAccount: newWallet().address }) }));
  check('sending OTT anywhere but the incinerator\'s account is not joining', r.status, 409);
  r = await POST(welcome(OLD, 'fixed_1GB_7D_JP', { joinTx: join({ from: OLD.address, amount: UNITS, slot: CURSOR_SLOT }) }));
  check('a transaction the ledger has already read adds nothing to it', [r.status, r.body.error], [409, NOT_FOUND]);
  r = await POST(welcome(TREASURY_KEY, 'fixed_1GB_7D_JP', { joinTx: join({ from: TREASURY, amount: UNITS }) }));
  check('the treasury is never a member', [r.status, r.body.error], [409, NOT_FOUND]);
  r = await POST(welcome(LATER, 'fixed_1GB_7D_JP', { joinTx: join({ from: LATER.address, amount: UNITS * 10n, at: week.weekStart(CUR + 1) + 3600 }) }));
  check('a join in a week the ledger has not priced cannot be judged yet', [r.status, r.body.error], [409, NOT_FOUND]);
  rpcCalls.length = 0;
  r = await POST(welcome(FRESH, 'fixed_1GB_7D_JP', { joinTx: freshJoin }));
  check('the fresh member\'s claim succeeds', [r.status, r.body.order && r.body.order.welcome], [200, true]);
  check('one transaction read from the chain, nothing else', rpcCalls, ['getTransaction']);
  r = await POST(welcome(PARTIAL, 'fixed_1GB_7D_AU', { joinTx: join({ from: PARTIAL.address, amount: 900000000000n }) }));
  check('a fresh send on top of what the ledger counted reaches the amount', [r.status, r.body.order && r.body.order.welcome], [200, true]);
  r = await POST(welcome(EARLY, 'fixed_1GB_7D_AU', { joinTx: join({ from: EARLY.address, amount: LAST_WEEK_UNITS, at: START + 60 }) }));
  check('in the first ten minutes of the week, last week\'s lower amount is enough', [r.status, r.body.order && r.body.order.welcome], [200, true]);

  console.log('\nchain lookups for named joins are bounded');
  {
    // Without the per-request cache reset, as a live instance sees them.
    const raw = (body) => call(redeem, { method: 'POST', url: '/api/redeem', body });
    redeem._resetCaches();
    rpcCalls.length = 0;
    const missingTx = randomSignature();
    const claimant = newWallet();
    r = await raw(welcome(claimant, 'fixed_1GB_7D_JP', { joinTx: missingTx }));
    check('a join the chain has never seen is refused', [r.status, r.body.error], [409, NOT_FOUND]);
    const asked = rpcCalls.length;
    checkThat('the chain was asked', asked > 0);
    r = await raw(welcome(claimant, 'fixed_1GB_7D_JP', { joinTx: missingTx }));
    check('naming it again within seconds is answered without asking the chain again', [r.status, rpcCalls.length], [409, asked]);
    redeem._resetCaches();
    const cap = require(path.join(API, '_lib', 'rpc.js')).LOOKUPS_PER_MINUTE;
    let last = null;
    for (let i = 0; i <= cap; i++) last = await raw(welcome(newWallet(), 'fixed_1GB_7D_JP', { joinTx: randomSignature() }));
    check('past the lookup cap a claim is told to try again, not refused', [last.status, last.body.error], [503, 'the chain could not be read just now; try again in a moment']);
    redeem._resetCaches();
  }

  console.log('\nwhen the chain cannot be read');
  const downChain = http.createServer((req, res) => { res.statusCode = 502; res.end('down'); });
  await new Promise((done) => downChain.listen(0, '127.0.0.1', done));
  const downUrl = 'http://127.0.0.1:' + downChain.address().port;
  process.env.SOLANA_RPC_URL = downUrl;
  publicChain = downUrl;
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: join({ from: SHORT.address, amount: UNITS }) }));
  check('the claim is a 503 to try again, not a refusal of the membership', [r.status, r.body.error], [503, 'the chain could not be read just now; try again in a moment']);
  check('and placed no order', await mock.find(redeem.welcomeIdFor(SHORT.address)), null);
  // One node finds nothing while the others fail: a node that keeps only recent history answers
  // that way for an older transaction. Unknown is not "not found", so the member is told to try
  // again rather than that their join doesn't exist.
  process.env.SOLANA_RPC_URL = chainUrl;
  r = await POST(welcome(SHORT, 'fixed_1GB_7D_JP', { joinTx: randomSignature() }));
  check('"not found" from one node while the rest fail is a 503, not a refusal', [r.status, r.body.error], [503, 'the chain could not be read just now; try again in a moment']);
  publicChain = chainUrl;
  await new Promise((done) => downChain.close(done));

  console.log('\nthe switches still apply');
  process.env.REDEMPTIONS_ENABLED = '0';
  r = await POST(welcome(STRANGER, 'fixed_1GB_7D_AU'));
  check('no welcome claims while purchases are off', [r.status, r.body.error], [503, 'data redemption is not enabled yet']);
  delete process.env.REDEMPTIONS_ENABLED;
  serve(standardFiles({ '/config/esim.json': config(Object.assign({}, MEMBERSHIP, { capMultiple: 0 })) }));
  r = await POST(welcome(MEMBER, 'fixed_1GB_7D_AU'));
  check('no welcome claims while the membership block is malformed', [r.status, r.body.error], [503, 'membership is not configured']);
  r = await GET(MEMBER);
  check('and the standing says membership is off', r.body.membership, { configured: false });
  serve(standardFiles({ '/config/esim.json': Object.assign(config(), { membership: undefined }) }));
  r = await GET(MEMBER);
  check('without a membership block at all there is no incinerator account, so the coin is not launched', [r.status, r.body.error], [409, 'coin not launched yet']);
  serve(standardFiles());

  global.fetch = realFetch;
  delete process.env.SOLANA_RPC_URL;
  files.close();
  chain.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
