#!/usr/bin/env node
'use strict';
/**
 * The redeem endpoint, end to end, with nothing outside this process.
 *
 * site/api/redeem.js is a Vercel function that talks to three things: the deployment's own
 * static files (config + allowances), a wallet's signature, and an eSIM provider. All three are
 * stood in for here — a node:http server for the files, lib/secp256k1 + lib/eip191 for the
 * wallet (the same code path a browser's personal_sign produces bytes for), and the mock
 * provider — so what is checked is the function's own logic: who may redeem, how much, that
 * asking twice never mints twice, and — the new part — that a wallet's allowance is this week's
 * share of the file's budget and nothing more: it does not carry over, its ids do not collide
 * with last week's, and a file that is not for the current week spends nothing at all.
 *
 * There is no injectable clock: a week is coarse enough (Monday to Monday) that computing it once
 * from Date.now(), the same way site/api/lib/week.js does, is stable for the life of a test run.
 * Every fixture below is built from that real, current week rather than a hard-coded number, so
 * this suite does not start failing the next time it is run in a different week.
 *
 *   node test/redeem.test.js
 */
const http = require('node:http');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const secp = require(path.join(API, 'lib', 'secp256k1.js'));
const eip191 = require(path.join(API, 'lib', 'eip191.js'));
const mock = require(path.join(API, 'lib', 'providers', 'mock.js'));
const week = require(path.join(API, 'lib', 'week.js'));

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

// The current week, computed the same way redeem.js computes it, so every fixture below is
// unconditionally "the current week" no matter when this file is run.
const CUR = week.weekOf(Math.floor(Date.now() / 1000));
const STALE_WEEK = CUR - 1;

// Four wallets, so each scenario starts from a clean ledger without reaching into the mock.
const RICH = secp.newPrivateKey();       // $5.30 allowance this week
const POOR = secp.newPrivateKey();       // holds no OTT: not in the wallets map at all
const OTHER = secp.newPrivateKey();      // signs for RICH's address
const HISTORIAN = secp.newPrivateKey();  // $2.00 this week, plus orders in each of the last 4 weeks
const addr = (k) => secp.addressOf(k).toLowerCase();

const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
// Two real catalogue entries at their 14 Sep 2026 wholesale prices, so the arithmetic below is
// the arithmetic the deployment will do: $5.30 buys the dear one, then the cheap one, then nothing.
const PACKAGES = [
  { code: 'GL-120_1_7', packageCode: 'PHS30M6EZ', name: 'Worldwide', gb: 1, days: 7, priceUsd: 4.6, regions: '120+ countries' },
  { code: 'EU-35_1_7', packageCode: 'P2CYMUS93', name: 'Europe', gb: 1, days: 7, priceUsd: 0.62, regions: '35 countries' },
];
const config = (coin) => ({
  coin, curve: coin ? CURVE : '', treasury: '', pair: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  taxBps: 1000, budgetBps: 10000, provider: 'mock', packages: PACKAGES,
});
// site/data/allowances.json's contract shape: written by the indexer, for one specific week, with
// each wallet's standing FOR THAT WEEK ONLY. RICH and HISTORIAN hold tokens; POOR is simply absent
// from `wallets`, exactly as a wallet holding zero OTT would be.
const allowances = {
  asOf: 1789600000, block: 64200000, week: CUR, weekStart: week.weekStart(CUR), weekEnd: week.weekEnd(CUR),
  snapshotBlock: 64100000, coin: COIN, curve: CURVE, budgetUsd: 1000, budgetSource: 'test fixture',
  circulating: '1000000000000000000000000', decimals: 18, holders: 2,
  wallets: {
    [addr(RICH)]: { tokens: '1000000000000000000000', share: 0.1, allowanceUsd: 5.3 },
    [addr(HISTORIAN)]: { tokens: '500000000000000000000', share: 0.05, allowanceUsd: 2.0 },
  },
};
// The same file, but stamped for last week — what the site sees the instant the clock rolls past
// Monday 00:00 UTC and the indexer has not run yet. RICH's numbers are otherwise identical, so any
// test against this fixture proves the staleness, not a coincidentally-empty wallet.
const staleAllowances = Object.assign({}, allowances, { week: STALE_WEEK, weekStart: week.weekStart(STALE_WEEK), weekEnd: week.weekEnd(STALE_WEEK) });
const FILES = {
  '/data/allowances.json': allowances,
  '/data/allowances-stale.json': staleAllowances,
  '/config/esim.json': config(COIN),
  '/config/esim-unlaunched.json': config(''),
};

