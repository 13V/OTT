#!/usr/bin/env node
'use strict';
/**
 * The redeem endpoint, end to end, with nothing outside this process.
 *
 * site/api/redeem.js is a Vercel function that talks to three things: the deployment's own
 * static files (config + allowances), a wallet's signature, and an eSIM provider. All three are
 * stood in for here — a node:http server for the files, lib/secp256k1 + lib/eip191 for the
 * wallet (the same code path a browser's personal_sign produces bytes for), and the mock
 * provider — so what is checked is the function's own logic: who may redeem, how much, and that
 * asking twice never mints twice.
 *
 *   node test/redeem.test.js
 */
const http = require('node:http');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const secp = require(path.join(API, 'lib', 'secp256k1.js'));
const eip191 = require(path.join(API, 'lib', 'eip191.js'));
const mock = require(path.join(API, 'lib', 'providers', 'mock.js'));

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

// Three wallets, so each scenario starts from a clean ledger without reaching into the mock.
const RICH = secp.newPrivateKey();   // $5.30 of data credit banked
const POOR = secp.newPrivateKey();   // nothing banked
const OTHER = secp.newPrivateKey();  // signs for RICH's address
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
  taxBps: 1000, rebateBps: 800, provider: 'mock', packages: PACKAGES,
});
const allowances = {
  asOf: 1700000000, block: 1, coin: COIN, curve: CURVE, rebateBps: 800,
  wallets: { [addr(RICH)]: { tradedUsd: 66.25, earnedUsd: 5.3 } },
};
const FILES = {
  '/data/allowances.json': allowances,
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
const message = (address, ts) => 'OT+T data\n' + address + '\n' + (ts === undefined ? now() : ts);
// A redeem names the slot it fills (n); every scenario below starts from a clean ledger, so the
// default is the first slot, and the sequences that fill more say so.
function signed(key, packageCode, opts = {}) {
  const address = opts.address || addr(key);
  const msg = message(address, opts.ts);
  const body = { address: opts.sendAddress || address, message: msg, signature: opts.signature || eip191.sign(key, msg) };
  if (packageCode !== null) { body.packageCode = packageCode; body.n = opts.n === undefined ? 0 : opts.n; }
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
  mock._reset();
  r = await POST(signed(RICH, 'MARS_1_7'));
  check('a package that is not in the config is 400', [r.status, r.body.error], [400, 'unknown package']);
  // Wallets and hardware signers disagree on whether v is 27/28 or 0/1; both must recover.
  const good = signed(RICH, 'EU-35_1_7');
  const vLow = good.signature.slice(0, 130) + (parseInt(good.signature.slice(130), 16) - 27).toString(16).padStart(2, '0');
  r = await POST(Object.assign({}, good, { signature: vLow }));
  check('a signature with v in {0,1} is accepted', r.status, 200);
  mock._reset();
  r = await POST(Object.assign({}, good, { address: addr(RICH).toUpperCase().replace('0X', '0x') }));
  check('a checksummed / upper-case address is the same wallet', r.status, 200);

  console.log('\nhow much: $5.30 banked buys Worldwide ($4.60) then Europe ($0.62), then nothing');
  mock._reset();
  r = await GET(addr(RICH));
  check('before anything: $5.30 earned, $0 redeemed, $5.30 remaining, no orders',
    [r.status, r.body.earnedUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders], [200, 5.3, 0, 5.3, []]);
  const first = await POST(signed(RICH, 'GL-120_1_7'));
  check('first redemption succeeds and leaves $0.70', [first.status, first.body.order.n, first.body.remainingUsd, first.body.order.priceUsd], [200, 0, 0.7, 4.6]);
  check('its id is the deterministic one for n=0', first.body.order.transactionId, redeem.transactionIdFor(addr(RICH), 0));
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
  check('GET lists the orders in the order they were made', r.body.orders.map((o) => [o.n, o.transactionId, o.packageCode]),
    [[0, first.body.order.transactionId, 'GL-120_1_7'], [1, second.body.order.transactionId, 'EU-35_1_7']]);
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
  const again = await mock.find(redeem.transactionIdFor(addr(RICH), 1));
  check('the provider holds exactly what the second POST returned', [again.transactionId, again.iccid], [second.body.order.transactionId, second.body.order.iccid]);
  const mintedBefore = (await GET(addr(RICH))).body.orders.length;
  await mock.order({ transactionId: redeem.transactionIdFor(addr(RICH), 1), packageCode: 'GL-120_1_7' });
  check('order() on an existing id does not mint a second profile', (await GET(addr(RICH))).body.orders.length, mintedBefore);
  check('and the existing package code is kept', (await mock.find(redeem.transactionIdFor(addr(RICH), 1))).packageCode, 'EU-35_1_7');

  console.log('\na wallet that never traded');
  r = await GET(addr(POOR));
  check('GET is a clean zero', [r.status, r.body.earnedUsd, r.body.remainingUsd, r.body.orders], [200, 0, 0, []]);
  r = await POST(signed(POOR, 'EU-35_1_7'));
  check('POST is refused', r.status, 409);

  console.log('\nVercel hands the function a pre-parsed body');
  mock._reset();
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
