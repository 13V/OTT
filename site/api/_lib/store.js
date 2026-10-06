'use strict';
/**
 * store — the one piece of state the wholesale provider needs, and the only database this site has.
 *
 * The eSIM Access provider needed none: its own order history could be paged and matched by
 * transactionId, so the reseller was the ledger. wholesale has no listing endpoint and no account —
 * an order is a Lightning invoice, a payment, and a completion call, and nothing on their side
 * says which wallet any of it belonged to. So the redeem function keeps that record itself, in a
 * Redis it reaches over HTTPS (Upstash, which Vercel's marketplace provisions and configures with
 * the KV_REST_API_URL / KV_REST_API_TOKEN pair this file reads). The ordinary commands it needs are
 * GET, SET (with NX, which is what makes a transactionId claimable exactly once across function
 * instances), DEL, ZADD and ZRANGEBYSCORE for a recent-orders index the treasury monitor reads.
 * EVAL provides atomic comparisons when advancing an order or taking over/releasing a lease.
 *
 * The in-memory store behind STORE=memory is for tests and for a keyless deploy with the mock
 * provider. It forgets on every cold start, which is why the wholesale provider will not run on it
 * unless told to in so many words: a paid order that is forgotten is money gone and no eSIM.
 */
const FETCH_TIMEOUT_MS = 5000;
const { isProduction } = require('./request-origin');
const PREFIX = () => process.env.STORE_PREFIX || 'wf:';
// Compare and mutate in one Redis operation. A separate GET followed by SET/DEL
// can overwrite a newer order or release another caller's payment lease.
const COMPARE_SET = `local current = redis.call('GET', KEYS[1])
if (ARGV[1] == 'missing' and not current) or (ARGV[1] == 'value' and current == ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[3]); return 1
end
return 0`;
const COMPARE_DEL = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
// Compare the entire batch before changing any key. Check-only entries keep session TTLs intact;
// replacements preserve existing TTLs, while new persistent link indexes have no expiry.
const COMPARE_MUTATE = `for i = 1, #KEYS do
  local at = (i - 1) * 4
  local current = redis.call('GET', KEYS[i])
  if ARGV[at + 1] == 'missing' then
    if current then return 0 end
  elseif current ~= ARGV[at + 2] then return 0 end
end
for i = 1, #KEYS do
  local at = (i - 1) * 4
  if ARGV[at + 3] == 'delete' then redis.call('DEL', KEYS[i])
  elseif ARGV[at + 3] == 'set' then redis.call('SET', KEYS[i], ARGV[at + 4], 'KEEPTTL') end
end
return 1`;

function mutationEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 16) throw new Error('invalid store mutation batch');
  const keys = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.key !== 'string' || !entry.key || keys.has(entry.key)
      || entry.expected === undefined) throw new Error('invalid store mutation entry');
    keys.add(entry.key);
    const expected = entry.expected === null ? null : JSON.stringify(entry.expected);
    const action = !Object.hasOwn(entry, 'value') ? 'check' : entry.value === null ? 'delete' : 'set';
    const value = action === 'set' ? JSON.stringify(entry.value) : '';
    if (expected === undefined || value === undefined) throw new Error('invalid store mutation value');
    return { key: entry.key, expected, action, value };
  });
}

function ttlSeconds(ex) {
  if (ex !== undefined && (!Number.isSafeInteger(ex) || ex < 1)) throw new Error('store TTL must be positive whole seconds');
  return ex;
}

