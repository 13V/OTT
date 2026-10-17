'use strict';
/**
 * The sandbox this runs in cannot rely on reaching Solana, and a test that depended on it would be
 * testing the network rather than the page. So `stubNetwork` answers the Solana JSON-RPC calls the
 * site makes locally (a recent blockhash, the coin's supply, a token balance, an account, recent
 * signatures, a transaction, signature statuses), which also means a number the page renders is a
 * number this file chose and the assertion can name it.
 *
 * Anything not matched here is aborted rather than allowed through, so a request this file forgot
 * about shows up as a visible failure instead of a thirty-second hang.
 *
 *   stubNetwork(page, {
 *     balance: '2000000000000',            // getTokenAccountBalance amount (null: no such account)
 *     supply: '1000000000000000',          // getTokenSupply amount, 6 decimals
 *     accounts: { [address]: { owner, data: [base64, 'base64'], lamports } },  // getAccountInfo
 *     signatures: { [address]: [{ signature, slot, blockTime, err }] },        // getSignaturesForAddress
 *     transactions: { [signature]: tx },   // getTransaction
 *     statuses: { [signature]: { confirmationStatus, err } | null } | (signature) => status | null,
 *     methods: { name: value | (request) => value },   // anything else, or an override
 *   })
 */
const RPC_HOSTS = /(publicnode|mainnet-beta\.solana|127\.0\.0\.1:899)/i;
// A fixed recent blockhash: 32 bytes of base58.
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

function stubNetwork(page, opts = {}) {
  // `requests` keeps each call's method and params, so a spec can say what was asked as well as what was answered.
  const seen = { rpc: 0, methods: [], requests: [], blocked: [] };

  // Playwright resolves routes last-registered-first, so the catch-all goes down FIRST and the RPC
  // handler, registered after it, sits on top of it.
  page.route('**://**', async (route) => {
    const url = route.request().url();
    // fallback(), not continue(): a same-origin request may have a more specific handler that a
    // test registered before calling stubNetwork.
    if (url.startsWith('http://127.0.0.1')) { await route.fallback(); return; }
    seen.blocked.push(url);
    await route.abort();
  });

  page.route((url) => RPC_HOSTS.test(url.host + ':' + url.port), async (route) => {
    seen.rpc++;
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* not JSON */ }
    const answer = (req) => {
      const m = req.method;
      const params = req.params || [];
      seen.methods.push(m);
      seen.requests.push({ method: m, params });
      const custom = (opts.methods || {})[m];
      if (custom !== undefined) return typeof custom === 'function' ? custom(req) : custom;
      if (m === 'getLatestBlockhash') return { context: { slot: 400000000 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 380000150 } };
      if (m === 'getTokenSupply') return { context: { slot: 400000000 }, value: { amount: opts.supply || '1000000000000000', decimals: 6, uiAmountString: '1000000000' } };
      if (m === 'getTokenAccountBalance') {
        if (opts.balance === null || opts.balance === undefined) return { error: { code: -32602, message: 'Invalid param: could not find account' } };
        return { context: { slot: 400000000 }, value: { amount: String(opts.balance), decimals: 6, uiAmountString: String(Number(opts.balance) / 1e6) } };
      }
      if (m === 'getAccountInfo') return { context: { slot: 400000000 }, value: (opts.accounts || {})[params[0]] || null };
      if (m === 'getSignaturesForAddress') return (opts.signatures || {})[params[0]] || [];
      if (m === 'getTransaction') return (opts.transactions || {})[params[0]] || null;
      if (m === 'getSignatureStatuses') {
        // A function or a listed signature answers exactly what it says, null (not landed) included;
        // any other signature is confirmed.
        const st = opts.statuses;
        const confirmed = { confirmationStatus: 'confirmed', err: null, slot: 400000001, confirmations: 1 };
        const statusOf = (sig) => {
          if (typeof st === 'function') return st(sig);
          if (st && Object.prototype.hasOwnProperty.call(st, sig)) return st[sig];
          return confirmed;
        };
        return { context: { slot: 400000000 }, value: (params[0] || []).map((sig) => statusOf(sig) || null) };
      }
      return null;
    };
    const one = (req) => {
      const result = answer(req);
      return result && typeof result === 'object' && result.error ? { jsonrpc: '2.0', id: req.id, error: result.error } : { jsonrpc: '2.0', id: req.id, result };
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  // Deployment settings can point at a remote API. A fixture must choose its own backend instead
  // of inheriting the checkout's; specs testing a remote API register their config after this.
  page.route('**/config/app.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ apiBaseUrl: '' }),
  }));

  return seen;
}

module.exports = { stubNetwork, BLOCKHASH };
