#!/usr/bin/env node
'use strict';
/**
 * The invoice decoder, against an invoice nadanada actually issued (15 Sep 2026, 2,424 sats for
 * $1.89 of German data; never paid) and against ones minted here. What is asserted is exactly
 * what the provider relies on: the amount, the payment hash, the expiry, and that a damaged
 * invoice is refused rather than misread.
 *
 *   node test/bolt11.test.js
 */
const path = require('path');
const bolt11 = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'bolt11.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const throws = (what, fn, re) => {
  checks++;
  try { fn(); failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};

// The real one. Its payment hash is what nadanada's /esim/purchase quoted beside it.
const REAL = 'lnbc24240n1p4239kfdzav4f5jnfq2p6hycmgv9ek2gpdyp8hyer9wgsxycfexscxvwfh943nxv3c956rqdr9943xycmy956ngc33x3jrvvtxxd3xvnp4qtyjfy99jhnpj8u9en49meskq8x08czk5axrh4cju64fvpcfenrfupp57g3y37cwmm4wwygr4hnfukf0e0rjrdh8lhca9rx9cya856n0e7xqsp5j65xgzs9tmexke9zghnflxdu3u562d3ecw5vwkhthg3wqpd6azcs9qyysgqcqzp2xqyz5vqdeet6ypsdqj09fjkf67yftdchguk3f5fhw72l6yxe7htfcuwrtv9zl2gurrxvyp8mjq4cf4w7j3v8hfdyrfqwace5k4lw3525akppwqq47zywy';
const REAL_HASH = 'f22248fb0edeeae71103ade69e592fcbc721b6e7fdf1d28cc5c13a7a6a6fcf8c';

console.log('a real invoice');
let d;
try { d = bolt11.decode(REAL); } catch (e) { d = { error: e.message }; }
check('decodes on mainnet for 2,424 sats', [d.prefix, d.sats, d.msat], ['bc', 2424, '2424000']);
check('with the payment hash nadanada quoted', d.paymentHash, REAL_HASH);
check('and an expiry after its timestamp', [typeof d.timestamp, d.expiresAt > d.timestamp, d.expiry > 0], ['number', true, true]);
check('upper case is the same invoice', bolt11.decode(REAL.toUpperCase()).paymentHash, REAL_HASH);

console.log('\ndamage is refused');
throws('a flipped character fails the checksum', () => bolt11.decode(REAL.slice(0, 40) + (REAL[40] === 'q' ? 'p' : 'q') + REAL.slice(41)), /checksum/);
throws('a truncated invoice is refused', () => bolt11.decode(REAL.slice(0, 80)), /checksum|short/);
throws('mixed case is refused', () => bolt11.decode(REAL.slice(0, 10).toUpperCase() + REAL.slice(10)), /mixed|case/);
throws('a bitcoin address is not an invoice', () => bolt11.decode('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), /not a Lightning invoice|separator|checksum/);
throws('nothing is not an invoice', () => bolt11.decode(''), /separator/);

console.log('\nminted invoices round-trip');
const hash = 'ab'.repeat(32);
const minted = bolt11.encode({ sats: 1890, paymentHash: hash, timestamp: 1789400000, expiry: 900, description: 'eSIM, 1GB, 7 Days, Germany' });
d = bolt11.decode(minted);
check('amount, hash, timestamp, expiry, description all come back', [d.sats, d.paymentHash, d.timestamp, d.expiry, d.expiresAt, d.description], [1890, hash, 1789400000, 900, 1789400900, 'eSIM, 1GB, 7 Days, Germany']);
check('an invoice with no amount says so', bolt11.decode(bolt11.encode({ sats: null, paymentHash: hash, timestamp: 1 })).sats, null);
check('a testnet invoice names its network', bolt11.decode(bolt11.encode({ sats: 5, paymentHash: hash, timestamp: 1, prefix: 'tb' })).prefix, 'tb');
check('the default expiry is an hour', bolt11.decode(bolt11.encode({ sats: 5, paymentHash: hash, timestamp: 100, expiry: 3600 })).expiresAt, 3700);
check('a large amount survives', bolt11.decode(bolt11.encode({ sats: 123456789, paymentHash: hash, timestamp: 1 })).sats, 123456789);

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
