'use strict';
/**
 * nadanada — the eSIM provider. nadanada.me, paid by Lightning, no account, no API key.
 *
 * Verified against the live API (https://nadanada.me/api/v2, OpenAPI at /api/v2/openapi.json) on
 * 15 Sep 2026:
 *   - GET  /esim/bundles?country=DE and /esim/portfolio list bundles by name (fixed_1GB_7D_DE) with
 *     a dollar price. scripts/catalogue.js turns that into site/config/esim.json.
 *   - POST /esim/purchase { bundleName, slug, paymentMethod: "lightning" } answers a checkoutId, a
 *     paymentHash, a bolt11 paymentRequest, the price (5% under list for Lightning) and expiresAt.
 *     A bundle that does not belong to the slug is refused (bundle_slug_mismatch), so both are sent.
 *   - POST /esim/complete { paymentHash } is 402 "Lightning invoice not settled yet" until the
 *     invoice is paid, 404 when the checkout is unknown, and 200 with the ICCID and the
 *     installation details (QR, manual code, SM-DP+ address, matching id, Apple and Android install
 *     links) once it is. It is safe to call repeatedly.
 *   - GET  /esim/{iccid} reports profile status and usage; /esim/{iccid}/purchase tops one up.
 *
 * There is no listing endpoint and nothing on their side knows which wallet an order was for, so
 * this provider keeps its own record in the store (lib/store.js): one document per transactionId,
 * claimed with SET NX so two function instances cannot both invoice the same redemption, and moved
 * through invoiced → paid → done as each step lands. Every step is resumable: a function that dies
 * between paying and completing leaves a record the next request finishes, and "did we pay this
 * already" is answered by the wallet (payer.sent) before any invoice is paid a second time.
 *
 * Before paying, the invoice is decoded (lib/bolt11.js) and refused unless it carries the payment
 * hash nadanada quoted, an amount, and an amount that is the quoted price at the wallet's own
 * BTC price to within a tenth; and the quoted price is refused if it is above the catalogue's.
 * The credit charged to the trader is the catalogue (list) price; the pool pays the Lightning
 * price, and the difference is what covers routing fees and the swap into sats.
 *
 * What counts as a redemption for the ledger in /api/redeem: a record that is done, paid, or has a
 * payment in flight. An invoice that was never paid is not one — find() answers null for it, so
 * the trader's credit is not consumed by an outage, and the next redeem for the same id either
 * pays that invoice (same package, still valid) or replaces it.
 */
const bolt11 = require('../bolt11');
const { store: chooseStore } = require('../store');
const { payer: choosePayer } = require('../payers');

const BASE = () => (process.env.NADANADA_BASE_URL || 'https://nadanada.me/api/v2').replace(/\/$/, '');
// How long order() waits for the profile after paying. Read per call: it is the one knob a
// deployment tunes to its function's wall-clock budget.
const COMPLETE_WAIT_MS = () => Number(process.env.NADANADA_COMPLETE_WAIT_MS || 12000);
const COMPLETE_POLL_MS = 1500;
const FETCH_TIMEOUT_MS = 15000;
const MIN_GAP_MS = 100;
const PRICE_TOLERANCE = 0.005;   // their rounding vs the catalogue's
const RATE_TOLERANCE = 0.10;     // sats in the invoice vs dollars at the wallet's price
const EXPIRY_GRACE_S = 120;      // an invoice is treated as dead this long after it says it is
const CLAIM_TTL_MS = 60 * 1000;  // a claim older than this belongs to an instance that died before quoting
const CLAIM_POLL_MS = 250;
const RECENT = 'orders:recent';
const keyOf = (tx) => 'order:' + tx;
const simKeyOf = (address) => 'sim:' + String(address || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, status) { const e = new Error(message); if (status) e.status = status; return e; }

