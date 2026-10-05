'use strict';
/**
 * wholesale — the private eSIM provider, paid by Lightning, with no customer-facing account.
 *
 * The endpoint is intentionally absent from the repository and supplied at deploy time. Its API:
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
 * this provider keeps its own record in the store (_lib/store.js): one document per transactionId,
 * claimed with SET NX so two function instances cannot both invoice the same redemption, and moved
 * through invoiced → paid → done as each step lands. Every step is resumable: a function that dies
 * between paying and completing leaves a record the next request finishes. "Did we pay this
 * already" is answered by the wallet (payer.sent) before any invoice is paid a second time — but
 * asking and then paying is itself a race between whichever callers reach an unpaid invoice at
 * once (the original placer's own retry, a second racer, an ordinary retried POST), so that whole
 * sequence runs under its own SET NX lease (see withPayLease/saveIfStep) with at most one caller
 * paying at a time and every write after it landing on the record as it stands in the store, never
 * on a stale copy taken before the wait for the wallet.
 *
 * Before paying, the invoice is decoded (_lib/bolt11.js) and refused unless it carries the payment
 * hash wholesale quoted, an amount, and an amount that is the quoted price at the wallet's own
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
const { requireRedemptionsEnabled } = require('../redemption-policy');

function BASE() {
  const value = String(process.env.WHOLESALE_BASE_URL || '').trim();
  if (!value) throw fail('the private provider endpoint is not configured', 503);
  return value.replace(/\/$/, '');
}
// How long order() waits for the profile after paying. Read per call: it is the one knob a
// deployment tunes to its function's wall-clock budget.
const COMPLETE_WAIT_MS = () => Number(process.env.WHOLESALE_COMPLETE_WAIT_MS || 12000);
const COMPLETE_POLL_MS = 1500;
const FETCH_TIMEOUT_MS = 15000;
const MIN_GAP_MS = 100;
const PRICE_TOLERANCE = 0.005;   // their rounding vs the catalogue's
const RATE_TOLERANCE = 0.10;     // sats in the invoice vs dollars at the wallet's price
const EXPIRY_GRACE_S = 120;      // an invoice is treated as dead this long after it says it is
const CLAIM_TTL_MS = 60 * 1000;  // a claim older than this belongs to an instance that died before quoting
const CLAIM_POLL_MS = 250;
// Blink may need both an account lookup and a send (up to 25s each), followed by
// durable writes. Only start a send in the lease's first 20s, leaving at least
// 100s before another caller can recover a lease whose owner died.
const PAY_LEASE_TTL_MS = 120 * 1000;
const PAY_SEND_WINDOW_MS = 20 * 1000;
const PAY_LEASE_WAIT_MS = 12 * 1000;
const RECENT = 'orders:recent';
const keyOf = (tx) => 'order:' + tx;
const simKeyOf = (address) => 'sim:' + String(address || '').toLowerCase();
const payLeaseKeyOf = (tx) => 'paylease:' + tx;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, status) { const e = new Error(message); if (status) e.status = status; return e; }

/** A URL we are willing to put behind a link, or nothing. Both install links wholesale sends are https. */
const httpsOnly = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');

