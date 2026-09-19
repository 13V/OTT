#!/usr/bin/env node
'use strict';
/**
 * /api/redeem, end to end, through the real wholesale provider — the fake wholesale
 * (test/support/fake-wholesale.js), the mock Lightning payer, the in-memory store, and, exactly as
 * test/redeem.test.js does for the mock provider, a node:http file server standing in for the
 * deployment's own config and allowances and lib/secp256k1 + lib/eip191 standing in for a
 * wallet's personal_sign.
 *
 * test/redeem.test.js checks the endpoint's own logic (who may redeem, how much, idempotence, the
 * week boundary, a stale allowances file) against the mock provider, which never fails and never
 * waits. test/wholesale.test.js checks the wholesale provider's own money-handling in isolation.
 * This file is the seam between them: does redeem.js still get the accounting right — this week's
 * allowance spent once per package, nothing lost, nothing doubled — when the provider underneath
 * is the one that can be slow, broke, or stale?
 *
 *   node test/redeem-wholesale.test.js
 */
const http = require('node:http');
const path = require('path');

const API = path.join(__dirname, '..', 'site', 'api');
const secp = require(path.join(API, 'lib', 'secp256k1.js'));
const eip191 = require(path.join(API, 'lib', 'eip191.js'));
const mockPayer = require(path.join(API, 'lib', 'payers', 'mock.js'));
const week = require(path.join(API, 'lib', 'week.js'));
const fakeWholesale = require(path.join(__dirname, 'support', 'fake-wholesale.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };

// --------------------------------------------------------------------------- wallets and wire format
// Every wallet is generated up front, before the allowances file is ever served: readAllowances()
// caches its response for a minute (redeem.js's CACHE_TTL_MS), so a wallet added to the map after
// the first fetch would not be seen until the cache expired. One wallet per scenario that needs a
// clean ledger, per the mock-provider suite's own convention.
const RICH = secp.newPrivateKey();   // $9.00 allowance this week: Europe, then Germany, then out of credit
const BROKE = secp.newPrivateKey();  // $2.99 allowance, for a wallet whose wallet-of-record cannot pay
const SLOW = secp.newPrivateKey();   // $2.99 allowance, for a profile slower than the function waits
const STALE = secp.newPrivateKey();  // $2.00 allowance, for a config whose price wholesale disagrees with
const MOCKW = secp.newPrivateKey();  // $9.00 allowance, to prove the mock provider still works untouched
const HOSTILE = secp.newPrivateKey(); // $2.99, for the day wholesale sends links that are not links
const addr = (k) => secp.addressOf(k).toLowerCase();

// The current week, computed the same way redeem.js computes it (site/api/lib/week.js), so the
// allowances fixture below is unconditionally "this week" whenever this file happens to run.
const CUR = week.weekOf(Math.floor(Date.now() / 1000));

const now = () => Math.floor(Date.now() / 1000);
const message = (address, ts) => 'OT+T data\n' + address + '\n' + (ts === undefined ? now() : ts);
// A redeem names the slot it fills (n): the number of orders the caller has seen. A signed body
// with no package is a read — the standing with the codes, which a public GET withholds.
function signed(key, packageCode, n = 0) {
  const address = addr(key);
  const msg = message(address);
  const body = { address, message: msg, signature: eip191.sign(key, msg) };
  if (packageCode !== null) { body.packageCode = packageCode; body.n = n; }
  return body;
}

const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
// The fake wholesale's default catalogue (test/support/fake-wholesale.js) prices exactly these two
// bundles, at exactly these dollar amounts, so the config below is what the fake will agree with.
const PACKAGES = [
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 5, days: 30, priceUsd: 5.99, regions: '38 countries' },
];
// A second catalogue, identical except Germany is quoted well under what wholesale actually charges
// for it — the "our config is out of date" case a real deployment could hit between catalogue
// refreshes.
const STALE_PACKAGES = [Object.assign({}, PACKAGES[0], { priceUsd: 1.50 }), PACKAGES[1]];
const BASE_CONFIG = { coin: COIN, curve: CURVE, treasury: '', pair: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', taxBps: 1000, budgetBps: 10000, provider: 'wholesale' };
const NORMAL_CONFIG = Object.assign({}, BASE_CONFIG, { packages: PACKAGES });
const STALE_CONFIG = Object.assign({}, BASE_CONFIG, { packages: STALE_PACKAGES });
// The same catalogue after `npm run catalogue -- --write` picked up cheaper prices from wholesale,
// which is the ordinary weekly reason that file changes.
const CHEAPER_CONFIG = Object.assign({}, BASE_CONFIG, {
  packages: PACKAGES.map((p) => Object.assign({}, p, { priceUsd: Math.round(p.priceUsd * 50) / 100 })),
});
// The contract shape: written by the indexer, for one specific week, each wallet's standing FOR
// THAT WEEK ONLY — tokens (base units), its share of the circulating supply, and the dollars that
// share is worth of this week's budget.
const allowances = {
  asOf: 1789600000, block: 64200000, week: CUR, weekStart: week.weekStart(CUR), weekEnd: week.weekEnd(CUR),
  snapshotBlock: 64100000, coin: COIN, curve: CURVE, budgetUsd: 1000, budgetSource: 'test fixture',
  circulating: '1000000000000000000000000', decimals: 18, holders: 5,
  wallets: {
    [addr(RICH)]: { tokens: '900000000000000000000', share: 0.09, allowanceUsd: 9.0 },
    [addr(BROKE)]: { tokens: '299000000000000000000', share: 0.0299, allowanceUsd: 2.99 },
    [addr(SLOW)]: { tokens: '299000000000000000000', share: 0.0299, allowanceUsd: 2.99 },
    [addr(STALE)]: { tokens: '200000000000000000000', share: 0.02, allowanceUsd: 2.0 },
    [addr(MOCKW)]: { tokens: '900000000000000000000', share: 0.09, allowanceUsd: 9.0 },
    [addr(HOSTILE)]: { tokens: '299000000000000000000', share: 0.0299, allowanceUsd: 2.99 },
  },
};
const FILES = {
  '/config/esim.json': NORMAL_CONFIG,
  '/config/esim-stale.json': STALE_CONFIG,
  '/config/esim-cheaper.json': CHEAPER_CONFIG,
  '/data/allowances.json': allowances,
};

// The same fake req/res shape test/redeem.test.js drives the handler with.
function call(handler, { method, url, body }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (body !== undefined) req.body = JSON.stringify(body);
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); },
    };
    handler(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
}