// A fake req/res pair in the shape Node gives a Vercel function. The body is left as a string
// here, which is the case the function must handle itself; Vercel's pre-parsed object is the
// easier case and is covered once below.
function call(handler, { method, url, body, rawBody }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (rawBody !== undefined) req.body = rawBody;
    else if (body !== undefined) req.body = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); },
    };
    handler(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
}

const now = () => Math.floor(Date.now() / 1000);
// The message /api/redeem checks. A redemption's signature names the plan and the slot it
// authorises, so it is good for that one order and nothing else; a read's names neither.
const message = (address, want, ts) => [
  want && want.action === 'redeem' ? 'OT+T \u2014 authorise a data redemption' : 'OT+T \u2014 show my eSIM codes',
  'Site: ott.test',
  'Wallet: ' + address,
].concat(want && want.action === 'redeem' ? ['Plan: ' + want.packageCode, 'Slot: ' + want.n] : [])
  .concat(['Issued: ' + (ts === undefined ? now() : ts)]).join('\n');
// A redeem names the slot it fills (n); every scenario below starts from a clean ledger, so the
// default is the first slot, and the sequences that fill more say so.
function signed(key, packageCode, opts = {}) {
  const address = opts.address || addr(key);
  const n = opts.n === undefined ? 0 : opts.n;
  const want = packageCode == null ? { action: 'read' } : { action: 'redeem', packageCode, n };
  const msg = opts.message !== undefined ? opts.message : message(address, want, opts.ts);
  const body = { address: opts.sendAddress || address, message: msg, signature: opts.signature || eip191.sign(key, msg) };
  if (packageCode != null) { body.packageCode = packageCode; body.n = n; }
  return body;
}

