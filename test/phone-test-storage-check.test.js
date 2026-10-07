#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { memoryStore } = require('../site/api/_lib/store');
const { PREFIX, FAILURE, parse, checkStorage, main } = require('../scripts/phone-test-storage-check');
const UUID = '15bf3c44-35e6-4cab-8f75-c0e44312b8b5';
const key = 'probe:' + UUID;
const options = { randomUUID: () => UUID, now: 1780000000000 };
const marker = 'PRIVATE-FIXTURE-TOKEN-never-print';
const rejection = error => error.message === FAILURE && !error.message.includes(marker);
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('ok ' + name); }
function fixture(changes = {}) {
  const inner = memoryStore(), calls = [];
  const storage = { name: 'upstash' };
  for (const method of ['get', 'set', 'compareSet', 'compareDel']) storage[method] = async (...args) => {
    calls.push({ method, args });
    return inner[method](...args);
  };
  return { inner, calls, storage: Object.assign(storage, changes) };
}
const dependencies = (env, storage, extra = {}) => ({ env, probeOptions: options,
  loadCredentials: () => ({ KV_REST_API_URL: 'https://unit-storage-check.upstash.io', KV_REST_API_TOKEN: marker,
    BLINK_API_KEY: 'unused-wallet-credential' }), makeStore: () => storage, ...extra });
