#!/usr/bin/env node
'use strict';
/**
 * One eSIM per wallet, per place, topped up — the real nadanada provider (site/api/lib/providers/
 * nadanada.js), against the fake of nadanada (test/support/fake-nadanada.js), the mock Lightning
 * payer, and the in-memory store. test/nadanada.test.js checks the provider's money-handling in
 * isolation; this file checks the layer on top of it: which eSIM a redemption lands on.
 *
 * What is asserted: a wallet's first order for a place is a new eSIM; its next order for the SAME
 * place tops that one up rather than minting another; a DIFFERENT place gets its own eSIM, because
 * bundles on one profile queue consecutively and a Japan bundle stuck behind an unused Europe one
 * would be unreachable on arrival; a DIFFERENT wallet never lands on someone else's SIM; sims()
 * shows one card per eSIM, install details included, no matter how many times it has been topped
 * up; a top-up nadanada refuses (not every bundle can join every profile) becomes a new eSIM
 * instead, and the wallet recovers — later orders for that place adopt the replacement rather than
 * retrying the dead one forever; a top-up quote naming the wrong ICCID is refused before anything
 * is paid; and, exactly as for a fresh order, a top-up is resumable when interrupted after paying
 * and never pays the same invoice twice.
 *
 *   node test/sim.test.js
 */
const path = require('path');

const LIB = path.join(__dirname, '..', 'site', 'api', 'lib');
const mockPayer = require(path.join(LIB, 'payers', 'mock.js'));
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

// --------------------------------------------------------------------------- fixtures
// The fake nadanada itself lives in test/support/fake-nadanada.js, shared with
// test/nadanada.test.js and test/redeem-nadanada.test.js so there is exactly one fake to keep
// faithful to the real API. Japan is added to its default catalogue (Germany, Europe) so there is
// a second, unrelated place to prove top-ups are scoped per slug, not per wallet-at-large.
const DE = { packageCode: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99 };
const JP = { packageCode: 'fixed_2GB_15D_JAPAN', slug: 'japan', priceUsd: 12.99 };
const CATALOGUE = Object.assign({}, fakeNadanada.CATALOGUE, { fixed_2GB_15D_JAPAN: { slug: 'japan', price: 12.99 } });

const mkAddr = (tag) => '0x' + tag.padStart(40, '0');
const WALLET_A = mkAddr('a1');   // first order, then a same-place top-up, then a different place
const WALLET_B = mkAddr('b2');   // must never land on WALLET_A's eSIM
const WALLET_C = mkAddr('c3');   // a top-up nadanada refuses, and recovery afterwards
const WALLET_D = mkAddr('d4');   // a top-up paid but interrupted before completion
const WALLET_E = mkAddr('e5');   // a top-up that cannot pay, then can
const WALLET_F = mkAddr('f6');   // never ordered anything
const WALLET_G = mkAddr('9a9a'); // nadanada quotes a top-up for the wrong ICCID

const noCodesOfItsOwn = (o) => !o.ac && !o.qrCodeUrl && !o.manualCode && !o.smdpAddress && !o.matchingId && !o.appleInstallUrl && !o.androidInstallUrl;
const hasInstallDetails = (o) => /^https/.test(o.qrCodeUrl) && o.ac.startsWith('LPA:1$') && o.smdpAddress && o.matchingId && o.appleInstallUrl && o.androidInstallUrl;

