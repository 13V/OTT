'use strict';
/**
 * fake-nadanada — a fake of nadanada.me that behaves the way the live API was observed to on
 * 15 Sep 2026: POST /esim/purchase prices a catalogue bundle and answers a checkoutId, a payment
 * hash and a bolt11 invoice; POST /esim/complete is 402 "Lightning invoice not settled yet" until
 * the invoice is paid, 404 for a checkout it no longer knows, and 200 with the ICCID and the
 * installation details once it is (safe to call repeatedly); GET /esim/{iccid} reports profile
 * status. It settles an invoice exactly when the mock payer says so
 * (mockPayer._state.paid.get(hash).status === 'SUCCESS') — the same coupling the real pair has
 * through the Lightning network, which is why start() takes the mock payer rather than keeping
 * its own notion of "paid".
 *
 * Shared by test/nadanada.test.js (the provider's own logic, driven against the fake directly)
 * and test/redeem-nadanada.test.js (the redeem endpoint through the provider, against the same
 * fake), so there is exactly one fake nadanada to keep faithful to the real one.
 *
 *   const fakeNadanada = require('./support/fake-nadanada');
 *   const fake = await fakeNadanada.start({ mockPayer });
 *   process.env.NADANADA_BASE_URL = fake.base;
 *   // fake.state: { checkouts, seq, tamper, settleAfterCalls, expirySeconds, log } — the same
 *   // knobs a test pokes directly to change what the fake does next.
 *   // fake.purchases() / fake.completes(): how many of each call has landed so far.
 *   // await fake.close(): stop listening.
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const bolt11 = require(path.join(__dirname, '..', '..', 'site', 'api', 'lib', 'bolt11.js'));

/** The two bundles the live catalogue prices, at their 15 Sep 2026 wholesale prices. */
const CATALOGUE = {
  fixed_1GB_7D_DE: { slug: 'germany', price: 1.99 },
  fixed_5GB_30D_EUROPE: { slug: 'europe', price: 5.99 },
};

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Start the fake on an ephemeral port. `mockPayer` is the same lib/payers/mock.js module a test
 * drives via `_state` and `_settle`; `catalogue` defaults to CATALOGUE above and can be overridden
 * to price different bundles without touching the fake's logic.
 */
function start({ mockPayer, catalogue = CATALOGUE } = {}) {
  const state = { checkouts: new Map(), seq: 1, tamper: '', settleAfterCalls: 0, expirySeconds: 3600, log: [] };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (status, j) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      const b = body ? JSON.parse(body) : {};
      state.log.push({ method: req.method, path: req.url, body: b });
      if (req.method === 'POST' && req.url === '/esim/purchase') {
        const c = catalogue[b.bundleName];
        if (!c) return reply(400, { error: 'Fixed pricing is not configured for this bundle and slug', code: 'missing_pricing_bundle' });
        if (c.slug !== b.slug) return reply(400, { error: 'bundleName does not match slug pricing', code: 'bundle_slug_mismatch' });
        const price = round2(c.price * 0.95);
        let sats = Math.round(price / mockPayer._state.usdPerSat);
        if (state.tamper === 'sats') sats *= 3;
        const paymentHash = crypto.randomBytes(32).toString('hex');
        const inInvoice = state.tamper === 'hash' ? crypto.randomBytes(32).toString('hex') : paymentHash;
        const now = Math.floor(Date.now() / 1000);
        const paymentRequest = bolt11.encode({ sats, paymentHash: inInvoice, timestamp: now, expiry: state.expirySeconds, description: 'eSIM ' + b.bundleName });
        const co = { checkoutId: crypto.randomUUID(), bundleName: b.bundleName, slug: b.slug, price, sats, completes: 0, iccid: '', gone: false };
        state.checkouts.set(paymentHash, co);
        return reply(200, { success: true, data: {
          checkoutId: co.checkoutId, bundleName: b.bundleName, providerBundleName: b.bundleName.replace('fixed_', 'esimc_') + '_V2', slug: b.slug,
          originalPrice: c.price, price, paymentMethod: 'lightning', paymentHash, paymentRequest,
          expiresAt: new Date((now + state.expirySeconds) * 1000).toISOString(),
        } });
      }
      if (req.method === 'POST' && req.url === '/esim/complete') {
        const co = state.checkouts.get(b.paymentHash);
        if (!co || co.gone) return reply(404, { error: 'Checkout session not found for this payment' });
        const paid = mockPayer._state.paid.get(b.paymentHash);
        if (!paid || paid.status !== 'SUCCESS') return reply(402, { error: 'Lightning invoice not settled yet' });
        co.completes++;
        if (co.completes <= state.settleAfterCalls) return reply(402, { error: 'Lightning invoice not settled yet' });
        if (!co.iccid) co.iccid = '8944' + String(state.seq++).padStart(15, '0');
        const ac = 'LPA:1$rsp.example.com$' + co.iccid.slice(-6);
        return reply(200, { success: true, data: {
          iccid: co.iccid, bundleName: co.bundleName, orderReference: 'ORD-' + co.checkoutId.slice(0, 8),
          installationDetails: {
            qrCode: 'https://nadanada.me/qr/' + co.iccid + '.png', manualCode: ac, smdpAddress: 'rsp.example.com', matchingId: co.iccid.slice(-6),
            appleInstallUrl: 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=' + encodeURIComponent(ac),
            androidInstallUrl: 'https://esim.example/android?lpa=' + encodeURIComponent(ac),
          },
        } });
      }
      const m = /^\/esim\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && m) {
        const co = [...state.checkouts.values()].find((x) => x.iccid === m[1]);
        if (!co) return reply(502, { error: 'Provider status/usage lookup failed' });
        return reply(200, { success: true, data: { iccid: co.iccid, profileStatus: 'Released', bundleCount: 1, activeBundleCount: 0, bundles: [{ name: co.bundleName, active: false }] } });
      }
      reply(404, { error: 'no such endpoint ' + req.url });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: 'http://127.0.0.1:' + server.address().port,
        state,
        purchases: () => state.log.filter((l) => l.path === '/esim/purchase').length,
        completes: () => state.log.filter((l) => l.path === '/esim/complete').length,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start, CATALOGUE };
