#!/usr/bin/env node
'use strict';

// All wallets are generated in this process. No external account, RPC, key or payment is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');
const auth = require('../site/api/auth');
const solana = require('../site/api/_lib/solana-auth');
const stores = require('../site/api/_lib/store');

let checks = 0;
function check(name, got, expected) { assert.deepEqual(got, expected, name); checks++; console.log('  ok   ' + name); }
function ok(name, value) { assert.ok(value, name); checks++; console.log('  ok   ' + name); }
function wallet() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const address = solana.encodeAddress(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { ...keys, address };
}
const A = wallet(), B = wallet();
const ORIGIN = 'https://ott.test';
const URI = ORIGIN + '/app.html';
let ipCounter = 1;
function call(body, { method = 'POST', headers = {}, rawBody, streamed } = {}) {
  return new Promise((resolve, reject) => {
    const req = streamed ? Readable.from([Buffer.from(streamed)]) : {};
    Object.assign(req, { method, url: '/api/auth', headers: { origin: ORIGIN, 'x-forwarded-for': '127.0.0.' + ipCounter++, ...headers } });
    if (!streamed) req.body = rawBody === undefined ? body : rawBody;
    const outputHeaders = {};
    const res = { setHeader(k, v) { outputHeaders[k.toLowerCase()] = v; }, end(value) { resolve({ status: res.statusCode, headers: outputHeaders, body: value ? JSON.parse(value) : null }); } };
    Promise.resolve(auth(req, res)).catch(reject);
  });
}
const requestChallenge = (address = A.address, extra = {}, options) => call({ action: 'challenge', address, domain: 'ott.test', uri: URI, ...extra }, options);
function signed(challenge, signer = A, fields = {}) {
  const bytes = fields.message || solana.messageBytes(challenge.input);
  return {
    action: 'verify', address: challenge.input.address, challengeId: challenge.challengeId,
    signedMessage: bytes.toString('base64'), signature: crypto.sign(null, bytes, signer.privateKey).toString('base64'),
    ...fields.body,
  };
}

