#!/usr/bin/env node
'use strict';
/**
 * site/api/_lib/payers/blink.js — the REAL Blink payer, driven against test/support/fake-blink.js,
 * a fake of api.blink.sv's GraphQL shape checked directly against the live API on 16 Sep 2026 (see
 * that file's header).
 *
 * Until this file, pay(), invoice(), sent() and received() had never run against anything, fake or
 * real: every other test in this repo sets LN_PAYER=mock, and the one place LN_PAYER=blink ever
 * appeared (test/status.test.js) points at a fake that only ever answers a malformed error, to
 * prove secret-scrubbing — it exercises balance()'s error path and nothing else. The first time
 * pay() ran for real would otherwise be a paying holder's redemption.
 *
 * What is asserted throughout is blink.js's own contract with its callers — the {status, error}
 * shape site/api/_lib/providers/wholesale.js switches on for pay(), the NONE|PENDING|SUCCESS|FAILURE
 * shape it switches on for sent(), the exceptions scripts/fund.js and site/api/status.js catch —
 * never fake-blink.js's internals.
 *
 *   node test/blink.test.js
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const payer = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'payers', 'blink.js'));
const fakeBlink = require(path.join(__dirname, 'support', 'fake-blink.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); } };
const rejects = async (what, p, re) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};
/** Like rejects(), but for a failure whose exact wording is a Node/undici implementation detail
 *  (an aborted fetch) rather than part of blink.js's own contract — only that it DID reject matters. */
const rejectsSomehow = async (what, p) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { console.log(`  ok   ${what} (${e.message})`); }
};
const hash = (label) => crypto.createHash('sha256').update(label).digest('hex');

