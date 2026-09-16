'use strict';
/**
 * blink — the Lightning wallet the treasury pays eSIMs from.
 *
 * Blink (blink.sv) is a hosted Lightning wallet with a GraphQL API at api.blink.sv, authenticated by
 * a single X-API-KEY header (dashboard.blink.sv issues keys with Read, Receive and Write scopes;
 * paying needs Write). Its public schema was read on 15 Sep 2026 and these are the five operations
 * used, with the fields they are known to have:
 *
 *   me { defaultAccount { wallets { id walletCurrency balance } } }          which wallet, how much
 *   realtimePrice(currency: "USD") { btcSatPrice { base offset } }           public, no key: cents per sat
 *   lnInvoicePaymentSend(input: { walletId, paymentRequest, memo })          pay: SUCCESS | PENDING | ALREADY_PAID | FAILURE
 *   walletById(walletId) { transactionsByPaymentHash(paymentHash) }          did we pay this one already
 *   lnInvoiceCreate(input: { walletId, amount, memo, expiresIn })            an invoice for the funding leg
 *
 * Balances are in sats for a BTC wallet and cents for a USD one. The dollar figure this file
 * reports is sats × the public price, which is what the treasury card shows as the pool.
 */
const URL = () => process.env.BLINK_API_URL || 'https://api.blink.sv/graphql';
const KEY = () => process.env.BLINK_API_KEY || '';
const FETCH_TIMEOUT_MS = 25000; // a Lightning payment can take a few seconds to find its route

async function gql(query, variables, { auth = true } = {}) {
  if (auth && !KEY()) throw new Error('BLINK_API_KEY is not set');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth) headers['X-API-KEY'] = KEY();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(URL(), { method: 'POST', headers, body: JSON.stringify({ query, variables: variables || {} }), signal: ctl.signal });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok) throw new Error('Blink answered HTTP ' + res.status + (j && j.errors && j.errors[0] ? ': ' + j.errors[0].message : ''));
    if (!j) throw new Error('Blink answered with no JSON');
    if (j.errors && j.errors.length) throw new Error('Blink: ' + j.errors[0].message);
    return j.data || {};
  } finally { clearTimeout(timer); }
}

const walletsOf = (d) => ((d.me && d.me.defaultAccount && d.me.defaultAccount.wallets) || []);

let walletCache = { key: '', id: '' };
/** The BTC wallet's id, from the env or the account, remembered per key. */
async function walletId() {
  if (process.env.BLINK_WALLET_ID) return process.env.BLINK_WALLET_ID;
  if (walletCache.id && walletCache.key === KEY()) return walletCache.id;
  const d = await gql('query { me { defaultAccount { wallets { id walletCurrency balance } } } }');
  const btc = walletsOf(d).find((w) => w.walletCurrency === 'BTC');
  if (!btc) throw new Error('the Blink account has no BTC wallet');
  walletCache = { key: KEY(), id: btc.id };
  return btc.id;
}

/** Dollars per sat, from Blink's public price. base / 10^offset is cents per sat. */
async function usdPerSat() {
  const d = await gql('query { realtimePrice(currency: "USD") { btcSatPrice { base offset } } }', {}, { auth: false });
  const p = d.realtimePrice && d.realtimePrice.btcSatPrice;
  if (!p) throw new Error('Blink gave no price');
  return Number(p.base) / Math.pow(10, Number(p.offset)) / 100;
}

module.exports = {
  name: 'blink',
  usdPerSat,

  /** Pay an invoice. Never throws on a refusal: the status and the wallet's own words come back. */
  async pay({ paymentRequest, memo }) {
    const input = { walletId: await walletId(), paymentRequest };
    if (memo) input.memo = String(memo).slice(0, 200);
    const d = await gql('mutation ($input: LnInvoicePaymentInput!) { lnInvoicePaymentSend(input: $input) { status errors { message code } } }', { input });
    const r = d.lnInvoicePaymentSend || {};
    const error = r.errors && r.errors.length ? r.errors.map((e) => e.message).join('; ') : '';
    return { status: r.status || (error ? 'FAILURE' : 'UNKNOWN'), error };
  },

  /** Was this hash paid from our wallet: NONE | PENDING | SUCCESS | FAILURE, best attempt wins. */
  async sent(paymentHash) {
    const d = await gql(
      'query ($walletId: WalletId!, $hash: PaymentHash!) { me { defaultAccount { walletById(walletId: $walletId) { transactionsByPaymentHash(paymentHash: $hash) { status direction settlementAmount settlementFee createdAt } } } } }',
      { walletId: await walletId(), hash: paymentHash });
    const txs = (((d.me || {}).defaultAccount || {}).walletById || {}).transactionsByPaymentHash || [];
    const sends = txs.filter((t) => t.direction === 'SEND');
    if (!sends.length) return { status: 'NONE' };
    const rank = { SUCCESS: 3, PENDING: 2, FAILURE: 1 };
    const best = sends.reduce((m, t) => ((rank[t.status] || 0) > (rank[m.status] || 0) ? t : m));
    return { status: best.status, sats: Math.abs(Number(best.settlementAmount)), feeSats: Math.abs(Number(best.settlementFee) || 0) };
  },

  /** { sats, usd, usdPerSat }: the BTC wallet in sats, plus any USD wallet, in dollars. */
  async balance() {
    const d = await gql('query { me { defaultAccount { wallets { id walletCurrency balance } } } }');
    const wallets = walletsOf(d);
    const btc = wallets.find((w) => w.walletCurrency === 'BTC');
    const usdW = wallets.find((w) => w.walletCurrency === 'USD');
    const sats = btc ? Number(btc.balance) : 0;
    const rate = await usdPerSat();
    const usd = sats * rate + (usdW ? Number(usdW.balance) / 100 : 0);
    return { sats, usd: Math.round(usd * 100) / 100, usdPerSat: rate };
  },

  /** An invoice on our BTC wallet, for the funding leg to pay into. */
  async invoice({ sats, memo, expiresInMinutes = 120 }) {
    const input = { walletId: await walletId(), amount: Math.round(Number(sats)), expiresIn: expiresInMinutes };
    if (memo) input.memo = String(memo).slice(0, 200);
    const d = await gql('mutation ($input: LnInvoiceCreateInput!) { lnInvoiceCreate(input: $input) { invoice { paymentRequest paymentHash } errors { message } } }', { input });
    const r = d.lnInvoiceCreate || {};
    if (!r.invoice || !r.invoice.paymentRequest) throw new Error('Blink would not create an invoice: ' + ((r.errors || []).map((e) => e.message).join('; ') || 'no reason given'));
    return { paymentRequest: r.invoice.paymentRequest, paymentHash: r.invoice.paymentHash };
  },

  /** Has an invoice of ours been paid: PAID | PENDING | EXPIRED. Public query, no key needed. */
  async received(paymentHash) {
    const d = await gql('query ($input: LnInvoicePaymentStatusByHashInput!) { lnInvoicePaymentStatusByHash(input: $input) { status } }', { input: { paymentHash } }, { auth: false });
    return { status: (d.lnInvoicePaymentStatusByHash && d.lnInvoicePaymentStatusByHash.status) || 'UNKNOWN' };
  },

  _reset() { walletCache = { key: '', id: '' }; },
};
