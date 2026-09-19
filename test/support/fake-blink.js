'use strict';
/**
 * fake-blink — a fake of api.blink.sv's GraphQL endpoint for driving the REAL site/api/lib/payers/
 * blink.js against something, fake or real, for the first time.
 *
 * One POST /graphql, exactly like the real API: every request is told apart by which operation its
 * query text names, not by a separate route. The six shapes below were checked directly against
 * the live, public schema at api.blink.sv on 16 Sep 2026 (introspection, plus a couple of live
 * unauthenticated calls) rather than trusted from blink.js's own 15 Sep 2026 comment — which had
 * in fact drifted from it in exactly one place: `lnInvoicePaymentStatusByHash` answers a payment
 * hash it does not recognise with a GraphQL `errors` array alongside HTTP 200 ("InvoiceNotFoundError"),
 * never a graceful null, because the field the schema gives it is non-nullable. blink.js's
 * received() did not expect that and threw; it has been fixed to treat it as UNKNOWN, and this
 * fake's default for an unlisted hash reproduces the real error text so a regression fails loudly.
 *
 *   - "wallets {"                     (no walletById in the same query) -> me.defaultAccount.wallets
 *                                       (walletId(), balance())
 *   - "realtimePrice"                                                   -> realtimePrice.btcSatPrice
 *                                       (usdPerSat())
 *   - "lnInvoicePaymentSend"                                            -> pay()
 *   - "transactionsByPaymentHash"                                       -> sent()
 *   - "lnInvoiceCreate"                                                 -> invoice()
 *   - "lnInvoicePaymentStatusByHash"                                    -> received()
 *
 * Auth: every operation but realtimePrice and lnInvoicePaymentStatusByHash needs X-API-KEY to equal
 * state.apiKey, exactly blink.js's own `auth: false` list — a missing or wrong key answers the way
 * an unauthenticated `me` query was observed to live: HTTP 200, the field null, one GraphQL error
 * ("Not authorized"), never an HTTP 401. (An API key that is merely malformed, rather than merely
 * wrong, is rejected further out, by Blink's own gateway, as a raw non-JSON HTTP 401 — state.forceHttp
 * below is how a test stands that up instead.)
 *
 *   const fakeBlink = require('./support/fake-blink');
 *   const fake = await fakeBlink.start();
 *   process.env.BLINK_API_URL = fake.base + '/graphql';
 *   process.env.BLINK_API_KEY = fake.apiKey;
 *   // fake.state: apiKey, wallets ([{id, walletCurrency, balance}]), price ({base, offset}),
 *   //   priceMissing, payHandler(input) -> {status, errors}, invoiceHandler(input) -> {invoice,
 *   //   errors}, transactions (Map<hash, tx[]>), invoiceStatus (Map<hash, 'PAID'|'PENDING'|
 *   //   'EXPIRED'>), log (every request seen so far: {op, query, variables, headers}).
 *   // fake.calls(op): how many requests named this operation landed so far.
 *   // fake.addSend(hash, {status, settlementAmount, settlementFee, direction, createdAt}): push
 *   //   one transaction onto that hash's list (call again for more than one on the same hash).
 *   // fake.state.forceHttp = { status, body, contentType }: the NEXT request, whichever operation,
 *   //   answers this raw HTTP response instead — consumed once, then back to normal.
 *   // fake.state.forceBody = 'raw text': the NEXT request answers HTTP 200 with exactly this body
 *   //   (not run through JSON.stringify) — consumed once. For a body that will not parse as JSON,
 *   //   or valid JSON in a shape blink.js does not expect.
 *   await fake.close();
 */
const http = require('http');
const crypto = require('crypto');

const DEFAULT_KEY = 'fake-blink-key-937zx-do-not-leak';

