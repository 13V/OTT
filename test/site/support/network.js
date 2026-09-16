'use strict';
/**
 * The sandbox this runs in cannot reach a Robinhood Chain RPC, and a test that depended on one
 * would be testing the network rather than the page. So `stubNetwork` answers eth_call, eth_chainId
 * and friends locally, which also means a number the page renders is a number this file chose and
 * the assertion can name it.
 *
 * Anything not matched here is aborted rather than allowed through, so a request this file forgot
 * about shows up as a visible failure instead of a thirty-second hang. There is no menu here to
 * stub, and no eth_getLogs scan: this site has neither — OT+T's own pages read the coin's curve
 * directly (site/esim.js, site/status.js) and read everything else from local JSON files that the
 * static test server (support/server.js) already serves as-is.
 */
const RPC_HOSTS = /(robinhood|ordofi|publicnode|127\.0\.0\.1:854)/i;

// eth_call returns are 32-byte words.
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const TRUE = '0x' + word(1);

function stubNetwork(page, opts = {}) {
  const seen = { rpc: 0, blocked: [] };

  // Playwright resolves routes last-registered-first, so the catch-all goes down FIRST and the RPC
  // handler, registered after it, sits on top of it. Everything else off-origin is a request
  // nothing in this suite arranged for.
  page.route('**://**', async (route) => {
    const url = route.request().url();
    // fallback(), not continue(): a same-origin request may have a more specific handler that a
    // test registered before calling stubNetwork, and continue() would send it to the server
    // instead. With no handler left, fallback() performs the request anyway.
    if (url.startsWith('http://127.0.0.1')) { await route.fallback(); return; }
    seen.blocked.push(url);
    await route.abort();
  });

  page.route((url) => RPC_HOSTS.test(url.host + ':' + url.port), async (route) => {
    seen.rpc++;
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* not JSON: fall through */ }
    const answer = (req) => {
      const m = req.method;
      if (m === 'eth_blockNumber') return '0x' + (opts.block || 0x1234567).toString(16);
      if (m === 'eth_chainId') return '0x1237';                 // 4663
      if (m === 'eth_call') {
        const data = ((req.params && req.params[0]) || {}).data || '';
        // `calls` lets a test answer a selector it cares about — the programme and status pages
        // read a handful of view functions off the coin's curve and fee escrow — either as a fixed
        // hex word or as a function of the request. Anything not named gets a true word.
        const chosen = (opts.calls || {})[data.slice(0, 10)];
        if (chosen !== undefined) return typeof chosen === 'function' ? chosen(req) : chosen;
        return TRUE;
      }
      if (m === 'eth_gasPrice') return '0x' + (290000000).toString(16);
      return '0x';
    };
    const one = (req) => ({ jsonrpc: '2.0', id: req.id, result: answer(req) });
    const out = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  return seen;
}

// A 32-byte word for a `calls` answer, so a test can say `hexWord(1000)` rather than pad hex by hand.
const hexWord = (n) => '0x' + word(n);

module.exports = { stubNetwork, hexWord };
