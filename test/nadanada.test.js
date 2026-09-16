#!/usr/bin/env node
'use strict';
/**
 * The nadanada provider, against a fake of nadanada that behaves the way the real API was observed
 * to on 15 Sep 2026 (purchase → bolt11 invoice + payment hash; complete → 402 until the invoice
 * is paid, 404 for a checkout it does not know, 200 with the installation details once paid), the
 * mock Lightning payer standing in for Blink, and the in-memory store standing in for Upstash.
 * The fake settles an invoice when the mock payer has paid it — the same coupling the real pair
 * has through the Lightning network.
 *
 * What is asserted is the money-handling: an invoice is checked before it is paid, nothing is paid
 * twice, an unpaid invoice is not a redemption, a paid one is never lost, and every one of the ways
 * a step can be interrupted (a wallet that is broke, pending, or down; a profile that is slow; an
 * invoice that dies) resumes from where it stopped.
 *
 *   node test/nadanada.test.js
 */
const path = require('path');

const LIB = path.join(__dirname, '..', 'site', 'api', 'lib');
const mockPayer = require(path.join(LIB, 'payers', 'mock.js'));
const S = require(path.join(LIB, 'store.js'));
const fakeNadanada = require(path.join(__dirname, 'support', 'fake-nadanada.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };
const rejects = async (what, p, re, status) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (re.test(e.message) && (status === undefined || e.status === status)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}" (status ${e.status})`); }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;

// --------------------------------------------------------------------------- fixtures
// The fake nadanada itself lives in test/support/fake-nadanada.js, shared with
// test/redeem-nadanada.test.js so there is exactly one fake to keep faithful to the real API.
const DE = { packageCode: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99, address: '0xAbCd000000000000000000000000000000000001' };
const EU = { packageCode: 'fixed_5GB_30D_EUROPE', slug: 'europe', priceUsd: 5.99, address: DE.address };

(async () => {
  const fake = await fakeNadanada.start({ mockPayer });
  process.env.NADANADA_BASE_URL = fake.base;
  process.env.NADANADA_COMPLETE_WAIT_MS = '3000';
  process.env.LN_PAYER = 'mock';
  process.env.STORE = 'memory';
  delete process.env.NADANADA_ALLOW_MEMORY_STORE;
  const state = fake.state;
  const purchases = fake.purchases;
  const completes = fake.completes;
  const prov = require(path.join(LIB, 'providers', 'nadanada.js'));
  const store = () => S.store();

  console.log('the store guard');
  await rejects('an in-memory store is refused unless a test says so', prov.find('wf-x'), /durable store/, 503);
  process.env.NADANADA_ALLOW_MEMORY_STORE = '1';
  check('with the flag, an unknown id is null', await prov.find('wf-x'), null);

  console.log('\nan order, start to finish');
  const o1 = await prov.order(Object.assign({ transactionId: 'wf-aaaa0001' }, DE));
  check('the purchase named the bundle, its place and Lightning', state.log.find((l) => l.path === '/esim/purchase').body, { bundleName: 'fixed_1GB_7D_DE', slug: 'germany', paymentMethod: 'lightning' });
  check('the invoice was paid once, with a memo naming the order', mockPayer._state.log.map((l) => [l.sats, l.memo]), [[Math.round(1.89 / 0.0008), 'OT+T wf-aaaa0001']]);
  check('the order is done, with the profile', [o1.step, o1.stage, o1.pending, o1.iccid.length, o1.qrCodeUrl, o1.ac, o1.smdpAddress, o1.matchingId],
    ['done', 'done', false, 19, 'https://nadanada.me/qr/' + o1.iccid + '.png', 'LPA:1$rsp.example.com$' + o1.iccid.slice(-6), 'rsp.example.com', o1.iccid.slice(-6)]);
  checkThat('and the install links', /^https:\/\/esimsetup\.apple\.com/.test(o1.appleInstallUrl) && /android/.test(o1.androidInstallUrl), JSON.stringify([o1.appleInstallUrl, o1.androidInstallUrl]));
  check('it charged the catalogue price and paid the Lightning price', [o1.priceUsd, o1.paidUsd, o1.sats, o1.packageCode], [1.99, 1.89, Math.round(1.89 / 0.0008), 'fixed_1GB_7D_DE']);
  check('the wallet is recorded, lower-cased, for support', o1.address, DE.address.toLowerCase());
  checkThat('with timestamps for each step', o1.createdAt && o1.paidAt && o1.completedAt, JSON.stringify(o1));
  const before = state.log.length;
  const f1 = await prov.find('wf-aaaa0001');
  check('find() answers a done order from the store alone', [f1.iccid, state.log.length - before], [o1.iccid, 0]);
  check('listOrders() lists it', (await prov.listOrders({ sinceIso: '2026-01-01T00:00:00Z' })).map((o) => o.transactionId), ['wf-aaaa0001']);
  check('and the balance is the wallet\'s, in dollars', await prov.balanceUsd(), round2((1000000 - 2363) * 0.0008));
  check('status() reads the profile', (await prov.status(o1.iccid)).profileStatus, 'Released');

  console.log('\nidempotence');
  const p0 = purchases(), paid0 = mockPayer._state.log.length;
  const again = await prov.order(Object.assign({ transactionId: 'wf-aaaa0001' }, EU));
  check('the same id again is the same eSIM, whatever package is asked for', [again.iccid, again.packageCode], [o1.iccid, 'fixed_1GB_7D_DE']);
  check('with no second purchase and no second payment', [purchases() - p0, mockPayer._state.log.length - paid0], [0, 0]);

  console.log('\nthe invoice is checked before it is paid');
  let p = purchases(), paid = mockPayer._state.log.length;
  await rejects('a price above the catalogue is refused as stale, 503', prov.order(Object.assign({ transactionId: 'wf-bbbb0001' }, DE, { priceUsd: 1.5 })), /catalogue is stale/, 503);
  state.tamper = 'hash';
  await rejects('an invoice whose hash is not the quoted one is refused', prov.order(Object.assign({ transactionId: 'wf-bbbb0002' }, DE)), /payment hash/, 502);
  state.tamper = 'sats';
  await rejects('an invoice for three times the price in sats is refused', prov.order(Object.assign({ transactionId: 'wf-bbbb0003' }, DE)), /against a price/, 502);
  state.tamper = '';
  await rejects('a bundle nadanada does not price for that place is refused with their words', prov.order({ transactionId: 'wf-bbbb0004', packageCode: 'fixed_1GB_7D_DE', slug: 'france', priceUsd: 1.99 }), /does not match slug/, 502);
  check('three quotes were asked for, none paid, none recorded', [purchases() - p, mockPayer._state.log.length - paid, await prov.find('wf-bbbb0001'), await prov.find('wf-bbbb0002'), await prov.find('wf-bbbb0003')], [4, 0, null, null, null]);

  console.log('\na wallet that cannot pay');
  mockPayer._state.mode = 'broke';
  p = purchases();
  await rejects('order() says the pool cannot pay, 503', prov.order(Object.assign({ transactionId: 'wf-cccc0001' }, DE)), /could not pay/, 503);
  let rec = await store().get('order:wf-cccc0001');
  check('the invoice is kept, unpaid, with the wallet\'s reason', [rec.step, rec.attempts, rec.error], ['invoiced', 1, 'Insufficient balance']);
  check('find() does not count it as a redemption', await prov.find('wf-cccc0001'), null);
  check('and listOrders() does not list it', (await prov.listOrders()).map((o) => o.transactionId), ['wf-aaaa0001']);
  mockPayer._state.mode = 'success';
  const o2 = await prov.order(Object.assign({ transactionId: 'wf-cccc0001' }, DE));
  check('once the wallet can pay, the same invoice is paid — no second purchase', [o2.step, purchases() - p, o2.attempts], ['done', 1, 2]);

  console.log('\na different package replaces an unpaid invoice');
  mockPayer._state.mode = 'broke';
  await rejects('first, an unpaid invoice for Germany', prov.order(Object.assign({ transactionId: 'wf-dddd0001' }, DE)), /could not pay/);
  mockPayer._state.mode = 'success';
  p = purchases(); paid = mockPayer._state.log.length;
  const o3 = await prov.order(Object.assign({ transactionId: 'wf-dddd0001' }, EU));
  check('then Europe under the same id is a fresh invoice, paid, done', [o3.step, o3.packageCode, o3.paidUsd, purchases() - p], ['done', 'fixed_5GB_30D_EUROPE', 5.69, 1]);
  check('and the German invoice was never paid', mockPayer._state.log.slice(paid).map((l) => l.sats), [Math.round(5.69 / 0.0008)]);

  console.log('\nan invoice that dies unpaid');
  mockPayer._state.mode = 'broke';
  await rejects('an unpaid invoice', prov.order(Object.assign({ transactionId: 'wf-eeee0001' }, DE)), /could not pay/);
  rec = await store().get('order:wf-eeee0001');
  rec.expiresAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await store().set('order:wf-eeee0001', rec);
  check('past its expiry, find() is null and the record says why', [await prov.find('wf-eeee0001'), (await store().get('order:wf-eeee0001')).step, (await store().get('order:wf-eeee0001')).error], [null, 'failed', 'invoice expired unpaid']);
  mockPayer._state.mode = 'success';
  p = purchases();
  const o4 = await prov.order(Object.assign({ transactionId: 'wf-eeee0001' }, DE));
  check('the next order for the id is a new invoice', [o4.step, purchases() - p], ['done', 1]);

  console.log('\na payment that is still in flight');
  mockPayer._state.mode = 'pending';
  const o5 = await prov.order(Object.assign({ transactionId: 'wf-ffff0001' }, DE));
  check('order() returns it pending, at the invoiced step', [o5.pending, o5.stage], [true, 'invoiced']);
  const f5 = await prov.find('wf-ffff0001');
  check('find() counts money in flight as a redemption', [f5 && f5.pending, f5 && f5.stage], [true, 'invoiced']);
  mockPayer._settle(o5.paymentHash);
  const f5b = await prov.find('wf-ffff0001');
  check('once it settles, find() completes it', [f5b.stage, f5b.iccid.length], ['done', 19]);
  mockPayer._state.mode = 'success';

  console.log('\na profile slower than the function will wait');
  process.env.NADANADA_COMPLETE_WAIT_MS = '0';
  state.settleAfterCalls = 2;
  const o6 = await prov.order(Object.assign({ transactionId: 'wf-0000a001' }, DE));
  check('order() returns it paid and pending', [o6.pending, o6.stage, typeof o6.paidAt], [true, 'paid', 'string']);
  const f6 = await prov.find('wf-0000a001');
  check('a first look finds it still being issued', [f6.pending, f6.stage], [true, 'paid']);
  const f6b = await prov.find('wf-0000a001');
  check('a later look finds the profile', [f6b.pending, f6b.stage, f6b.iccid.length], [false, 'done', 19]);
  state.settleAfterCalls = 1;
  process.env.NADANADA_COMPLETE_WAIT_MS = '3000';
  const t0 = Date.now();
  const o7 = await prov.order(Object.assign({ transactionId: 'wf-0000a002' }, DE));
  check('with patience, order() waits it out', [o7.stage, Date.now() - t0 >= 1000], ['done', true]);
  state.settleAfterCalls = 0;

  console.log('\na wallet that is unreachable');
  mockPayer._state.mode = 'broke';
  await rejects('an unpaid invoice first', prov.order(Object.assign({ transactionId: 'wf-0000b001' }, DE)), /could not pay/);
  mockPayer._state.mode = 'down';
  paid = mockPayer._state.log.length;
  await rejects('order() will not pay into the dark, 503', prov.order(Object.assign({ transactionId: 'wf-0000b001' }, DE)), /could not be reached/, 503);
  const f8 = await prov.find('wf-0000b001');
  check('find() keeps the order visible rather than guessing it away', [f8 && f8.pending, f8 && f8.stage], [true, 'invoiced']);
  check('and nothing was paid', mockPayer._state.log.length - paid, 0);
  mockPayer._state.mode = 'success';

  console.log('\na checkout nadanada has forgotten');
  mockPayer._state.mode = 'broke';
  await rejects('an unpaid invoice', prov.order(Object.assign({ transactionId: 'wf-0000c001' }, DE)), /could not pay/);
  mockPayer._state.mode = 'success';
  rec = await store().get('order:wf-0000c001');
  state.checkouts.get(rec.paymentHash).gone = true;
  check('unpaid and gone is not a redemption', [await prov.find('wf-0000c001'), (await store().get('order:wf-0000c001')).step], [null, 'failed']);
  rec = await store().get('order:wf-0000a002');
  state.checkouts.get(rec.paymentHash).gone = true;
  check('but a paid, done order is untouched by nadanada forgetting it', (await prov.find('wf-0000a002')).stage, 'done');

  console.log('\ntwo requests racing for one fresh id');
  p = purchases(); paid = mockPayer._state.log.length;
  const [ra, rb] = await Promise.all([
    prov.order(Object.assign({ transactionId: 'wf-0000d001' }, DE)),
    prov.order(Object.assign({ transactionId: 'wf-0000d001' }, DE)),
  ]);
  check('both get the same done order', [ra.stage, rb.stage, ra.iccid === rb.iccid, ra.paymentHash === rb.paymentHash], ['done', 'done', true, true]);
  check('one quote at nadanada, one payment from the wallet', [purchases() - p, mockPayer._state.log.length - paid], [1, 1]);

  console.log('\na claim whose owner died before quoting');
  await store().set('order:wf-0000e001', { transactionId: 'wf-0000e001', attempt: 'gone', packageCode: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99, step: 'claiming', createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), error: '' });
  check('find() does not count a bare claim', await prov.find('wf-0000e001'), null);
  p = purchases();
  const o9 = await prov.order(Object.assign({ transactionId: 'wf-0000e001' }, DE));
  check('a stale claim is replaced and the order goes through', [o9.stage, purchases() - p], ['done', 1]);
  await store().set('order:wf-0000e002', { transactionId: 'wf-0000e002', attempt: 'busy', packageCode: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99, step: 'claiming', createdAt: new Date().toISOString(), error: '' });
  process.env.NADANADA_COMPLETE_WAIT_MS = '0';
  const t9 = Date.now();
  // With no patience to wait, a fresh claim held by someone else is a 503 after a minute at most;
  // here the claim goes stale in the store first, which is the same answer sooner.
  const stalePromise = prov.order(Object.assign({ transactionId: 'wf-0000e002' }, DE));
  await sleep(300);
  const held = await store().get('order:wf-0000e002');
  held.createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await store().set('order:wf-0000e002', held);
  await rejects('a fresh claim held by another request is waited on, then given up', stalePromise, /still being placed/, 503);
  checkThat('without minting anything', Date.now() - t9 < 5000);
  process.env.NADANADA_COMPLETE_WAIT_MS = '3000';

  console.log('\nthe recent index');
  const recent = await prov.listOrders({ sinceIso: new Date(Date.now() - 60000).toISOString() });
  check('lists what cost money, in order, and nothing that did not', recent.map((o) => [o.transactionId, o.stage]),
    [['wf-aaaa0001', 'done'], ['wf-cccc0001', 'done'], ['wf-dddd0001', 'done'], ['wf-eeee0001', 'done'], ['wf-ffff0001', 'done'], ['wf-0000a001', 'done'], ['wf-0000a002', 'done'], ['wf-0000d001', 'done'], ['wf-0000e001', 'done']]);
  check('the paid records carry what the pool paid', recent.map((o) => o.paidUsd), [1.89, 1.89, 5.69, 1.89, 1.89, 1.89, 1.89, 1.89, 1.89]);

  await fake.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