async function main() {
  const server = http.createServer((req, res) => {
    const file = FILES[new URL(req.url, 'http://x').pathname];
    if (!file) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.ALLOWANCES_URL = base + '/data/allowances.json';
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';
  process.env.ESIM_PROVIDER = 'mock';
  delete process.env.VERCEL_URL;

  const redeem = require(path.join(API, 'redeem.js'));
  const GET = (address) => call(redeem, { method: 'GET', url: '/api/redeem?address=' + address });
  const POST = (body) => call(redeem, { method: 'POST', url: '/api/redeem', body });

  console.log('the wire format');
  let r = await call(redeem, { method: 'DELETE', url: '/api/redeem' });
  check('an unsupported method is 405', r.status, 405);
  check('every response is JSON that is never cached', [r.headers['content-type'], r.headers['cache-control']], ['application/json; charset=utf-8', 'no-store']);
  checkThat('no CORS header is ever set', !('access-control-allow-origin' in r.headers));
  r = await GET('');
  check('GET without an address is 400', [r.status, r.body.ok], [400, false]);
  r = await call(redeem, { method: 'POST', url: '/api/redeem', body: '{not json' });
  check('a POST with a broken body is 400, not a throw', r.status, 400);

  // Regression: readBody()'s streamed-body branch (req.body undefined — the "bare Node" case
  // this fake exercises via a real async-iterable req, unlike the string/object bodies above)
  // used to abandon an oversized request mid-read without saying so on the wire, leaving the
  // connection looking reusable to an HTTP/1.1 client even though its stream was never drained.
  // Driven over a real socket (see the verification harness), a client that then reused that
  // connection for its next request got ECONNRESET or a multi-second stall on a completely
  // unrelated request. `connection: close` on this one response is what tells Node (and any
  // real client) not to offer the socket back for reuse.
  r = await new Promise((resolve) => {
    const req = { method: 'POST', url: '/api/redeem', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.alloc(20 * 1024, 'A'); } }; // > MAX_BODY_BYTES (16KiB)
    const headers = {};
    const res = { statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); } };
    redeem(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
  check('an oversized streamed body is 400, not a throw', r.status, 400);
  checkThat('and the connection is closed, so a reused socket is never handed a corrupted stream', r.headers.connection === 'close', JSON.stringify(r.headers));

  console.log('\nwho may redeem');
  r = await POST(signed(RICH, 'EU-35_1_7', { signature: '0x' + 'ab'.repeat(65) }));
  check('a garbage signature is 401', r.status, 401);
  r = await POST(signed(OTHER, 'EU-35_1_7', { address: addr(RICH) }));
  check('another key signing for this address is 401', r.status, 401);
  r = await POST(signed(RICH, 'EU-35_1_7', { ts: now() - 11 * 60 }));
  check('a sign-in older than ten minutes is 401', r.status, 401);
  checkThat('and says so', /expired|again/i.test(r.body.error), r.body.error);
  r = await POST(signed(RICH, 'EU-35_1_7', { ts: now() + 11 * 60 }));
  check('a sign-in from the future is 401 too', r.status, 401);
  // Each accepted POST below spends $0.62 of RICH's $5.30, so the ledger is wiped between them.
  r = await POST(signed(RICH, 'EU-35_1_7', { ts: now() - 9 * 60 }));
  check('nine minutes old is still fine', r.status, 200);
  mock._reset(); redeem._resetCaches();
  r = await POST(signed(RICH, 'MARS_1_7'));
  check('a package that is not in the config is 400', [r.status, r.body.error], [400, 'unknown package']);
  // Wallets and hardware signers disagree on whether v is 27/28 or 0/1; both must recover.
  const good = signed(RICH, 'EU-35_1_7');
  const vLow = good.signature.slice(0, 130) + (parseInt(good.signature.slice(130), 16) - 27).toString(16).padStart(2, '0');
  r = await POST(Object.assign({}, good, { signature: vLow }));
  check('a signature with v in {0,1} is accepted', r.status, 200);
  mock._reset(); redeem._resetCaches();
  r = await POST(Object.assign({}, good, { address: addr(RICH).toUpperCase().replace('0X', '0x') }));
  check('a checksummed / upper-case address is the same wallet', r.status, 200);

  // ------------------------------------------------------------------------------------------
  // A signature authorises ONE action. It used to authorise the wallet: anything holding a
  // captured message-and-signature could redeem any package at any slot until the window closed,
  // which made a page that talked a holder into signing it able to spend their whole week. Naming
  // the plan and the slot inside the signed text is what bounds that to a single order.
  // ------------------------------------------------------------------------------------------
  console.log('\none signature, one order');
  mock._reset(); redeem._resetCaches();
  const forEurope = signed(RICH, 'EU-35_1_7');
  r = await POST(Object.assign({}, forEurope, { packageCode: 'GL-120_1_7' }));
  check('a signature for Europe cannot buy Worldwide', r.status, 401);
  checkThat('and says it authorises a different plan', /different plan/.test(r.body.error), r.body.error);
  r = await POST(Object.assign({}, forEurope, { n: 1 }));
  check('a signature for slot 0 cannot fill slot 1 — no walking it across the week', r.status, 401);
  checkThat('and says to sign again', /different order|sign again/.test(r.body.error), r.body.error);
  r = await POST(Object.assign({}, signed(RICH, null), { packageCode: 'EU-35_1_7', n: 0 }));
  check('a read signature cannot redeem at all', r.status, 401);
  checkThat('and says it does not authorise a redemption', /authorise a redemption/.test(r.body.error), r.body.error);
  r = await POST(Object.assign({}, forEurope, { packageCode: undefined, n: undefined }));
  check('and a redemption signature cannot be used to read the codes', r.status, 401);
  check('none of that spent anything', (await GET(addr(RICH))).body.redeemedUsd, 0);
  r = await POST(forEurope);
  check('the signature it was actually issued for still works', r.status, 200);
  mock._reset(); redeem._resetCaches();

  // The site line is what gives a person reading their wallet prompt a chance to notice where the
  // request came from, so a message naming somewhere else is refused when this deployment knows
  // its own name. A deployment that knows no host cannot check it, and must not therefore refuse
  // everything — that would lock every holder out of a preview deploy.
  console.log('\nthe site the signature names');
  process.env.SIGNIN_HOST = 'ott.test';
  r = await POST(signed(RICH, 'EU-35_1_7'));
  check('a message naming this host is fine', r.status, 200);
  mock._reset(); redeem._resetCaches();
  process.env.SIGNIN_HOST = 'ott.example';
  r = await POST(signed(RICH, 'EU-35_1_7'));
  check('one naming a different host is 401', r.status, 401);
  checkThat('and says which it was signed for', /signed for ott\.test/.test(r.body.error), r.body.error);
  delete process.env.SIGNIN_HOST;
  r = await POST(signed(RICH, 'EU-35_1_7'));
  check('a deployment that cannot name its own host does not refuse everything', r.status, 200);
  mock._reset(); redeem._resetCaches();

  console.log('\nhow much: $5.30 this week buys Worldwide ($4.60) then Europe ($0.62), then nothing');
  mock._reset(); redeem._resetCaches();
  r = await GET(addr(RICH));
  check('before anything: $5.30 allowance, $0 redeemed, $5.30 remaining, no orders, not stale',
    [r.status, r.body.week, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders, r.body.stale, r.body.allowancesWeek],
    [200, CUR, 5.3, 0, 5.3, [], false, CUR]);
  check('weekEnd is the contract\'s own arithmetic', r.body.weekEnd, week.weekEnd(CUR));
  const first = await POST(signed(RICH, 'GL-120_1_7'));
  check('first redemption succeeds and leaves $0.70', [first.status, first.body.order.n, first.body.order.week, first.body.remainingUsd, first.body.order.priceUsd], [200, 0, CUR, 0.7, 4.6]);
  check('its id is the deterministic, week-scoped one for n=0', first.body.order.transactionId, redeem.transactionIdFor(addr(RICH), CUR, 0));
  checkThat('ids carry the new "ott-" prefix — trading no longer earns a "wf-" rebate', first.body.order.transactionId.startsWith('ott-'));
  checkThat('it carries a QR, an activation code and an ICCID',
    first.body.order.qrCodeUrl && first.body.order.ac && /^\d{19}$/.test(first.body.order.iccid), JSON.stringify(first.body.order));
  const second = await POST(signed(RICH, 'EU-35_1_7', { n: 1 }));
  check('second redemption succeeds and leaves $0.08', [second.status, second.body.order.n, second.body.remainingUsd], [200, 1, 0.08]);
  checkThat('the two orders have different ids', first.body.order.transactionId !== second.body.order.transactionId);
  const third = await POST(signed(RICH, 'EU-35_1_7', { n: 2 }));
  check('the third is refused with $0.08 left', [third.status, third.body.ok], [409, false]);
  checkThat('and the reason is the balance', /not enough/i.test(third.body.error), third.body.error);
  r = await GET(addr(RICH));
  check('GET agrees: $5.22 redeemed, $0.08 remaining', [r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.length], [5.22, 0.08, 2]);
  check('each order says what it cost', r.body.orders.map((o) => o.priceUsd), [4.6, 0.62]);
  check('GET lists the orders in the order they were made, each tagged with this week', r.body.orders.map((o) => [o.n, o.week, o.transactionId, o.packageCode]),
    [[0, CUR, first.body.order.transactionId, 'GL-120_1_7'], [1, CUR, second.body.order.transactionId, 'EU-35_1_7']]);
  check('but GET, being public, carries no codes', [r.body.orders[0].ac, r.body.orders[0].qrCodeUrl, r.body.orders[0].codes, r.body.orders[0].iccid === first.body.order.iccid], ['', '', false, true]);
  r = await POST(signed(RICH, null));
  check('a signed read is the same standing, with the codes', [r.status, r.body.remainingUsd, r.body.orders.length, r.body.orders[0].ac === first.body.order.ac, r.body.orders[0].codes], [200, 0.08, 2, true, true]);
  r = await POST(signed(OTHER, null, { address: addr(RICH) }));
  check('and needs the wallet\'s own signature', r.status, 401);

  console.log('\nthe slot: a replay is the same order, a stale picture is told to reload');
  r = await POST(signed(RICH, 'GL-120_1_7', { n: 0 }));
  check('replaying the first redeem returns the first order, minting nothing', [r.status, r.body.replayed, r.body.order.transactionId, (await GET(addr(RICH))).body.orders.length], [200, true, first.body.order.transactionId, 2]);
  r = await POST(signed(RICH, 'EU-35_1_7', { n: 0 }));
  check('the same slot with a different package is 409', [r.status, /reload/.test(r.body.error)], [409, true]);
  r = await POST(signed(RICH, 'EU-35_1_7', { n: 5 }));
  check('a slot ahead of the ledger is 409', [r.status, /reload/.test(r.body.error)], [409, true]);
  const noN = signed(RICH, 'EU-35_1_7'); delete noN.n;
  r = await POST(noN);
  check('a redeem that names no slot is 400', [r.status, /n required/.test(r.body.error)], [400, true]);

  console.log('\nidempotence: the same n asked for again is the same order');
  // Simulate a retry that lands after the provider recorded the order but before the client saw
  // it: the provider already holds n=1, so a fresh POST for the "next" id must return it unchanged.
  const again = await mock.find(redeem.transactionIdFor(addr(RICH), CUR, 1));
  check('the provider holds exactly what the second POST returned', [again.transactionId, again.iccid], [second.body.order.transactionId, second.body.order.iccid]);
  const mintedBefore = (await GET(addr(RICH))).body.orders.length;
  await mock.order({ transactionId: redeem.transactionIdFor(addr(RICH), CUR, 1), packageCode: 'GL-120_1_7' });
  check('order() on an existing id does not mint a second profile', (await GET(addr(RICH))).body.orders.length, mintedBefore);
  check('and the existing package code is kept', (await mock.find(redeem.transactionIdFor(addr(RICH), CUR, 1))).packageCode, 'EU-35_1_7');

  console.log('\na wallet that holds no OTT');
  r = await GET(addr(POOR));
  check('GET is a clean zero, and says the wallet holds nothing', [r.status, r.body.tokens, r.body.allowanceUsd, r.body.remainingUsd, r.body.orders], [200, '0', 0, 0, []]);
  r = await POST(signed(POOR, 'EU-35_1_7'));
  check('POST is refused', r.status, 409);
  checkThat('and says plainly that the wallet holds nothing, not just "not enough"', /holds no ott/i.test(r.body.error), r.body.error);

  console.log('\nthe week boundary: last week\'s orders do not spend this week\'s allowance, and ids do not collide');
  mock._reset(); redeem._resetCaches();
  // Four weeks of history, seeded directly at the provider the way a real wallet's past
  // redemptions would sit there — bypassing the API entirely, exactly as the idempotence check
  // above does, because there is no other way to have "already redeemed last week" in a fixture.
  for (let i = 1; i <= 4; i++) {
    await mock.order({ transactionId: redeem.transactionIdFor(addr(HISTORIAN), CUR - i, 0), packageCode: 'EU-35_1_7' });
  }
  r = await GET(addr(HISTORIAN));
  check('no orders yet this week, despite four weeks of history', [r.body.orders, r.body.redeemedUsd, r.body.remainingUsd], [[], 0, 2.0]);
  check('history holds exactly the three most recent past weeks, most recent first', r.body.history.map((o) => o.week), [CUR - 1, CUR - 2, CUR - 3]);
  checkThat('history does not reach back a fourth week', !r.body.history.some((o) => o.week === CUR - 4));
  check('every history order still prices correctly', r.body.history.map((o) => o.priceUsd), [0.62, 0.62, 0.62]);
  checkThat('history is redacted on a public GET, exactly like this week\'s orders', r.body.history.every((o) => o.ac === '' && o.qrCodeUrl === '' && o.codes === false));
  const thisWeek = await POST(signed(HISTORIAN, 'EU-35_1_7', { n: 0 }));
  check('this week starts a fresh sequence at n=0 regardless of four weeks of history', [thisWeek.status, thisWeek.body.order.n, thisWeek.body.order.week, thisWeek.body.remainingUsd], [200, 0, CUR, 1.38]);
  checkThat('its id is not any of the past four weeks\' ids — last week\'s ids are never reused',
    ![1, 2, 3, 4].map((i) => redeem.transactionIdFor(addr(HISTORIAN), CUR - i, 0)).includes(thisWeek.body.order.transactionId));
  r = await GET(addr(HISTORIAN));
  check('GET now shows one order this week, redeemedUsd only for it, and the same three-week history', [r.body.orders.length, r.body.redeemedUsd, r.body.history.length], [1, 0.62, 3]);
  r = await POST(signed(HISTORIAN, null));
  checkThat('a signed read reveals codes on this week\'s orders', r.body.orders[0].codes === true && !!r.body.orders[0].ac);
  checkThat('and on every history order too', r.body.history.length === 3 && r.body.history.every((o) => o.codes === true && !!o.ac));

  console.log('\na stale allowances file: last week\'s numbers do not carry over, and nothing can be spent');
  mock._reset(); redeem._resetCaches();
  process.env.ALLOWANCES_URL = base + '/data/allowances-stale.json';
  r = await GET(addr(RICH));
  check('GET still succeeds and says plainly that the file is stale', [r.status, r.body.ok, r.body.stale, r.body.allowancesWeek, r.body.week], [200, true, true, STALE_WEEK, CUR]);
  check('allowanceUsd and remainingUsd are forced to zero, not last week\'s $5.30', [r.body.allowanceUsd, r.body.remainingUsd], [0, 0]);
  r = await POST(signed(RICH, 'EU-35_1_7', { n: 0 }));
  check('every redemption is refused while the file is stale', [r.status, r.body.ok], [409, false]);
  checkThat('and says the week\'s allowance has not been published yet, not "not enough credit"', /allowance.*not.*published/i.test(r.body.error), r.body.error);
  check('nothing was minted', (await mock.find(redeem.transactionIdFor(addr(RICH), CUR, 0))), null);
  process.env.ALLOWANCES_URL = base + '/data/allowances.json';

  console.log('\nVercel hands the function a pre-parsed body');
  mock._reset(); redeem._resetCaches();
  r = await call(redeem, { method: 'POST', url: '/api/redeem', rawBody: signed(RICH, 'EU-35_1_7') });
  check('an object body works the same as a string', [r.status, r.body.order.n], [200, 0]);

  console.log('\nbefore the coin is launched');
  process.env.ESIM_CONFIG_URL = base + '/config/esim-unlaunched.json';
  r = await GET(addr(RICH));
  check('GET is 409 with a sentence, not a throw', [r.status, r.body.ok, r.body.error], [409, false, 'coin not launched yet']);
  r = await POST(signed(RICH, 'EU-35_1_7'));
  check('POST is 409 with the same sentence', [r.status, r.body.error], [409, 'coin not launched yet']);

  console.log('\nwhen the deployment cannot serve its own files');
  process.env.ESIM_CONFIG_URL = base + '/config/missing.json';
  r = await GET(addr(RICH));
  check('a missing config is 503, not a throw', [r.status, r.body.ok], [503, false]);
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';
  process.env.ALLOWANCES_URL = base + '/data/missing.json';
  r = await GET(addr(RICH));
  check('missing allowances is 503, not a throw', [r.status, r.body.ok], [503, false]);

  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
