'use strict';
/**
 * fake-nadanada — a fake of nadanada.me that behaves the way the live API was observed to on
 * 15 Sep 2026:
 *   - POST /esim/purchase prices a catalogue bundle and answers a checkoutId, a payment hash and a
 *     bolt11 invoice.
 *   - POST /esim/complete is 402 "Lightning invoice not settled yet" until the invoice is paid,
 *     404 for a checkout it no longer knows, and 200 with the ICCID and the installation details
 *     once it is (safe to call repeatedly).
 *   - POST /esim/{iccid}/purchase prices a bundle joining a profile already issued: the same shape
 *     as /esim/purchase, plus an `iccid` echoing which profile it quoted. state.refuseTopup makes
 *     this answer 400 instead — nadanada documents that not every bundle can join every profile —
 *     `true` refuses every top-up purchase, an ICCID string refuses only that profile's, and ''
 *     (the default) refuses none. state.wrongTopupIccid, when set, echoes that ICCID instead of the
 *     one actually asked for — a nadanada bug (or a test of the guard against paying for it).
 *   - POST /esim/{iccid}/complete is the same 402/404 as /esim/complete, plus 403 when the payment
 *     hash names a checkout for a different ICCID, and 200 with only { iccid, bundleName, toppedUp }
 *     — no installationDetails, because the profile is already on the phone.
 *   - GET /esim/{iccid} reports profile status.
 * It settles an invoice exactly when the mock payer says so
 * (mockPayer._state.paid.get(hash).status === 'SUCCESS') — the same coupling the real pair has
 * through the Lightning network, which is why start() takes the mock payer rather than keeping
 * its own notion of "paid".
 *
 * Shared by test/nadanada.test.js (the provider's own logic, driven against the fake directly),
 * test/redeem-nadanada.test.js (the redeem endpoint through the provider, against the same fake)
 * and test/sim.test.js (one eSIM per wallet, topped up, per place), so there is exactly one fake
 * nadanada to keep faithful to the real one.
 *
 *   const fakeNadanada = require('./support/fake-nadanada');
 *   const fake = await fakeNadanada.start({ mockPayer });
 *   process.env.NADANADA_BASE_URL = fake.base;
 *   // fake.state: { checkouts, seq, tamper, settleAfterCalls, expirySeconds, refuseTopup,
 *   //               wrongTopupIccid, log } — the same knobs a test pokes directly to change what
 *   //               the fake does next.
 *   // fake.purchases() / fake.completes(): how many of each call has landed so far, fresh and
 *   //   top-up together — a top-up purchase or completion counts the same as a fresh one.
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
  const state = {
    checkouts: new Map(), seq: 1, tamper: '', settleAfterCalls: 0, expirySeconds: 3600,
    refuseTopup: '', wrongTopupIccid: '', log: [],
  };

  /** A quote for `bundleName`/`slug`, against `targetIccid` (a top-up) or '' (a fresh eSIM). */
  function quote(b, targetIccid) {
    const c = catalogue[b.bundleName];
    if (!c) return { status: 400, body: { error: 'Fixed pricing is not configured for this bundle and slug', code: 'missing_pricing_bundle' } };
    if (c.slug !== b.slug) return { status: 400, body: { error: 'bundleName does not match slug pricing', code: 'bundle_slug_mismatch' } };
    const price = round2(c.price * 0.95);
    let sats = Math.round(price / mockPayer._state.usdPerSat);
    if (state.tamper === 'sats') sats *= 3;
    const paymentHash = crypto.randomBytes(32).toString('hex');
    const inInvoice = state.tamper === 'hash' ? crypto.randomBytes(32).toString('hex') : paymentHash;
    const now = Math.floor(Date.now() / 1000);
    const paymentRequest = bolt11.encode({ sats, paymentHash: inInvoice, timestamp: now, expiry: state.expirySeconds, description: 'eSIM ' + b.bundleName });
    // What this checkout is FOR: the profile a top-up quote names, which is normally the one asked
    // for, but a test can make it lie (wrongTopupIccid) to exercise the caller's guard against
    // paying for a quote that names a different ICCID than the one it asked to top up.
    const quotedIccid = targetIccid ? String(state.wrongTopupIccid || targetIccid) : '';
    const co = { checkoutId: crypto.randomUUID(), bundleName: b.bundleName, slug: b.slug, price, sats, completes: 0, iccid: quotedIccid, forIccid: quotedIccid, gone: false };
    state.checkouts.set(paymentHash, co);
    const data = {
      checkoutId: co.checkoutId, bundleName: b.bundleName, providerBundleName: b.bundleName.replace('fixed_', 'esimc_') + '_V2', slug: b.slug,
      originalPrice: c.price, price, paymentMethod: 'lightning', paymentHash, paymentRequest,
      expiresAt: new Date((now + state.expirySeconds) * 1000).toISOString(),
    };
    if (targetIccid) data.iccid = quotedIccid;
    return { status: 200, body: { success: true, data } };
  }

  /** A completion for `paymentHash`, against `requireIccid` (a top-up) or '' (a fresh eSIM). */
  function completeFor(paymentHash, requireIccid) {
    const co = state.checkouts.get(paymentHash);
    if (!co || co.gone) return { status: 404, body: { error: 'Checkout session not found for this payment' } };
    if (requireIccid && co.forIccid !== requireIccid) return { status: 403, body: { error: 'ICCID does not match checkout session' } };
    const paid = mockPayer._state.paid.get(paymentHash);
    if (!paid || paid.status !== 'SUCCESS') return { status: 402, body: { error: 'Lightning invoice not settled yet' } };
    co.completes++;
    if (co.completes <= state.settleAfterCalls) return { status: 402, body: { error: 'Lightning invoice not settled yet' } };
    if (requireIccid) {
      // Already on the phone: nothing new to install, so no installationDetails.
      return { status: 200, body: { success: true, data: { iccid: co.iccid || requireIccid, bundleName: co.bundleName, toppedUp: true } } };
    }
    if (!co.iccid) co.iccid = '8944' + String(state.seq++).padStart(15, '0');
    const ac = 'LPA:1$rsp.example.com$' + co.iccid.slice(-6);
    return { status: 200, body: { success: true, data: {
      iccid: co.iccid, bundleName: co.bundleName, orderReference: 'ORD-' + co.checkoutId.slice(0, 8),
      installationDetails: {
        qrCode: 'https://nadanada.me/qr/' + co.iccid + '.png', manualCode: ac, smdpAddress: 'rsp.example.com', matchingId: co.iccid.slice(-6),
        appleInstallUrl: 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=' + encodeURIComponent(ac),
        androidInstallUrl: 'https://esim.example/android?lpa=' + encodeURIComponent(ac),
      },
    } } };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (status, j) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      const b = body ? JSON.parse(body) : {};
      state.log.push({ method: req.method, path: req.url, body: b });

      if (req.method === 'POST' && req.url === '/esim/purchase') {
        const r = quote(b, '');
        return reply(r.status, r.body);
      }
      const pm = /^\/esim\/([^/]+)\/purchase$/.exec(req.url);
      if (req.method === 'POST' && pm) {
        const iccid = decodeURIComponent(pm[1]);
        if (state.refuseTopup === true || state.refuseTopup === iccid) {
          return reply(400, { error: 'This bundle cannot be added to the existing profile', code: 'topup_not_supported' });
        }
        const r = quote(b, iccid);
        return reply(r.status, r.body);
      }
      if (req.method === 'POST' && req.url === '/esim/complete') {
        const r = completeFor(b.paymentHash, '');
        return reply(r.status, r.body);
      }
      const cm = /^\/esim\/([^/]+)\/complete$/.exec(req.url);
      if (req.method === 'POST' && cm) {
        const r = completeFor(b.paymentHash, decodeURIComponent(cm[1]));
        return reply(r.status, r.body);
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
        purchases: () => state.log.filter((l) => /^\/esim\/([^/]+\/)?purchase$/.test(l.path)).length,
        completes: () => state.log.filter((l) => /^\/esim\/([^/]+\/)?complete$/.test(l.path)).length,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start, CATALOGUE };