(async () => {
  await check('CLI requires an explicit isolated check and rejects payment or arbitrary key options', () => {
    assert.deepEqual(parse(['--local-credentials']), { help: false });
    assert.deepEqual(parse(['--help']), { help: true });
    for (const args of [[], ['--purchase'], ['--key', 'order:existing'], ['--local-credentials', '--local-credentials']]) assert.throws(() => parse(args), rejection);
  });
  await check('capability probe uses one dummy key, exercises stale contenders and confirms cleanup', async () => {
    const f = fixture(), result = await checkStorage(f.storage, options);
    assert.equal(result.passed, true); assert.equal(result.paymentReady, false); assert.equal(result.cleanup, 'verified');
    assert.equal(result.prefix, PREFIX); assert.equal(await f.inner.get(key), null);
    assert.ok(f.calls.every(call => call.args[0] === key));
    assert.deepEqual([...new Set(f.calls.map(call => call.method))].sort(), ['compareDel', 'compareSet', 'get', 'set']);
    assert.ok(f.calls.filter(call => call.method === 'set').every(call => call.args[2].nx === true));
    assert.ok(result.limitations.some(value => value.includes('crash')));
  });
  await check('memory and incomplete atomic stores are rejected before any write', async () => {
    await assert.rejects(checkStorage(memoryStore(), options), rejection);
    for (const missing of ['get', 'set', 'compareSet', 'compareDel']) {
      const f = fixture({ [missing]: undefined }); await assert.rejects(checkStorage(f.storage, options), rejection);
      assert.equal(f.calls.length, 0);
    }
  });
  await check('preexisting foreign value is preserved and never claimed or deleted', async () => {
    const f = fixture(), foreign = { private: marker }; await f.inner.set(key, foreign);
    await assert.rejects(checkStorage(f.storage, options), rejection);
    assert.deepEqual(await f.inner.get(key), foreign); assert.deepEqual(f.calls.map(call => call.method), ['get']);
  });
  await check('read-only storage permissions fail safely and remove no unrelated records', async () => {
    const f = fixture({ set: async () => { throw new Error(marker); } });
    await f.inner.set('unrelated', { retained: true });
    await assert.rejects(checkStorage(f.storage, options), rejection);
    assert.equal(await f.inner.get(key), null); assert.deepEqual(await f.inner.get('unrelated'), { retained: true });
    assert.ok(f.calls.every(call => call.args[0] === key));
  });
  await check('a write followed by a transport error cleans its exact owned value', async () => {
    const f = fixture();
    f.storage.set = async (name, value, opts) => { await f.inner.set(name, value, opts); throw new Error(marker); };
    await assert.rejects(checkStorage(f.storage, options), rejection);
    assert.equal(await f.inner.get(key), null);
    assert.ok(f.calls.some(call => call.method === 'compareDel' && call.args[1].phase === 'claimed'));
  });
  await check('broken NX replacement is detected and only its dummy replacement is cleaned', async () => {
    const f = fixture(); f.storage.set = (name, value) => f.inner.set(name, value);
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.equal(await f.inner.get(key), null);
  });
  await check('missing atomic permission fails and conditionally cleans the owned claim', async () => {
    const f = fixture({ compareSet: async () => { throw new Error(marker); } });
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.equal(await f.inner.get(key), null);
  });
  await check('wrong-expected compareSet that mutates is detected and cleaned', async () => {
    const f = fixture(); f.storage.compareSet = (name, expected, value) => f.inner.set(name, value);
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.equal(await f.inner.get(key), null);
  });
  await check('non-atomic compareSet race cannot pass with two stale winners', async () => {
    const f = fixture();
    f.storage.compareSet = async (name, expected, value) => {
      const matches = JSON.stringify(await f.inner.get(name)) === JSON.stringify(expected);
      if (!matches) return false;
      await new Promise(resolve => setImmediate(resolve)); await f.inner.set(name, value); return true;
    };
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.equal(await f.inner.get(key), null);
  });
  await check('one failed contender is awaited with its delayed peer before owned cleanup', async () => {
    const f = fixture(); let contenders = 0;
    f.storage.compareSet = async (name, expected, value) => {
      if (expected?.phase !== 'claimed') return f.inner.compareSet(name, expected, value);
      if (++contenders === 1) throw new Error(marker);
      await new Promise(resolve => setImmediate(resolve)); return f.inner.compareSet(name, expected, value);
    };
    await assert.rejects(checkStorage(f.storage, options), rejection);
    assert.equal(contenders, 2); assert.equal(await f.inner.get(key), null);
  });
  await check('non-atomic compareDel race cannot pass with two release winners', async () => {
    const f = fixture();
    f.storage.compareDel = async (name, expected) => {
      const matches = JSON.stringify(await f.inner.get(name)) === JSON.stringify(expected);
      if (!matches) return false;
      await new Promise(resolve => setImmediate(resolve)); await f.inner.del(name); return true;
    };
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.equal(await f.inner.get(key), null);
  });
  await check('failed cleanup cannot report success and exposes no backend error', async () => {
    const f = fixture({ compareDel: async () => { throw new Error(marker); } });
    await assert.rejects(checkStorage(f.storage, options), rejection);
    assert.ok(await f.inner.get(key));
  });
  await check('foreign replacement during failure is preserved by value-bound cleanup', async () => {
    const f = fixture(), foreign = { ownedBy: 'different-process', private: marker };
    f.storage.compareSet = async () => { await f.inner.set(key, foreign); throw new Error(marker); };
    await assert.rejects(checkStorage(f.storage, options), rejection); assert.deepEqual(await f.inner.get(key), foreign);
  });
  await check('CLI validates only storage, forces production isolation and restores caller environment', async () => {
    const f = fixture(), env = { NODE_ENV: 'development', STORE_PREFIX: 'production:', REDEMPTIONS_ENABLED: '1',
      BLINK_API_URL: 'unused-invalid-wallet-url', LN_PAYER: 'unused-payer' }, before = { ...env };
    const result = await main(['--local-credentials'], dependencies(env, f.storage, { makeStore: () => {
      assert.equal(env.NODE_ENV, 'production'); assert.equal(env.STORE_PREFIX, PREFIX); assert.equal(env.REDEMPTIONS_ENABLED, '0');
      assert.equal(env.BLINK_API_KEY, undefined); return f.storage;
    } }));
    assert.equal(result.passed, true); assert.deepEqual(env, before);
    assert.ok(!JSON.stringify(result).includes(marker));
  });
  await check('missing or invalid credentials are rejected before storage access', async () => {
    for (const credentials of [{}, { KV_REST_API_URL: 'https://unit-storage-check.upstash.io' },
      { KV_REST_API_URL: 'https://evil.example', KV_REST_API_TOKEN: marker }]) {
      let accessed = false; const env = {};
      await assert.rejects(main(['--local-credentials'], dependencies(env, null, { loadCredentials: () => credentials,
        makeStore: () => { accessed = true; throw new Error(marker); } })), rejection);
      assert.equal(accessed, false); assert.deepEqual(env, {});
    }
    const env = { STORE: 'memory' };
    await assert.rejects(main(['--local-credentials'], dependencies(env, fixture().storage)), rejection);
    assert.deepEqual(env, { STORE: 'memory' });
  });
  await check('actual production REST adapter sends only isolated one-key GET SET NX and EVAL commands', async () => {
    const originalFetch = globalThis.fetch, commands = [], kv = new Map();
    const envNames = ['STORE', 'STORE_URL', 'STORE_TOKEN'];
    const previous = envNames.map(name => [name, Object.hasOwn(process.env, name), process.env[name]]);
    for (const name of envNames) delete process.env[name];
    globalThis.fetch = async (url, request) => {
      assert.equal(url, 'https://unit-storage-check.upstash.io');
      assert.equal(request.headers.authorization, 'Bearer ' + marker);
      assert.equal(process.env.NODE_ENV, 'production'); assert.equal(process.env.STORE_PREFIX, PREFIX);
      const args = JSON.parse(request.body); commands.push(args);
      const command = args[0], name = args[command === 'EVAL' ? 3 : 1];
      assert.equal(name, PREFIX + key); assert.ok(['GET', 'SET', 'EVAL'].includes(command));
      let result;
      if (command === 'GET') result = kv.get(name) ?? null;
      else if (command === 'SET') {
        assert.equal(args[3], 'NX'); assert.equal(args.length, 4);
        if (kv.has(name)) result = null; else { kv.set(name, args[2]); result = 'OK'; }
      } else {
        assert.equal(args[2], '1');
        if (args[1].includes("redis.call('SET'")) {
          const match = args[4] === 'missing' ? !kv.has(name) : kv.get(name) === args[5];
          if (match) kv.set(name, args[6]); result = Number(match);
        } else {
          assert.ok(args[1].includes("redis.call('DEL'"));
          const match = kv.get(name) === args[4]; if (match) kv.delete(name); result = Number(match);
        }
      }
      return { ok: true, json: async () => ({ result }) };
    };
    try {
      const result = await main(['--local-credentials'], { probeOptions: options,
        loadCredentials: () => ({ KV_REST_API_URL: 'https://unit-storage-check.upstash.io', KV_REST_API_TOKEN: marker }) });
      assert.equal(result.passed, true); assert.equal(kv.size, 0); assert.ok(commands.some(args => args[0] === 'EVAL'));
      assert.ok(!JSON.stringify(result).includes(marker));
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, existed, value] of previous) { if (existed) process.env[name] = value; else delete process.env[name]; }
    }
  });
  await check('help and rejected CLI flags never unlock credentials or access storage', async () => {
    const forbidden = () => { throw new Error('must not call'); }, deps = { env: {}, loadCredentials: forbidden, makeStore: forbidden };
    assert.match(await main(['--help'], deps), /isolated dummy key/);
    await assert.rejects(main(['--purchase'], deps), rejection);
    const result = spawnSync(process.execPath, [require.resolve('../scripts/phone-test-storage-check'), '--purchase', marker], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), FAILURE);
    assert.ok(!(result.stdout + result.stderr).includes(marker));
  });
  console.log(checks + ' isolated storage capability checks passed. Only mock stores and fixture credentials were used.');
})().catch(error => { console.error(error); process.exitCode = 1; });