async function main() {
  const fake = await fakeBlink.start();
  const originalWallets = fake.state.wallets;
  process.env.BLINK_API_URL = fake.base + '/graphql';
  delete process.env.BLINK_WALLET_ID;
  delete process.env.BLINK_API_KEY;

  console.log('auth — every operation but the two public ones needs X-API-KEY');
  await rejects('pay() with no key set at all fails locally, before any request', payer.pay({ paymentRequest: 'lnfake1x' }), /BLINK_API_KEY is not set/);
  await rejects('explicit BTC balance evidence also requires authentication before any request', payer.btcBalance(), /BLINK_API_KEY is not set/);
  check('...and the fake never even saw it', fake.calls('wallets') + fake.calls('pay'), 0);
  process.env.BLINK_API_KEY = 'the-wrong-key';
  await rejects('balance() with a key the fake does not recognise surfaces Blink\'s own refusal, not a generic HTTP error', payer.balance(), /Blink: Not authorized/);
  process.env.BLINK_API_KEY = fake.apiKey;

  console.log('\nusdPerSat() — public, no key needed');
  check('the formula is base / 10^offset / 100', await payer.usdPerSat(), 8 / 100 / 100);
  const priceLog = fake.state.log[fake.state.log.length - 1];
  checkThat('and no X-API-KEY was sent for a call that needs none', !('x-api-key' in priceLog.headers), JSON.stringify(priceLog.headers));
  fake.state.priceMissing = true;
  await rejects('a price response with no btcSatPrice is a clear failure, not a silent 0', payer.usdPerSat(), /Blink gave no price/);
  fake.state.priceMissing = false;

  console.log('\nbalance()');
  check('a BTC wallet plus a USD wallet: sats is the BTC wallet, usd adds both at the public rate', await payer.balance(), { sats: 1000000, usd: 850, usdPerSat: 0.0008 });
  fake.state.wallets = [{ id: 'wallet-btc-0001', walletCurrency: 'BTC', balance: 1000000 }];
  check('BTC alone: usd is just sats at the rate, nothing to add', await payer.balance(), { sats: 1000000, usd: 800, usdPerSat: 0.0008 });
  fake.state.wallets = [{ id: 'wallet-usd-0001', walletCurrency: 'USD', balance: 12345 }];
  check('no BTC wallet at all: sats reports 0 rather than throwing — a USD-only account is real, and this is a report, not a spend', await payer.balance(), { sats: 0, usd: 123.45, usdPerSat: 0.0008 });
  fake.state.wallets = [{ id: 'wallet-btc-0001', walletCurrency: 'BTC', balance: 333 }, { id: 'wallet-usd-0001', walletCurrency: 'USD', balance: 1 }];
  check('the dollar figure rounds to the cent (333 sats at $0.0008 plus one cent is $0.2764, not $0.28 without rounding)', (await payer.balance()).usd, 0.28);
  fake.state.wallets = originalWallets;

  console.log('\nbtcBalance() — explicit read-only BTC wallet evidence');
  check('BTC evidence excludes the separate USD wallet and does not reveal wallet identifiers', await payer.btcBalance(),
    { sats: 1000000, usd: 800, usdPerSat: 0.0008, walletCurrency: 'BTC' });
  fake.state.wallets = [{ id: 'wallet-btc-0001', walletCurrency: 'BTC', balance: 0 }, { id: 'wallet-usd-0001', walletCurrency: 'USD', balance: 5000 }];
  check('an empty BTC wallet is positively distinguished from an absent one', await payer.btcBalance(),
    { sats: 0, usd: 0, usdPerSat: 0.0008, walletCurrency: 'BTC' });
  fake.state.wallets = [{ id: 'wallet-usd-0001', walletCurrency: 'USD', balance: 5000 }];
  const priceCalls = fake.calls('price');
  check('a USD-only account has no BTC evidence even after an earlier BTC lookup', await payer.btcBalance(), null);
  check('absent BTC evidence does not need a price request', fake.calls('price') - priceCalls, 0);
  for (const balance of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '', '01']) {
    fake.state.wallets = [{ id: 'wallet-btc-0001', walletCurrency: 'BTC', balance }];
    await rejects('invalid BTC balance cannot count as an empty verified wallet: ' + JSON.stringify(balance), payer.btcBalance(), /BTC wallet balance is unavailable/);
  }
  fake.state.wallets = [{ id: '', walletCurrency: 'BTC', balance: 0 }];
  await rejects('missing BTC wallet identity refuses evidence', payer.btcBalance(), /BTC wallet balance is unavailable/);
  fake.state.wallets = [{ id: 'btc-one', walletCurrency: 'BTC', balance: 0 }, { id: 'btc-two', walletCurrency: 'BTC', balance: 0 }];
  await rejects('ambiguous multiple BTC wallets refuse evidence', payer.btcBalance(), /BTC wallet balance is unavailable/);
  fake.state.wallets = originalWallets;
  const originalPrice = fake.state.price; fake.state.price = { base: 0, offset: 2 };
  await rejects('a nonpositive price cannot establish BTC funding readiness', payer.btcBalance(), /BTC price is unavailable/);
  fake.state.price = originalPrice;

  console.log('\nwalletId() — cached across pay()/invoice()/sent(), cleared by _reset()');
  payer._reset();
  const wCalls0 = fake.calls('wallets');
  await payer.invoice({ sats: 100 });
  check('the first authenticated call fetches the wallet once', fake.calls('wallets') - wCalls0, 1);
  await payer.pay({ paymentRequest: 'lnfake1cached' });
  check('a second, different call reuses the cached id: no second wallets fetch', fake.calls('wallets') - wCalls0, 1);
  payer._reset();
  await payer.sent(hash('anything'));
  check('_reset() clears the cache: the next call fetches the wallet again', fake.calls('wallets') - wCalls0, 2);

  process.env.BLINK_WALLET_ID = 'wallet-from-env';
  payer._reset();
  const wCalls1 = fake.calls('wallets');
  await payer.invoice({ sats: 50 });
  check('BLINK_WALLET_ID short-circuits the lookup entirely: no wallets fetch at all', fake.calls('wallets') - wCalls1, 0);
  checkThat('...and is the id actually sent on the wire', fake.state.log.filter((l) => l.op === 'invoice').slice(-1)[0].variables.input.walletId === 'wallet-from-env');
  delete process.env.BLINK_WALLET_ID;
  payer._reset();

  fake.state.wallets = originalWallets.filter((w) => w.walletCurrency !== 'BTC');
  await rejects('with no BTC wallet at all, anything that needs to pay fails loudly — unlike balance(), a report, this is a spend', payer.pay({ paymentRequest: 'lnfake1nobtc' }), /the Blink account has no BTC wallet/);
  fake.state.wallets = originalWallets;
  payer._reset();

  console.log('\npay()');
  fake.state.payHandler = () => ({ status: 'SUCCESS', errors: [] });
  check('a successful payment', await payer.pay({ paymentRequest: 'lnfake1success', memo: 'OT+T order-1' }), { status: 'SUCCESS', error: '' });
  const lastPay = fake.state.log.filter((l) => l.op === 'pay').slice(-1)[0];
  check('the invoice and memo actually sent on the wire', [lastPay.variables.input.paymentRequest, lastPay.variables.input.memo], ['lnfake1success', 'OT+T order-1']);
  check('ordinary sends retain the exact supported input fields', Object.keys(lastPay.variables.input).sort(), ['memo', 'paymentRequest', 'walletId']);

  fake.state.payHandler = () => ({ status: 'PENDING', errors: [] });
  check('PENDING', await payer.pay({ paymentRequest: 'lnfake1pending' }), { status: 'PENDING', error: '' });

  fake.state.payHandler = () => ({ status: 'ALREADY_PAID', errors: [] });
  check('ALREADY_PAID', await payer.pay({ paymentRequest: 'lnfake1already' }), { status: 'ALREADY_PAID', error: '' });

  fake.state.payHandler = () => ({ status: 'FAILURE', errors: [{ message: 'Unable to find a route for payment', code: 'ROUTE_FIND_FAILED' }] });
  check('FAILURE surfaces the wallet\'s own words verbatim', await payer.pay({ paymentRequest: 'lnfake1noroute' }), { status: 'FAILURE', error: 'Unable to find a route for payment' });

  fake.state.payHandler = () => ({ status: 'FAILURE', errors: [{ message: 'Payment amount exceeds wallet balance', code: 'INSUFFICIENT_BALANCE' }] });
  check('an insufficient-balance failure reads like any other refusal, not a crash', await payer.pay({ paymentRequest: 'lnfake1broke' }), { status: 'FAILURE', error: 'Payment amount exceeds wallet balance' });

  fake.state.payHandler = () => ({ status: null, errors: [{ message: 'first problem' }, { message: 'second problem' }] });
  check('several errors join with "; ", while a missing status remains UNKNOWN', await payer.pay({ paymentRequest: 'lnfake1multi' }), { status: 'UNKNOWN', error: 'first problem; second problem' });

  fake.state.payHandler = () => ({ status: null, errors: [] });
  check('a null status with nothing else to go on is UNKNOWN — not a crash, and not a false FAILURE', await payer.pay({ paymentRequest: 'lnfake1blank' }), { status: 'UNKNOWN', error: '' });

  fake.state.payHandler = () => ({ status: 'SOME_FUTURE_STATUS', errors: [] });
  check('a status this file has never seen before is passed through as-is, not coerced or crashed on', await payer.pay({ paymentRequest: 'lnfake1future' }), { status: 'SOME_FUTURE_STATUS', error: '' });

  fake.state.payHandler = () => ({ status: 'SUCCESS', errors: [] });
  await payer.pay({ paymentRequest: 'lnfake1memo', memo: 'x'.repeat(500) });
  check('a memo over 200 characters is truncated before it is sent, not merely before it is stored', fake.state.log.filter((l) => l.op === 'pay').slice(-1)[0].variables.input.memo.length, 200);

  fake.state.forceBody = JSON.stringify({ data: {} });
  check('lnInvoicePaymentSend missing from the response entirely degrades to UNKNOWN rather than throwing', await payer.pay({ paymentRequest: 'lnfake1shapedrift' }), { status: 'UNKNOWN', error: '' });
  fake.state.payHandler = () => ({ status: 'SUCCESS', errors: [] });

  console.log('\npayment deadlines — checked locally before the send mutation');
  const callsBeforeExpiry = fake.state.log.length;
  for (const deadlineMs of [Date.now() - 1, NaN, 'invalid']) {
    check('an expired or malformed deadline refuses without dispatch: ' + String(deadlineMs),
      await payer.pay({ paymentRequest: 'lnfake1expired', deadlineMs }),
      { status: 'FAILURE', error: 'Lightning invoice expired before payment was sent', notSent: true });
  }
  check('a local deadline refusal makes no wallet or payment request', fake.state.log.length, callsBeforeExpiry);
  {
    const originalFetch = global.fetch, originalNow = Date.now;
    const deadlineMs = Date.now() + 1000, payments = fake.calls('pay'), wallets = fake.calls('wallets');
    payer._reset();
    global.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (JSON.parse(args[1].body).query.includes('wallets {')) Date.now = () => deadlineMs + 1;
      return response;
    };
    try {
      check('expiry during wallet lookup remains an explicit known-unsent refusal',
        await payer.pay({ paymentRequest: 'lnfake1lookup-expired', deadlineMs }),
        { status: 'FAILURE', error: 'Lightning invoice expired before payment was sent', notSent: true });
      check('the wallet lookup occurred but no payment mutation followed', [fake.calls('wallets') - wallets, fake.calls('pay') - payments], [1, 0]);
    } finally { global.fetch = originalFetch; Date.now = originalNow; payer._reset(); }
  }
  await payer.pay({ paymentRequest: 'lnfake1fresh-deadline', deadlineMs: Date.now() + 10000 });
  check('the private deadline is not sent as an unsupported GraphQL field',
    fake.state.log.filter(log => log.op === 'pay').slice(-1)[0].variables.input,
    { walletId: 'wallet-btc-0001', paymentRequest: 'lnfake1fresh-deadline' });

  console.log('\nfeeProbe() — an estimate in sats, not an enforced send limit');
  const sendsBeforeProbe = fake.calls('pay');
  check('the payer declares that Blink cannot enforce a caller-selected fee limit', payer.supportsFeeLimit, false);
  delete process.env.BLINK_API_KEY;
  const noKeyCalls = fake.state.log.length;
  await rejects('a fee probe without a key fails before any request', payer.feeProbe({ paymentRequest: 'lnfake1fee' }), /BLINK_API_KEY is not set/);
  check('the unauthenticated probe made no wallet or fee request', fake.state.log.length, noKeyCalls);
  process.env.BLINK_API_KEY = fake.apiKey;
  check('a valid estimate returns routing fee sats without adding invoice amount or converting units', await payer.feeProbe({ paymentRequest: 'lnfake1fee' }), { feeSats: 12 });
  const feeLog = fake.state.log.filter(l => l.op === 'feeProbe').slice(-1)[0];
  check('the probe names the exact invoice and BTC wallet', feeLog.variables.input, { walletId: 'wallet-btc-0001', paymentRequest: 'lnfake1fee' });
  check('the probe uses its authenticated official GraphQL input type', [feeLog.query.includes('LnInvoiceFeeProbeInput!'), feeLog.headers['x-api-key']], [true, fake.apiKey]);
  fake.state.feeProbeHandler = () => ({ amount: 0, errors: [] });
  check('a zero-fee route is a valid estimate', await payer.feeProbe({ paymentRequest: 'lnfake1free' }), { feeSats: 0 });
  fake.state.feeProbeHandler = () => ({ amount: 12, errors: [{ message: 'Unable to find a route', code: 'ROUTE_FIND_FAILED' }] });
  await rejects('probe errors cannot be ignored even when an amount is present', payer.feeProbe({ paymentRequest: 'lnfake1noroute' }), /could not estimate/);
  for (const amount of [null, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1]) {
    fake.state.feeProbeHandler = () => ({ amount, errors: [] });
    await rejects('an invalid probe amount cannot authorize budgeting: ' + String(amount), payer.feeProbe({ paymentRequest: 'lnfake1invalidfee' }), /no valid routing fee/);
  }
  fake.state.forceBody = JSON.stringify({ data: { lnInvoiceFeeProbe: { amount: 12 } } });
  await rejects('a malformed probe response without its errors list is refused', payer.feeProbe({ paymentRequest: 'lnfake1missingerrors' }), /could not estimate/);
  fake.state.forceBody = JSON.stringify({ data: null, errors: [{ message: 'fee probe unavailable' }] });
  await rejects('a GraphQL probe failure is not treated as a zero-fee route', payer.feeProbe({ paymentRequest: 'lnfake1gqlfee' }), /Blink: fee probe unavailable/);
  fake.state.feeProbeHandler = () => ({ amount: 12, errors: [] });
  check('probing never invoked payment send', fake.calls('pay'), sendsBeforeProbe);
  const callsBeforeBoundedPay = fake.state.log.length;
  for (const maxFeeSats of [0, 25, null]) {
    await rejects('a requested hard fee cap is refused locally: ' + String(maxFeeSats), payer.pay({ paymentRequest: 'lnfake1capped', maxFeeSats }), /does not support a hard Lightning fee limit; payment was not sent/);
  }
  check('hard-limit refusal did not look up a wallet, probe a route or send payment', fake.state.log.length, callsBeforeBoundedPay);

  console.log('\ninvoice()');
  fake.state.invoiceHandler = (input) => ({ invoice: { paymentRequest: 'lnfake1inv-' + input.amount, paymentHash: hash('inv-' + input.amount) }, errors: [] });
  const inv = await payer.invoice({ sats: 12345, memo: 'OT+T data pool top-up' });
  check('a created invoice: the fake\'s own numbers come back untouched', inv, { paymentRequest: 'lnfake1inv-12345', paymentHash: hash('inv-12345') });
  const invLog = fake.state.log.filter((l) => l.op === 'invoice').slice(-1)[0];
  check('sats round to a whole amount and expiresIn defaults to 120 minutes', [invLog.variables.input.amount, invLog.variables.input.expiresIn], [12345, 120]);

  await payer.invoice({ sats: 10, expiresInMinutes: 5 });
  check('a custom expiry is passed through', fake.state.log.filter((l) => l.op === 'invoice').slice(-1)[0].variables.input.expiresIn, 5);

  await payer.invoice({ sats: 10, memo: 'y'.repeat(400) });
  check('a long memo is truncated on invoice() too', fake.state.log.filter((l) => l.op === 'invoice').slice(-1)[0].variables.input.memo.length, 200);

  fake.state.invoiceHandler = () => ({ invoice: null, errors: [{ message: 'below the minimum amount' }] });
  await rejects('no invoice, with a reason: the reason is in the thrown message', payer.invoice({ sats: 1 }), /Blink would not create an invoice: below the minimum amount/);

  fake.state.invoiceHandler = () => ({ invoice: null, errors: [] });
  await rejects('no invoice and no reason given at all: still fails loudly rather than returning something empty', payer.invoice({ sats: 1 }), /Blink would not create an invoice: no reason given/);

  console.log('\nsent()');
  const hPaid = hash('paid-invoice'), hNotPaid = hash('failed-invoice'), hUnknown = hash('never-heard-of'), hMixed = hash('flaky-invoice'), hReceiveOnly = hash('inbound-only');

  check('a hash Blink does not know at all', await payer.sent(hUnknown), { status: 'NONE' });

  fake.addSend(hPaid, { status: 'SUCCESS', settlementAmount: -2363, settlementFee: -12 });
  check('a hash that was paid: the sign on Blink\'s settlement figures is normalised away', await payer.sent(hPaid), { status: 'SUCCESS', sats: 2363, feeSats: 12 });

  fake.addSend(hNotPaid, { status: 'FAILURE', settlementAmount: 0, settlementFee: 0 });
  check('a hash that was tried and failed is not confused with one that was never tried', await payer.sent(hNotPaid), { status: 'FAILURE', sats: 0, feeSats: 0 });

  fake.addSend(hMixed, { status: 'FAILURE', settlementAmount: -500, settlementFee: 0 });
  fake.addSend(hMixed, { status: 'SUCCESS', settlementAmount: -500, settlementFee: -5 });
  check('of two attempts on the same hash, the best outcome wins, not the latest one', await payer.sent(hMixed), { status: 'SUCCESS', sats: 500, feeSats: 5 });

  fake.addSend(hReceiveOnly, { status: 'SUCCESS', direction: 'RECEIVE', settlementAmount: 500, settlementFee: 0 });
  check('an inbound transaction on the hash does not count as us having paid it', await payer.sent(hReceiveOnly), { status: 'NONE' });
  fake.addSend(hReceiveOnly, { status: 'PENDING', direction: 'SEND', settlementAmount: -500, settlementFee: 0 });
  check('once a real SEND shows up on the same hash, that is the one that counts', await payer.sent(hReceiveOnly), { status: 'PENDING', sats: 500, feeSats: 0 });

  fake.state.forceBody = JSON.stringify({ data: {} });
  check('missing payment history is UNKNOWN rather than an empty unpaid history', await payer.sent(hUnknown), { status: 'UNKNOWN' });
  fake.state.forceBody = JSON.stringify({ data: { me: { defaultAccount: { walletById: { transactionsByPaymentHash: null } } } } });
  check('null payment history cannot permit a retry', await payer.sent(hUnknown), { status: 'UNKNOWN' });
  const hFuture = hash('future-send-status');
  fake.addSend(hFuture, { status: 'SOME_FUTURE_STATUS', settlementAmount: -500, settlementFee: 0 });
  fake.addSend(hFuture, { status: 'FAILURE', settlementAmount: 0, settlementFee: 0 });
  check('an unknown send outcome is not hidden by a known failed attempt', await payer.sent(hFuture), { status: 'UNKNOWN' });
  fake.addSend(hFuture, { status: 'SUCCESS', settlementAmount: -500, settlementFee: -5 });
  check('a proven successful send still prevents duplicate payment despite an unknown attempt', await payer.sent(hFuture), { status: 'SUCCESS', sats: 500, feeSats: 5 });
  fake.state.forceBody = JSON.stringify({ data: { me: { defaultAccount: { walletById: { transactionsByPaymentHash: [null] } } } } });
  check('malformed transaction entries cannot look unpaid', await payer.sent(hUnknown), { status: 'UNKNOWN' });

  console.log('\nreceived() — public, no key, and the fix for the shape found live on 16 Sep 2026');
  const rPaid = hash('recv-paid'), rPending = hash('recv-pending'), rExpired = hash('recv-expired'), rUnknown = hash('recv-unknown');
  fake.state.invoiceStatus.set(rPaid, 'PAID');
  fake.state.invoiceStatus.set(rPending, 'PENDING');
  fake.state.invoiceStatus.set(rExpired, 'EXPIRED');
  check('PAID', await payer.received(rPaid), { status: 'PAID' });
  check('PENDING', await payer.received(rPending), { status: 'PENDING' });
  check('EXPIRED', await payer.received(rExpired), { status: 'EXPIRED' });
  check('a hash Blink has never heard of answers UNKNOWN rather than throwing — the defect this suite was written to catch', await payer.received(rUnknown), { status: 'UNKNOWN' });
  const recvLog = fake.state.log.filter((l) => l.op === 'received').slice(-1)[0];
  checkThat('and, again, no X-API-KEY for a call that needs none', !('x-api-key' in recvLog.headers), JSON.stringify(recvLog.headers));

  console.log('\nthe shared transport: a GraphQL errors array alongside 200, an HTTP-level error, a body that will not parse');
  fake.state.forceBody = JSON.stringify({ data: null, errors: [{ message: 'rate limited, try again shortly', code: 'RATE_LIMITED' }] });
  await rejects('a 200 with a GraphQL errors array is a thrown failure, not a silently empty result', payer.balance(), /Blink: rate limited, try again shortly/);

  fake.state.forceHttp = { status: 401, body: '<html><body>401 Authorization Required</body></html>', contentType: 'text/html' };
  await rejects('a raw HTTP error with a non-JSON body still names the status code', payer.balance(), /Blink answered HTTP 401/);

  fake.state.forceHttp = { status: 500, body: JSON.stringify({ errors: [{ message: 'internal server error' }] }), contentType: 'application/json' };
  await rejects('an HTTP error whose body does parse folds the wallet\'s own message in too', payer.balance(), /Blink answered HTTP 500: internal server error/);

  fake.state.forceBody = 'this is not json at all';
  await rejects('HTTP 200 with a body that will not parse as JSON is its own clear failure', payer.balance(), /Blink answered with no JSON/);

  console.log('\na hung Blink does not hang the payer forever');
  process.env.BLINK_FETCH_TIMEOUT_MS = '150';
  const hangServer = http.createServer(() => { /* never responds, never ends the request */ });
  await new Promise((r) => hangServer.listen(0, '127.0.0.1', r));
  const realUrl = process.env.BLINK_API_URL;
  process.env.BLINK_API_URL = 'http://127.0.0.1:' + hangServer.address().port + '/graphql';
  const startedAt = Date.now();
  await rejectsSomehow('a request Blink never answers is abandoned by the timeout rather than hanging forever', payer.balance());
  checkThat('...and it did not take anywhere near the default 25s to give up', Date.now() - startedAt < 5000, (Date.now() - startedAt) + 'ms');
  process.env.BLINK_API_URL = realUrl;
  delete process.env.BLINK_FETCH_TIMEOUT_MS;
  await new Promise((r) => hangServer.close(r));

  await fake.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