/** The store, refusing the forgetful one unless a test says so in the environment. */
function storeFor() {
  const s = chooseStore();
  if (s.name === 'memory' && process.env.WHOLESALE_ALLOW_MEMORY_STORE !== '1') {
    throw fail('wholesale needs a durable store (KV_REST_API_URL + KV_REST_API_TOKEN); an in-memory one would forget paid orders', 503);
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
  : 'wholesale answered HTTP ' + r.status + (r.json ? '' : ' with no JSON') + ' on ' + what;

async function purchase({ bundleName, slug, iccid }) {
  const path = iccid ? '/esim/' + encodeURIComponent(iccid) + '/purchase' : '/esim/purchase';
  const r = await api('POST', path, { bundleName, slug, paymentMethod: 'lightning' });
  if (r.status !== 200 || !r.json || !r.json.success || !r.json.data) {
    const e = fail('wholesale refused the order: ' + errorOf(r, 'purchase'), 502);
    // Marked so order() can fall back to a new eSIM: wholesale warns that not every bundle can
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
// wholesale's bundles run consecutively on a profile, not concurrently: a top-up queues behind
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
  // Unconditional, unlike `primary`: this runs whenever a genuinely new eSIM was just issued for
  // `slug`, which happens not only the first time (bySlug[slug] unset) but also when a top-up of
  // the wallet's existing SIM for this place was refused and order() minted a replacement instead
  // (see the topupRefused fallback in order()). Leaving the old, now-refusing ICCID in bySlug[slug]
  // would make every future order for this place retry and fail against a dead profile forever,
  // instead of adopting the replacement — the opposite of "one eSIM per wallet, topped up".
  for (;;) {
    const before = await store.get(key);
    const rec = { ...(before || fresh), bySlug: { ...before?.bySlug }, cards: { ...before?.cards } };
    if (!rec.primary) rec.primary = card.iccid;
    rec.bySlug[slug] = card.iccid;
    if (!rec.cards[card.iccid]) rec.cards[card.iccid] = card;
    rec.updatedAt = now;
    if (await store.compareSet(key, before, rec)) return;
  }
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
/** The record as the API sees it: pending until done, and the step named. */
const publicOf = (rec) => (rec ? Object.assign({}, rec, { pending: rec.step !== 'done', stage: rec.step }) : null);

/**
 * At most one caller inside `fn` at a time for this transactionId — the mutual exclusion that
 * "has this been paid? then pay it" needs and, on its own, never had: two callers can each observe
 * an invoice unpaid and each go on to pay it. Built from the one primitive this store has, the same
 * way the id claim in order() is: SET NX claims a fresh lease; an atomic comparison replaces
 * one unreleased past PAY_LEASE_TTL_MS. Cleanup deletes only the lease this caller still owns,
 * so a recovered lease cannot be stolen or released by a delayed former owner.
 */
async function withPayLease(store, transactionId, fn) {
  const key = payLeaseKeyOf(transactionId);
  const deadline = Date.now() + PAY_LEASE_WAIT_MS;
  let mine;
  for (;;) {
    mine = { attempt: attemptId(), at: Date.now() };
    if (await store.set(key, mine, { nx: true })) break;
    const held = await store.get(key);
    const age = held && Date.now() - Number(held.at);
    if ((!held || !Number.isFinite(age) || age >= PAY_LEASE_TTL_MS) && await store.compareSet(key, held, mine)) break;
    if (Date.now() >= deadline) throw fail('a payment is already being checked; resume the same order shortly', 503);
    await sleep(CLAIM_POLL_MS);
  }
  try { return await fn(mine); } finally { await store.compareDel(key, mine); }
}

async function requireSendLease(store, transactionId, mine) {
  const held = await store.get(payLeaseKeyOf(transactionId));
  const age = Date.now() - mine.at;
  if (!held || held.attempt !== mine.attempt || held.at !== mine.at || age < 0 || age >= PAY_SEND_WINDOW_MS) {
    throw fail('the payment lease changed or its safe send window elapsed; resume the same order', 503);
  }
}

const unpaidStatus = s => s && ['NONE', 'FAILURE'].includes(s.status);
const paymentReserved = rec => ['sending', 'pending', 'uncertain'].includes(rec?.paymentState);
async function paymentStatus(payer, hash) {
  const result = await payer.sent(hash);
  if (!result || !['NONE', 'FAILURE', 'PENDING', 'SUCCESS'].includes(result.status)) {
    throw fail('the Lightning wallet payment status is uncertain; resume the same order', 503);
  }
  return result;
}

function validateInvoice(rec, rate) {
  const inv = bolt11.decode(rec.paymentRequest);
  if (inv.prefix !== 'bc' || inv.paymentHash !== rec.paymentHash || !Number.isFinite(inv.sats) || inv.sats <= 0 ||
      inv.expiresAt * 1000 <= Date.now()) throw fail('the stored Lightning invoice failed validation or expired', 502);
  if (!Number.isFinite(rec.priceUsd) || rec.priceUsd <= 0 || !Number.isFinite(rec.paidUsd) || rec.paidUsd <= 0 ||
      rec.paidUsd > rec.priceUsd * (1 + PRICE_TOLERANCE) + 1e-9) throw fail('the stored invoice exceeds its reviewed catalogue price', 502);
  if (!Number.isFinite(rate) || rate <= 0) throw fail('the Lightning wallet price is unavailable', 503);
  const usd = inv.sats * rate;
  if (usd > rec.priceUsd * (1 + PRICE_TOLERANCE) + 1e-9) throw fail('the stored invoice exceeds its reviewed catalogue price at the current wallet price', 502);
  if (!Number.isFinite(usd) || Math.abs(usd - rec.paidUsd) > rec.paidUsd * RATE_TOLERANCE + 0.02) {
    throw fail('the stored invoice disagrees with the current Lightning wallet price', 502);
  }
}

/**
 * Apply `patch` (an object, or a function of the current record to one) to the record as it
 * stands in the store RIGHT NOW — never to a possibly-stale local copy — and only while it is
 * still at `fromStep`. If another caller has already carried it further (paid it, or even
 * finished it, while this call was off asking the wallet something), the patch is dropped rather
 * than regressing whatever they wrote: an already-issued eSIM's installation details, most of all.
 * `applied` says which happened, so the caller can tell "I moved it forward" from "it had already
 * moved"; `record` is the record either way, fresh from the store.
 */
async function saveIfStep(store, transactionId, fromStep, patch, paymentHash) {
  for (;;) {
    const current = await store.get(keyOf(transactionId));
    if (!current) return { applied: false, record: null };
    if (current.step !== fromStep || (paymentHash && current.paymentHash !== paymentHash)) return { applied: false, record: current };
    const change = typeof patch === 'function' ? patch(current) : patch;
    if (!change) return { applied: false, record: current };
    const next = Object.assign({}, current, change);
    if (await store.compareSet(keyOf(transactionId), current, next)) return { applied: true, record: next };
  }
}

// A delayed send response can modify only the exact attempt that dispatched it.
function savePaymentAttempt(store, transactionId, attempt, paymentHash, patch) {
  return saveIfStep(store, transactionId, 'invoiced', current => current.paymentAttempt === attempt ? patch : null, paymentHash);
}

function newRecord({ transactionId, packageCode, slug, priceUsd, address, quote, inv, attempt, topupOf }) {
  return {
    transactionId, attempt, address: String(address || '').toLowerCase(), packageCode, slug,
    // The profile this bundle joins, empty when it is a new eSIM. It decides which pair of
    // wholesale endpoints completes the order, so it is written before the invoice is ever paid.
    topupOf: String(topupOf || ''),
    checkoutId: quote.checkoutId || '', paymentHash: inv.paymentHash, paymentRequest: quote.paymentRequest,
    providerBundleName: quote.providerBundleName || '',
    priceUsd: Number(priceUsd), paidUsd: Number(quote.price), sats: inv.sats,
    expiresAt: earliest(quote.expiresAt, inv.expiresAt),
    createdAt: new Date().toISOString(), paidAt: null, completedAt: null,
    step: 'invoiced', attempts: 0, error: '',
    paymentState: 'not-sent', paymentAttempt: '', paymentAttemptAt: null,
    iccid: '', orderReference: '', bundleName: '', qrCodeUrl: '', ac: '', manualCode: '',
    smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '',
  };
}

/**
 * The completion payload onto the record. The activation code is whichever field carries an LPA
 * string. A top-up carries none — its bundle queues on a profile already installed — so it keeps
 * the fields blank and the dashboard shows it under the SIM it joined.
 *
 * Written onto the record as it stands in the store right now, not onto the possibly-stale `rec`
 * this call was handed: `rec` may predate fields another caller already set (paidAt, attempts, or
 * — calling complete() is safe to repeat — this very completion, written a moment ago by whoever
 * got there first). Re-reading here means a slow caller can only ever repeat the same write, never
 * undo one that happened after its own copy was taken.
 */
async function finish(store, rec, data) {
  const before = await store.get(keyOf(rec.transactionId));
  if (!before || before.paymentHash !== rec.paymentHash || before.step === 'done') return before;
  const current = { ...before };
  current.paymentState = 'settled';
  if (current.topupOf) {
    current.step = 'done';
    current.iccid = String(data.iccid || current.topupOf);
    current.bundleName = String(data.bundleName || '');
    current.toppedUp = true;
    current.completedAt = new Date().toISOString();
    current.error = '';
    if (!(await store.compareSet(keyOf(rec.transactionId), before, current))) return finish(store, rec, data);
    return current;
  }
  const inst = data.installationDetails || {};
  const qr = String(inst.qrCode || '');
  const manual = String(inst.manualCode || '');
  current.step = 'done';
  current.iccid = String(data.iccid || '');
  current.orderReference = String(data.orderReference || '');
  current.bundleName = String(data.bundleName || '');
  current.smdpAddress = String(inst.smdpAddress || '');
  current.matchingId = String(inst.matchingId || '');
  current.qrCodeUrl = /^(data:|https?:\/\/)/i.test(qr) ? qr : '';
  current.manualCode = manual;
  current.ac = /^LPA:/i.test(manual) ? manual
    : /^LPA:/i.test(qr) ? qr
      : (current.smdpAddress && current.matchingId ? 'LPA:1$' + current.smdpAddress + '$' + current.matchingId : manual);
  // Scheme-checked for the same reason the QR above is: these become the href of a button the
  // holder is invited to press, on the page that is showing their activation code. A "javascript:"
  // in either field would run in that page's origin. We already decline to trust this response
  // enough to put it in an <img>; an <a> deserves no more trust.
  current.appleInstallUrl = httpsOnly(inst.appleInstallUrl);
  current.androidInstallUrl = httpsOnly(inst.androidInstallUrl);
  current.completedAt = new Date().toISOString();
  current.error = '';
  if (!(await store.compareSet(keyOf(rec.transactionId), before, current))) return finish(store, rec, data);
  // From here on this wallet is topped up rather than re-issued. Recorded after the order is
  // saved: a failure to index costs a duplicate SIM next week, a failure to save costs the eSIM.
  try {
    await recordSim(store, current.address, current.slug, {
      iccid: current.iccid, slug: current.slug, ac: current.ac, qrCodeUrl: current.qrCodeUrl, manualCode: current.manualCode,
      smdpAddress: current.smdpAddress, matchingId: current.matchingId,
      appleInstallUrl: current.appleInstallUrl, androidInstallUrl: current.androidInstallUrl,
      createdAt: current.completedAt,
    });
  } catch (e) { /* indexed next time; the eSIM is issued either way */ }
  return current;
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
    // A missing checkout is not evidence of an unpaid invoice. A send may have
    // succeeded or still be pending while the caller died before recording it.
    const current = await withPayLease(store, rec.transactionId, async () => {
      const live = await store.get(keyOf(rec.transactionId));
      if (!live || live.paymentHash !== rec.paymentHash || live.step === 'done') return live;
      if (live.step === 'paid') return (await saveIfStep(store, rec.transactionId, 'paid', {
        error: 'paid, but wholesale no longer knows the checkout: ' + c.error,
      }, rec.paymentHash)).record;
      let s;
      try { s = await paymentStatus(payer, live.paymentHash); }
      catch (e) {
        if (pay) throw fail('the Lightning wallet could not be reached or its payment status is uncertain: ' + e.message, 503);
        return live;
      }
      const patch = s.status === 'SUCCESS' ? { step: 'paid', paymentState: 'settled', paidAt: live.paidAt || new Date().toISOString(), error: 'paid, but wholesale no longer knows the checkout: ' + c.error }
        : s.status === 'PENDING' ? { paymentState: 'pending', error: 'payment pending, but wholesale no longer knows the checkout: ' + c.error }
          : paymentReserved(live) ? { error: 'payment outcome uncertain, but wholesale no longer knows the checkout: ' + c.error }
            : { step: 'failed', error: c.error };
      return (await saveIfStep(store, rec.transactionId, 'invoiced', patch, rec.paymentHash)).record;
    });
    return current?.step === 'failed' ? null : current;
  }
  if (!c.unpaid) {
    if (rec.step === 'paid') return (await saveIfStep(store, rec.transactionId, 'paid', { error: c.error }, rec.paymentHash)).record;
    throw fail('wholesale could not confirm the order: ' + c.error, 502);
  }

  // 2. Not settled on their side. What does our wallet say?
  let justPaid = false;
  if (rec.step === 'invoiced') {
    let s;
    try { s = await paymentStatus(payer, rec.paymentHash); } catch (e) {
      // Not knowing is not a reason to pay: a second payment of the same invoice is the one
      // mistake that costs real money. Say so, or (for a lookup) leave the record as it is.
      if (pay) throw fail('the Lightning wallet could not be reached or its payment status is uncertain: ' + e.message, 503);
      return rec;
    }
    if (s.status === 'PENDING') {
      return rec;   // money in flight: it counts, and a later completion will find it settled
    } else if (unpaidStatus(s) && paymentReserved(rec)) {
      return rec;   // Empty history or an older failure cannot disprove a dispatched send.
    }

    // From here on we either already know it is paid (sent() just said so) or are about to try
    // paying it ourselves — "has this been paid, then pay it", which may run for at most one
    // caller at a time or two callers can each see it unpaid and each pay it. A store-backed
    // lease, claimed with SET NX and released in a finally, in keeping with how order() already
    // claims a fresh id the same way.
    const outcome = await withPayLease(store, rec.transactionId, async (paymentLease) => {
      // The pre-lease read can become stale while another caller sends. Check
      // the current record AND wallet again after acquiring exclusive ownership.
      const current = await store.get(keyOf(rec.transactionId));
      if (!current) return { applied: false, record: null, justPaid: false };
      if (current.paymentHash !== rec.paymentHash || current.step !== 'invoiced') return { applied: false, record: current, justPaid: false };
      try { s = await paymentStatus(payer, current.paymentHash); }
      catch (e) {
        if (pay) throw fail('the Lightning wallet could not be reached or its payment status is uncertain: ' + e.message, 503);
        return { applied: true, record: current, pending: true, justPaid: false };
      }
      if (s.status === 'PENDING') return { applied: true, record: current, pending: true, justPaid: false };
      if (s.status === 'SUCCESS') {
        // Onto the order as it stands now: another caller may already have carried it past
        // 'invoiced' — paid it, or even finished it — while we were asking the wallet.
        const r = await saveIfStep(store, rec.transactionId, 'invoiced', (cur) => ({ step: 'paid', paymentState: 'settled', paidAt: cur.paidAt || new Date().toISOString(), error: '' }), rec.paymentHash);
        return { applied: r.applied, record: r.record, justPaid: false };
      }
      if (paymentReserved(current)) return { applied: true, record: current, pending: true, justPaid: false };
      if (isExpired(current, Date.now())) {
        const r = await saveIfStep(store, rec.transactionId, 'invoiced', { step: 'failed', error: 'invoice expired unpaid' }, rec.paymentHash);
        return { applied: r.applied, record: r.applied ? null : r.record, justPaid: false };
      }
      if (!pay) return { applied: true, record: null, justPaid: false };
      validateInvoice(current, await payer.usdPerSat());
      await requireSendLease(store, rec.transactionId, paymentLease);
      // Reserve credit BEFORE the external action. If this process dies or the
      // response is lost, a temporarily empty wallet history cannot allow a
      // second send, release credit, expire the record or replace its checkout.
      const started = await saveIfStep(store, rec.transactionId, 'invoiced', cur => paymentReserved(cur) ? null : {
        paymentState: 'sending', paymentAttempt: paymentLease.attempt, paymentAttemptAt: new Date().toISOString(),
        attempts: (cur.attempts || 0) + 1, error: '',
      }, rec.paymentHash);
      if (!started.applied) return { applied: false, record: started.record, justPaid: false };
      try { await requireSendLease(store, rec.transactionId, paymentLease); }
      catch (e) {
        // This process knows it has not invoked pay yet. A process that dies
        // instead leaves its reservation in place for payment-state review.
        await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { paymentState: 'not-sent', error: e.message });
        throw e;
      }
      let r;
      try { r = await payer.pay({ paymentRequest: current.paymentRequest, memo: 'OT+T ' + current.transactionId, paymentLease }); } catch (e) {
        await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { paymentState: 'uncertain', error: 'wallet did not answer: ' + e.message });
        throw fail('the Lightning wallet did not answer; try again in a minute', 503);
      }
      if (r && (r.status === 'SUCCESS' || r.status === 'ALREADY_PAID')) {
        const saved = await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { step: 'paid', paymentState: 'settled', paidAt: new Date().toISOString(), error: '' });
        return { applied: saved.applied, record: saved.record, justPaid: true };
      } else if (r?.status === 'PENDING') {
        const saved = await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { paymentState: 'pending', error: '' });
        return { applied: saved.applied, record: saved.record, justPaid: false, pending: true };
      } else {
        if (!r || r.status !== 'FAILURE') {
          await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { paymentState: 'uncertain', error: 'wallet payment result is uncertain; resume this order' });
          throw fail('the Lightning wallet payment result is uncertain; resume the same order', 503);
        }
        await savePaymentAttempt(store, rec.transactionId, paymentLease.attempt, rec.paymentHash, { paymentState: 'failed', error: r.error || 'payment failed' });
        throw fail('the pool could not pay for this eSIM: ' + (r.error || 'payment failed'), /balance|insufficient/i.test(r.error || '') ? 503 : 502);
      }
    });
    if (!outcome.record) return null;
    // Someone else already carried this past 'invoiced' before our own write landed (they held
    // the lease before us, or stole a stale one from us) — carry the record as it now stands
    // rather than what we just tried to write.
    if (!outcome.applied) return resume(store, outcome.record, { pay, waitMs });
    if (outcome.pending) return outcome.record;
    rec = outcome.record;
    justPaid = outcome.justPaid;
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
    if (c.gone || (!c.unpaid && c.error)) return (await saveIfStep(store, rec.transactionId, 'paid', { error: c.error }, rec.paymentHash)).record;
    if (Date.now() >= deadline) return rec;
    await sleep(COMPLETE_POLL_MS);
  }
}

