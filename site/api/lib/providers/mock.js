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

  async order({ transactionId, packageCode, slug }) { // priceUsd is accepted and ignored: nothing here costs anything
    packageCode = slug || packageCode; // recorded the way the real reseller shows it: by slug
    // A second order() for the same id must not mint a second profile, even though the API only
    // calls order() after find() came back empty: the same guarantee a real reseller gives.
    if (orders.has(transactionId)) return orders.get(transactionId);
    // A plausible-looking ICCID (89 = telecom, then 17 digits) derived from the id so it is stable.
    const digits = BigInt('0x' + keccak256(transactionId).toString('hex')).toString().slice(0, 17);
    const order = {
      transactionId,
      packageCode,
      qrCodeUrl: fakeQr(transactionId),
      ac: 'LPA:1$mock.invalid$' + transactionId,
      iccid: '89' + digits.padStart(17, '0'),
      // ISO 8601, like the real reseller's createTime: the page does `new Date(createdAt)` on it,
      // and a unix-seconds value there renders as January 1970.
      createdAt: new Date().toISOString(),
      pending: false,
    };
    orders.set(transactionId, order);
    return order;
  },

  /** Every order this instance remembers. Mirrors the real provider's listOrders for scripts/treasury.js. */
  async listOrders() { return Array.from(orders.values()); },
  async balanceUsd() { return 0; },

  /** Tests only: forget everything, as a cold start would. */
  _reset() { orders.clear(); },
};