function memoryStore() {
  const kv = new Map();
  const zs = new Map();
  const expiry = new Map();
  const expire = key => {
    if (expiry.has(key) && Date.now() >= expiry.get(key)) { kv.delete(key); expiry.delete(key); }
  };
  return {
    name: 'memory',
    async get(key) { expire(key); const v = kv.get(key); return v === undefined ? null : JSON.parse(v); },
    async set(key, value, { nx = false, ex } = {}) {
      ttlSeconds(ex);
      expire(key);
      if (nx && kv.has(key)) return false;
      kv.set(key, JSON.stringify(value));
      if (ex === undefined) expiry.delete(key); else expiry.set(key, Date.now() + ex * 1000);
      return true;
    },
    async del(key) { kv.delete(key); expiry.delete(key); },
    async compareSet(key, expected, value) {
      expire(key);
      if (expected === null ? kv.has(key) : kv.get(key) !== JSON.stringify(expected)) return false;
      kv.set(key, JSON.stringify(value));
      expiry.delete(key);
      return true;
    },
    async compareDel(key, expected) {
      expire(key);
      if (kv.get(key) !== JSON.stringify(expected)) return false;
      expiry.delete(key);
      return kv.delete(key);
    },
    async compareMutate(entries) {
      const batch = mutationEntries(entries);
      for (const entry of batch) {
        expire(entry.key);
        if (entry.expected === null ? kv.has(entry.key) : kv.get(entry.key) !== entry.expected) return false;
      }
      for (const entry of batch) {
        if (entry.action === 'delete') { kv.delete(entry.key); expiry.delete(entry.key); }
        else if (entry.action === 'set') kv.set(entry.key, entry.value);
      }
      return true;
    },
    async zadd(set, score, member) {
      if (!zs.has(set)) zs.set(set, new Map());
      zs.get(set).set(member, Number(score));
    },
    async zrange(set, min, max, { limit = 1000 } = {}) {
      const z = zs.get(set);
      if (!z) return [];
      return [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
    },
    _reset() { kv.clear(); zs.clear(); expiry.clear(); },
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
    async set(key, value, { nx = false, ex } = {}) {
      ttlSeconds(ex);
      const args = ['SET', key, JSON.stringify(value)];
      if (nx) args.push('NX');
      if (ex !== undefined) args.push('EX', String(ex));
      return (await cmd(args)) === 'OK';
    },
    async del(key) { await cmd(['DEL', key]); },
    async compareSet(key, expected, value) {
      return Number(await cmd(['EVAL', COMPARE_SET, '1', key, expected === null ? 'missing' : 'value',
        expected === null ? '' : JSON.stringify(expected), JSON.stringify(value)])) === 1;
    },
    async compareDel(key, expected) {
      return Number(await cmd(['EVAL', COMPARE_DEL, '1', key, JSON.stringify(expected)])) === 1;
    },
    async compareMutate(entries) {
      const batch = mutationEntries(entries);
      const args = batch.flatMap(entry => [entry.expected === null ? 'missing' : 'value', entry.expected || '', entry.action, entry.value]);
      return Number(await cmd(['EVAL', COMPARE_MUTATE, String(batch.length), ...batch.map(entry => entry.key), ...args])) === 1;
    },
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
    compareSet: (k, expected, v) => inner.compareSet(p(k), expected, v),
    compareDel: (k, expected) => inner.compareDel(p(k), expected),
    compareMutate: entries => inner.compareMutate(entries.map(entry => ({ ...entry, key: p(entry.key) }))),
    zadd: (s, score, m) => inner.zadd(p(s), score, m),
    zrange: (s, min, max, o) => inner.zrange(p(s), min, max, o),
    _reset: () => (inner._reset ? inner._reset() : undefined),
  };
}

let cached = null;
let cachedToken = '';

/**
 * The configured store. Read per call so a test can switch it; cached per URL so a warm function
 * does not rebuild it per request. STORE_URL/STORE_TOKEN win, then the names Vercel's Upstash
 * integration sets, then Upstash's own. No credentials and no STORE=memory is an error with the
 * fix in it.
 */
function store() {
  const kind = String(process.env.STORE || '').toLowerCase();
  if (kind === 'memory') {
    if (isProduction()) {
      const error = new Error('production requires a durable store; configure KV_REST_API_URL and KV_REST_API_TOKEN');
      error.status = 503;
      throw error;
    }
    if (!cached || cached.name !== 'memory') cached = prefixed(memoryStore());
    return cached;
  }
  const url = process.env.STORE_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.STORE_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) throw new Error('no store configured: set KV_REST_API_URL and KV_REST_API_TOKEN (Upstash Redis), or STORE=memory for a demo');
  if (!cached || cached.name !== 'upstash' || cached.url !== String(url).replace(/\/$/, '') || cachedToken !== token) {
    cached = prefixed(restStore({ url, token }));
    cachedToken = token;
  }
  return cached;
}

module.exports = { store, memoryStore, restStore };