(async () => {
  for (const name of ['STORE_URL', 'STORE_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
  process.env.STORE = 'memory';
  process.env.STORE_PREFIX = 'auth-test:';
  process.env.SIGNIN_HOST = 'ott.test';
  process.env.FRONTEND_ORIGINS = ORIGIN + ',https://second.test';
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  stores.store()._reset();
  const realNow = Date.now;
  let now = Math.floor(realNow() / 1000) * 1000;
  Date.now = () => now;
  const advance = (ms = 1000) => { now += ms; };
  try {
    console.log('strict Solana address and SIWS byte encoding');
    check('a generated public key decodes to exactly 32 bytes', solana.decodeAddress(A.address).length, 32);
    check('a base58 address retains exact case', solana.encodeAddress(solana.decodeAddress(A.address)), A.address);
    for (const bad of [null, '', '0x' + 'a'.repeat(40), '1'.repeat(31), '1'.repeat(33), '0'.repeat(32), 'z'.repeat(44)]) {
      check('malformed or wrong-sized public key is rejected: ' + String(bad), solana.decodeAddress(bad), null);
    }
    check('canonical all-zero 32-byte encoding remains a correctly sized address', solana.decodeAddress('1'.repeat(32)).length, 32);
    for (const bad of ['YWJj\n', 'YQ', 'YR==', 'YQ===', ['YQ=='], '']) check('base64 is strictly canonical: ' + JSON.stringify(bad), solana.decodeBase64(bad), null);

    console.log('\nmethod, origin and bounded body policy');
    let r = await call({}, { method: 'GET' });
    check('authentication is POST only', [r.status, r.headers.allow], [405, 'POST']);
    check('all authentication responses are JSON and no-store', [r.headers['content-type'], r.headers['cache-control']], ['application/json; charset=utf-8', 'no-store']);
    r = await call(null, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    check('a configured frontend may preflight JSON authentication', [r.status, r.headers['access-control-allow-origin']], [204, ORIGIN]);
    r = await requestChallenge(A.address, {}, { headers: { origin: 'https://evil.test' } });
    check('an unrelated browser origin cannot create challenges', r.status, 403);
    check('refused origins receive no CORS permission', r.headers['access-control-allow-origin'], undefined);
    r = await call(null, { rawBody: '{bad' });
    check('malformed JSON fails safely', r.status, 400);
    for (const rawBody of [null, [], 'null', '[]', '42']) {
      r = await call(rawBody, { rawBody });
      check('only JSON objects are supported: ' + JSON.stringify(rawBody), r.status, 400);
    }
    for (const [shape, options] of [
      ['object', { rawBody: { action: 'challenge', padding: 'A'.repeat(17000) } }],
      ['string', { rawBody: JSON.stringify({ action: 'challenge', padding: 'A'.repeat(17000) }) }],
      ['stream', { streamed: JSON.stringify({ action: 'challenge', padding: 'A'.repeat(17000) }) }],
    ]) {
      r = await call({}, options);
      check('a large ' + shape + ' body is refused before authentication work', [r.status, r.headers['cache-control']], [413, 'no-store']);
    }
    r = await call({ action: 'unknown' });
    check('unknown authentication actions are refused', r.status, 400);

    console.log('\nserver-controlled frontend and challenge');
    for (const extra of [
      { uri: 'https://evil.test/app.html', domain: 'evil.test' },
      { uri: URI, domain: 'evil.test' },
      { uri: URI + '?redirect=evil' }, { uri: URI + '#evil' },
      { uri: 'https://user:pass@ott.test/app.html' },
      { uri: 'http://ott.test/app.html' },
      { uri: 'https://second.test/app.html', domain: 'second.test' },
    ]) {
      r = await requestChallenge(A.address, extra);
      check('untrusted or mismatched frontend fields are refused: ' + extra.uri, r.status, 403);
    }
    r = await requestChallenge('1'.repeat(31));
    check('a malformed address cannot create a challenge', r.status, 400);
    const challengeResponse = await requestChallenge();
    check('a canonical wallet receives a challenge', challengeResponse.status, 200);
    const challenge = challengeResponse.body;
    const expectedInput = {
      domain: 'ott.test', address: A.address, statement: 'Sign in to OTT. This does not move funds.', uri: URI,
      version: '1', chainId: 'solana:mainnet', nonce: challenge.input.nonce,
      issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + 300000).toISOString(),
    };
    check('challenge fields are server-controlled and expire in five minutes', challenge.input, expectedInput);
    ok('challenge ID and nonce are unpredictable independent alphanumeric values', /^[a-f0-9]{48}$/.test(challenge.challengeId) && /^[a-f0-9]{48}$/.test(challenge.input.nonce) && challenge.challengeId !== challenge.input.nonce);
    const canonical = 'ott.test wants you to sign in with your Solana account:\n' + A.address
      + '\n\nSign in to OTT. This does not move funds.\n\nURI: ' + URI
      + '\nVersion: 1\nChain ID: solana:mainnet\nNonce: ' + challenge.input.nonce
      + '\nIssued At: ' + challenge.input.issuedAt + '\nExpiration Time: ' + challenge.input.expirationTime;
    check('SIWS bytes follow the official ordered format with no trailing newline', solana.messageBytes(challenge.input).toString('utf8'), canonical);
    r = await requestChallenge();
    check('an address cannot rapidly allocate more challenges', [r.status, r.headers['retry-after']], [429, '1']);

    console.log('\nonly the exact requested wallet and SIWS message can verify');
    r = await call(signed(challenge, B));
    check('a different key cannot sign in as this wallet', r.status, 401);
    r = await call(signed(challenge, A, { body: { address: B.address } }));
    check('the verification address cannot be replaced', r.status, 401);
    const alteredCase = A.address.replace(/[a-zA-Z]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    r = await call(signed(challenge, A, { body: { address: alteredCase } }));
    check('Solana addresses are never lowercased or case-folded', r.status, 401);
    for (const [field, value] of [
      ['domain', 'evil.test'], ['uri', 'https://evil.test/app.html'], ['address', B.address],
      ['nonce', 'a'.repeat(48)], ['chainId', 'solana:devnet'], ['statement', 'Send funds'],
      ['version', '2'], ['issuedAt', new Date(now - 1000).toISOString()], ['expirationTime', new Date(now + 600000).toISOString()],
    ]) {
      const bytes = solana.messageBytes({ ...challenge.input, [field]: value });
      r = await call(signed(challenge, A, { message: bytes }));
      check('a valid signature cannot mutate the stored ' + field, r.status, 401);
    }
    for (const text of [canonical + '\n', canonical.replace(/\n/g, '\r\n'), canonical.replace('Version: 1\nChain ID: solana:mainnet', 'Chain ID: solana:mainnet\nVersion: 1')]) {
      r = await call(signed(challenge, A, { message: Buffer.from(text) }));
      check('alternate SIWS formatting is refused', r.status, 401);
    }
    for (const body of [
      { signatureType: 'secp256k1' }, { signature: Buffer.alloc(63).toString('base64') },
      { signature: Buffer.alloc(65).toString('base64') }, { signature: 'YQ' },
      { signedMessage: Buffer.from(canonical).toString('base64') + '\n' },
    ]) {
      r = await call(signed(challenge, A, { body }));
      check('malformed encoding, length or signature type is refused', r.status, 401);
    }
    r = await call(signed(challenge), { headers: { origin: 'https://second.test' } });
    check('another allowed frontend cannot verify this challenge', r.status, 403);

    console.log('\nnonce consumption and session lifecycle');
    const verified = await Promise.all([call(signed(challenge)), call(signed(challenge))]);
    check('parallel verification consumes a challenge exactly once', verified.map(x => x.status).sort(), [200, 401]);
    const session = verified.find(x => x.status === 200).body;
    check('a Solana account has no invented credit or EVM eligibility', session.account, { address: A.address, chain: 'solana', verified: true, credit: 0, eligible: false });
    check('session expiration is numeric milliseconds thirty minutes ahead', session.expiresAt, now + 1800000);
    ok('session token is a canonical opaque 32-byte value', /^[A-Za-z0-9_-]{43}$/.test(session.token) && Buffer.from(session.token, 'base64url').length === 32);
    r = await call(signed(challenge));
    check('captured verification bytes cannot mint another session', r.status, 401);
    check('consumed challenges are removed from storage', await stores.store().get('auth:challenge:' + challenge.challengeId), null);
    const sessionStorageKey = 'auth:session:' + crypto.createHash('sha256').update(session.token).digest('hex');
    const persisted = await stores.store().get(sessionStorageKey);
    ok('persisted session keys and values contain no bearer token', !sessionStorageKey.includes(session.token) && !JSON.stringify(persisted).includes(session.token));
    check('tokens are not stored under their raw value', await stores.store().get('auth:session:' + session.token), null);
    r = await call({ action: 'session', token: session.token });
    check('a valid session returns its exact verified account', [r.status, r.body.account], [200, session.account]);
    r = await call({ action: 'session', token: session.token }, { headers: { origin: 'https://second.test' } });
    check('a session remains bound to its frontend origin', r.status, 403);
    r = await call({ action: 'session', token: 'x'.repeat(43) });
    check('a forged token has no account access', r.status, 401);
    advance(1800000);
    r = await call({ action: 'session', token: session.token });
    check('a session expires at the exact thirty-minute boundary', r.status, 401);
    check('the expired memory session is removed', await stores.store().get(sessionStorageKey), null);

    const expiresResponse = await requestChallenge();
    advance(300000);
    r = await call(signed(expiresResponse.body));
    check('a challenge expires at the exact five-minute boundary', r.status, 401);
    check('expired challenges are removed', await stores.store().get('auth:challenge:' + expiresResponse.body.challengeId), null);
    const retryResponse = await requestChallenge();
    r = await call(signed(retryResponse.body, A, { body: { signatureType: 'ed25519' } }));
    check('the explicit Ed25519 signature type works', r.status, 200);
    const logoutToken = r.body.token;
    r = await call({ action: 'logout', token: logoutToken }, { headers: { origin: 'https://second.test' } });
    check('another origin cannot revoke this session', r.status, 403);
    r = await call({ action: 'logout', token: logoutToken });
    check('logout revokes the opaque session', [r.status, r.body.ok], [200, true]);
    r = await call({ action: 'session', token: logoutToken });
    check('revoked sessions cannot read account state', r.status, 401);
    r = await call({ action: 'logout', token: logoutToken });
    check('logout can be safely retried', r.status, 200);
    advance();
    r = await requestChallenge();
    check('short challenge cooldowns permit normal retries', r.status, 200);
    const firstIp = { origin: ORIGIN, 'x-forwarded-for': '192.0.2.1' };
    advance();
    await requestChallenge(A.address, {}, { headers: firstIp });
    r = await requestChallenge(B.address, {}, { headers: firstIp });
    check('one IP cannot allocate simultaneous challenges for different addresses', r.status, 429);

    console.log('\nproduction durable storage and Redis expiration');
    process.env.NODE_ENV = 'production';
    r = await requestChallenge(B.address);
    check('production refuses in-memory account sessions', [r.status, r.body.error], [503, 'sign-in is temporarily unavailable']);
    delete process.env.STORE;
    r = await requestChallenge(B.address);
    check('production without durable storage fails closed without configuration leaks', [r.status, r.body.error], [503, 'sign-in is temporarily unavailable']);
    delete process.env.NODE_ENV;
    process.env.STORE = 'memory';
    const wire = [];
    const ttlStore = stores.restStore({ url: 'http://127.0.0.1:1', token: 'local-fixture-token' });
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => { wire.push(JSON.parse(options.body)); return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); };
    try {
      await ttlStore.set('auth:test', { safe: true }, { nx: true, ex: 300 });
      check('Redis SET carries atomic NX and a server-side expiry', wire[0], ['SET', 'auth:test', '{"safe":true}', 'NX', 'EX', '300']);
      await ttlStore.set('auth:session', {}, { ex: 1800 });
      check('session TTL is sent to Redis in seconds', wire[1], ['SET', 'auth:session', '{}', 'EX', '1800']);
      for (const ex of [0, -1, 1.5, NaN, '300']) {
        await assert.rejects(ttlStore.set('bad', {}, { ex }), /TTL/);
        checks++; console.log('  ok   invalid Redis TTL is rejected: ' + String(ex));
      }
    } finally { global.fetch = originalFetch; }
    const memory = stores.memoryStore();
    await memory.set('ttl', { one: true }, { nx: true, ex: 1 });
    check('TTL keys cannot be reclaimed before expiry', await memory.set('ttl', {}, { nx: true, ex: 1 }), false);
    advance();
    check('expired TTL keys may be reclaimed atomically', await memory.set('ttl', { two: true }, { nx: true, ex: 1 }), true);
    await memory.set('ttl', { durable: true });
    advance(2000);
    check('a plain SET retains the prior durable-store behavior', await memory.get('ttl'), { durable: true });

    console.log('\na production auth flow against a local durable-store fixture');
    const durableValues = new Map(), durableExpiry = new Map(), durableCommands = [];
    let storeFault = false;
    const redis = http.createServer((req, res) => {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const reply = (result, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); };
        if (storeFault) return reply({ error: 'private-store-fixture-token' }, 500);
        if (req.headers.authorization !== 'Bearer local-fixture-token') return reply({ error: 'unauthorized' }, 401);
        const command = JSON.parse(text); durableCommands.push(command);
        const [kind, key] = command;
        const expire = name => { if (durableExpiry.has(name) && now >= durableExpiry.get(name)) { durableValues.delete(name); durableExpiry.delete(name); } };
        if (kind === 'GET') { expire(key); return reply({ result: durableValues.get(key) ?? null }); }
        if (kind === 'SET') {
          expire(key);
          if (command.includes('NX') && durableValues.has(key)) return reply({ result: null });
          durableValues.set(key, command[2]);
          const ex = command.indexOf('EX');
          if (ex >= 0) durableExpiry.set(key, now + Number(command[ex + 1]) * 1000); else durableExpiry.delete(key);
          return reply({ result: 'OK' });
        }
        if (kind === 'DEL') { const removed = durableValues.delete(key); durableExpiry.delete(key); return reply({ result: removed ? 1 : 0 }); }
        if (kind === 'EVAL' && command[1].includes("redis.call('DEL'")) {
          const name = command[3]; expire(name);
          const matches = durableValues.get(name) === command[4];
          if (matches) { durableValues.delete(name); durableExpiry.delete(name); }
          return reply({ result: matches ? 1 : 0 });
        }
        reply({ error: 'unsupported local fixture command' }, 400);
      });
    });
    await new Promise(resolve => redis.listen(0, '127.0.0.1', resolve));
    process.env.STORE = 'upstash';
    process.env.STORE_URL = 'http://127.0.0.1:' + redis.address().port;
    process.env.STORE_TOKEN = 'local-fixture-token';
    process.env.NODE_ENV = 'production';
    try {
      advance();
      const durableChallenge = await requestChallenge();
      check('production creates a challenge only with durable storage', durableChallenge.status, 200);
      const races = await Promise.all(Array.from({ length: 8 }, () => call(signed(durableChallenge.body))));
      check('durable atomic nonce consumption permits exactly one concurrent session', races.map(x => x.status).sort(), [200, 401, 401, 401, 401, 401, 401, 401]);
      const durableSession = races.find(x => x.status === 200).body;
      r = await call({ action: 'session', token: durableSession.token });
      check('durable sessions return the same isolated Solana account', [r.status, r.body.account], [200, session.account]);
      ok('all auth writes have a Redis TTL', durableCommands.filter(cmd => cmd[0] === 'SET').every(cmd => cmd.includes('EX')));
      ok('one-use challenges are consumed with atomic one-key EVAL', durableCommands.some(cmd => cmd[0] === 'EVAL' && cmd[2] === '1'));
      ok('Redis commands and stored values never persist a bearer session token', !JSON.stringify(durableCommands).includes(durableSession.token) && !JSON.stringify([...durableValues]).includes(durableSession.token));
      advance();
      const durableExpired = await requestChallenge();
      advance(300000);
      r = await call(signed(durableExpired.body));
      check('Redis expires an unused challenge at five minutes', r.status, 401);
      check('expired challenge storage is actually removed', durableValues.has('auth-test:auth:challenge:' + durableExpired.body.challengeId), false);
      now = durableSession.expiresAt;
      r = await call({ action: 'session', token: durableSession.token });
      check('Redis expires sessions at thirty minutes', r.status, 401);
      const durableSessionKey = 'auth-test:auth:session:' + crypto.createHash('sha256').update(durableSession.token).digest('hex');
      check('expired session storage is actually removed', durableValues.has(durableSessionKey), false);
      storeFault = true;
      r = await requestChallenge(B.address);
      check('store faults fail closed with no credential or URL echo', [r.status, r.body.error], [503, 'sign-in is temporarily unavailable']);
    } finally {
      redis.closeAllConnections(); await new Promise(resolve => redis.close(resolve));
      process.env.STORE = 'memory'; delete process.env.STORE_URL; delete process.env.STORE_TOKEN; delete process.env.NODE_ENV;
    }

    console.log('\nportable auth route reaches the actual handler');
    const server = require('../scripts/serve-api').createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      advance();
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/auth', {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', address: B.address, domain: 'ott.test', uri: URI }),
      });
      check('the local HTTP API exposes bounded Solana authentication', [response.status, (await response.json()).input.address, response.headers.get('cache-control')], [200, B.address, 'no-store']);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } finally { Date.now = realNow; }
  console.log('\nall ' + checks + ' authentication checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
