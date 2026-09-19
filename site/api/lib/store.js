'use strict';
/**
 * store — the one piece of state the wholesale provider needs, and the only database this site has.
 *
 * The eSIM Access provider needed none: its own order history could be paged and matched by
 * transactionId, so the reseller was the ledger. wholesale has no listing endpoint and no account —
 * an order is a Lightning invoice, a payment, and a completion call, and nothing on their side
 * says which wallet any of it belonged to. So the redeem function keeps that record itself, in a
 * Redis it reaches over HTTPS (Upstash, which Vercel's marketplace provisions and configures with
 * the KV_REST_API_URL / KV_REST_API_TOKEN pair this file reads). Four commands are all it needs:
 * GET, SET (with NX, which is what makes a transactionId claimable exactly once across function
 * instances), ZADD and ZRANGEBYSCORE for a recent-orders index the treasury monitor reads.
 *
 * The in-memory store behind STORE=memory is for tests and for a keyless deploy with the mock
 * provider. It forgets on every cold start, which is why the wholesale provider will not run on it
 * unless told to in so many words: a paid order that is forgotten is money gone and no eSIM.
 */
const FETCH_TIMEOUT_MS = 5000;
const PREFIX = () => process.env.STORE_PREFIX || 'wf:';

function memoryStore() {
  const kv = new Map();
  const zs = new Map();
  return {
    name: 'memory',
    async get(key) { const v = kv.get(key); return v === undefined ? null : JSON.parse(v); },
    async set(key, value, { nx = false } = {}) {
      if (nx && kv.has(key)) return false;
      kv.set(key, JSON.stringify(value));
      return true;
    },
    async del(key) { kv.delete(key); },
    async zadd(set, score, member) {
      if (!zs.has(set)) zs.set(set, new Map());
      zs.get(set).set(member, Number(score));
    },
    async zrange(set, min, max, { limit = 1000 } = {}) {
      const z = zs.get(set);
      if (!z) return [];
      return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
    },
    _reset() { kv.clear(); zs.clear(); },
  };
}

/** Upstash's REST shape: POST the command as a JSON array, read { result } or { error }. */
function restStore({ url, token }) {
  const base = String(url).replace(/\/$/, '');
  async function cmd(args) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal,
      });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok) throw new Error('store answered HTTP ' + res.status + (j && j.error ? ': ' + j.error : ''));
      if (!j || j.error) throw new Error('store error: ' + ((j && j.error) || 'no body'));
      return j.result;
    } finally { clearTimeout(timer); }
  }
  return {
    name: 'upstash',
    url: base,
    async get(key) { const v = await cmd(['GET', key]); return v === null || v === undefined ? null : JSON.parse(v); },
    async set(key, value, { nx = false } = {}) {
      const args = ['SET', key, JSON.stringify(value)];
      if (nx) args.push('NX');
      return (await cmd(args)) === 'OK';
    },
    async del(key) { await cmd(['DEL', key]); },
    async zadd(set, score, member) { await cmd(['ZADD', set, String(score), member]); },
    async zrange(set, min, max, { limit = 1000 } = {}) {
      return (await cmd(['ZRANGEBYSCORE', set, String(min), String(max), 'LIMIT', '0', String(limit)])) || [];
    },
  };
}

/** Every key under one prefix, so a staging deploy and production can share a database without sharing orders. */
function prefixed(inner) {
  const p = (k) => PREFIX() + k;
  return {
    name: inner.name,
    url: inner.url,
    get: (k) => inner.get(p(k)),
    set: (k, v, o) => inner.set(p(k), v, o),
    del: (k) => inner.del(p(k)),
    zadd: (s, score, m) => inner.zadd(p(s), score, m),
    zrange: (s, min, max, o) => inner.zrange(p(s), min, max, o),
    _reset: () => (inner._reset ? inner._reset() : undefined),
  };
}

let cached = null;

/**
 * The configured store. Read per call so a test can switch it; cached per URL so a warm function
 * does not rebuild it per request. STORE_URL/STORE_TOKEN win, then the names Vercel's Upstash
 * integration sets, then Upstash's own. No credentials and no STORE=memory is an error with the
 * fix in it.
 */
function store() {
  const kind = String(process.env.STORE || '').toLowerCase();
  if (kind === 'memory') {
    if (!cached || cached.name !== 'memory') cached = prefixed(memoryStore());
    return cached;
  }
  const url = process.env.STORE_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.STORE_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) throw new Error('no store configured: set KV_REST_API_URL and KV_REST_API_TOKEN (Upstash Redis), or STORE=memory for a demo');
  if (!cached || cached.name !== 'upstash' || cached.url !== String(url).replace(/\/$/, '')) cached = prefixed(restStore({ url, token }));
  return cached;
}

module.exports = { store, memoryStore, restStore };