/** The store, refusing the forgetful one unless a test says so in the environment. */
function storeFor() {
  const s = chooseStore();
  if (s.name === 'memory' && process.env.NADANADA_ALLOW_MEMORY_STORE !== '1') {
    throw fail('nadanada needs a durable store (KV_REST_API_URL + KV_REST_API_TOKEN); an in-memory one would forget paid orders', 503);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// HTTP, one request at a time and spaced out — a courtesy to an API with no published limit.
// ---------------------------------------------------------------------------------------------
let chain = Promise.resolve();
let lastAt = 0;
function spaced(fn) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function api(method, path, body) {
  return spaced(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { accept: 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      const res = await fetch(BASE() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      return { status: res.status, json };
    } finally { clearTimeout(timer); }
  });
}

const errorOf = (r, what) => (r.json && (r.json.error || r.json.message))
  ? String(r.json.error || r.json.message)
  : 'nadanada answered HTTP ' + r.status + (r.json ? '' : ' with no JSON') + ' on ' + what;

async function purchase({ bundleName, slug, iccid }) {
  const path = iccid ? '/esim/' + encodeURIComponent(iccid) + '/purchase' : '/esim/purchase';
  const r = await api('POST', path, { bundleName, slug, paymentMethod: 'lightning' });
  if (r.status !== 200 || !r.json || !r.json.success || !r.json.data) {
    const e = fail('nadanada refused the order: ' + errorOf(r, 'purchase'), 502);
    // Marked so order() can fall back to a new eSIM: nadanada warns that not every bundle can
    // join every profile. Nothing has been paid at this point, so the fallback costs a round trip.
    if (iccid) e.topupRefused = true;
    throw e;
  }
  return r.json.data;
}

/**
 * One completion attempt: { done, data } | { unpaid } | { gone, error } | { error }.
 *
 * `iccid` names the profile being topped up, and is empty for a new eSIM. A top-up answers
 * { iccid, bundleName, toppedUp } and no installation details — the profile is already on the
 * phone, so there is nothing new to install. Its 403 (the checkout belongs to another ICCID) is
 * as final as a 404: this record can never complete, so both are 'gone'.
 */
async function complete(paymentHash, iccid) {
  const path = iccid ? '/esim/' + encodeURIComponent(iccid) + '/complete' : '/esim/complete';
  const r = await api('POST', path, { paymentHash });
  if (r.status === 200 && r.json && r.json.success && r.json.data && r.json.data.iccid) return { done: true, data: r.json.data };
  if (r.status === 402) return { done: false, unpaid: true };
  if (r.status === 404 || r.status === 403) return { done: false, gone: true, error: errorOf(r, 'complete') };
  return { done: false, error: errorOf(r, 'complete') };
}

// ---------------------------------------------------------------------------------------------
// One eSIM per wallet, topped up.
//
// nadanada's bundles run consecutively on a profile, not concurrently: a top-up queues behind
// whatever is running and starts the moment that one ends, and a bundle's validity does not begin
// until the phone first connects to a network in its region. So the right thing to give a holder
// every week is another bundle on the SIM they already have — not another SIM. Ten weekly claims
// become one profile with ten bundles queued, instead of ten profiles each with its own six-month
// idle clock and its own QR code to install.
//
// The index is one document per wallet: which ICCID to top up (per place, and in general), and the
// installation details of each, which is all the dashboard needs to show a card. It is written
// when a new eSIM completes — the first writer wins with NX, so two first-ever claims racing each
// other leave the loser's SIM out of the index rather than overwriting the winner's. That holder
// ends up with two profiles for one week and one from then on, which is worth more than a lock.
// ---------------------------------------------------------------------------------------------

/**
 * The eSIM this wallet should top up for `slug` — its SIM for that place, and only that place.
 *
 * Deliberately NOT "whichever SIM it has". Bundles on a profile run consecutively, so a Japan
 * bundle queued behind an unused Europe one would be unreachable until the Europe one ended: the
 * holder would land in Tokyo with data they had paid for and could not use. A second profile for
 * a second region costs nothing (the SIM is free; only data is billed) and is always usable on
 * arrival. So a wallet has one eSIM per place it buys — one, for anyone who keeps buying the
 * same place, which is nearly everyone.
 */
async function simFor(store, address, slug) {
  if (!address) return '';
  const rec = await store.get(simKeyOf(address));
  if (!rec || !rec.bySlug) return '';
  return String(rec.bySlug[slug] || '');
}

/** Remember a newly issued eSIM as this wallet's, for this place and — if it is the first — at large. */
async function recordSim(store, address, slug, card) {
  if (!address || !card || !card.iccid) return;
  const key = simKeyOf(address);
  const now = new Date().toISOString();
  const fresh = {
    address: String(address).toLowerCase(), primary: card.iccid, bySlug: {}, cards: {},
    createdAt: now, updatedAt: now,
  };
  fresh.bySlug[slug] = card.iccid;
  fresh.cards[card.iccid] = card;
  if (await store.set(key, fresh, { nx: true })) return;
  const rec = (await store.get(key)) || fresh;
  rec.bySlug = rec.bySlug || {};
  rec.cards = rec.cards || {};
  if (!rec.primary) rec.primary = card.iccid;
  // Unconditional, unlike `primary`: this runs whenever a genuinely new eSIM was just issued for
  // `slug`, which happens not only the first time (bySlug[slug] unset) but also when a top-up of
  // the wallet's existing SIM for this place was refused and order() minted a replacement instead
  // (see the topupRefused fallback in order()). Leaving the old, now-refusing ICCID in bySlug[slug]
  // would make every future order for this place retry and fail against a dead profile forever,
  // instead of adopting the replacement — the opposite of "one eSIM per wallet, topped up".
  rec.bySlug[slug] = card.iccid;
  if (!rec.cards[card.iccid]) rec.cards[card.iccid] = card;
  rec.updatedAt = now;
  await store.set(key, rec);
}

// ---------------------------------------------------------------------------------------------
// The record, and the steps it moves through.
// ---------------------------------------------------------------------------------------------
const earliest = (...isos) => {
  const ts = isos.map((x) => (typeof x === 'number' ? x * 1000 : Date.parse(x))).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
};
const isExpired = (rec, now) => {
  const t = rec.expiresAt ? Date.parse(rec.expiresAt) : NaN;
  return Number.isFinite(t) && t + EXPIRY_GRACE_S * 1000 < now;
};
const isStaleClaim = (rec, now) => rec.step === 'claiming' && !(now - Date.parse(rec.createdAt) < CLAIM_TTL_MS);
const attemptId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const save = (store, rec) => store.set(keyOf(rec.transactionId), rec);
/** The record as the API sees it: pending until done, and the step named. */
const publicOf = (rec) => (rec ? Object.assign({}, rec, { pending: rec.step !== 'done', stage: rec.step }) : null);

function newRecord({ transactionId, packageCode, slug, priceUsd, address, quote, inv, attempt, topupOf }) {
  return {
    transactionId, attempt, address: String(address || '').toLowerCase(), packageCode, slug,
    // The profile this bundle joins, empty when it is a new eSIM. It decides which pair of
    // nadanada endpoints completes the order, so it is written before the invoice is ever paid.
    topupOf: String(topupOf || ''),
    checkoutId: quote.checkoutId || '', paymentHash: inv.paymentHash, paymentRequest: quote.paymentRequest,
    providerBundleName: quote.providerBundleName || '',
    priceUsd: Number(priceUsd), paidUsd: Number(quote.price), sats: inv.sats,
    expiresAt: earliest(quote.expiresAt, inv.expiresAt),
    createdAt: new Date().toISOString(), paidAt: null, completedAt: null,
    step: 'invoiced', attempts: 0, error: '',
    iccid: '', orderReference: '', bundleName: '', qrCodeUrl: '', ac: '', manualCode: '',
    smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '',
  };
}

/**
 * The completion payload onto the record. The activation code is whichever field carries an LPA
 * string. A top-up carries none — its bundle queues on a profile already installed — so it keeps
 * the fields blank and the dashboard shows it under the SIM it joined.
 */
async function finish(store, rec, data) {
  if (rec.topupOf) {
    rec.step = 'done';
    rec.iccid = String(data.iccid || rec.topupOf);
    rec.bundleName = String(data.bundleName || '');
    rec.toppedUp = true;
    rec.completedAt = new Date().toISOString();
    rec.error = '';
    await save(store, rec);
    return rec;
  }
  const inst = data.installationDetails || {};
  const qr = String(inst.qrCode || '');
  const manual = String(inst.manualCode || '');
  rec.step = 'done';
  rec.iccid = String(data.iccid || '');
  rec.orderReference = String(data.orderReference || '');
  rec.bundleName = String(data.bundleName || '');
  rec.smdpAddress = String(inst.smdpAddress || '');
  rec.matchingId = String(inst.matchingId || '');
  rec.qrCodeUrl = /^(data:|https?:\/\/)/i.test(qr) ? qr : '';
  rec.manualCode = manual;
  rec.ac = /^LPA:/i.test(manual) ? manual
    : /^LPA:/i.test(qr) ? qr
      : (rec.smdpAddress && rec.matchingId ? 'LPA:1$' + rec.smdpAddress + '$' + rec.matchingId : manual);
  rec.appleInstallUrl = String(inst.appleInstallUrl || '');
  rec.androidInstallUrl = String(inst.androidInstallUrl || '');
  rec.completedAt = new Date().toISOString();
  rec.error = '';
  await save(store, rec);
  // From here on this wallet is topped up rather than re-issued. Recorded after the order is
  // saved: a failure to index costs a duplicate SIM next week, a failure to save costs the eSIM.
  try {
    await recordSim(store, rec.address, rec.slug, {
      iccid: rec.iccid, slug: rec.slug, ac: rec.ac, qrCodeUrl: rec.qrCodeUrl, manualCode: rec.manualCode,
      smdpAddress: rec.smdpAddress, matchingId: rec.matchingId,
      appleInstallUrl: rec.appleInstallUrl, androidInstallUrl: rec.androidInstallUrl,
      createdAt: rec.completedAt,
    });
  } catch (e) { /* indexed next time; the eSIM is issued either way */ }
  return rec;
}

/**
 * Carry a record as far as it can go. `pay` says whether this caller may pay an unpaid invoice
 * (a redeem may; a lookup may not), `waitMs` how long to wait for the profile once paid.
 * Returns the record, or null when the record is not a redemption (nothing was ever paid).
 */
async function resume(store, rec, { pay = false, waitMs = 0 } = {}) {
  if (rec.step === 'done') return rec;
  if (rec.step === 'failed' || rec.step === 'claiming') return null;
  const payer = choosePayer();

  // 1. Completing is the cheapest truth about whether the invoice was paid.
  let c = await complete(rec.paymentHash, rec.topupOf);
  if (c.done) return finish(store, rec, c.data);
  if (c.gone) {
    // Unpaid and gone: the order never happened. Paid and gone: money out and no eSIM — stays
    // visible, with the reason, for a person to take up with nadanada.
    if (rec.step === 'paid') { rec.error = 'paid, but nadanada no longer knows the checkout: ' + c.error; await save(store, rec); return rec; }
    rec.step = 'failed'; rec.error = c.error; await save(store, rec);
    return null;
  }
  if (!c.unpaid) {
    if (rec.step === 'paid') { rec.error = c.error; await save(store, rec); return rec; }
    throw fail('nadanada could not confirm the order: ' + c.error, 502);
  }

  // 2. Not settled on their side. What does our wallet say?
  let justPaid = false;
  if (rec.step === 'invoiced') {
    let s;
    try { s = await payer.sent(rec.paymentHash); } catch (e) {
      // Not knowing is not a reason to pay: a second payment of the same invoice is the one
      // mistake that costs real money. Say so, or (for a lookup) leave the record as it is.
      if (pay) throw fail('the Lightning wallet could not be reached: ' + e.message, 503);
      return rec;
    }
    if (s.status === 'SUCCESS') {
      rec.step = 'paid'; rec.paidAt = rec.paidAt || new Date().toISOString(); rec.error = '';
      await save(store, rec);
    } else if (s.status === 'PENDING') {
      return rec;   // money in flight: it counts, and a later completion will find it settled
    } else {
      // NONE or FAILURE: nothing has left the wallet.
      if (isExpired(rec, Date.now())) { rec.step = 'failed'; rec.error = 'invoice expired unpaid'; await save(store, rec); return null; }
      if (!pay) return null;
      // Re-read before paying: if this id was replaced under us (another request superseded the
      // invoice), the record on file is the one to carry, not this copy of an older one.
      const current = await store.get(keyOf(rec.transactionId));
      if (!current) return null;
      if (current.paymentHash !== rec.paymentHash || current.step !== rec.step) return resume(store, current, { pay, waitMs });
      let r;
      try { r = await payer.pay({ paymentRequest: rec.paymentRequest, memo: 'OT+T ' + rec.transactionId }); } catch (e) {
        rec.attempts = (rec.attempts || 0) + 1; rec.error = 'wallet did not answer: ' + e.message; await save(store, rec);
        throw fail('the Lightning wallet did not answer; try again in a minute', 503);
      }
      rec.attempts = (rec.attempts || 0) + 1;
      if (r.status === 'SUCCESS' || r.status === 'ALREADY_PAID') {
        rec.step = 'paid'; rec.paidAt = new Date().toISOString(); rec.error = ''; justPaid = true;
        await save(store, rec);
      } else if (r.status === 'PENDING') {
        rec.error = ''; await save(store, rec);
        return rec;
      } else {
        rec.error = r.error || 'payment failed'; await save(store, rec);
        throw fail('the pool could not pay for this eSIM: ' + rec.error, /balance|insufficient/i.test(rec.error) ? 503 : 502);
      }
    }
  }

  // 3. Paid. Complete, with whatever patience the caller has.
  const deadline = Date.now() + waitMs;
  if (!justPaid) {
    if (waitMs <= 0) return rec;   // the attempt in step 1 was this call's one look
    await sleep(COMPLETE_POLL_MS);
  }
  for (;;) {
    c = await complete(rec.paymentHash, rec.topupOf);
    if (c.done) return finish(store, rec, c.data);
    if (c.gone || (!c.unpaid && c.error)) { rec.error = c.error; await save(store, rec); return rec; }
    if (Date.now() >= deadline) return rec;
    await sleep(COMPLETE_POLL_MS);
  }
}

module.exports = {
  name: 'nadanada',

  async find(transactionId) {
    const store = storeFor();
    const rec = await store.get(keyOf(transactionId));
    if (!rec) return null;
    return publicOf(await resume(store, rec, { pay: false, waitMs: 0 }));
  },

  /**
   * A new eSIM for this redemption id, or the one already under way. `packageCode` is nadanada's
   * bundle name, `slug` the place it is priced for, `priceUsd` the catalogue price the trader is
   * being charged, `address` the wallet (recorded for support; nadanada is never told).
   *
   * The id is claimed in the store BEFORE nadanada is asked for a quote, so two requests racing
   * for the same redemption produce one invoice: the loser waits for the winner's record and
   * carries that. A claim whose owner died before quoting goes stale after a minute and is
   * replaced; nothing was paid on it.
   */
  async order({ transactionId, packageCode, slug, priceUsd, address }) {
    const store = storeFor();
    const waitMs = COMPLETE_WAIT_MS();
    const key = keyOf(transactionId);
    const carry = async (rec) => {
      const done = await resume(store, rec, { pay: true, waitMs });
      if (!done) throw fail('the order could not be placed; try again', 503);
      return publicOf(done);
    };
    // The record another request is placing right now, once it has stopped being a bare claim.
    const awaitClaim = async () => {
      const deadline = Date.now() + waitMs + CLAIM_TTL_MS;
      for (;;) {
        const rec = await store.get(key);
        if (!rec || rec.step === 'failed') throw fail('the other request placing this order did not get through; try again', 503);
        if (rec.step !== 'claiming') return carry(rec);
        if (isStaleClaim(rec, Date.now()) || Date.now() >= deadline) throw fail('this redemption is still being placed; try again in a moment', 503);
        await sleep(CLAIM_POLL_MS);
      }
    };

    const existing = await store.get(key);
    if (existing) {
      if (existing.step === 'claiming' && !isStaleClaim(existing, Date.now())) return awaitClaim();
      const live = existing.step === 'invoiced' && existing.packageCode === packageCode && !isExpired(existing, Date.now());
      if (existing.step === 'done' || existing.step === 'paid' || live) return carry(existing);
      if (existing.step === 'invoiced') {
        // A dead invoice, or one for a different package. Replaceable only if nothing was paid.
        let s;
        try { s = await choosePayer().sent(existing.paymentHash); } catch (e) { throw fail('the Lightning wallet could not be reached: ' + e.message, 503); }
        if (s.status === 'SUCCESS' || s.status === 'PENDING') return carry(existing);
        existing.step = 'failed';
        existing.error = existing.packageCode === packageCode ? 'invoice expired unpaid' : 'superseded by an order for ' + packageCode;
        await save(store, existing);
      }
    }
    if (!packageCode || !slug) throw fail('order needs the bundle name and its place');

    // Claim the id. A fresh one with NX, so a race is settled by the store; a failed record or a
    // stale claim by overwriting, with the attempt id telling afterwards whose write landed.
    const claim = {
      transactionId, attempt: attemptId(), address: String(address || '').toLowerCase(), packageCode, slug,
      priceUsd: Number(priceUsd), step: 'claiming', createdAt: new Date().toISOString(), error: '',
    };
    const claimed = existing ? await store.set(key, claim) : await store.set(key, claim, { nx: true });
    if (!claimed) return awaitClaim();
    const mine = async () => { const cur = await store.get(key); return !!cur && cur.attempt === claim.attempt; };
    if (existing && !(await mine())) return awaitClaim();

    let quote, inv, topupOf = '';
    try {
      const payer = choosePayer();
      // The eSIM this wallet already has, if any: the bundle queues on that profile rather than
      // arriving as another SIM to install. A refusal here is free — nothing has been paid yet —
      // so a bundle the profile cannot take simply becomes a new eSIM.
      topupOf = await simFor(store, address, slug);
      try {
        quote = await purchase({ bundleName: packageCode, slug, iccid: topupOf });
      } catch (e) {
        if (!e.topupRefused) throw e;
        topupOf = '';
        quote = await purchase({ bundleName: packageCode, slug });
      }
      if (!quote.paymentRequest || !quote.paymentHash) throw fail('nadanada returned no Lightning invoice', 502);
      // A top-up quote names the profile it is for. If that is not the profile we asked to top up,
      // paying this invoice would put a holder's data on someone else's SIM — refuse before the
      // money moves rather than rely on their 403 at completion, when it is already spent.
      if (topupOf && quote.iccid && String(quote.iccid) !== topupOf) {
        throw fail('nadanada quoted a top-up for a different eSIM than the one asked for', 502);
      }
      try { inv = bolt11.decode(quote.paymentRequest); } catch (e) { throw fail('nadanada returned an invoice that does not decode: ' + e.message, 502); }
      if (inv.paymentHash !== String(quote.paymentHash).toLowerCase()) throw fail('nadanada\'s invoice does not carry the payment hash it quoted', 502);
      if (inv.sats === null) throw fail('nadanada returned an invoice with no amount', 502);
      const price = Number(quote.price);
      if (!(price > 0)) throw fail('nadanada quoted no price', 502);
      if (price > Number(priceUsd) * (1 + PRICE_TOLERANCE) + 1e-9) {
        throw fail('the catalogue is stale: ' + packageCode + ' is $' + price.toFixed(2) + ' at nadanada and $' + Number(priceUsd).toFixed(2) + ' here', 503);
      }
      const rate = await payer.usdPerSat();
      const invUsd = inv.sats * rate;
      if (Math.abs(invUsd - price) > price * RATE_TOLERANCE + 0.02) {
        throw fail('the invoice asks $' + invUsd.toFixed(2) + ' of sats against a price of $' + price.toFixed(2), 502);
      }
    } catch (e) {
      // The claim is released as a failed record: not a redemption, and the next order replaces it.
      if (await mine()) { claim.step = 'failed'; claim.error = String(e.message || e).slice(0, 200); await save(store, claim); }
      throw e;
    }

    const rec = newRecord({ transactionId, packageCode, slug, priceUsd, address, quote, inv, attempt: claim.attempt, topupOf });
    if (!(await mine())) return awaitClaim();   // lost the id while quoting; this invoice is never paid
    await save(store, rec);
    await store.zadd(RECENT, Date.parse(rec.createdAt), transactionId);
    return carry(rec);
  },

  /** Orders that cost something since `sinceIso` — done, or paid and still being issued. For scripts/treasury.js. */
  async listOrders({ sinceIso } = {}) {
    const store = storeFor();
    const since = sinceIso ? Date.parse(sinceIso) : 0;
    const ids = await store.zrange(RECENT, Number.isFinite(since) ? since : 0, Date.now() + 86400 * 1000, { limit: 500 });
    const out = [];
    for (const id of ids) {
      const rec = await store.get(keyOf(id));
      if (rec && (rec.step === 'done' || rec.step === 'paid')) out.push(publicOf(rec));
    }
    return out;
  },

  /** What the pool holds, in dollars: the Lightning wallet's balance at its own price. */
  async balanceUsd() { return (await choosePayer().balance()).usd; },
  async balance() { return choosePayer().balance(); },

  /**
   * The eSIMs this wallet has been issued, newest first, each with what a phone needs to install
   * it. A wallet that has only ever bought one place has exactly one; the dashboard shows its
   * code once and lists every bundle queued on it underneath.
   */
  async sims(address) {
    const store = storeFor();
    const rec = await store.get(simKeyOf(address));
    if (!rec || !rec.cards) return [];
    return Object.keys(rec.cards).map((k) => rec.cards[k]).filter((c) => c && c.iccid)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  },

  /** Profile status and usage for an issued eSIM, straight from nadanada. */
  async status(iccid) {
    const r = await api('GET', '/esim/' + encodeURIComponent(iccid));
    if (r.status !== 200 || !r.json || !r.json.success) throw fail('nadanada could not report on ' + iccid + ': ' + errorOf(r, 'status'), 502);
    return r.json.data;
  },

  /** Tests only. */
  _reset() { chain = Promise.resolve(); lastAt = 0; try { chooseStore()._reset(); } catch (e) { /* no store */ } },
};