module.exports = {
  name: 'wholesale',

  async find(transactionId) {
    const store = storeFor();
    const rec = await store.get(keyOf(transactionId));
    if (!rec) return null;
    return publicOf(await resume(store, rec, { pay: false, waitMs: 0 }));
  },

  /**
   * A new eSIM for this redemption id, or the one already under way. `packageCode` is wholesale's
   * bundle name, `slug` the place it is priced for, `priceUsd` the catalogue price the trader is
   * being charged, `address` the wallet (recorded for support; wholesale is never told).
   *
   * The id is claimed in the store BEFORE wholesale is asked for a quote, so two requests racing
   * for the same redemption produce one invoice: the loser waits for the winner's record and
   * carries that. A claim whose owner died before quoting goes stale after a minute and is
   * replaced; nothing was paid on it.
   */
  async order({ transactionId, packageCode, slug, priceUsd, address }) {
    requireRedemptionsEnabled();
    const store = storeFor();
    const waitMs = COMPLETE_WAIT_MS();
    const key = keyOf(transactionId);
    const carry = async (rec) => {
      // An interrupted index write can leave a valid invoice on file. Repair
      // the treasury's index on every retry BEFORE allowing its payment.
      const createdAt = Date.parse(rec.createdAt);
      if (!Number.isFinite(createdAt)) throw fail('the stored order has no valid creation time; review it before payment', 503);
      await store.zadd(RECENT, createdAt, transactionId);
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

    let existing = await store.get(key);
    if (existing) {
      if (existing.step === 'claiming' && !isStaleClaim(existing, Date.now())) return awaitClaim();
      const live = existing.step === 'invoiced' && existing.packageCode === packageCode && !isExpired(existing, Date.now());
      if (existing.step === 'done' || existing.step === 'paid' || live) return carry(existing);
      if (existing.step === 'invoiced' || (existing.step === 'failed' && existing.paymentHash)) {
        // A dead invoice, or one for a different package. Replaceable only if nothing was paid.
        // Replacement competes with payment under the SAME lease. Otherwise a
        // quote could be replaced while another caller is sending its invoice.
        const replacement = await withPayLease(store, transactionId, async () => {
          const current = await store.get(key);
          if (!current) return { replace: null };
          if (current.paymentHash !== existing.paymentHash || !['invoiced', 'failed'].includes(current.step)) return { carry: current };
          let s;
          try { s = await paymentStatus(choosePayer(), current.paymentHash); }
          catch (e) { throw fail('the Lightning wallet could not be reached or its payment status is uncertain: ' + e.message, 503); }
          if (s.status === 'SUCCESS' || s.status === 'PENDING') {
            const marked = await saveIfStep(store, transactionId, current.step, {
              step: s.status === 'SUCCESS' ? 'paid' : 'invoiced',
              paymentState: s.status === 'SUCCESS' ? 'settled' : 'pending',
              ...(s.status === 'SUCCESS' ? { paidAt: current.paidAt || new Date().toISOString() } : {}), error: '',
            }, current.paymentHash);
            return { carry: marked.record };
          }
          if (paymentReserved(current)) return { carry: current };
          if (current.step === 'failed') return { replace: current };
          const marked = await saveIfStep(store, transactionId, 'invoiced', {
            step: 'failed', error: current.packageCode === packageCode ? 'invoice expired unpaid' : 'superseded by an order for ' + packageCode,
          }, current.paymentHash);
          return marked.applied ? { replace: marked.record } : { carry: marked.record };
        });
        if (replacement.carry) return carry(replacement.carry);
        existing = replacement.replace;
      }
    }
    if (!packageCode || !slug) throw fail('order needs the bundle name and its place');

    // Claim a fresh id with NX, or compare against the exact failed/stale record
    // being replaced so concurrent claimants cannot overwrite each other.
    const claim = {
      transactionId, attempt: attemptId(), address: String(address || '').toLowerCase(), packageCode, slug,
      priceUsd: Number(priceUsd), step: 'claiming', createdAt: new Date().toISOString(), error: '',
    };
    const claimed = existing ? await store.compareSet(key, existing, claim) : await store.set(key, claim, { nx: true });
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
      if (!quote.paymentRequest || !quote.paymentHash) throw fail('wholesale returned no Lightning invoice', 502);
      // A top-up quote names the profile it is for. If that is missing, or is not the profile we
      // asked to top up, paying this invoice would put a holder's data on someone else's SIM (or
      // on no identified SIM at all) — refuse before the money moves rather than rely on their 403
      // at completion, when it is already spent. A missing iccid is refused rather than let
      // through: the provider silently omitting the field it is supposed to always send is not
      // evidence the checkout is for the right profile.
      if (topupOf && String(quote.iccid || '') !== topupOf) {
        throw fail('wholesale quoted a top-up for a different eSIM than the one asked for', 502);
      }
      try { inv = bolt11.decode(quote.paymentRequest); } catch (e) { throw fail('wholesale returned an invoice that does not decode: ' + e.message, 502); }
      if (inv.paymentHash !== String(quote.paymentHash).toLowerCase()) throw fail('wholesale\'s invoice does not carry the payment hash it quoted', 502);
      if (inv.sats === null) throw fail('wholesale returned an invoice with no amount', 502);
      const price = Number(quote.price);
      if (!(price > 0)) throw fail('wholesale quoted no price', 502);
      if (price > Number(priceUsd) * (1 + PRICE_TOLERANCE) + 1e-9) {
        throw fail('the catalogue is stale: ' + packageCode + ' is $' + price.toFixed(2) + ' at wholesale and $' + Number(priceUsd).toFixed(2) + ' here', 503);
      }
      const rate = await payer.usdPerSat();
      const invUsd = inv.sats * rate;
      if (Math.abs(invUsd - price) > price * RATE_TOLERANCE + 0.02) {
        throw fail('the invoice asks $' + invUsd.toFixed(2) + ' of sats against a price of $' + price.toFixed(2), 502);
      }
      validateInvoice({ paymentRequest: quote.paymentRequest, paymentHash: inv.paymentHash, priceUsd: Number(priceUsd), paidUsd: price }, rate);
    } catch (e) {
      // The claim is released as a failed record: not a redemption, and the next order replaces it.
      await store.compareSet(key, claim, { ...claim, step: 'failed', error: String(e.message || e).slice(0, 200) });
      throw e;
    }

    const rec = newRecord({ transactionId, packageCode, slug, priceUsd, address, quote, inv, attempt: claim.attempt, topupOf });
    if (!(await store.compareSet(key, claim, rec))) return awaitClaim();   // lost the id while quoting; this invoice is never paid
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

  /** Profile status and usage for an issued eSIM, straight from wholesale. */
  async status(iccid) {
    const r = await api('GET', '/esim/' + encodeURIComponent(iccid));
    if (r.status !== 200 || !r.json || !r.json.success) throw fail('wholesale could not report on ' + iccid + ': ' + errorOf(r, 'status'), 502);
    return r.json.data;
  },

  /** Tests only. */
  _reset() { chain = Promise.resolve(); lastAt = 0; try { chooseStore()._reset(); } catch (e) { /* no store */ } },
};
