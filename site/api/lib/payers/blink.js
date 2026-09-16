'use strict';
/**
 * blink — the Lightning wallet the treasury pays eSIMs from.
 *
 * Blink (blink.sv) is a hosted Lightning wallet with a GraphQL API at api.blink.sv, authenticated by
 * a single X-API-KEY header (dashboard.blink.sv issues keys with Read, Receive and Write scopes;
 * paying needs Write). Its public schema was read on 15 Sep 2026 and these are the six operations
 * used, with the fields they are known to have:
 *
 *   me { defaultAccount { wallets { id walletCurrency balance } } }          which wallet, how much
 *   realtimePrice(currency: "USD") { btcSatPrice { base offset } }           public, no key: cents per sat
 *   lnInvoicePaymentSend(input: { walletId, paymentRequest, memo })          pay: SUCCESS | PENDING | ALREADY_PAID | FAILURE
 *   walletById(walletId) { transactionsByPaymentHash(paymentHash) }          did we pay this one already
 *   lnInvoiceCreate(input: { walletId, amount, memo, expiresIn })            an invoice for the funding leg
 *   lnInvoicePaymentStatusByHash(input: { paymentHash })                    did OUR invoice get paid: public, no key
 *
 * Balances are in sats for a BTC wallet and cents for a USD one. The dollar figure this file
 * reports is sats × the public price, which is what the treasury card shows as the pool.
 *
 * Re-checked directly against api.blink.sv's live introspection on 16 Sep 2026, for an audit that
 * found this file had never run against anything, fake or real (see test/blink.test.js and
 * test/support/fake-blink.js). Everything above still matches — except received(), below: a
 * payment hash Blink does not recognise answers lnInvoicePaymentStatusByHash with a GraphQL
 * `errors` array alongside HTTP 200 ("InvoiceNotFoundError"), never the graceful null this file
 * assumed (the field is non-nullable, so an unresolved value fails the whole query rather than
 * coming back empty). That made received() throw instead of answering a status the way PAID,
 * PENDING and EXPIRED already do below — fixed to treat it the same as those three, UNKNOWN.
 */
const URL = () => process.env.BLINK_API_URL || 'https://api.blink.sv/graphql';
const KEY = () => process.env.BLINK_API_KEY || '';
// a Lightning payment can take a few seconds to find its route; env-overridable, the same pattern
// as URL()/KEY() above, so a test can shrink it rather than wait out a production-sized timeout.
const FETCH_TIMEOUT_MS = () => Number(process.env.BLINK_FETCH_TIMEOUT_MS) || 25000;

async function gql(query, variables, { auth = true } = {}) {
  if (auth && !KEY()) throw new Error('BLINK_API_KEY is not set');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth) headers['X-API-KEY'] = KEY();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS());
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

  /**
   * Has an invoice of ours been paid: PAID | PENDING | EXPIRED, or UNKNOWN when Blink cannot say —
   * including a hash it does not recognise, which answers as a GraphQL error rather than a status
   * (see the file header). Never throws: its one caller (scripts/fund.js) already treats "could
   * not tell" as UNKNOWN, so answering that directly is the more honest shape. Public, no key needed.
   */
  async received(paymentHash) {
    let d;
    try {
      d = await gql('query ($input: LnInvoicePaymentStatusByHashInput!) { lnInvoicePaymentStatusByHash(input: $input) { status } }', { input: { paymentHash } }, { auth: false });
    } catch (e) {
      return { status: 'UNKNOWN' };
    }
    return { status: (d.lnInvoicePaymentStatusByHash && d.lnInvoicePaymentStatusByHash.status) || 'UNKNOWN' };
  },

  _reset() { walletCache = { key: '', id: '' }; },
};