async function main() {
  const fake = await fakeWholesale.start({ mockPayer });

  const server = http.createServer((req, res) => {
    const file = FILES[new URL(req.url, 'http://x').pathname];
    if (!file) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';
  process.env.ALLOWANCES_URL = base + '/data/allowances.json';
  process.env.ESIM_PROVIDER = 'wholesale';
  process.env.LN_PAYER = 'mock';
  process.env.STORE = 'memory';
  process.env.WHOLESALE_ALLOW_MEMORY_STORE = '1';
  process.env.WHOLESALE_BASE_URL = fake.base;
  process.env.WHOLESALE_COMPLETE_WAIT_MS = '3000';
  delete process.env.VERCEL_URL;

  const redeem = require(path.join(API, 'redeem.js'));
  const GET = (address) => call(redeem, { method: 'GET', url: '/api/redeem?address=' + address });
  const POST = (body) => call(redeem, { method: 'POST', url: '/api/redeem', body });

  console.log('before anything');
  let r = await GET(addr(RICH));
  check('$9 allowance this week, $0 redeemed, $9 remaining, no orders, not stale', [r.status, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders, r.body.stale], [200, 9, 0, 9, [], false]);

  console.log('\nPOST Europe, sent twice at once — the deterministic id must resolve the race to one eSIM');
  // A client that never saw the first response (a dropped connection, a timeout) retries with the
  // exact same signed request. Two such requests racing for the same not-yet-existing order (both
  // see zero prior orders for this wallet before either commits) must settle on one paid eSIM,
  // never two — the "Two requests racing for the same n" guarantee documented at the top of
  // site/api/redeem.js. What that guarantee does NOT cover is a single call to wholesale's own
  // /esim/purchase: wholesale.js quotes an invoice before it claims the store slot (the NX claim
  // happens after quoting), so under a genuine race both requests quote one, and the loser's is
  // simply orphaned and unpaid — only the payment, the part that actually costs money, happens
  // once, and both callers see the identical finished order. Checked below.
  const bodyEurope = signed(RICH, 'fixed_5GB_30D_EUROPE');
  const purchasesBeforeEurope = fake.purchases();
  const paidBeforeEurope = mockPayer._state.log.length;
  const [respA, respB] = await Promise.all([POST(bodyEurope), POST(bodyEurope)]);
  check('both racing POSTs succeed', [respA.status, respB.status], [200, 200]);
  const europeOrder = respA.body.order;
  check('the order is Europe, n=0, this week, done, at the catalogue price', [europeOrder.n, europeOrder.week, europeOrder.packageCode, europeOrder.stage, europeOrder.pending, europeOrder.priceUsd], [0, CUR, 'fixed_5GB_30D_EUROPE', 'done', false, 5.99]);
  check('remainingUsd on both responses reflects one deduction, not two', [respA.body.remainingUsd, respB.body.remainingUsd], [3.01, 3.01]);
  checkThat('it carries a QR (https), an LPA activation code and a 19-digit ICCID',
    /^https/.test(europeOrder.qrCodeUrl) && europeOrder.ac.startsWith('LPA:1$') && /^\d{19}$/.test(europeOrder.iccid), JSON.stringify(europeOrder));
  checkThat('and the SM-DP+ address, matching id and both install links', !!(europeOrder.smdpAddress && europeOrder.matchingId && europeOrder.appleInstallUrl && europeOrder.androidInstallUrl), JSON.stringify(europeOrder));
  check('note is empty — nothing went wrong', europeOrder.note, '');
  check('the fake wholesale saw the purchase named the bundle, its place and Lightning', fake.state.log.find((l) => l.path === '/esim/purchase').body, { bundleName: 'fixed_5GB_30D_EUROPE', slug: 'europe', paymentMethod: 'lightning' });
  check('the two racing responses carry the identical order', respB.body.order, europeOrder);
  check('the mock payer paid exactly once, with a memo naming the order', mockPayer._state.log.slice(paidBeforeEurope).map((l) => l.memo), ['OT+T ' + europeOrder.transactionId]);
  check('one quote at wholesale for the two racing requests: the slot is claimed before the quote', fake.purchases() - purchasesBeforeEurope, 1);

  console.log('\nGET agrees, and a second GET costs nothing');
  r = await GET(addr(RICH));
  check('$5.99 redeemed, $3.01 remaining, one order with the Europe iccid', [r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.length, r.body.orders[0].iccid], [5.99, 3.01, 1, europeOrder.iccid]);
  const logBeforeSecondGet = fake.state.log.length;
  const r2 = await GET(addr(RICH));
  check('a done order is answered from the store: no request reaches the fake wholesale', [fake.state.log.length - logBeforeSecondGet, r2.body.orders.length], [0, 1]);

  console.log('\nPOST Germany, then Germany again with too little left');
  const germany = await POST(signed(RICH, 'fixed_1GB_7D_DE', 1));
  check('Germany succeeds as order n=1, leaving $1.02', [germany.status, germany.body.order.n, germany.body.remainingUsd], [200, 1, 1.02]);
  const germanyAgain = await POST(signed(RICH, 'fixed_1GB_7D_DE', 2));
  check('a third redemption is refused, 409', germanyAgain.status, 409);
  checkThat('and says why', /not enough data credit/.test(germanyAgain.body.error), germanyAgain.body.error);

  console.log('\na wallet that cannot pay');
  mockPayer._state.mode = 'broke';
  const purchasesBeforeBroke = fake.purchases();
  const brokeAttempt = await POST(signed(BROKE, 'fixed_1GB_7D_DE'));
  check('the pool refuses, 503', brokeAttempt.status, 503);
  checkThat('and says it could not pay', /could not pay/.test(brokeAttempt.body.error), brokeAttempt.body.error);
  check('the attempt still quoted an invoice — there is something to reuse below', fake.purchases() - purchasesBeforeBroke, 1);
  const brokeGet = await GET(addr(BROKE));
  check('an unpaid invoice is not a redemption: no orders, full credit still banked', [brokeGet.body.orders, brokeGet.body.remainingUsd], [[], 2.99]);
  mockPayer._state.mode = 'success';
  const purchasesBeforeRetry = fake.purchases();
  const brokeRetry = await POST(signed(BROKE, 'fixed_1GB_7D_DE'));
  check('once the wallet can pay, the same POST succeeds', [brokeRetry.status, brokeRetry.body.order.n, brokeRetry.body.order.stage, brokeRetry.body.remainingUsd], [200, 0, 'done', 1.0]);
  check('the fake saw no second purchase for this wallet — the invoice was reused', fake.purchases() - purchasesBeforeRetry, 0);

  console.log('\na profile slower than the function will wait');
  fake.state.settleAfterCalls = 2;
  process.env.WHOLESALE_COMPLETE_WAIT_MS = '0';
  const slow = await POST(signed(SLOW, 'fixed_1GB_7D_DE'));
  check('POST returns it paid and pending, with the credit already spent', [slow.status, slow.body.order.pending, slow.body.order.stage, slow.body.remainingUsd], [200, true, 'paid', 1.0]);
  const slowGet1 = await GET(addr(SLOW));
  check('a GET still finds it pending', [slowGet1.body.orders[0].pending, slowGet1.body.orders[0].stage], [true, 'paid']);
  const slowGet2 = await POST(signed(SLOW, null));   // a signed read: a public GET withholds the codes
  checkThat('a later signed read finds it done, with the QR', !slowGet2.body.orders[0].pending && slowGet2.body.orders[0].stage === 'done' && /^https/.test(slowGet2.body.orders[0].qrCodeUrl) && slowGet2.body.orders[0].codes === true, JSON.stringify(slowGet2.body.orders[0]));
  fake.state.settleAfterCalls = 0;
  process.env.WHOLESALE_COMPLETE_WAIT_MS = '3000';

  console.log('\na stale catalogue: our price is under what wholesale actually charges');
  process.env.ESIM_CONFIG_URL = base + '/config/esim-stale.json';
  const purchasesBeforeStale = fake.purchases();
  const paidBeforeStale = mockPayer._state.log.length;
  const stale = await POST(signed(STALE, 'fixed_1GB_7D_DE'));
  check('the order is refused, 503', stale.status, 503);
  checkThat('and says the catalogue is stale', /catalogue is stale/.test(stale.body.error), stale.body.error);
  check('wholesale was quoted (that is how the staleness was caught) but nothing was paid', [fake.purchases() - purchasesBeforeStale, mockPayer._state.log.length - paidBeforeStale], [1, 0]);
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';

  console.log('\nno durable store configured');
  delete process.env.WHOLESALE_ALLOW_MEMORY_STORE;
  const noStore = await GET(addr(RICH));
  check('GET is 503', noStore.status, 503);
  checkThat('and says a durable store is needed', /durable store/.test(noStore.body.error), noStore.body.error);
  process.env.WHOLESALE_ALLOW_MEMORY_STORE = '1';

  // ------------------------------------------------------------------------------------------
  // Everything wholesale says about how to install an eSIM becomes an attribute on the page that
  // is displaying the holder's activation code: the QR an <img src>, the two install links an
  // <a href>. A "javascript:" in any of them runs in that origin, next to the codes. We do not
  // trust that response enough to put it in an <img> unchecked; this is the same care, applied to
  // the rest of it, at BOTH ends — where the record is written, and where it is served.
  // ------------------------------------------------------------------------------------------
  // ------------------------------------------------------------------------------------------
  // A week's allowance is a fixed sum, so what a wallet has already spent out of it has to be a
  // fixed sum too. The catalogue is not: scripts/catalogue.js rewrites it from wholesale's live
  // prices whenever it runs, which is an ordinary weekly thing to do. Pricing a past order from
  // the catalogue as it stands NOW means that refresh silently rewrites history.
  // ------------------------------------------------------------------------------------------
  console.log('\na catalogue refresh does not rewrite what a wallet already spent');
  const beforeRefresh = await GET(addr(RICH));
  const spent = beforeRefresh.body.redeemedUsd;
  const left = beforeRefresh.body.remainingUsd;
  checkThat('RICH has spent something this week to begin with', spent > 0, spent);
  process.env.ESIM_CONFIG_URL = base + '/config/esim-cheaper.json';
  const afterRefresh = await GET(addr(RICH));
  check('each past order still shows the price it was actually charged, not the new one',
    afterRefresh.body.orders.map((o) => o.priceUsd), beforeRefresh.body.orders.map((o) => o.priceUsd));
  check('so what was spent, and what is left, are exactly what they were',
    [afterRefresh.body.redeemedUsd, afterRefresh.body.remainingUsd], [spent, left]);
  process.env.ESIM_CONFIG_URL = base + '/config/esim.json';

  console.log('\nwholesale sends links that would run script, and none of them reach the page');
  fake.state.hostileInstall = true;
  const hostile = await POST(signed(HOSTILE, 'fixed_1GB_7D_DE'));
  check('the order still succeeds — the eSIM is real, only its links were not', [hostile.status, !!hostile.body.order.iccid], [200, true]);
  check('the javascript: QR, the javascript: Apple link and the data: Android link are all dropped',
    [hostile.body.order.qrCodeUrl, hostile.body.order.appleInstallUrl, hostile.body.order.androidInstallUrl], ['', '', '']);
  check('and the activation code, which is the part that actually matters, survives intact',
    /^LPA:1\$rsp\.example\.com\$/.test(hostile.body.order.ac), true);
  const hostileSims = (await POST(signed(HOSTILE))).body.sims || [];
  check('the SIM the codes are shown on carries none of them either',
    hostileSims.map((x) => [x.qrCodeUrl, x.appleInstallUrl, x.androidInstallUrl]), [['', '', '']]);
  fake.state.hostileInstall = false;

  // The guard at the serving end is not redundant: a record written before it existed, or by any
  // provider that never checked, is cleaned on the way out rather than trusted because it is ours.
  console.log('\na hostile record already in the store is still not served');
  const store = require(path.join(API, 'lib', 'store.js')).store();
  const planted = await store.get('sim:' + addr(HOSTILE));
  const onlyIccid = Object.keys(planted.cards)[0];
  planted.cards[onlyIccid].appleInstallUrl = 'javascript:alert(1)';
  planted.cards[onlyIccid].qrCodeUrl = 'javascript:alert(2)';
  await store.set('sim:' + addr(HOSTILE), planted);
  const served = (await POST(signed(HOSTILE))).body.sims || [];
  check('a record poisoned in the database is served with its links emptied',
    served.map((x) => [x.qrCodeUrl, x.appleInstallUrl]), [['', '']]);

  console.log('\nthe mock provider is untouched — the switch is env-only');
  process.env.ESIM_PROVIDER = 'mock';
  const logBeforeMock = fake.state.log.length, paidBeforeMock = mockPayer._state.log.length;
  const mockResp = await POST(signed(MOCKW, 'fixed_1GB_7D_DE'));
  check('the same handler, same signing, same config — just ESIM_PROVIDER=mock — still redeems', [mockResp.status, mockResp.body.order.n], [200, 0]);
  check('wholesale and the Lightning wallet were never touched', [fake.state.log.length - logBeforeMock, mockPayer._state.log.length - paidBeforeMock], [0, 0]);
  process.env.ESIM_PROVIDER = 'wholesale';

  await fake.close();
  server.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
