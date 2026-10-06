#!/usr/bin/env node
'use strict';
/** Operator-only phone test. No token, holder allocation or public redemption bypass.
 * Default is an offline plan. --purchase is an explicit paid action, never run by CI.
 * Fee probes are estimates. A small dedicated BTC balance limits available spend.
 */
const fs = require('fs');
const path = require('path');
const bolt11 = require('../site/api/_lib/bolt11');
const { PRIVATE_BASE, privatePath, writePrivate } = require('./operator-test-files');
const PREFIX = 'ott:operator-test:';
const MAX_WALLET_USD = 20;
const DEFAULT_WALLET_USD = 4;
const CATALOGUE = path.join(__dirname, '..', 'site', 'config', 'esim.json');

function parse(argv) {
  const opts = { purchase: false, sku: 'fixed_1GB_7D_AU' };
  const names = { '--sku': 'sku', '--run-id': 'runId', '--max-invoice-usd': 'maxInvoiceUsd',
    '--max-payment-usd': 'maxPaymentUsd', '--max-wallet-usd': 'maxWalletUsd' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--purchase') opts.purchase = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--preflight') opts.preflight = true;
    else if (arg === '--local-credentials') opts.localCredentials = true;
    else if (arg === '--help') opts.help = true;
    else if (names[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[names[arg]] = argv[++i];
    else throw new Error('Unknown or incomplete test option. Use --help.');
  }
  if ([opts.purchase, opts.dryRun, opts.preflight].filter(Boolean).length > 1) throw new Error('Choose either --dry-run, --preflight or --purchase.');
  if (opts.localCredentials && !opts.purchase && !opts.preflight) throw new Error('Local credentials are only used for preflight or purchase.');
  return opts;
}
function plan(opts, catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'))) {
  const pkg = catalogue.packages.find(p => p.code === opts.sku);
  if (!pkg || !Number.isFinite(pkg.priceUsd) || pkg.priceUsd <= 0) throw new Error('Select a valid reviewed package SKU.');
  if (opts.runId && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(opts.runId)) throw new Error('Run ID needs 3 to 64 lowercase letters, numbers or hyphens.');
  const cap = (value, name, fallback = null) => {
    const amount = value === undefined ? fallback : Number(value);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > MAX_WALLET_USD)) throw new Error(name + ' cap must be greater than zero and at most $20.');
    return amount;
  };
  const invoiceCap = cap(opts.maxInvoiceUsd, 'Invoice');
  const paymentCap = cap(opts.maxPaymentUsd, 'Payment estimate');
  const walletCap = cap(opts.maxWalletUsd, 'Wallet', DEFAULT_WALLET_USD);
  if ((opts.purchase || opts.preflight) && (!opts.runId || invoiceCap === null || paymentCap === null || opts.maxWalletUsd === undefined)) {
    throw new Error('Preflight and purchase require an explicit run ID, invoice cap, payment estimate cap and wallet cap.');
  }
  if (invoiceCap !== null && invoiceCap < pkg.priceUsd) throw new Error('Invoice cap must cover the reviewed catalogue price.');
  if ((paymentCap !== null && invoiceCap !== null && paymentCap < invoiceCap) || (paymentCap !== null && paymentCap > walletCap)) throw new Error('Caps must satisfy invoice <= payment estimate <= wallet.');
  return { schema: 2, runId: opts.runId || null, sku: pkg.code, slug: pkg.slug, name: pkg.name,
    gb: pkg.gb, days: pkg.days, catalogueUsd: pkg.priceUsd, maxInvoiceUsd: invoiceCap,
    maxPaymentUsd: paymentCap, namespace: PREFIX, maxWalletUsd: walletCap, feeLimitEnforced: false };
}
function manifestOf(p) {
  return { schema: 2, sku: p.sku, slug: p.slug, cap: p.maxInvoiceUsd,
    maxPaymentUsd: p.maxPaymentUsd, maxWalletUsd: p.maxWalletUsd, catalogueUsd: p.catalogueUsd };
}
function matchRecord(record, p) {
  if (record && (record.transactionId !== 'operator-' + p.runId || record.packageCode !== p.sku ||
      record.slug !== p.slug || record.address || record.topupOf)) throw new Error('Stored order does not match this operator test.');
}
async function checkedPay({ record, paymentRequest, p, payer }) {
  matchRecord(record, p);
  if (!record || record.step !== 'invoiced' || record.paymentRequest !== paymentRequest) throw new Error('Stored invoice is not ready for this test.');
  const invoice = bolt11.decode(paymentRequest);
  const deadlineMs = Math.min(invoice.expiresAt * 1000, record.expiresAt == null ? Infinity : Date.parse(record.expiresAt));
  if (invoice.paymentHash !== record.paymentHash || !Number.isFinite(invoice.sats) || invoice.sats <= 0 ||
      !Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw new Error('Stored invoice failed validation.');
  const rate = await payer.usdPerSat();
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Blink price is unavailable.');
  const usd = invoice.sats * rate;
  if (!Number.isFinite(record.paidUsd) || record.paidUsd <= 0 || record.paidUsd > p.maxInvoiceUsd ||
      record.paidUsd > p.catalogueUsd * 1.005 || usd > p.maxInvoiceUsd ||
      Math.abs(usd - record.paidUsd) > record.paidUsd * 0.1 + 0.02) throw new Error('Invoice exceeds the approved cap or disagrees with the quote.');
  if (typeof payer.feeProbe !== 'function') throw new Error('A Lightning fee estimate is required before sending.');
  const { feeSats } = await payer.feeProbe({ paymentRequest });
  if (!Number.isSafeInteger(feeSats) || feeSats < 0) throw new Error('Lightning fee estimate is invalid.');
  const balance = await payer.balance();
  if (!Number.isSafeInteger(balance.sats) || balance.sats < 0 || !Number.isFinite(balance.usdPerSat) || balance.usdPerSat <= 0) throw new Error('BTC balance or price is unavailable.');
  // Use the higher of both fresh prices; a different balance price cannot weaken a cap.
  const checkedRate = Math.max(rate, balance.usdPerSat);
  const btcUsd = balance.sats * checkedRate;
  const estimatedSats = invoice.sats + feeSats;
  if (invoice.sats * checkedRate > p.maxInvoiceUsd || estimatedSats > Math.floor(p.maxPaymentUsd / checkedRate)) throw new Error('Invoice plus estimated routing fee exceeds the approved payment estimate cap.');
  if (btcUsd <= 0 || btcUsd > p.maxWalletUsd || balance.sats < estimatedSats) {
    throw new Error('Use a dedicated BTC wallet with enough sats for the invoice and estimated fee, within the approved wallet cap.');
  }
  if (deadlineMs <= Date.now()) throw new Error('Stored invoice expired while checking payment.');
  return { invoiceSats: invoice.sats, estimatedFeeSats: feeSats, estimatedPaymentUsd: estimatedSats * checkedRate, feeLimitEnforced: false, deadlineMs };
}
async function livePackage(p) {
  const country = /_([A-Z]{2})$/.exec(p.sku)?.[1];
  if (!country) throw new Error('Live phone-test review requires a country-specific SKU.');
  const response = await fetch('https://nadanada.me/api/v2/esim/bundles?country=' + country,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Supplier catalogue is unavailable.');
  const body = await response.json();
  const bundles = body.data?.bundles || body.data || body.bundles || body;
  if (!Array.isArray(bundles)) throw new Error('Supplier catalogue format is unavailable.');
  const bundle = bundles.find(value => value.name === p.sku);
  if (!bundle || bundle.price !== p.catalogueUsd || bundle.dataInGB !== p.gb || bundle.durationInDays !== p.days ||
      !bundle.roamingEnabled?.some(value => value.iso === country)) throw new Error('Live package differs from the reviewed catalogue. Review it before funding.');
  return { sku: p.sku, priceUsd: bundle.price, gb: bundle.dataInGB, days: bundle.durationInDays, country };
}
async function preflight(p, deps, record) {
  const manifest = deps.store ? await deps.store.get('operator-run:' + p.runId) : null;
  if (manifest && JSON.stringify(manifest) !== JSON.stringify(manifestOf(p))) throw new Error('Run ID is already bound to different package or spending settings.');
  const reviewed = await deps.catalogueLookup(p);
  let wallet = { status: 'credential-required' };
  if (deps.payer) {
    const balance = await deps.payer.balance();
    if (!Number.isSafeInteger(balance.sats) || balance.sats < 0 || !Number.isFinite(balance.usdPerSat) || balance.usdPerSat <= 0) throw new Error('BTC balance or price is unavailable.');
    const btcUsd = balance.sats * balance.usdPerSat;
    wallet = { status: btcUsd > p.maxWalletUsd ? 'over-cap' : balance.sats ? 'balance-present' : 'needs-funding',
      sats: balance.sats, btcUsd, feeEstimateAvailable: typeof deps.payer.feeProbe === 'function', feeLimitEnforced: false };
  }
  return { mode: 'preflight', plan: p, livePackage: reviewed, storedStage: record?.step || null,
    storage: deps.store ? 'read-access-verified' : 'credential-required', wallet,
    checkedAt: new Date().toISOString(), paymentTested: false,
    note: 'No checkout, invoice, payment or storage write. Fee estimates are not a strict fee cap. Keep this dedicated wallet within its cap; review conversion and source fees before funding.' };
}
function resultOf(p, order) {
  return { schema: 1, purpose: 'ott-operator-phone-test', runId: p.runId, package: p,
    step: order.step, pending: order.step !== 'done', topupOf: order.topupOf || '',
    iccid: order.iccid || '', ac: order.ac || '', manualCode: order.manualCode || '',
    smdpAddress: order.smdpAddress || '', matchingId: order.matchingId || '',
    appleInstallUrl: order.appleInstallUrl || '', androidInstallUrl: order.androidInstallUrl || '',
    completedAt: order.completedAt || null };
}
async function runTest(opts, deps = {}) {
  const p = plan(opts, deps.catalogue);
  const transactionId = p.runId ? 'operator-' + p.runId : null;
  const record = transactionId && deps.store ? await deps.store.get('order:' + transactionId) : null;
  if (record) matchRecord(record, p);
  if (opts.preflight) return preflight(p, deps, record);
  if (!opts.purchase) return { mode: 'dry-run', plan: p, storedStage: record?.step || null,
    note: 'No invoice, payment or provider completion. Payment cap checks an estimated routing fee; the wallet balance is the available-spend limit. This does not test holder allocation.' };
  if (!deps.store || !deps.payer || !deps.order) throw new Error('Live test requires configured Blink and durable storage.');
  const output = privatePath(path.join(PRIVATE_BASE, p.runId, 'order.json'));
  const key = 'operator-run:' + p.runId;
  const manifest = manifestOf(p);
  const created = await deps.store.set(key, manifest, { nx: true });
  const saved = created ? manifest : await deps.store.get(key);
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error('Run ID is already bound to different package or spending settings.');
  if (record?.step === 'failed' && record.paymentHash) throw new Error('Previous checkout failed. Inspect its payment state before creating another test.');
  const pay = async args => {
    let deadlineMs;
    try {
      const current = await deps.store.get('order:' + transactionId);
      const checked = await checkedPay({ record: current, paymentRequest: args.paymentRequest, p, payer: deps.payer });
      deadlineMs = Math.min(checked.deadlineMs, args.deadlineMs === undefined ? Infinity : args.deadlineMs);
      // This callback runs inside wholesale's payment lease. Its earlier status read can be stale.
      const sent = await deps.payer.sent(current.paymentHash);
      if (sent.status === 'SUCCESS') return { status: 'ALREADY_PAID', error: '' };
      if (sent.status === 'PENDING') return { status: 'PENDING', error: '' };
      if (!['NONE', 'FAILURE'].includes(sent.status)) throw new Error('Payment status is uncertain. Resume this run after checking the wallet.');
      const lease = await deps.store.get('paylease:' + transactionId);
      if (!args.paymentLease || !lease || lease.attempt !== args.paymentLease.attempt ||
          lease.at !== args.paymentLease.at || !Number.isFinite(lease.at) || Date.now() - lease.at >= 20000) {
        throw new Error('Payment lease changed or its safe send window elapsed. Resume the same run.');
      }
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw new Error('Invoice expired before payment was sent.');
    } catch {
      // The real payer has not been invoked. An explicit local refusal lets wholesale
      // retain the unpaid invoice for retry instead of stranding a send reservation.
      return { status: 'FAILURE', error: 'Operator checks prevented payment before any send. Resume the same run after reviewing its balance, invoice and payment status.', notSent: true };
    }
    // A thrown or ambiguous wallet response may follow a dispatch. Leave it to wholesale
    // to preserve that reservation; never convert it into a known unpaid refusal.
    return deps.payer.pay({ ...args, deadlineMs });
  };
  const order = await deps.order({ transactionId, packageCode: p.sku, slug: p.slug,
    priceUsd: p.catalogueUsd, address: '' }, pay);
  matchRecord(order, p);
  if (!order || !['invoiced', 'paid', 'done'].includes(order.step)) throw new Error('Provider returned an unexpected test state.');
  let orderFile = null;
  if (order.step === 'done') orderFile = writePrivate(output, JSON.stringify(resultOf(p, order), null, 2) + '\n');
  return { mode: 'operator-test', runId: p.runId, sku: p.sku, stage: order.step,
    issued: order.step === 'done', orderFile, next: order.step === 'done' ? 'Generate a private installation pack.' : 'Rerun the same ID and settings to resume. Do not start a second purchase.' };
}
function officialConfig(env = process.env, requirePayer = false, requireStore = requirePayer) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (env.STORE_URL || env.STORE_TOKEN || env.STORE === 'memory') throw new Error('Operator tests require the configured durable Redis REST store.');
  if (url || token || requireStore) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Configure the Redis REST URL and token in this process.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.upstash.io') || parsed.username || parsed.password || !token) throw new Error('Use the verified Upstash HTTPS REST endpoint.');
  }
  if (requirePayer) {
    if (!env.BLINK_API_KEY) throw new Error('BLINK_API_KEY is not configured. Complete Blink account setup first.');
    if (env.BLINK_WALLET_ID) throw new Error('Remove BLINK_WALLET_ID for this test. Its balance guard uses the default BTC wallet.');
    if (env.BLINK_API_URL && env.BLINK_API_URL !== 'https://api.blink.sv/graphql') throw new Error('This phone test uses the official Blink mainnet API only.');
    if (env.WHOLESALE_BASE_URL && env.WHOLESALE_BASE_URL.replace(/\/$/, '') !== 'https://nadanada.me/api/v2') throw new Error('Use the verified wholesale provider for this phone test.');
    if (env.LN_PAYER && env.LN_PAYER !== 'blink') throw new Error('This phone test requires Blink.');
  }
  return !!(url && token);
}
async function main(argv = process.argv.slice(2)) {
  const opts = parse(argv);
  if (opts.help) {
    console.log('Offline plan: node scripts/test-esim.js --dry-run\nRead-only review: --preflight\nPaid test: --purchase\nPreflight/purchase require: --run-id <unique-id> --sku fixed_1GB_7D_AU --max-invoice-usd <cap> --max-payment-usd <estimate-cap> --max-wallet-usd <balance-cap>\nAdd --local-credentials to unlock credentials entered with npm run phone:setup.\nFees are estimated, not guaranteed. Use a dedicated BTC wallet within the balance cap. Never run purchase in CI.');
    return;
  }
  plan(opts); // Validate spending settings before loading services.
  if (opts.localCredentials) Object.assign(process.env, require('./operator-test-credentials').loadLocalCredentials());
  const hasStore = officialConfig(process.env, opts.purchase);
  if (opts.preflight && process.env.BLINK_API_KEY) officialConfig(process.env, true, false);
  process.env.NODE_ENV = 'production';
  process.env.STORE_PREFIX = PREFIX;
  process.env.REDEMPTIONS_ENABLED = '0';
  const deps = {};
  if (hasStore) deps.store = require('../site/api/_lib/store').store();
  if (opts.preflight) deps.catalogueLookup = livePackage;
  if (opts.purchase || (opts.preflight && process.env.BLINK_API_KEY)) {
    process.env.LN_PAYER = 'blink';
    // Keep validation inside the provider's 20-second send-start window,
    // including 5-second Redis calls. Its full lease lasts 120 seconds.
    process.env.BLINK_FETCH_TIMEOUT_MS = '2000';
    process.env.WHOLESALE_BASE_URL = 'https://nadanada.me/api/v2';
    const blink = require('../site/api/_lib/payers/blink');
    const originalPay = blink.pay;
    deps.payer = { ...blink, pay: args => originalPay(args) };
    deps.order = async (args, pay) => {
      blink.pay = pay;
      process.env.REDEMPTIONS_ENABLED = '1'; // This CLI process only, never the deployed app.
      try { return await require('../site/api/_lib/providers/wholesale').order(args); }
      finally { blink.pay = originalPay; process.env.REDEMPTIONS_ENABLED = '0'; }
    };
  }
  console.log(JSON.stringify(await runTest(opts, deps), null, 2));
}
if (require.main === module) main().catch(() => {
  // Upstream errors may contain invoices, tokens or activation details. Keep terminal output private-safe.
  console.error('Operator test did not finish. Check account setup, approved caps and the stored run. Reuse the same run ID; do not start another payment. No sensitive response was printed.');
  process.exitCode = 1;
});
module.exports = { parse, plan, runTest, checkedPay, officialConfig, resultOf, manifestOf, livePackage, PREFIX, main };
