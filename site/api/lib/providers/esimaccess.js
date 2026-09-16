'use strict';
/**
 * esimaccess — the real reseller. Written against the eSIM Access Partner API as documented in its
 * Postman collection (docs.esimaccess.com) and checked against the live endpoint on 14 Sep 2026.
 *
 * What was verified, and how:
 *   - Auth is the single header RT-AccessCode. balance/query answered with it alone; the "secret"
 *     shown beside it in the console is not needed for ordering (it is for webhook verification)
 *     and is deliberately never read here.
 *   - An order is idempotent by transactionId: "Duplicate transactionId will be identified as the
 *     same request." (order description). That is the one property /api/redeem relies on.
 *   - Profiles are allocated asynchronously after an order, up to ~30 seconds; esim/query by orderNo
 *     answers errorCode 200010 (or an empty list) until then.
 *   - esim/query filters by orderNo, iccid, esimTranNo or a startTime/endTime range — NOT by
 *     transactionId. So find() pages this account's own orders by time and matches transactionId on
 *     the records, which each carry it. At the volume a v1 launch produces that is one or two
 *     requests, cached for thirty seconds.
 *   - Prices and amounts are integers of value × 10,000 (57000 = $5.70), pageSize is 5..500, and
 *     the rate limit is 8 requests a second.
 *
 * What is NOT done here: any accounting. This file orders and looks up; who may order what, and
 * how much they have left, is /api/redeem's business.
 */
const ACCESS_CODE = () => process.env.ESIMACCESS_ACCESS_CODE || '';
const BASE = () => (process.env.ESIMACCESS_BASE_URL || 'https://api.esimaccess.com/api/v1/open').replace(/\/$/, '');
// Orders before this moment are not ours to page through. Set it to the launch day.
const SINCE = () => process.env.ESIMACCESS_SINCE || '2026-09-01T00:00+00:00';

const FETCH_TIMEOUT_MS = 8000;
const MIN_GAP_MS = 130;            // 8 req/s, with a little room
const INDEX_TTL_MS = 30 * 1000;
const MISS_REFRESH_MS = 3 * 1000;  // a miss re-reads the index at most this often
const ALLOCATE_POLL_MS = 2000;
// Read per call rather than at load: Vercel functions have a wall-clock budget, and the wait is
// the one knob a deployment tunes without redeploying.
const ALLOCATE_WAIT_MS = () => Number(process.env.ESIMACCESS_ALLOCATE_WAIT_MS || 20000);
const PAGE_SIZE = 500;
const MAX_PAGES = 40;              // 20,000 orders; beyond that the design needs a database anyway

