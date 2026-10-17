'use strict';
/**
 * rpc — the few chain reads the API makes: a welcome claim's burn receipt, and the coin's
 * decimals before the weekly ledger knows them. Endpoints come from config/addresses.json, which
 * site/vercel.json bundles with the function, or from CHAIN_RPC_URLS (comma-separated) for tests
 * and other hosts. Each endpoint is tried in turn.
 *
 * A null result is an answer for eth_getTransactionReceipt (a transaction not mined yet), but a
 * lagging endpoint gives the same null for one that is. So a null is only believed once every
 * endpoint has said it.
 */
const fs = require('fs');
const path = require('path');

const ADDRESSES_PATH = path.join(__dirname, '..', '..', 'config', 'addresses.json');
const TIMEOUT_MS = 5000;
// The public endpoint rejects script user agents; scripts/chain.js sends the same string.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function endpoints() {
  const fromEnv = String(process.env.CHAIN_RPC_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const addresses = JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
    const list = Array.isArray(addresses.rpcs) && addresses.rpcs.length ? addresses.rpcs : [addresses.rpc];
    return list.filter((url) => typeof url === 'string' && /^https:\/\//i.test(url));
  } catch (e) { return []; }
}

function unavailable() {
  const error = new Error('the chain could not be read just now; try again in a moment');
  error.status = 503;
  return error;
}

async function call(method, params) {
  const urls = endpoints();
  if (!urls.length) throw unavailable();
  let answered = false;
  for (const url of urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctl.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': BROWSER_UA },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await res.json();
      if (!res.ok || !body || body.error) continue;
      answered = true;
      if (body.result !== null && body.result !== undefined) return body.result;
    } catch (e) { /* the next endpoint */ } finally { clearTimeout(timer); }
  }
  if (answered) return null;
  throw unavailable();
}

/** token.decimals(), from the chain. */
async function decimalsOf(token) {
  const raw = await call('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  const value = typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) ? Number(BigInt(raw)) : NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > 36) throw unavailable();
  return value;
}

module.exports = { call, decimalsOf, endpoints };