function start() {
  const state = {
    apiKey: DEFAULT_KEY,
    wallets: [
      { id: 'wallet-btc-0001', walletCurrency: 'BTC', balance: 1000000 },
      { id: 'wallet-usd-0001', walletCurrency: 'USD', balance: 5000 }, // cents
    ],
    price: { base: 8, offset: 2 },              // 8 / 10^2 / 100 = $0.0008 per sat
    priceMissing: false,
    payHandler: () => ({ status: 'SUCCESS', errors: [] }),
    invoiceHandler: () => ({
      invoice: { paymentRequest: 'lnfake1' + crypto.randomBytes(16).toString('hex'), paymentHash: crypto.randomBytes(32).toString('hex') },
      errors: [],
    }),
    transactions: new Map(),   // paymentHash -> [{status, direction, settlementAmount, settlementFee, createdAt}]
    invoiceStatus: new Map(),  // paymentHash -> 'PAID' | 'PENDING' | 'EXPIRED'
    forceHttp: null,           // one-shot: { status, body, contentType }
    forceBody: null,           // one-shot: raw response text
    log: [],
  };

  // Which operations need X-API-KEY, and — for the ones that do — whether an unresolved field
  // nulls out just itself (the field is nullable, like `me`) or the whole `data` (the field is
  // non-null, the way GraphQL null-propagation was observed to behave for lnInvoicePaymentStatusByHash).
  const AUTH_REQUIRED = { wallets: true, price: false, pay: true, sent: true, invoice: true, received: false };
  const NULLABLE_ROOT = { wallets: 'me', sent: 'me' };

  function opOf(query) {
    if (query.indexOf('realtimePrice') !== -1) return 'price';
    if (query.indexOf('lnInvoicePaymentSend') !== -1) return 'pay';
    if (query.indexOf('transactionsByPaymentHash') !== -1) return 'sent';
    if (query.indexOf('lnInvoiceCreate') !== -1) return 'invoice';
    if (query.indexOf('lnInvoicePaymentStatusByHash') !== -1) return 'received';
    if (query.indexOf('wallets {') !== -1) return 'wallets';
    return '';
  }

  function notAuthorized(op) {
    const root = NULLABLE_ROOT[op];
    return {
      data: root ? { [root]: null } : null,
      errors: [{ message: 'Not authorized', locations: [{ line: 1, column: 2 }], path: [root || op] }],
    };
  }

  // Observed live for a payment hash api.blink.sv has never heard of — see the file header.
  function invoiceNotFound(hash) {
    return {
      data: null,
      errors: [{
        message: 'Unexpected error occurred, please try again or contact support if it persists (code: InvoiceNotFoundError: {"paymentHash":"' + hash + '"})',
        locations: [{ line: 1, column: 1 }], path: ['lnInvoicePaymentStatusByHash'],
      }],
    };
  }

  function handle(op, body, headers) {
    const vars = body.variables || {};
    const input = vars.input || {};
    const authed = headers['x-api-key'] === state.apiKey;
    if (AUTH_REQUIRED[op] && !authed) return notAuthorized(op);

    if (op === 'price') {
      return state.priceMissing
        ? { data: { realtimePrice: null } }
        : { data: { realtimePrice: { btcSatPrice: { base: state.price.base, offset: state.price.offset } } } };
    }
    if (op === 'wallets') return { data: { me: { defaultAccount: { wallets: state.wallets } } } };
    if (op === 'pay') {
      const r = state.payHandler(input) || {};
      return { data: { lnInvoicePaymentSend: { status: r.status === undefined ? null : r.status, errors: r.errors || [] } } };
    }
    if (op === 'sent') {
      const txs = state.transactions.get(vars.hash) || [];
      return { data: { me: { defaultAccount: { walletById: { transactionsByPaymentHash: txs } } } } };
    }
    if (op === 'invoice') {
      const r = state.invoiceHandler(input) || {};
      return { data: { lnInvoiceCreate: { invoice: r.invoice || null, errors: r.errors || [] } } };
    }
    if (op === 'received') {
      const status = state.invoiceStatus.get(input.paymentHash);
      return status ? { data: { lnInvoicePaymentStatusByHash: { status } } } : invoiceNotFound(input.paymentHash);
    }
    return { errors: [{ message: 'fake-blink: unrecognised operation for query: ' + body.query.slice(0, 80) }] };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
      const query = String(body.query || '');
      const op = opOf(query);
      const headers = {};
      for (const k of Object.keys(req.headers)) headers[k.toLowerCase()] = req.headers[k];
      state.log.push({ op, query, variables: body.variables, headers });

      if (state.forceHttp) {
        const f = state.forceHttp; state.forceHttp = null;
        res.writeHead(f.status, { 'content-type': f.contentType || 'text/plain' });
        return res.end(f.body === undefined ? '' : f.body);
      }
      if (state.forceBody !== null) {
        const b = state.forceBody; state.forceBody = null;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(b);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handle(op, body, headers)));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: 'http://127.0.0.1:' + server.address().port,
        apiKey: DEFAULT_KEY,
        state,
        calls: (op) => state.log.filter((l) => l.op === op).length,
        addSend(hash, tx) {
          const list = state.transactions.get(hash) || [];
          list.push(Object.assign({ direction: 'SEND', createdAt: Math.floor(Date.now() / 1000), settlementFee: 0 }, tx));
          state.transactions.set(hash, list);
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start };
