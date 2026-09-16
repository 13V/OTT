#!/usr/bin/env node
'use strict';
/**
 * The eSIM Access provider, against a fake of the reseller that behaves the way the real one was
 * observed to on 14 Sep 2026: RT-AccessCode is the whole of authentication, an order is idempotent
 * by transactionId, profiles are allocated a moment after the order (query-by-orderNo answers
 * errorCode 200010 until then), and the only way to find an order by transactionId is to page the
 * account's orders by time and read the field off each record.
 *
 * Nothing here touches the network: ESIMACCESS_BASE_URL points at a node:http server this file
 * starts, and the provider's module-level caches are reset between cases.
 *
 *   node test/esimaccess.test.js
 */
const http = require('http');
const path = require('path');

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- the fake reseller
const ACCESS = 'test-access-code';
const state = { orders: new Map(), records: [], seq: 1, allocateMs: 150, log: [] };

function allocate(order) {
  const rec = {
    esimTranNo: '2509' + String(order.seq).padStart(10, '0'),
    orderNo: order.orderNo,
    transactionId: order.transactionId,
    iccid: '89431081700' + String(order.seq).padStart(8, '0'),
    ac: 'LPA:1$rsp-eu.example$' + order.transactionId.toUpperCase(),
    qrCodeUrl: 'https://p.example/qr/' + order.transactionId + '.png',
    shortUrl: 'https://p.example/' + order.transactionId,
    smdpStatus: 'RELEASED', esimStatus: 'GOT_RESOURCE',
    packageList: [{ packageName: 'Fake 1GB 7Days', packageCode: 'PFAKE', slug: order.slug, duration: 7, volume: 1073741824, locationCode: 'XX', createTime: '2026-09-14T10:00:00+0000' }],
  };
  order.allocated = true;
  state.records.push(rec);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (j) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    state.log.push({ path: req.url, body, access: req.headers['rt-accesscode'] });
    if (req.headers['rt-accesscode'] !== ACCESS) return reply({ success: false, errorCode: '000101', errorMessage: 'Req Header:[RT-AccessCode] is invalid', obj: null });
    const b = body ? JSON.parse(body) : {};
    if (req.url === '/balance/query') return reply({ success: true, errorCode: '0', errorMsg: null, obj: { balance: 940000 } });
    if (req.url === '/esim/order') {
      const tx = b.transactionId;
      if (!tx || !Array.isArray(b.packageInfoList) || !b.packageInfoList.length) return reply({ success: false, errorCode: '000102', errorMsg: 'bad request', obj: null });
      if (state.orders.has(tx)) return reply({ success: true, errorCode: null, errorMsg: null, obj: { orderNo: state.orders.get(tx).orderNo, transactionId: tx } });
      const order = { seq: state.seq++, orderNo: 'B2509' + String(state.seq).padStart(9, '0'), transactionId: tx, slug: b.packageInfoList[0].slug, price: b.packageInfoList[0].price, amount: b.amount, allocated: false };
      state.orders.set(tx, order);
      setTimeout(() => allocate(order), state.allocateMs);
      return reply({ success: true, errorCode: null, errorMsg: null, obj: { orderNo: order.orderNo, transactionId: tx } });
    }
    if (req.url === '/esim/query') {
      if (b.orderNo) {
        const order = [...state.orders.values()].find((o) => o.orderNo === b.orderNo);
        if (!order) return reply({ success: true, errorCode: '0', errorMsg: null, obj: { esimList: [], pager: { pageSize: 5, pageNum: 1, total: 0 } } });
        if (!order.allocated) return reply({ success: false, errorCode: '200010', errorMsg: 'SM-DP+ is still allocating profiles for the order', obj: null });
        return reply({ success: true, errorCode: '0', errorMsg: null, obj: { esimList: state.records.filter((r) => r.orderNo === b.orderNo), pager: { pageSize: 5, pageNum: 1, total: 1 } } });
      }
      const size = Math.min(500, Math.max(5, Number(b.pager && b.pager.pageSize) || 10));
      const num = Number(b.pager && b.pager.pageNum) || 1;
      const list = state.records.slice((num - 1) * size, num * size);
      return reply({ success: true, errorCode: '0', errorMsg: null, obj: { esimList: list, pager: { pageSize: size, pageNum: num, total: state.records.length } } });
    }
    reply({ success: false, errorCode: '404', errorMsg: 'no such endpoint ' + req.url, obj: null });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.ESIMACCESS_BASE_URL = base;
  process.env.ESIMACCESS_ACCESS_CODE = ACCESS;
  process.env.ESIMACCESS_SINCE = '2026-01-01T00:00+00:00';
  process.env.ESIMACCESS_ALLOCATE_WAIT_MS = '3000';
  const prov = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'providers', 'esimaccess.js'));

  console.log('the request shape');
  const b = await prov.balanceUsd();
  check('balance comes back in dollars from value*10000', b, 94);
  check('the only credential sent is RT-AccessCode', state.log[state.log.length - 1].access, ACCESS);

  console.log('\nan order, waited for');
  const t0 = Date.now();
  const o1 = await prov.order({ transactionId: 'wf-aaaa0001', packageCode: 'P2CYMUS93', slug: 'EU-35_1_7', priceUsd: 0.62 });
  checkThat('order() waits for allocation and returns the profile', o1 && o1.qrCodeUrl && o1.ac && o1.iccid && !o1.pending, JSON.stringify(o1));
  check('the record carries the slug as packageCode', o1.packageCode, 'EU-35_1_7');
  check('and the reseller order number', typeof o1.orderNo, 'string');
  const sent = JSON.parse(state.log.find((l) => l.path === '/esim/order').body);
  check('price and amount are sent as value*10000 integers', [sent.packageInfoList[0].price, sent.amount, sent.packageInfoList[0].count], [6200, 6200, 1]);
  check('ordered with the catalogue packageCode the live API demands, and the slug beside it', [sent.packageInfoList[0].packageCode, sent.packageInfoList[0].slug], ['P2CYMUS93', 'EU-35_1_7']);
  checkThat('and it took at least the allocation delay', Date.now() - t0 >= state.allocateMs - 5);

  console.log('\nidempotency');
  const before = state.orders.size;
  const again = await prov.order({ transactionId: 'wf-aaaa0001', packageCode: 'PHS30M6EZ', slug: 'GL-120_1_7', priceUsd: 4.6 });
  check('ordering the same transactionId again returns the existing order', [again.orderNo, again.packageCode], [o1.orderNo, 'EU-35_1_7']);
  check('and the reseller saw no second order', state.orders.size, before);

  console.log('\nfinding by transactionId, which the API cannot do directly');
  prov._reset();
  check('an unknown id is null', await prov.find('wf-nope'), null);
  const found = await prov.find('wf-aaaa0001');
  check('a known id is found by paging the account\'s orders', found && [found.orderNo, found.iccid], [o1.orderNo, o1.iccid]);
  const queries = state.log.filter((l) => l.path === '/esim/query' && /startTime/.test(l.body));
  checkThat('the paging query asks by time range with a pager', queries.length >= 1 && /pageSize/.test(queries[0].body), queries[0] && queries[0].body);

  console.log('\nthe pending path: allocation slower than the function is willing to wait');
  prov._reset();
  process.env.ESIMACCESS_ALLOCATE_WAIT_MS = '0';
  state.allocateMs = 400;
  const o2 = await prov.order({ transactionId: 'wf-bbbb0002', packageCode: 'PHAJHEAYP', slug: 'US_1_7', priceUsd: 0.9 });
  check('order() returns a pending record with the order number and no QR', [o2.pending, typeof o2.orderNo, o2.qrCodeUrl], [true, 'string', '']);
  const f2 = await prov.find('wf-bbbb0002');
  check('find() on the same instance answers from the pending record meanwhile', f2 && f2.pending, true);
  await sleep(500);
  prov._reset(); // a different function instance, later
  const f3 = await prov.find('wf-bbbb0002');
  checkThat('once allocated, a fresh instance finds the real profile', f3 && !f3.pending && f3.qrCodeUrl, JSON.stringify(f3));

  console.log('\nrefusals are sentences');
  process.env.ESIMACCESS_ACCESS_CODE = 'wrong';
  prov._reset();
  let err = null; try { await prov.balanceUsd(); } catch (e) { err = e.message; }
  checkThat('a bad access code surfaces the reseller\'s message', /RT-AccessCode/.test(err || ''), err);
  process.env.ESIMACCESS_ACCESS_CODE = '';
  err = null; try { await prov.find('wf-x'); } catch (e) { err = e.message; }
  check('a missing access code is refused before any request', err, 'ESIMACCESS_ACCESS_CODE is not set');

  server.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
