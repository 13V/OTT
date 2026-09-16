'use strict';
/**
 * mock — the eSIM provider that exists so the redeem flow can be exercised without an account.
 *
 * It honours the one property the API leans on: find(transactionId) returns what order() created
 * under that id, so the API's "ask the provider how many times this wallet has redeemed" loop
 * works exactly as it does against a real reseller. What it cannot honour is durability. The
 * ledger is a Map in the function's memory, so it forgets on every cold start — on Vercel that is
 * every few minutes of idleness, and every deploy. With ESIM_PROVIDER=mock a wallet's redeemed
 * count therefore resets to zero whenever the function is reloaded, which is fine for a demo and
 * for tests and is the reason it is never the provider in production.
 */
const { keccak256 } = require('../keccak');

const orders = new Map();
// address -> { primary, bySlug, cards } — the same one-eSIM-per-wallet index the real
// provider keeps, so the demo and the tests show the same shape the live site does.
const sims = new Map();

/** A placeholder "QR" the route can drop into an <img> with no network: an inline SVG data URI. */
function fakeQr(transactionId) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">' +
    '<rect width="200" height="200" fill="#fff"/>' +
    '<rect x="20" y="20" width="50" height="50" fill="#000"/><rect x="130" y="20" width="50" height="50" fill="#000"/>' +
    '<rect x="20" y="130" width="50" height="50" fill="#000"/>' +
    '<text x="100" y="105" font-family="monospace" font-size="10" text-anchor="middle" fill="#000">mock ' +
    transactionId.slice(0, 11) + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

module.exports = {
  name: 'mock',

  async find(transactionId) {
    return orders.get(transactionId) || null;
  },

  async order({ transactionId, packageCode, slug, address }) { // priceUsd is accepted and ignored: nothing here costs anything
    const place = slug || packageCode;
    packageCode = place; // recorded the way the real reseller shows it: by slug
    // A second order() for the same id must not mint a second profile, even though the API only
    // calls order() after find() came back empty: the same guarantee a real reseller gives.
    if (orders.has(transactionId)) return orders.get(transactionId);
    const wallet = String(address || '').toLowerCase();
    const sim = wallet ? sims.get(wallet) : null;
    // Per place, not per wallet-at-large: bundles queue consecutively, so a bundle for somewhere
    // else would sit unreachable behind this one. Mirrors simFor() in the real provider.
    const topupOf = sim ? String(sim.bySlug[place] || '') : '';
    const order = {
      transactionId,
      packageCode,
      topupOf,
      toppedUp: !!topupOf,
      // ISO 8601, like the real reseller's createTime: the page does `new Date(createdAt)` on it,
      // and a unix-seconds value there renders as January 1970.
      createdAt: new Date().toISOString(),
      pending: false,
    };
    if (topupOf) {
      // A bundle queued on a profile already installed: nothing new to scan, so no code.
      order.iccid = topupOf;
      order.qrCodeUrl = '';
      order.ac = '';
    } else {
      // A plausible-looking ICCID (89 = telecom, then 17 digits) derived from the id so it is stable.
      const digits = BigInt('0x' + keccak256(transactionId).toString('hex')).toString().slice(0, 17);
      order.iccid = '89' + digits.padStart(17, '0');
      order.qrCodeUrl = fakeQr(transactionId);
      order.ac = 'LPA:1$mock.invalid$' + transactionId;
      if (wallet) {
        const card = { iccid: order.iccid, slug: place, ac: order.ac, qrCodeUrl: order.qrCodeUrl, createdAt: order.createdAt };
        const rec = sim || { primary: order.iccid, bySlug: {}, cards: {} };
        if (!rec.primary) rec.primary = order.iccid;
        if (!rec.bySlug[place]) rec.bySlug[place] = order.iccid;
        if (!rec.cards[order.iccid]) rec.cards[order.iccid] = card;
        sims.set(wallet, rec);
      }
    }
    orders.set(transactionId, order);
    return order;
  },

  /** The eSIMs this wallet holds, newest first. Mirrors the real provider's sims(). */
  async sims(address) {
    const rec = sims.get(String(address || '').toLowerCase());
    if (!rec) return [];
    return Object.keys(rec.cards).map((k) => rec.cards[k])
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  },

  /** Every order this instance remembers. Mirrors the real provider's listOrders for scripts/treasury.js. */
  async listOrders() { return Array.from(orders.values()); },
  async balanceUsd() { return 0; },

  /** Tests only: forget everything, as a cold start would. */
  _reset() { orders.clear(); sims.clear(); },
};