// ---------------------------------------------------------------------------------------------
// One request at a time, spaced out. The account's rate limit is shared by every function instance
// so this is a courtesy rather than a guarantee, but it keeps one page load from tripping it.
// ---------------------------------------------------------------------------------------------
let chain = Promise.resolve();
let lastAt = 0;
function spaced(fn) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function call(path, body) {
  if (!ACCESS_CODE()) throw new Error('ESIMACCESS_ACCESS_CODE is not set');
  return spaced(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(BASE() + path, {
        method: 'POST',
        headers: { 'RT-AccessCode': ACCESS_CODE(), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('eSIM Access answered HTTP ' + res.status + ' on ' + path);
      const j = await res.json();
      // The envelope: { success, errorCode, errorMsg | errorMessage, obj }. Both spellings of the
      // message appear in the documented examples, so both are read.
      return j;
    } finally { clearTimeout(timer); }
  });
}

const errorOf = (j) => (j && (j.errorMsg || j.errorMessage)) || (j && j.errorCode ? 'error ' + j.errorCode : 'unknown error');
const toUnits = (usd) => Math.round(Number(usd) * 10000);
const iso = (d) => new Date(d).toISOString().replace(/:\d\d\.\d{3}Z$/, '+00:00');

/** One esim/query record as the shape the API and the page share. */
function toRecord(e) {
  const p = (e.packageList && e.packageList[0]) || {};
  return {
    transactionId: e.transactionId,
    orderNo: e.orderNo,
    esimTranNo: e.esimTranNo,
    packageCode: p.slug || p.packageCode || '',
    packageName: p.packageName || '',
    qrCodeUrl: e.qrCodeUrl || '',
    shortUrl: e.shortUrl || '',
    ac: e.ac || '',
    iccid: e.iccid || '',
    createdAt: p.createTime || null,
    smdpStatus: e.smdpStatus || '',
    esimStatus: e.esimStatus || '',
    pending: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The index: every order this account has placed since SINCE, keyed by transactionId.
// ---------------------------------------------------------------------------------------------
let index = { at: 0, missAt: 0, byTx: new Map() };
// Orders placed by this instance whose profiles were not yet allocated when order() returned. They
// are answered from here until the reseller lists them, so a GET straight after a POST does not
// report one order fewer than the wallet has.
const placed = new Map();

/** Every profile the account has ordered since `startTime` (ISO, +00:00), paged to the end. */
async function pageOrders(startTime) {
  const out = [];
  const endTime = iso(Date.now() + 24 * 3600 * 1000);
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const j = await call('/esim/query', { startTime, endTime, pager: { pageNum, pageSize: PAGE_SIZE } });
    if (!j.success) throw new Error('eSIM Access query failed: ' + errorOf(j));
    const list = (j.obj && j.obj.esimList) || [];
    for (const e of list) if (e && e.transactionId) out.push(toRecord(e));
    const total = Number(j.obj && j.obj.pager && j.obj.pager.total) || 0;
    if (list.length < PAGE_SIZE || pageNum * PAGE_SIZE >= total) break;
  }
  return out;
}

async function refreshIndex() {
  const byTx = new Map();
  for (const rec of await pageOrders(SINCE())) byTx.set(rec.transactionId, rec);
  index = { at: Date.now(), missAt: index.missAt, byTx };
  return byTx;
}

async function lookup(transactionId) {
  const stale = Date.now() - index.at > INDEX_TTL_MS;
  if (stale) await refreshIndex();
  let hit = index.byTx.get(transactionId) || null;
  if (!hit && !stale && Date.now() - index.missAt > MISS_REFRESH_MS) {
    // A miss on a fresh index is usually a real miss (the wallet has not redeemed this one), but
    // it is also what a just-allocated profile looks like for up to thirty seconds. One re-read,
    // rate-limited, settles it.
    index.missAt = Date.now();
    await refreshIndex();
    hit = index.byTx.get(transactionId) || null;
  }
  if (hit) placed.delete(transactionId);
  return hit || placed.get(transactionId) || null;
}

/** Poll esim/query by orderNo until the profile is allocated, or give up and report it pending. */
async function awaitProfile(orderNo, transactionId, packageCode) {
  const deadline = Date.now() + ALLOCATE_WAIT_MS();
  for (;;) {
    const j = await call('/esim/query', { orderNo, pager: { pageNum: 1, pageSize: 5 } });
    const list = (j.success && j.obj && j.obj.esimList) || [];
    const mine = list.find((e) => e && e.transactionId === transactionId) || list[0];
    if (mine) {
      const rec = toRecord(mine);
      if (!rec.packageCode) rec.packageCode = packageCode;
      index.byTx.set(transactionId, rec);
      return rec;
    }
    // 200010: "SM-DP+ is still allocating profiles for the order". Anything else is a real error.
    if (!j.success && String(j.errorCode) !== '200010') throw new Error('eSIM Access query failed: ' + errorOf(j));
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, ALLOCATE_POLL_MS));
  }
}

module.exports = {
  name: 'esimaccess',

  async find(transactionId) {
    return lookup(transactionId);
  },

  /**
   * Place the order and wait for its profile. The docs say to prefer `slug`; the live endpoint, on
   * 14 Sep 2026, refused an order carrying only a slug with "packageInfoList[0].packageCode: must
   * not be blank" — so both go in, the catalogue's packageCode and its slug. `priceUsd` is sent as
   * price and amount so a catalogue that has moved since esim.json was written is refused by the
   * reseller rather than paid at the new rate.
   */
  async order({ transactionId, packageCode, slug, priceUsd }) {
    const existing = await lookup(transactionId);
    if (existing) return existing;
    if (!packageCode) throw new Error('order needs the catalogue packageCode');

    const body = { transactionId, packageInfoList: [{ packageCode, slug: slug || packageCode, count: 1 }] };
    if (Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0) {
      body.packageInfoList[0].price = toUnits(priceUsd);
      body.amount = toUnits(priceUsd);
    }
    const j = await call('/esim/order', body);
    if (!j.success || !j.obj || !j.obj.orderNo) throw new Error('eSIM Access refused the order: ' + errorOf(j));
    const orderNo = j.obj.orderNo;

    const pendingRecord = {
      transactionId, orderNo, esimTranNo: '', packageCode: slug || packageCode, packageName: '',
      qrCodeUrl: '', shortUrl: '', ac: '', iccid: '', createdAt: new Date().toISOString(),
      smdpStatus: '', esimStatus: '', pending: true,
    };
    placed.set(transactionId, pendingRecord);
    const rec = await awaitProfile(orderNo, transactionId, slug || packageCode);
    return rec || pendingRecord;
  },

  /** Orders since `sinceIso`, newest last. Not part of the redeem interface; scripts/treasury.js
   *  uses it to work out how fast the balance is being spent. */
  async listOrders({ sinceIso } = {}) {
    return pageOrders(sinceIso || SINCE());
  },

  /** The account's balance in dollars. Not part of the redeem interface; scripts/treasury.js uses it. */
  async balanceUsd() {
    const j = await call('/balance/query', {});
    if (!j.success) throw new Error('eSIM Access balance query failed: ' + errorOf(j));
    return Number(j.obj && j.obj.balance) / 10000;
  },

  /** Tests only. */
  _reset() { index = { at: 0, missAt: 0, byTx: new Map() }; placed.clear(); chain = Promise.resolve(); lastAt = 0; },
};
