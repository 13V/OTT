'use strict';
/**
 * mock — a Lightning wallet that pays nothing and remembers everything.
 *
 * It decodes the invoice it is handed (so a malformed one fails here the way it would at a real
 * wallet), debits a pretend balance, and answers `sent()` from what it paid. Its behaviour is a
 * knob for tests: success, pending (paid but not yet settled), failure (no route), broke (balance
 * too low) and down (the API is unreachable). Nothing here survives a cold start, which is fine
 * for what it is for.
 */
const bolt11 = require('../bolt11');
const { keccak256Hex } = require('../keccak');

const fresh = () => ({ mode: 'success', paid: new Map(), sats: 1000000, usdPerSat: 0.0008, invoices: [], log: [] });
let state = fresh();
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = {
  name: 'mock',

  async usdPerSat() {
    if (state.mode === 'down') throw new Error('Blink answered HTTP 503');
    return state.usdPerSat;
  },

  async pay({ paymentRequest, memo }) {
    if (state.mode === 'down') throw new Error('Blink answered HTTP 503');
    const inv = bolt11.decode(paymentRequest);
    state.log.push({ paymentHash: inv.paymentHash, sats: inv.sats, memo: memo || '' });
    const already = state.paid.get(inv.paymentHash);
    if (already && already.status === 'SUCCESS') return { status: 'ALREADY_PAID', error: '' };
    if (state.mode === 'broke' || inv.sats > state.sats) return { status: 'FAILURE', error: 'Insufficient balance' };
    if (state.mode === 'failure') return { status: 'FAILURE', error: 'Unable to find a route for payment' };
    if (state.mode === 'pending') { state.paid.set(inv.paymentHash, { status: 'PENDING', sats: inv.sats }); return { status: 'PENDING', error: '' }; }
    state.sats -= inv.sats;
    state.paid.set(inv.paymentHash, { status: 'SUCCESS', sats: inv.sats, feeSats: 0 });
    return { status: 'SUCCESS', error: '' };
  },

  async sent(paymentHash) {
    if (state.mode === 'down') throw new Error('Blink answered HTTP 503');
    return state.paid.get(paymentHash) || { status: 'NONE' };
  },

  async balance() {
    if (state.mode === 'down') throw new Error('Blink answered HTTP 503');
    return { sats: state.sats, usd: round2(state.sats * state.usdPerSat), usdPerSat: state.usdPerSat };
  },

  async invoice({ sats, memo }) {
    const paymentHash = keccak256Hex('mock-invoice:' + state.invoices.length + ':' + sats).slice(2);
    const paymentRequest = bolt11.encode({ sats: Math.round(sats), paymentHash, timestamp: Math.floor(Date.now() / 1000), description: memo || '' });
    state.invoices.push({ paymentRequest, paymentHash, sats, memo: memo || '', status: 'PENDING' });
    return { paymentRequest, paymentHash };
  },

  async received(paymentHash) {
    const inv = state.invoices.find((i) => i.paymentHash === paymentHash);
    return { status: inv ? inv.status : 'EXPIRED' };
  },

  /** Tests: settle a pending payment, mark an invoice paid, change the mode, read the log. */
  _settle(paymentHash) { const p = state.paid.get(paymentHash); if (p) { p.status = 'SUCCESS'; state.sats -= p.sats; } },
  _markPaid(paymentHash) { const inv = state.invoices.find((i) => i.paymentHash === paymentHash); if (inv) { inv.status = 'PAID'; state.sats += inv.sats; } },
  get _state() { return state; },
  _reset() { state = fresh(); },
};
