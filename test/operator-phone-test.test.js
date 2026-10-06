#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const { parse, plan, runTest, checkedPay, officialConfig, resultOf, manifestOf, livePackage } = require('../scripts/test-esim');
const pack = require('../scripts/esim-install-pack');
const { PRIVATE_BASE, privatePath } = require('../scripts/operator-test-files');
const { memoryStore } = require('../site/api/_lib/store');
const bolt11 = require('../site/api/_lib/bolt11');
const options = { purchase: true, runId: 'unit-phone-' + crypto.randomBytes(4).toString('hex'), sku: 'fixed_1GB_7D_AU',
  maxInvoiceUsd: 2.5, maxPaymentUsd: 2.5, maxWalletUsd: 4 };
const p = plan(options);
const hash = crypto.randomBytes(32).toString('hex');
const paymentRequest = bolt11.encode({ sats: 1890, paymentHash: hash, timestamp: Math.floor(Date.now() / 1000) });
const rec = { transactionId: 'operator-' + options.runId, packageCode: p.sku, slug: p.slug, address: '', topupOf: '',
  step: 'invoiced', paymentHash: hash, paymentRequest, paidUsd: 1.89 };
const issued = { ...rec, step: 'done', pending: false, iccid: '8944000000000000001', ac: 'LPA:1$rsp.example.com$test-code',
  smdpAddress: 'rsp.example.com', matchingId: 'test-code', completedAt: new Date().toISOString() };
const payer = { usdPerSat: async () => 0.001, balance: async () => ({ sats: 3000, usdPerSat: 0.001 }),
  feeProbe: async () => ({ feeSats: 10 }) };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok ' + name); }
