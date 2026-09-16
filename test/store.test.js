#!/usr/bin/env node
'use strict';
/**
 * The store: the in-memory one, and the Upstash REST one against a fake that speaks Upstash's
 * wire shape (a JSON array in, { result } out, a bearer token, an { error } when it goes wrong).
 * The properties that matter are the ones the nadanada provider builds on: SET NX claims a key
 * exactly once, values survive a JSON round trip, the recent index comes back in score order, and
 * every key wears the prefix so two deployments can share one database.
 *
 *   node test/store.test.js
 */
const http = require('http');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'store.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const rejects = async (what, p, re) => {
  checks++;
  try { await p; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) { if (re.test(e.message)) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); } }
};

// --------------------------------------------------------------------------- a fake Upstash
const TOKEN = 'test-token';
const fake = { kv: new Map(), zs: new Map(), log: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (status, j) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return reply(401, { error: 'Unauthorized' });
    let args;
    try { args = JSON.parse(body); } catch (e) { return reply(400, { error: 'bad json' }); }
    fake.log.push(args);
    const [cmd, ...a] = args;
    if (cmd === 'GET') return reply(200, { result: fake.kv.has(a[0]) ? fake.kv.get(a[0]) : null });
    if (cmd === 'SET') {
      if (a[2] === 'NX' && fake.kv.has(a[0])) return reply(200, { result: null });
      fake.kv.set(a[0], a[1]); return reply(200, { result: 'OK' });
    }
    if (cmd === 'DEL') { const had = fake.kv.delete(a[0]); return reply(200, { result: had ? 1 : 0 }); }
    if (cmd === 'ZADD') { if (!fake.zs.has(a[0])) fake.zs.set(a[0], new Map()); fake.zs.get(a[0]).set(a[2], Number(a[1])); return reply(200, { result: 1 }); }
    if (cmd === 'ZRANGEBYSCORE') {
      const z = fake.zs.get(a[0]) || new Map();
      const lim = a[3] === 'LIMIT' ? Number(a[5]) : Infinity;
      const out = [...z.entries()].filter(([, s]) => s >= Number(a[1]) && s <= Number(a[2])).sort((x, y) => x[1] - y[1]).slice(0, lim).map(([m]) => m);
      return reply(200, { result: out });
    }
    reply(400, { error: 'ERR unknown command ' + cmd });
  });
});

async function exercise(store, label) {
  console.log(`\n${label}`);
  const rec = { transactionId: 'wf-1', step: 'invoiced', sats: 2424, nested: { ok: true } };
  check('a missing key is null', await store.get('order:none'), null);
  check('SET NX claims a fresh key', await store.set('order:wf-1', rec, { nx: true }), true);
  check('SET NX on a held key is refused', await store.set('order:wf-1', { step: 'other' }, { nx: true }), false);
  check('and the value is the first one, round-tripped', await store.get('order:wf-1'), rec);
  check('a plain SET overwrites', [await store.set('order:wf-1', Object.assign({}, rec, { step: 'paid' })), (await store.get('order:wf-1')).step], [true, 'paid']);
  await store.zadd('orders:recent', 300, 'c');
  await store.zadd('orders:recent', 100, 'a');
  await store.zadd('orders:recent', 200, 'b');
  check('the index comes back in score order', await store.zrange('orders:recent', 0, 1000), ['a', 'b', 'c']);
  check('bounded by score', await store.zrange('orders:recent', 150, 1000), ['b', 'c']);
  check('and by limit', await store.zrange('orders:recent', 0, 1000, { limit: 2 }), ['a', 'b']);
  await store.del('order:wf-1');
  check('DEL removes', await store.get('order:wf-1'), null);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  console.log('choosing');
  delete process.env.STORE; delete process.env.STORE_URL; delete process.env.STORE_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  await rejects('no credentials and no STORE=memory is refused with the fix in it', Promise.resolve().then(() => S.store()), /KV_REST_API_URL/);
  process.env.STORE = 'memory';
  check('STORE=memory gives the in-memory store', S.store().name, 'memory');
  check('and the same one twice', S.store() === S.store(), true);
  await exercise(S.store(), 'in memory');

  delete process.env.STORE;
  process.env.KV_REST_API_URL = base + '/';
  process.env.KV_REST_API_TOKEN = TOKEN;
  process.env.STORE_PREFIX = 'test:';
  check('Vercel\'s KV_REST_API_* pair gives the REST store', S.store().name, 'upstash');
  await exercise(S.store(), 'over Upstash REST');
  check('every key the server saw wore the prefix', fake.log.every((a) => String(a[1]).startsWith('test:')), true);
  check('SET NX went over the wire as NX', fake.log.some((a) => a[0] === 'SET' && a[3] === 'NX'), true);
  check('ZRANGEBYSCORE went with a LIMIT', fake.log.some((a) => a[0] === 'ZRANGEBYSCORE' && a[4] === 'LIMIT'), true);

  console.log('\nrefusals');
  process.env.KV_REST_API_TOKEN = 'wrong';
  process.env.KV_REST_API_URL = base;   // a different normalised url is the same; force a rebuild via prefix of url change
  process.env.STORE_URL = base + '//';   // STORE_URL wins and differs -> a fresh client with the wrong token
  await rejects('a bad token is an error naming the status', S.store().get('x'), /HTTP 401/);
  delete process.env.STORE_URL;
  process.env.KV_REST_API_TOKEN = TOKEN;

  server.close();
  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