(async () => {
  const fake = await fakeNadanada.start({ mockPayer, catalogue: CATALOGUE });
  process.env.NADANADA_BASE_URL = fake.base;
  process.env.NADANADA_COMPLETE_WAIT_MS = '3000';
  process.env.LN_PAYER = 'mock';
  process.env.STORE = 'memory';
  process.env.NADANADA_ALLOW_MEMORY_STORE = '1';
  const state = fake.state;
  const prov = require(path.join(LIB, 'providers', 'nadanada.js'));

  console.log('a wallet\'s first order buys a new eSIM');
  const a1 = await prov.order(Object.assign({ transactionId: 'sim-a-001', address: WALLET_A }, DE));
  check('done, a new eSIM: no topupOf, a 19-digit ICCID', [a1.stage, a1.topupOf, /^\d{19}$/.test(a1.iccid)], ['done', '', true]);
  checkThat('with its own install details', hasInstallDetails(a1), JSON.stringify(a1));
  check('toppedUp is not set on a new eSIM', !!a1.toppedUp, false);

  console.log('\nthe same wallet\'s second order for the same place tops it up');
  const a2 = await prov.order(Object.assign({ transactionId: 'sim-a-002', address: WALLET_A }, DE));
  check('it names the first ICCID as what it topped up, and lands on it', [a2.topupOf, a2.toppedUp, a2.iccid], [a1.iccid, true, a1.iccid]);
  checkThat('and carries no activation code of its own — the profile is already on the phone', noCodesOfItsOwn(a2), JSON.stringify(a2));

  console.log('\na different wallet gets its own eSIM');
  const b1 = await prov.order(Object.assign({ transactionId: 'sim-b-001', address: WALLET_B }, DE));
  check('a new eSIM, not a top-up of anything', [b1.topupOf, !!b1.toppedUp], ['', false]);
  checkThat('a different ICCID than WALLET_A\'s — the case that would let a holder onto someone else\'s SIM', b1.iccid !== a1.iccid, [b1.iccid, a1.iccid]);

  console.log('\na third order for the same place tops up the same eSIM again');
  const a3 = await prov.order(Object.assign({ transactionId: 'sim-a-003', address: WALLET_A }, DE));
  check('still the first ICCID', [a3.topupOf, a3.iccid], [a1.iccid, a1.iccid]);
  const simsA3 = await prov.sims(WALLET_A);
  check('sims() shows one card for three orders on the same place', simsA3.length, 1);
  checkThat('carrying the install details issued with the first order', simsA3[0] && simsA3[0].iccid === a1.iccid && simsA3[0].ac === a1.ac && simsA3[0].qrCodeUrl === a1.qrCodeUrl, JSON.stringify(simsA3));

  console.log('\na different place gets its own eSIM, not a top-up of the first — bundles queue consecutively, so a Japan bundle stuck behind an unused Europe/Germany one would be unreachable on arrival');
  const a4 = await prov.order(Object.assign({ transactionId: 'sim-a-004', address: WALLET_A }, JP));
  check('a new eSIM for Japan: no topupOf, a different ICCID than the Germany one', [a4.topupOf, a4.iccid !== a1.iccid], ['', true]);
  checkThat('with its own install details', hasInstallDetails(a4), JSON.stringify(a4));
  const a5 = await prov.order(Object.assign({ transactionId: 'sim-a-005', address: WALLET_A }, JP));
  check('the next Japan order tops up the Japan eSIM, not the Germany one', [a5.topupOf, a5.iccid], [a4.iccid, a4.iccid]);
  const simsA5 = await prov.sims(WALLET_A);
  check('sims() now shows two cards, one per place', simsA5.map((c) => c.iccid).sort(), [a1.iccid, a4.iccid].sort());
  checkThat('each carrying its own install details', simsA5.every((c) => c.ac && c.qrCodeUrl), JSON.stringify(simsA5));

  console.log('\na top-up nadanada refuses becomes a new eSIM, and nothing is paid for the refusal');
  const c1 = await prov.order(Object.assign({ transactionId: 'sim-c-001', address: WALLET_C }, DE));
  state.refuseTopup = c1.iccid; // nadanada documents that not every bundle can join every profile
  const purchasesBeforeRefusal = fake.purchases(), paidBeforeRefusal = mockPayer._state.log.length;
  const c2 = await prov.order(Object.assign({ transactionId: 'sim-c-002', address: WALLET_C }, DE));
  check('the order still succeeds, as a new eSIM', [c2.stage, c2.topupOf], ['done', '']);
  checkThat('a different ICCID than the refused one', c2.iccid !== c1.iccid, [c2.iccid, c1.iccid]);
  check('nadanada was asked twice (the refused top-up, then the fresh purchase) but paid only once', [fake.purchases() - purchasesBeforeRefusal, mockPayer._state.log.length - paidBeforeRefusal], [2, 1]);
  const simsC2 = await prov.sims(WALLET_C);
  check('the wallet now has two cards', simsC2.map((c) => c.iccid).sort(), [c1.iccid, c2.iccid].sort());
  state.refuseTopup = '';
  const c3 = await prov.order(Object.assign({ transactionId: 'sim-c-003', address: WALLET_C }, DE));
  check('the wallet has recovered: the next order tops up the REPLACEMENT eSIM, not the dead one', [c3.topupOf, c3.iccid], [c2.iccid, c2.iccid]);

  console.log('\nnadanada quoting a top-up for the wrong ICCID is refused before anything is paid');
  const g1 = await prov.order(Object.assign({ transactionId: 'sim-g-001', address: WALLET_G }, DE));
  state.wrongTopupIccid = '8944999999999999999';
  const paidBeforeMismatch = mockPayer._state.log.length;
  await rejects('the order is refused', prov.order(Object.assign({ transactionId: 'sim-g-002', address: WALLET_G }, DE)), /different eSIM/, 502);
  check('the wallet was never even asked to pay', mockPayer._state.log.length - paidBeforeMismatch, 0);
  check('and it is not a redemption', await prov.find('sim-g-002'), null);
  state.wrongTopupIccid = '';

  console.log('\na top-up that is paid but interrupted resumes on the next find()');
  const d1 = await prov.order(Object.assign({ transactionId: 'sim-d-001', address: WALLET_D }, DE));
  state.settleAfterCalls = 2;
  process.env.NADANADA_COMPLETE_WAIT_MS = '0';
  const d2 = await prov.order(Object.assign({ transactionId: 'sim-d-002', address: WALLET_D }, DE));
  check('order() returns it paid and pending — money moved, the top-up is not finished yet', [d2.pending, d2.stage, typeof d2.paidAt], [true, 'paid', 'string']);
  const fd1 = await prov.find('sim-d-002');
  check('a first look still finds it being issued', [fd1.pending, fd1.stage], [true, 'paid']);
  const fd2 = await prov.find('sim-d-002');
  check('a later look finds it topped up, on the first ICCID', [fd2.pending, fd2.stage, fd2.topupOf, fd2.iccid], [false, 'done', d1.iccid, d1.iccid]);
  state.settleAfterCalls = 0;
  process.env.NADANADA_COMPLETE_WAIT_MS = '3000';

  console.log('\nmoney is not spent twice on a top-up');
  const e1 = await prov.order(Object.assign({ transactionId: 'sim-e-001', address: WALLET_E }, DE));
  mockPayer._state.mode = 'broke';
  await rejects('a top-up the pool cannot pay for', prov.order(Object.assign({ transactionId: 'sim-e-002', address: WALLET_E }, DE)), /could not pay/, 503);
  const purchasesBeforeRetry = fake.purchases();
  mockPayer._state.mode = 'success';
  const e2 = await prov.order(Object.assign({ transactionId: 'sim-e-002', address: WALLET_E }, DE));
  check('once the wallet can pay, the same invoice is reused and it tops up the first ICCID', [e2.stage, e2.topupOf, fake.purchases() - purchasesBeforeRetry], ['done', e1.iccid, 0]);
  checkThat('paid exactly once', mockPayer._state.paid.get(e2.paymentHash) && mockPayer._state.paid.get(e2.paymentHash).status === 'SUCCESS', JSON.stringify(mockPayer._state.log.filter((l) => l.paymentHash === e2.paymentHash)));
  check('one payment attempt failed, one succeeded', mockPayer._state.log.filter((l) => l.paymentHash === e2.paymentHash).length, 2);

  console.log('\na wallet that has never ordered anything');
  check('sims() is empty', await prov.sims(WALLET_F), []);

  await fake.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