async function checkAsync(name, fn) { await fn(); checks++; console.log('ok ' + name); }
function removeFixture(directory, base, prefix) {
  const resolved = fs.realpathSync(directory);
  const root = fs.realpathSync(base);
  assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
  assert.ok(path.basename(resolved).startsWith(prefix));
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function integration() {
  const mock = require('../site/api/_lib/payers/mock');
  const storage = require('../site/api/_lib/store');
  const fake = await require('./support/fake-wholesale').start({ mockPayer: mock,
    catalogue: { [p.sku]: { slug: p.slug, price: p.catalogueUsd } } });
  const names = ['WHOLESALE_BASE_URL', 'WHOLESALE_COMPLETE_WAIT_MS', 'WHOLESALE_ALLOW_MEMORY_STORE', 'LN_PAYER', 'STORE', 'STORE_PREFIX', 'NODE_ENV', 'VERCEL_ENV', 'REDEMPTIONS_ENABLED'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const opts = { ...options, runId: 'unit-integration-' + crypto.randomBytes(4).toString('hex') };
  let output, restorePay;
  try {
    Object.assign(process.env, { WHOLESALE_BASE_URL: fake.base, WHOLESALE_COMPLETE_WAIT_MS: '0', WHOLESALE_ALLOW_MEMORY_STORE: '1',
      LN_PAYER: 'mock', STORE: 'memory', STORE_PREFIX: 'ott:operator-test:', NODE_ENV: 'test',
      VERCEL_ENV: 'test', REDEMPTIONS_ENABLED: '1' });
    mock._reset(); mock._state.sats = 3000; mock._state.usdPerSat = 0.001; mock._state.mode = 'pending';
    const provider = require('../site/api/_lib/providers/wholesale');
    provider._reset();
    const originalPay = mock.pay;
    restorePay = originalPay;
    let guardedPay;
    // Each real CLI has its own module instance. Keep one guarded fixture for concurrent calls.
    mock.pay = args => guardedPay(args);
    const deps = { store: storage.store(), payer: { ...mock, feeProbe: async () => ({ feeSats: 10 }), pay: args => originalPay(args) },
      order: async (args, pay) => {
        guardedPay = pay;
        return provider.order(args);
      } };
    await checkAsync('real provider retries keep one invoice and one pending payment', async () => {
      const first = await runTest(opts, deps);
      assert.equal(first.stage, 'invoiced');
      const second = await runTest(opts, deps);
      assert.equal(second.stage, 'invoiced');
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, 1);
    });
    await checkAsync('concurrent retries preserve a pending payment despite stale empty history', async () => {
      const originalSent = mock.sent;
      let arrivals = 0, release;
      const bothRead = new Promise(resolve => { release = resolve; });
      mock.sent = async hash => {
        const arrival = ++arrivals;
        if (arrival <= 2) {
          if (arrival === 2) release();
          await bothRead;
          return { status: 'NONE' }; // Both pre-lease observations are deliberately stale.
        }
        return originalSent(hash);
      };
      try {
        const results = await Promise.all([runTest(opts, deps), runTest(opts, deps)]);
        assert.ok(results.every(result => result.stage === 'invoiced'));
        assert.equal((await deps.store.get('order:operator-' + opts.runId)).paymentState, 'pending');
        assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, 1);
      } finally { mock.sent = originalSent; }
    });
    await checkAsync('settled payment resumes issuance without buying or paying twice', async () => {
      const record = await deps.store.get('order:operator-' + opts.runId);
      mock._settle(record.paymentHash);
      const done = await runTest(opts, deps); output = done.orderFile;
      assert.equal(done.stage, 'done'); assert.ok(done.orderFile);
      const again = await runTest(opts, deps);
      assert.equal(again.orderFile, done.orderFile);
      assert.equal(fake.purchases(), 1); assert.equal(mock._state.log.length, 1);
      const exported = JSON.parse(fs.readFileSync(output));
      assert.equal(exported.purpose, 'ott-operator-phone-test');
      assert.ok(!('paymentRequest' in exported));
      assert.equal((await provider.sims('')).length, 0);
    });
    for (const [name, sats] of [['insufficient', 0], ['oversized', 50000]]) {
      await checkAsync(name + ' balance refusal retains an unpaid invoice that the same run can retry', async () => {
        const guardedOpts = { ...opts, runId: opts.runId + '-' + name };
        const key = 'order:operator-' + guardedOpts.runId;
        const purchases = fake.purchases(), sends = mock._state.log.length;
        mock._state.sats = sats;
        await assert.rejects(runTest(guardedOpts, deps), /before any send/);
        const refused = await deps.store.get(key);
        assert.equal(refused.step, 'invoiced');
        assert.equal(refused.paymentState, 'not-sent');
        assert.equal(mock._state.log.length, sends);
        mock._state.sats = 3000; mock._state.mode = 'pending';
        const retry = await runTest(guardedOpts, deps);
        const pending = await deps.store.get(key);
        assert.equal(retry.stage, 'invoiced');
        assert.equal(pending.paymentState, 'pending');
        assert.equal(pending.paymentHash, refused.paymentHash);
        assert.equal(fake.purchases(), purchases + 1);
        assert.equal(mock._state.log.length, sends + 1);
      });
    }
    for (const mode of ['lost', 'unknown']) {
      await checkAsync('a ' + mode + ' operator send response stays reserved despite empty or failed wallet history', async () => {
        const uncertainOpts = { ...opts, runId: opts.runId + '-' + mode };
        const key = 'order:operator-' + uncertainOpts.runId;
        const originalGuardedPay = deps.payer.pay, originalSent = mock.sent;
        const purchases = fake.purchases();
        let sends = 0;
        deps.payer.pay = async () => {
          sends++;
          if (mode === 'lost') throw new Error('response lost after dispatch');
          return { status: 'UNKNOWN' };
        };
        try {
          await assert.rejects(runTest(uncertainOpts, deps), mode === 'lost' ? /wallet did not answer/ : /result is uncertain/);
          const reserved = await deps.store.get(key);
          assert.equal(reserved.paymentState, 'uncertain');
          for (const status of ['NONE', 'FAILURE']) {
            mock.sent = async () => ({ status });
            const retry = await runTest(uncertainOpts, deps);
            const current = await deps.store.get(key);
            assert.equal(retry.stage, 'invoiced');
            assert.equal(current.paymentState, 'uncertain');
            assert.equal(current.paymentHash, reserved.paymentHash);
          }
          assert.equal(fake.purchases(), purchases + 1);
          assert.equal(sends, 1);
        } finally { deps.payer.pay = originalGuardedPay; mock.sent = originalSent; }
      });
    }
  } finally {
    await fake.close();
    if (restorePay) mock.pay = restorePay;
    if (output) removeFixture(path.dirname(output), PRIVATE_BASE, 'unit-integration-');
    storage.store()._reset(); mock._reset();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function main() {
  check('default is a dry run', () => assert.equal(parse([]).purchase, false));
  check('purchase requires named run and cap', () => assert.throws(() => plan({ purchase: true, sku: p.sku }), /explicit/));
  check('conflicting modes rejected', () => assert.throws(() => parse(['--purchase', '--dry-run']), /either/));
  check('preflight cannot be combined with purchase or dry-run', () => {
    for (const mode of ['--purchase', '--dry-run']) assert.throws(() => parse(['--preflight', mode]), /either/);
  });
  check('local credentials never load for an offline plan', () => assert.throws(() => parse(['--dry-run', '--local-credentials']), /only/));
  check('offline default wallet ceiling is $4', () => assert.equal(plan(parse([])).maxWalletUsd, 4));
  check('preflight and purchase require all explicit caps', () => {
    for (const name of ['runId', 'maxInvoiceUsd', 'maxPaymentUsd', 'maxWalletUsd']) {
      for (const mode of ['purchase', 'preflight']) assert.throws(() => plan({ ...options, purchase: false, [mode]: true, [name]: undefined }), /explicit/);
    }
  });
  check('caps cannot be negative, nonfinite or ordered incorrectly', () => {
    for (const name of ['maxInvoiceUsd', 'maxPaymentUsd', 'maxWalletUsd']) {
      for (const value of [0, -1, Infinity, NaN, 21]) assert.throws(() => plan({ ...options, [name]: value }), /cap/);
    }
    assert.throws(() => plan({ ...options, maxPaymentUsd: 2 }), /Caps/);
    assert.throws(() => plan({ ...options, maxWalletUsd: 2 }), /Caps/);
  });
  check('caps must be finite and at most $20', () => assert.throws(() => plan({ ...options, maxInvoiceUsd: 'Infinity' }), /cap/));
  check('cap must cover reviewed SKU', () => assert.throws(() => plan({ ...options, maxInvoiceUsd: 1 }), /catalogue/));
  check('path traversal run IDs refused', () => assert.throws(() => plan({ ...options, runId: '../escape' }), /Run ID/));
  check('no credentials needed for offline plan', () => assert.equal(officialConfig({}), false));
  check('memory store refused', () => assert.throws(() => officialConfig({ STORE: 'memory' }), /durable/));
  check('credential forwarding to arbitrary store refused', () => assert.throws(() => officialConfig({ KV_REST_API_URL: 'https://evil.example', KV_REST_API_TOKEN: 'private' }), /Upstash/));
  check('Blink custom host refused', () => assert.throws(() => officialConfig({ KV_REST_API_URL: 'https://test.upstash.io', KV_REST_API_TOKEN: 'private', BLINK_API_KEY: 'private', BLINK_API_URL: 'https://evil.example' }, true), /mainnet/));
  check('payment wallet override cannot bypass checked BTC balance', () => assert.throws(() => officialConfig({ KV_REST_API_URL: 'https://test.upstash.io', KV_REST_API_TOKEN: 'private', BLINK_API_KEY: 'private', BLINK_WALLET_ID: 'unchecked-wallet' }, true), /default BTC/));
  await checkAsync('live package review uses only an official catalogue GET and rejects changed terms', async () => {
    const originalFetch = global.fetch;
    const bundle = { name: p.sku, price: p.catalogueUsd, dataInGB: p.gb, durationInDays: p.days, roamingEnabled: [{ iso: 'AU' }] };
    let selected = bundle;
    global.fetch = async (url, init) => {
      assert.equal(url, 'https://nadanada.me/api/v2/esim/bundles?country=AU');
      assert.ok(!init.method || init.method === 'GET'); assert.ok(!init.body); assert.ok(!init.headers.authorization);
      return { ok: true, json: async () => ({ data: [selected] }) };
    };
    try {
      assert.equal((await livePackage(p)).priceUsd, p.catalogueUsd);
      for (const changed of [{ price: 2.99 }, { dataInGB: 0.5 }, { durationInDays: 1 }, { roamingEnabled: [{ iso: 'NZ' }] }, { name: 'other' }]) {
        selected = { ...bundle, ...changed }; await assert.rejects(livePackage(p), /differs/);
      }
    } finally { global.fetch = originalFetch; }
  });
  const store = memoryStore();
  await store.set('order:' + rec.transactionId, rec);
  let calls = 0;
  await checkAsync('dry run does not invoice, complete, pay or write a manifest', async () => {
    const report = await runTest({ ...options, purchase: false }, { store, order: () => { calls++; }, payer });
    assert.equal(report.storedStage, 'invoiced'); assert.equal(calls, 0);
    assert.equal(await store.get('operator-run:' + options.runId), null);
    assert.ok(!JSON.stringify(report).includes(paymentRequest));
  });
  await checkAsync('approved stored invoice passes', () => checkedPay({ record: rec, paymentRequest, p, payer }));
  await checkAsync('fee guard reports estimate rather than guaranteed final cost', async () => {
    const estimate = await checkedPay({ record: rec, paymentRequest, p, payer });
    assert.equal(estimate.estimatedFeeSats, 10); assert.equal(estimate.feeLimitEnforced, false);
  });
  await checkAsync('routing estimate fits exact boundary and refuses the next sat', async () => {
    const exact = { ...payer, feeProbe: async () => ({ feeSats: 610 }) };
    assert.equal((await checkedPay({ record: rec, paymentRequest, p, payer: exact })).estimatedPaymentUsd, 2.5);
    await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...exact, feeProbe: async () => ({ feeSats: 611 }) } }), /estimate cap/);
  });
  await checkAsync('fractional sat headroom is rounded down', () => assert.rejects(checkedPay({ record: rec, paymentRequest,
    p: { ...p, maxPaymentUsd: 1.9009 }, payer: { ...payer, feeProbe: async () => ({ feeSats: 11 }) } }), /estimate cap/));
  await checkAsync('a fractional-sat invoice cannot slip past the whole-sat invoice cap', async () => {
    const { words } = bolt11.bech32Decode(paymentRequest);
    const fractional = bolt11.bech32Encode('lnbc19909990p', words);
    await assert.rejects(checkedPay({ record: { ...rec, paymentRequest: fractional }, paymentRequest: fractional,
      p: { ...p, maxInvoiceUsd: p.catalogueUsd, maxPaymentUsd: p.catalogueUsd },
      payer: { ...payer, feeProbe: async () => ({ feeSats: 0 }) } }), /cap/);
  });
  await checkAsync('a fractional-sat invoice needs the next whole sat in the payment wallet', async () => {
    const { words } = bolt11.bech32Decode(paymentRequest);
    const fractional = bolt11.bech32Encode('lnbc25009990p', words);
    const fractionalPayer = { usdPerSat: async () => 0.000756, feeProbe: async () => ({ feeSats: 0 }),
      balance: async () => ({ sats: 2500, usdPerSat: 0.000756 }) };
    await assert.rejects(checkedPay({ record: { ...rec, paymentRequest: fractional }, paymentRequest: fractional,
      p, payer: fractionalPayer }), /dedicated/);
  });
  await checkAsync('missing or malformed fee estimates refuse payment', async () => {
    await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, feeProbe: undefined } }), /estimate/);
    for (const feeSats of [-1, 0.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, feeProbe: async () => ({ feeSats }) } }), /invalid/);
    }
  });
  await checkAsync('invoice-only balance is insufficient when a fee is expected', () => assert.rejects(checkedPay({ record: rec, paymentRequest, p,
    payer: { ...payer, balance: async () => ({ sats: 1890, usdPerSat: 0.001 }) } }), /dedicated/));
  await checkAsync('higher balance-query price cannot weaken invoice or wallet caps', async () => {
    await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, balance: async () => ({ sats: 3000, usdPerSat: 0.0014 }) } }), /cap/);
    await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, balance: async () => ({ sats: 4000, usdPerSat: 0.00101 }) } }), /dedicated/);
  });
  await checkAsync('invalid balances and missing price fail closed', async () => {
    for (const balance of [{ sats: -1, usdPerSat: 0.001 }, { sats: 3000.5, usdPerSat: 0.001 }, { sats: 3000, usdPerSat: 0 }, { sats: 3000, usdPerSat: NaN }]) {
      await assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, balance: async () => balance } }), /unavailable/);
    }
  });
  await checkAsync('resumed invoice over cap cannot pay', () => assert.rejects(checkedPay({ record: rec, paymentRequest, p: { ...p, maxInvoiceUsd: 1 }, payer }), /cap/));
  await checkAsync('changed BTC rate is checked again on resume', () => assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, usdPerSat: async () => 0.003 } }), /cap/));
  await checkAsync('mismatched payment hash refused', () => assert.rejects(checkedPay({ record: { ...rec, paymentHash: 'f'.repeat(64) }, paymentRequest, p, payer }), /validation/));
  await checkAsync('expired invoice refused before payment', async () => {
    const expired = bolt11.encode({ sats: 1890, paymentHash: hash, timestamp: Math.floor(Date.now() / 1000) - 7200, expiry: 60 });
    await assert.rejects(checkedPay({ record: { ...rec, paymentRequest: expired }, paymentRequest: expired, p, payer }), /validation/);
  });
  await checkAsync('an earlier expired checkout cannot pass invoice-only validation', () => assert.rejects(checkedPay({
    record: { ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() }, paymentRequest, p, payer }), /validation/));
  await checkAsync('different package on stored run refused', () => assert.rejects(checkedPay({ record: { ...rec, packageCode: 'other' }, paymentRequest, p, payer }), /match/));
  await checkAsync('large BTC wallet refused before paying', () => assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, balance: async () => ({ sats: 50000, usdPerSat: 0.001 }) } }), /dedicated/));
  await checkAsync('insufficient BTC balance refused', () => assert.rejects(checkedPay({ record: rec, paymentRequest, p, payer: { ...payer, balance: async () => ({ sats: 100, usdPerSat: 0.001 }) } }), /dedicated/));
  await checkAsync('failed invoice cannot silently create new checkout', async () => {
    await store.set('order:' + rec.transactionId, { ...rec, step: 'failed' });
    await assert.rejects(runTest(options, { store, payer, order: () => { calls++; } }), /Previous checkout/);
    assert.equal(calls, 0);
  });
  await checkAsync('immutable run invoice cap cannot be changed', () => assert.rejects(runTest({ ...options, maxInvoiceUsd: 2.2 }, { store, payer, order: () => { calls++; } }), /bound/));
  await checkAsync('immutable payment and wallet caps cannot be changed', async () => {
    for (const changed of [{ maxPaymentUsd: 3 }, { maxWalletUsd: 5 }]) await assert.rejects(runTest({ ...options, ...changed }, { store, payer, order: () => { calls++; } }), /bound/);
    assert.equal(calls, 0);
  });
  await checkAsync('legacy run manifest cannot silently gain new spending settings', async () => {
    const legacy = memoryStore(); await legacy.set('operator-run:' + options.runId, { schema: 1, sku: p.sku, slug: p.slug, cap: 2.5, catalogueUsd: p.catalogueUsd });
    await assert.rejects(runTest(options, { store: legacy, payer, order: () => { calls++; } }), /bound/);
    assert.equal(calls, 0);
  });
  await checkAsync('preflight is read-only and redacts existing invoice and activation data', async () => {
    const readonly = { get: async key => key.startsWith('order:') ? issued : manifestOf(p), set: () => { throw new Error('unexpected write'); } };
    const noAction = () => { throw new Error('unexpected payment or checkout'); };
    const report = await runTest({ ...options, purchase: false, preflight: true }, { store: readonly,
      catalogueLookup: async () => ({ sku: p.sku, priceUsd: 1.99 }), order: noAction,
      payer: { ...payer, balance: async () => ({ sats: 0, usdPerSat: 0.001 }), pay: noAction, invoice: noAction, feeProbe: noAction } });
    assert.equal(report.mode, 'preflight'); assert.equal(report.wallet.status, 'needs-funding');
    assert.equal(report.storage, 'read-access-verified'); assert.equal(report.paymentTested, false);
    const output = JSON.stringify(report);
    for (const secret of [paymentRequest, issued.ac, issued.iccid]) assert.ok(!output.includes(secret));
  });
  await checkAsync('preflight reports missing credentials without claiming account access', async () => {
    const report = await runTest({ ...options, purchase: false, preflight: true }, { catalogueLookup: async () => ({ sku: p.sku, priceUsd: 1.99 }) });
    assert.equal(report.wallet.status, 'credential-required'); assert.equal(report.storage, 'credential-required');
    assert.equal(report.paymentTested, false);
  });
  await checkAsync('preflight distinguishes a present balance from an oversized wallet', async () => {
    for (const [sats, status] of [[3000, 'balance-present'], [5000, 'over-cap']]) {
      const report = await runTest({ ...options, purchase: false, preflight: true }, { catalogueLookup: async () => ({}), payer: { ...payer, balance: async () => ({ sats, usdPerSat: 0.001 }) } });
      assert.equal(report.wallet.status, status); assert.equal(report.wallet.feeLimitEnforced, false);
    }
  });
  await checkAsync('preflight rejects bound-setting changes before catalogue lookup', async () => {
    let lookups = 0;
    await assert.rejects(runTest({ ...options, purchase: false, preflight: true }, { store: { get: async key => key.startsWith('order:') ? null : { ...manifestOf(p), maxWalletUsd: 20 } }, catalogueLookup: async () => { lookups++; } }), /bound/);
    assert.equal(lookups, 0);
  });
  await checkAsync('every spending-guard refusal dispatches zero payments and preserves the invoice', async () => {
    const refusedPayers = [
      { ...payer, feeProbe: undefined }, { ...payer, feeProbe: async () => ({ feeSats: 1000 }) },
      { ...payer, feeProbe: async () => ({ feeSats: -1 }) }, { ...payer, feeProbe: async () => { throw new Error('route unavailable'); } },
      { ...payer, balance: async () => ({ sats: 5000, usdPerSat: 0.001 }) }, { ...payer, balance: async () => ({ sats: 1890, usdPerSat: 0.001 }) },
    ];
    for (const guarded of refusedPayers) {
      const fresh = memoryStore(); await fresh.set('order:' + rec.transactionId, rec);
      const lease = { attempt: 'test', at: Date.now() }; await fresh.set('paylease:' + rec.transactionId, lease);
      let sends = 0;
      await assert.rejects(runTest(options, { store: fresh, payer: { ...guarded, sent: async () => ({ status: 'NONE' }), pay: async () => { sends++; } },
        order: async (_args, guardedPay) => { const result = await guardedPay({ paymentRequest, paymentLease: lease }); throw new Error(result.error); } }), /before any send/);
      assert.equal(sends, 0); assert.deepEqual(await fresh.get('order:' + rec.transactionId), rec);
    }
  });
  check('CLI failure never exposes private upstream markers', () => {
    const marker = 'PRIVATE-KEY-INVOICE-ACTIVATION';
    const proc = spawnSync(process.execPath, ['scripts/test-esim.js', '--preflight', '--run-id', options.runId, '--sku', p.sku,
      '--max-invoice-usd', '2.50', '--max-payment-usd', '2.50', '--max-wallet-usd', '4'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, USERPROFILE: os.homedir(),
        BLINK_API_KEY: marker, BLINK_API_URL: 'https://evil.example/' + marker, KV_REST_API_URL: 'https://test.upstash.io', KV_REST_API_TOKEN: marker },
    });
    assert.equal(proc.status, 1); assert.ok(!(proc.stdout + proc.stderr).includes(marker));
  });
  await checkAsync('uncertain payment status prevents another send', async () => {
    const fresh = memoryStore(); await fresh.set('order:' + rec.transactionId, rec);
    let sends = 0;
    await assert.rejects(runTest(options, { store: fresh,
      payer: { ...payer, sent: async () => ({ status: 'UNKNOWN' }), pay: async () => { sends++; } },
      order: async (_args, guardedPay) => {
        const result = await guardedPay({ paymentRequest });
        assert.equal(result.status, 'FAILURE'); throw new Error(result.error);
      } }), /before any send/);
    assert.equal(sends, 0);
  });
  await checkAsync('expired or replaced payment lease cannot send', async () => {
    for (const changed of [false, true]) {
      const fresh = memoryStore(); await fresh.set('order:' + rec.transactionId, rec);
      const lease = { attempt: 'original', at: Date.now() - (changed ? 0 : 46000) };
      await fresh.set('paylease:' + rec.transactionId, { ...lease, attempt: changed ? 'replacement' : lease.attempt });
      let sends = 0;
      await assert.rejects(runTest(options, { store: fresh,
        payer: { ...payer, sent: async () => ({ status: 'NONE' }), pay: async () => { sends++; } },
        order: async (_args, guardedPay) => {
          const result = await guardedPay({ paymentRequest, paymentLease: lease });
          assert.equal(result.status, 'FAILURE'); throw new Error(result.error);
        } }), /before any send/);
      assert.equal(sends, 0);
    }
  });
  await checkAsync('expiry during fee or final status checks refuses before the actual payer', async () => {
    const originalNow = Date.now;
    try {
      for (const expireAt of ['fee', 'status']) {
        Date.now = originalNow;
        const deadlineMs = Date.now() + 1000;
        const fresh = memoryStore();
        const expiring = { ...rec, expiresAt: new Date(deadlineMs).toISOString() };
        await fresh.set('order:' + rec.transactionId, expiring);
        const lease = { attempt: 'expiry-test', at: Date.now() };
        await fresh.set('paylease:' + rec.transactionId, lease);
        let sends = 0;
        await assert.rejects(runTest(options, { store: fresh, payer: { ...payer,
          feeProbe: async () => { if (expireAt === 'fee') Date.now = () => deadlineMs + 1; return { feeSats: 10 }; },
          sent: async () => { if (expireAt === 'status') Date.now = () => deadlineMs + 1; return { status: 'NONE' }; },
          pay: async () => { sends++; },
        }, order: async (_args, guardedPay) => {
          const refused = await guardedPay({ paymentRequest, paymentLease: lease, deadlineMs });
          assert.equal(refused.status, 'FAILURE'); assert.equal(refused.notSent, true);
          throw new Error(refused.error);
        } }), /before any send/);
        assert.equal(sends, 0); assert.deepEqual(await fresh.get('order:' + rec.transactionId), expiring);
      }
    } finally { Date.now = originalNow; }
  });
  const privateOrder = resultOf(p, issued);
  check('private export strips Lightning invoice and payment hash', () => { assert.ok(!('paymentRequest' in privateOrder)); assert.ok(!('paymentHash' in privateOrder)); });
  const html = pack.render(privateOrder);
  check('QR is locally encoded with no external image URL or script', () => { assert.match(html, /data:image\/svg\+xml/); assert.ok(!html.includes('<script')); assert.ok(!/<img[^>]+src="https?:/i.test(html)); });
  check('provider remote installation URLs are not emitted', () => { assert.ok(!pack.render({ ...privateOrder, appleInstallUrl: 'https://evil.example/steal' }).includes('evil.example')); });
  check('pending eSIM cannot be exported', () => assert.throws(() => pack.render({ ...privateOrder, pending: true }), /completed/));
  check('top-up cannot be mistaken for a new profile', () => assert.throws(() => pack.render({ ...privateOrder, topupOf: issued.iccid }), /completed/));
  check('missing LPA refused', () => assert.throws(() => pack.render({ ...privateOrder, ac: '', manualCode: '' }), /activation/));
  check('mismatched provider fields refused', () => assert.throws(() => pack.render({ ...privateOrder, matchingId: 'wrong' }), /disagree/));
  check('package HTML escaped', () => assert.ok(!pack.render({ ...privateOrder, package: { name: '<script>bad()</script>' } }).includes('<script>')));
  check('checkout output rejected', () => assert.throws(() => privatePath(path.join(__dirname, '..', 'review', 'secret.html')), /outside/));
  check('OneDrive output rejected', () => assert.throws(() => privatePath(path.join(os.homedir(), 'OneDrive', 'secret.html')), /outside/));
  check('shared or arbitrary output location refused', () => assert.throws(() => privatePath(path.join(os.tmpdir(), 'secret.html')), /dedicated/));
  fs.mkdirSync(PRIVATE_BASE, { recursive: true });
  const temp = fs.mkdtempSync(path.join(PRIVATE_BASE, 'unit-install-test-'));
  try {
    const file = path.join(temp, 'order.json'); fs.writeFileSync(file, JSON.stringify(privateOrder));
    check('completed file creates offline page in private directory', () => assert.equal(fs.existsSync(pack.build({ orderFile: file })), true));
    if (process.platform === 'win32') check('installation file ACL permits only this user and SYSTEM', () => {
      const script = String.raw`$f = New-Object System.IO.FileInfo($env:OTT_ACL_TEST_FILE)
$acl = $f.GetAccessControl()
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ids = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }
Write-Output ($acl.AreAccessRulesProtected -and !($ids | Where-Object { $_ -ne $owner -and $_ -ne 'S-1-5-18' }))`;
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, OTT_ACL_TEST_FILE: path.join(temp, 'install.html') }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.trim(), 'True');
    });
  } finally { removeFixture(temp, PRIVATE_BASE, 'unit-install-test-'); }
  check('CLI dry-run works offline and leaves production config alone', () => {
    const proc = spawnSync(process.execPath, ['scripts/test-esim.js', '--dry-run'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, USERPROFILE: os.homedir() } });
    assert.equal(proc.status, 0); assert.equal(JSON.parse(proc.stdout).mode, 'dry-run');
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site/config/esim.json'))).coin, '');
  });
  await integration();
  console.log(checks + ' operator phone-test checks passed. No live services or payments used.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
