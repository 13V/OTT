#!/usr/bin/env node
'use strict';
// Actual provider recovery logic against local HTTP and a pretend Lightning wallet.
// No live endpoint, credential, invoice or payment is used.
const assert = require('node:assert/strict');
const mock = require('../site/api/_lib/payers/mock');
const storage = require('../site/api/_lib/store');
const bolt11 = require('../site/api/_lib/bolt11');
const supplier = require('./support/fake-wholesale');
const DE = { transactionId: 'recovery-one', packageCode: 'fixed_1GB_7D_DE', slug: 'germany', priceUsd: 1.99, address: '' };
const EU = { ...DE, packageCode: 'fixed_5GB_30D_EUROPE', slug: 'europe', priceUsd: 5.99 };

async function main() {
  const fake = await supplier.start({ mockPayer: mock });
  Object.assign(process.env, { STORE: 'memory', STORE_PREFIX: 'recovery:', LN_PAYER: 'mock', NODE_ENV: 'test',
    VERCEL_ENV: 'test', WHOLESALE_ALLOW_MEMORY_STORE: '1', WHOLESALE_BASE_URL: fake.base,
    WHOLESALE_COMPLETE_WAIT_MS: '0', REDEMPTIONS_ENABLED: '1' });
  const provider = require('../site/api/_lib/providers/wholesale');
  const store = storage.store();
  const orderKey = 'order:' + DE.transactionId, leaseKey = 'paylease:' + DE.transactionId;
  const originals = { pay: mock.pay, sent: mock.sent, rate: mock.usdPerSat,
    set: store.set, get: store.get, compareSet: store.compareSet, compareDel: store.compareDel, zadd: store.zadd, now: Date.now };
  let checks = 0;
  async function seed() {
    mock._state.mode = 'broke';
    await assert.rejects(provider.order(DE), /could not pay/);
    mock._state.mode = 'success';
    return store.get(orderKey);
  }
  async function scenario(label, fn) {
    let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery scenario timed out: ' + label)), 10000); })]);
      checks++; console.log('ok ' + label);
    }
    finally {
      clearTimeout(timer);
      mock.pay = originals.pay; mock.sent = originals.sent; mock.usdPerSat = originals.rate;
      store.set = originals.set; store.get = originals.get;
      store.compareSet = originals.compareSet; store.compareDel = originals.compareDel;
      store.zadd = originals.zadd;
      Date.now = originals.now;
      provider._reset(); mock._reset(); fake.state.checkouts.clear(); fake.state.log.length = 0;
      fake.state.settleAfterCalls = 0; fake.state.refuseTopup = '';
    }
  }
  try {
    await scenario('concurrent pending retries send only once after stale pre-lease reads', async () => {
      const rec = await seed();
      mock._state.mode = 'pending';
      let arrivals = 0, release;
      const both = new Promise(resolve => { release = resolve; });
      mock.sent = async hash => {
        const index = ++arrivals;
        if (index <= 2) { if (index === 2) release(); await both; return { status: 'NONE' }; }
        return originals.sent(hash);
      };
      mock.pay = async args => { await new Promise(resolve => setTimeout(resolve, 300)); return originals.pay(args); };
      const before = mock._state.log.length;
      const orders = await Promise.all([provider.order(DE), provider.order(DE)]);
      assert.ok(orders.every(order => order.step === 'invoiced' && order.paymentHash === rec.paymentHash));
      assert.equal(mock._state.log.length - before, 1); assert.equal(fake.purchases(), 1);
      assert.ok(arrivals >= 4); // Both stale observations were rechecked under the lease.
    });
    await scenario('unknown wallet status cannot pay, expire or replace an invoice', async () => {
      const rec = await seed(), before = mock._state.log.length;
      rec.expiresAt = new Date(Date.now() - 600000).toISOString(); await store.set(orderKey, rec);
      mock.sent = async () => ({ status: 'UNKNOWN' });
      await assert.rejects(provider.order(DE), /uncertain/);
      await assert.rejects(provider.order(EU), /uncertain/);
      assert.equal((await provider.find(DE.transactionId)).step, 'invoiced');
      assert.equal((await store.get(orderKey)).paymentHash, rec.paymentHash);
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, before);
    });
    await scenario('send timeout preserves the same checkout and pending payment on retry', async () => {
      const rec = await seed(); mock._state.mode = 'pending';
      const before = mock._state.log.length;
      mock.pay = async args => { await originals.pay(args); throw new Error('response interrupted'); };
      await assert.rejects(provider.order(DE), /wallet did not answer/);
      mock.pay = originals.pay;
      assert.equal((await provider.order(DE)).step, 'invoiced');
      mock._settle(rec.paymentHash);
      assert.equal((await provider.order(DE)).step, 'done');
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length - before, 1);
    });
    await scenario('unknown send result cannot authorize another pending send', async () => {
      await seed(); mock._state.mode = 'pending'; const before = mock._state.log.length;
      mock.pay = async args => { await originals.pay(args); return { status: 'UNKNOWN' }; };
      await assert.rejects(provider.order(DE), /result is uncertain/);
      mock.pay = originals.pay;
      assert.equal((await provider.order(DE)).step, 'invoiced');
      assert.equal(mock._state.log.length - before, 1); assert.equal(fake.purchases(), 1);
    });
    await scenario('a lost send response stays reserved even when wallet history is empty or reports an older failure', async () => {
      const rec = await seed();
      let sends = 0;
      mock.sent = async () => ({ status: 'NONE' });
      mock.pay = async () => { sends++; throw new Error('response lost after dispatch'); };
      await assert.rejects(provider.order(DE), /wallet did not answer/);
      assert.equal((await store.get(orderKey)).paymentState, 'uncertain');
      assert.equal((await provider.find(DE.transactionId)).paymentHash, rec.paymentHash);
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash);
      mock.sent = async () => ({ status: 'FAILURE' });
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      await store.set(orderKey, { ...(await store.get(orderKey)), expiresAt: new Date(Date.now() - 600000).toISOString() });
      assert.equal((await provider.find(DE.transactionId)).step, 'invoiced');
      fake.state.checkouts.get(rec.paymentHash).gone = true;
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).step, 'invoiced');
      assert.equal((await provider.find(DE.transactionId)).paymentHash, rec.paymentHash);
      assert.equal(sends, 1); assert.equal(fake.purchases(), 1);
      mock.sent = async () => ({ status: 'SUCCESS' });
      assert.equal((await provider.find(DE.transactionId)).step, 'paid');
    });
    await scenario('a crash after durable reservation but before dispatch cannot silently clear or resend it', async () => {
      const rec = await seed();
      let sends = 0;
      mock.sent = async () => ({ status: 'NONE' });
      mock.pay = async () => { sends++; return { status: 'SUCCESS' }; };
      store.compareSet = async (key, expected, value) => {
        const changed = await originals.compareSet(key, expected, value);
        if (changed && key === orderKey && value.paymentState === 'sending') throw new Error('process stopped after reservation');
        return changed;
      };
      await assert.rejects(provider.order(DE), /process stopped/);
      store.compareSet = originals.compareSet;
      assert.equal((await store.get(orderKey)).paymentState, 'sending');
      assert.equal((await provider.find(DE.transactionId)).paymentHash, rec.paymentHash);
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash);
      assert.equal(sends, 0); assert.equal(fake.purchases(), 1);
    });
    await scenario('a pending send with delayed empty history retains its credit and checkout', async () => {
      const rec = await seed(); let sends = 0;
      mock.sent = async () => ({ status: 'NONE' });
      mock.pay = async () => { sends++; return { status: 'PENDING' }; };
      assert.equal((await provider.order(DE)).paymentState, 'pending');
      assert.equal((await provider.find(DE.transactionId)).paymentHash, rec.paymentHash);
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash);
      assert.equal(sends, 1); assert.equal(fake.purchases(), 1);
    });
    await scenario('forgotten checkout keeps pending and subsequently successful payment visible', async () => {
      const rec = await seed(); mock._state.mode = 'pending'; await provider.order(DE);
      fake.state.checkouts.get(rec.paymentHash).gone = true;
      assert.equal((await provider.find(DE.transactionId)).step, 'invoiced');
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash);
      mock._settle(rec.paymentHash);
      const paid = await provider.find(DE.transactionId);
      assert.equal(paid.step, 'paid'); assert.match(paid.error, /no longer knows/);
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).step, 'paid'); assert.equal(fake.purchases(), 1);
    });
    await scenario('forgotten checkout with an unreachable wallet cannot become failed', async () => {
      const rec = await seed(); fake.state.checkouts.get(rec.paymentHash).gone = true;
      mock._state.mode = 'down';
      assert.equal((await provider.find(DE.transactionId)).step, 'invoiced');
      await assert.rejects(provider.order(DE), /could not be reached/);
      assert.equal((await store.get(orderKey)).step, 'invoiced'); assert.equal(fake.purchases(), 1);
    });
    await scenario('expired invoice with pending funds cannot be replaced', async () => {
      const rec = await seed(); mock._state.mode = 'pending'; await provider.order(DE);
      await store.set(orderKey, { ...(await store.get(orderKey)), expiresAt: new Date(Date.now() - 600000).toISOString() });
      const before = mock._state.log.length;
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash);
      assert.equal((await provider.find(DE.transactionId)).step, 'invoiced');
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, before);
    });
    await scenario('expired invoice with settled funds advances to paid while supplier catches up', async () => {
      const rec = await seed(); mock._state.mode = 'pending'; await provider.order(DE); mock._settle(rec.paymentHash);
      fake.state.settleAfterCalls = 100;
      await store.set(orderKey, { ...(await store.get(orderKey)), expiresAt: new Date(Date.now() - 600000).toISOString() });
      assert.equal((await provider.find(DE.transactionId)).step, 'paid');
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      assert.equal((await provider.order(DE)).paymentHash, rec.paymentHash); assert.equal(fake.purchases(), 1);
    });
    await scenario('two callers recovering a stale lease have one atomic takeover and one send', async () => {
      await seed(); mock._state.mode = 'pending';
      await store.set(leaseKey, { attempt: 'dead-owner', at: Date.now() - 121000 });
      let arrivals = 0, takeovers = 0, release;
      const both = new Promise(resolve => { release = resolve; });
      store.compareSet = async (key, expected, value) => {
        if (key === leaseKey && expected?.attempt === 'dead-owner') {
          if (++arrivals === 2) release(); await both;
          const changed = await originals.compareSet(key, expected, value); takeovers += Number(changed); return changed;
        }
        return originals.compareSet(key, expected, value);
      };
      const before = mock._state.log.length;
      const orders = await Promise.all([provider.order(DE), provider.order(DE)]);
      assert.ok(orders.every(order => order.step === 'invoiced'));
      assert.equal(takeovers, 1); assert.equal(mock._state.log.length - before, 1);
      assert.equal(await store.get(leaseKey), null);
    });
    await scenario('obsolete lease owner neither sends nor deletes its replacement lease', async () => {
      await seed(); const replacement = { attempt: 'new-owner', at: Date.now() };
      mock.usdPerSat = async () => { await store.set(leaseKey, replacement); return originals.rate(); };
      const before = mock._state.log.length;
      await assert.rejects(provider.order(DE), /lease changed/);
      assert.deepEqual(await store.get(leaseKey), replacement); assert.equal(mock._state.log.length, before);
    });
    await scenario('slow validation cannot start a send outside its safe lease window', async () => {
      await seed(); const before = mock._state.log.length;
      mock.usdPerSat = async () => { Date.now = () => originals.now() + 21000; return originals.rate(); };
      await assert.rejects(provider.order(DE), /safe send window/);
      assert.equal(mock._state.log.length, before); assert.equal(await store.get(leaseKey), null);
    });
    await scenario('a package replacement waits for an in-flight send and preserves its pending invoice', async () => {
      const rec = await seed(); mock._state.mode = 'pending';
      let release, started, waited;
      const sendGate = new Promise(resolve => { release = resolve; });
      const sendStarted = new Promise(resolve => { started = resolve; });
      const replacementWaiting = new Promise(resolve => { waited = resolve; });
      mock.pay = async args => { started(); await sendGate; return originals.pay(args); };
      store.set = async (key, value, opts) => {
        const result = await originals.set(key, value, opts);
        if (key === leaseKey && opts?.nx && !result) waited();
        return result;
      };
      const before = mock._state.log.length;
      const sender = provider.order(DE); await sendStarted;
      const replacement = provider.order(EU);
      const results = Promise.allSettled([sender, replacement]);
      await replacementWaiting; release();
      const [sent, refused] = await results;
      assert.equal(sent.status, 'fulfilled');
      assert.equal(sent.value.paymentHash, rec.paymentHash);
      assert.equal(sent.value.packageCode, DE.packageCode);
      assert.equal(refused.status, 'rejected'); assert.equal(refused.reason.status, 409);
      assert.match(refused.reason.message, /orders have changed.*reload/);
      assert.equal((await store.get(orderKey)).paymentState, 'pending');
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length - before, 1);
    });
    await scenario('a legacy failed invoice with a pending payment is recovered rather than replaced', async () => {
      const rec = await seed(); mock._state.mode = 'pending'; await provider.order(DE);
      await store.set(orderKey, { ...(await store.get(orderKey)), step: 'failed' });
      await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
      const order = await provider.order(DE);
      assert.equal(order.step, 'invoiced'); assert.equal(order.paymentHash, rec.paymentHash); assert.equal(fake.purchases(), 1);
    });
    await scenario('a competing plan cannot carry or pay the other plan while its claim is being quoted', async () => {
      let claimed, release;
      const claimReady = new Promise(resolve => { claimed = resolve; });
      const quoteGate = new Promise(resolve => { release = resolve; });
      store.set = async (key, value, opts) => {
        const applied = await originals.set(key, value, opts);
        if (key === orderKey && opts?.nx && applied) { claimed(); await quoteGate; }
        return applied;
      };
      const first = provider.order(DE); await claimReady;
      try {
        await assert.rejects(provider.order(EU), error => error.status === 409 && /reload/.test(error.message));
        assert.equal(fake.purchases(), 0); assert.equal(mock._state.log.length, 0);
        assert.equal((await store.get(orderKey)).packageCode, DE.packageCode);
      } finally { release(); }
      const done = await first;
      assert.equal(done.packageCode, DE.packageCode);
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, 1);
    });
    await scenario('completed and paid records cannot be carried for another requested plan or place', async () => {
      const done = await provider.order(DE);
      const before = mock._state.log.length, completions = fake.completes();
      for (const step of ['done', 'paid']) {
        const stored = { ...done, step }; await store.set(orderKey, stored);
        for (const other of [EU, { ...DE, slug: 'france' }]) {
          await assert.rejects(provider.order(other), error => error.status === 409 && /reload/.test(error.message));
          assert.deepEqual(await store.get(orderKey), stored);
        }
      }
      assert.equal(mock._state.log.length, before); assert.equal(fake.completes(), completions);
    });
    await scenario('a record replaced after the first wallet-status read cannot be paid under the old plan', async () => {
      const rec = await seed(), before = mock._state.log.length;
      const competing = { ...rec, packageCode: EU.packageCode, slug: EU.slug };
      let reads = 0;
      mock.sent = async () => {
        if (++reads === 1) await store.set(orderKey, competing);
        return { status: 'NONE' };
      };
      await assert.rejects(provider.order(DE), error => error.status === 409 && /reload/.test(error.message));
      assert.deepEqual(await store.get(orderKey), competing);
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
    });
    await scenario('retry repairs an interrupted treasury index before paying the same invoice', async () => {
      store.zadd = async () => { throw new Error('index write interrupted'); };
      await assert.rejects(provider.order(DE), /index write interrupted/);
      const rec = await store.get(orderKey);
      assert.equal(rec.step, 'invoiced'); assert.equal(mock._state.log.length, 0);
      store.zadd = originals.zadd;
      const done = await provider.order(DE);
      assert.equal(done.step, 'done'); assert.equal(done.paymentHash, rec.paymentHash);
      assert.deepEqual((await provider.listOrders()).map(order => order.transactionId), [DE.transactionId]);
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, 1);
    });
    await scenario('lookup repairs a failed completed-profile index and the next same-place order tops it up', async () => {
      const address = '0x4444444444444444444444444444444444444444';
      const simKey = 'sim:' + address;
      const nextProfile = fake.state.seq;
      let indexFailures = 0;
      store.set = async (key, value, opts) => {
        if (key === simKey && indexFailures++ === 0) throw new Error('profile index write interrupted');
        return originals.set(key, value, opts);
      };
      const done = await provider.order({ ...DE, address });
      assert.equal(done.step, 'done'); assert.equal((await provider.sims(address)).length, 0);
      store.set = originals.set;
      const purchases = fake.purchases(), sends = mock._state.log.length;
      const recovered = await provider.find(DE.transactionId);
      assert.deepEqual(recovered, done);
      const cards = await provider.sims(address);
      assert.equal(cards.length, 1); assert.equal(cards[0].iccid, done.iccid); assert.equal(cards[0].ac, done.ac);
      assert.equal(fake.purchases(), purchases); assert.equal(mock._state.log.length, sends);
      const next = await provider.order({ ...DE, address, transactionId: 'recovery-next-bundle' });
      assert.equal(next.topupOf, done.iccid); assert.equal(next.iccid, done.iccid);
      assert.equal(fake.state.seq, nextProfile + 1); assert.equal((await provider.sims(address)).length, 1);
      assert.equal(fake.purchases(), purchases + 1); assert.equal(mock._state.log.length, sends + 1);
    });
    await scenario('repairing an older completed card does not replace the newer profile selected for top-ups', async () => {
      const address = '0x4444444444444444444444444444444444444444';
      const first = await provider.order({ ...DE, address });
      fake.state.refuseTopup = first.iccid;
      const replacement = await provider.order({ ...DE, address, transactionId: 'recovery-replacement' });
      assert.notEqual(replacement.iccid, first.iccid);
      const simKey = 'sim:' + address;
      const index = await store.get(simKey); delete index.cards[first.iccid]; await store.set(simKey, index);
      const purchases = fake.purchases(), sends = mock._state.log.length;
      await provider.find(DE.transactionId);
      const repaired = await store.get(simKey);
      assert.equal(repaired.bySlug[DE.slug], replacement.iccid); assert.equal(repaired.cards[first.iccid].ac, first.ac);
      assert.equal(fake.purchases(), purchases); assert.equal(mock._state.log.length, sends);
      const next = await provider.order({ ...DE, address, transactionId: 'recovery-after-repair' });
      assert.equal(next.topupOf, replacement.iccid); assert.equal(next.iccid, replacement.iccid);
    });
    await scenario('every resumed send revalidates invoice amount, network, hash, expiry and current rate', async () => {
      const rec = await seed(), before = mock._state.log.length;
      const variants = [
        { ...rec, paidUsd: 3 },
        { ...rec, paymentRequest: bolt11.encode({ sats: rec.sats, paymentHash: 'ff'.repeat(32), timestamp: Math.floor(Date.now() / 1000) }) },
        { ...rec, paymentRequest: bolt11.encode({ sats: rec.sats, paymentHash: rec.paymentHash, prefix: 'tb', timestamp: Math.floor(Date.now() / 1000) }) },
        { ...rec, paymentRequest: bolt11.encode({ sats: rec.sats, paymentHash: rec.paymentHash, timestamp: Math.floor(Date.now() / 1000) - 7200, expiry: 60 }) },
      ];
      for (const variant of variants) { await store.set(orderKey, variant); await assert.rejects(provider.order(DE), /stored.*invoice/); }
      await store.set(orderKey, rec); mock._state.usdPerSat = 0.00086;
      await assert.rejects(provider.order(DE), /reviewed catalogue price at the current wallet price/);
      mock._state.usdPerSat = 0.003;
      await assert.rejects(provider.order(DE), /current.*wallet price/);
      mock._state.usdPerSat = NaN;
      await assert.rejects(provider.order(DE), /price is unavailable/);
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
    });
    await scenario('an unpaid checkout past its earlier provider expiry cannot send during reconciliation grace', async () => {
      const rec = await seed(), before = mock._state.log.length;
      assert.ok(bolt11.decode(rec.paymentRequest).expiresAt * 1000 > Date.now());
      const expired = { ...rec, expiresAt: new Date(Date.now() - 30000).toISOString() };
      await store.set(orderKey, expired);
      await assert.rejects(provider.order(DE), /stored.*invoice.*expired/);
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
      assert.deepEqual(await store.get(orderKey), expired);
    });
    await scenario('expiry during the final lease check releases only the known unsent reservation', async () => {
      const rec = await seed(), before = mock._state.log.length;
      const deadlineMs = Date.now() + 1000;
      await store.set(orderKey, { ...rec, expiresAt: new Date(deadlineMs).toISOString() });
      let leaseReads = 0;
      store.get = async key => {
        const value = await originals.get(key);
        if (key === leaseKey && ++leaseReads === 2) Date.now = () => deadlineMs + 1;
        return value;
      };
      await assert.rejects(provider.order(DE), /expired before payment was sent/);
      const unsent = await store.get(orderKey);
      assert.equal(unsent.paymentState, 'not-sent'); assert.equal(unsent.paymentHash, rec.paymentHash);
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
    });
    await scenario('a payer refusal before its own dispatch leaves the invoice known unsent', async () => {
      const rec = await seed(), before = mock._state.log.length;
      mock.pay = async args => {
        assert.equal(args.deadlineMs, Date.parse(rec.expiresAt));
        return { status: 'FAILURE', error: 'invoice expired before payment was sent', notSent: true };
      };
      await assert.rejects(provider.order(DE), /expired before payment was sent/);
      assert.equal((await store.get(orderKey)).paymentState, 'not-sent');
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
    });
    await scenario('an expired checkout with a reserved payment still reconciles to issuance without another send', async () => {
      const rec = await seed(); mock._state.mode = 'pending'; await provider.order(DE);
      await store.set(orderKey, { ...(await store.get(orderKey)), expiresAt: new Date(Date.now() - 30000).toISOString() });
      const before = mock._state.log.length;
      const pending = await provider.order(DE);
      assert.equal(pending.paymentState, 'pending'); assert.equal(pending.paymentHash, rec.paymentHash);
      mock._settle(rec.paymentHash);
      const done = await provider.order(DE);
      assert.equal(done.step, 'done'); assert.equal(done.paymentHash, rec.paymentHash);
      assert.equal(mock._state.log.length, before); assert.equal(fake.purchases(), 1);
    });
    console.log(checks + ' wholesale recovery scenarios passed. Local fakes only.');
  } finally { await fake.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
