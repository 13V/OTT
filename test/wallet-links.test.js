#!/usr/bin/env node
'use strict';

// Every key is ephemeral and generated locally. Fixtures never use a live wallet or service.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const auth = require('../site/api/auth');
const solana = require('../site/api/_lib/solana-auth');
const eip191 = require('../site/api/_lib/eip191');
const secp = require('../site/api/_lib/secp256k1');
const stores = require('../site/api/_lib/store');
const links = require('../site/api/_lib/wallet-links');
const redeem = require('../site/api/redeem');
let checks = 0, ip = 1;
const check = (name, got, expected) => { assert.deepEqual(got, expected, name); checks++; console.log('  ok   ' + name); };
const ok = (name, value) => { assert.ok(value, name); checks++; console.log('  ok   ' + name); };
function solWallet() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return { ...keys, address: solana.encodeAddress(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)) };
}
function evmWallet() { const privateKey = secp.newPrivateKey(); return { privateKey, address: secp.addressOf(privateKey).toLowerCase() }; }
const S = Array.from({ length: 12 }, solWallet), E = Array.from({ length: 12 }, evmWallet);
const ORIGIN = 'https://ott.test', URI = ORIGIN + '/app.html';
function call(body, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = { method: 'POST', url: '/api/auth', headers: { origin, 'x-forwarded-for': '192.0.2.' + ip++ }, body };
    const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(value) { resolve({ status: res.statusCode, headers, body: JSON.parse(value) }); } };
    Promise.resolve(auth(req, res)).catch(reject);
  });
}
let now = Date.now();
const advance = (ms = 1000) => { now += ms; };
async function login(wallet) {
  advance();
  const c = await call({ action: 'challenge', address: wallet.address, domain: 'ott.test', uri: URI });
  assert.equal(c.status, 200);
  const bytes = solana.messageBytes(c.body.input);
  const r = await call({ action: 'verify', address: wallet.address, challengeId: c.body.challengeId,
    signedMessage: bytes.toString('base64'), signature: crypto.sign(null, bytes, wallet.privateKey).toString('base64') });
  assert.equal(r.status, 200);
  return r.body;
}
async function challenge(token, evm, extra = {}, origin) {
  advance();
  return call({ action: 'link-challenge', token, evmAddress: evm.address, domain: 'ott.test', uri: URI, ...extra }, origin);
}
function proof(token, c, sol, evm, extra = {}) {
  const bytes = extra.bytes || solana.messageBytes(c.solanaInput);
  return { action: 'link-verify', token, challengeId: c.challengeId, addressSOL: c.solanaInput.address,
    evmAddress: evm.address, signedMessage: bytes.toString('base64'), signature: crypto.sign(null, bytes, sol.privateKey).toString('base64'),
    evmSignature: eip191.sign(evm.privateKey, c.evmMessage), signatureType: 'ed25519', ...extra.body };
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

(async () => {
  for (const name of ['STORE_URL', 'STORE_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'NODE_ENV', 'VERCEL_ENV']) delete process.env[name];
  process.env.STORE = 'memory'; process.env.STORE_PREFIX = 'links-test:';
  process.env.SIGNIN_HOST = 'ott.test'; process.env.FRONTEND_ORIGINS = ORIGIN + ',https://second.test';
  const realNow = Date.now; Date.now = () => now;
  const store = stores.store(); store._reset();
  const writeKeys = [];
  const originalSet = store.set.bind(store), originalMutate = store.compareMutate.bind(store);
  store.set = (key, ...args) => { writeKeys.push(key); return originalSet(key, ...args); };
  store.compareMutate = entries => { writeKeys.push(...entries.filter(x => Object.hasOwn(x, 'value')).map(x => x.key)); return originalMutate(entries); };
  try {
    console.log('exact link purpose, identities, frontend and two-key ownership');
    const a = await login(S[0]), aSecond = await login(S[0]), b = await login(S[1]);
    let r = await call({ action: 'link', token: a.token });
    check('unlinked accounts return no linked wallet', [r.status, r.body.linkedWallet], [200, null]);
    r = await challenge(a.token, E[0], { evmAddress: E[0].address.toUpperCase() });
    check('link challenges require canonical lowercase EVM addresses', r.status, 400);
    r = await challenge(a.token, E[0], { domain: 'evil.test', uri: 'https://evil.test/app.html' });
    check('a session cannot link through another frontend URI', r.status, 403);
    const c = (await challenge(a.token, E[0])).body;
    check('SIWS has the exact link-only statement', c.solanaInput.statement, 'Link this Solana account to Robinhood Chain wallet ' + E[0].address + ' on OTT. This does not move funds.');
    const expectedEvm = ['OT+T — link wallets', 'Purpose: Link accounts only; no funds, redemption, or installation-code access.',
      'Site: ott.test', 'URI: ' + URI, 'Solana Wallet: ' + S[0].address, 'Robinhood Chain Wallet: ' + E[0].address,
      'Chain ID: 4663', 'Nonce: ' + c.solanaInput.nonce, 'Issued At: ' + c.solanaInput.issuedAt, 'Expiration Time: ' + c.solanaInput.expirationTime].join('\n');
    check('the EVM message binds purpose, site, URI, both wallets, chain and matching challenge', c.evmMessage, expectedEvm);
    check('link challenge has a five-minute expiration', Date.parse(c.solanaInput.expirationTime) - Date.parse(c.solanaInput.issuedAt), 300000);
    const valid = proof(a.token, c, S[0], E[0]);
    for (const [name, body, origin] of [
      ['wrong Solana key', proof(a.token, c, S[1], E[0])],
      ['wrong EVM key', { ...valid, evmSignature: eip191.sign(E[1].privateKey, c.evmMessage) }],
      ['missing EVM proof', { ...valid, evmSignature: undefined }],
      ['missing Solana proof', { ...valid, signature: undefined }],
      ['another Solana address', { ...valid, addressSOL: S[1].address }],
      ['case-folded Solana address', { ...valid, addressSOL: S[0].address.toLowerCase() }],
      ['uppercase EVM address', { ...valid, evmAddress: E[0].address.toUpperCase() }],
      ['another live session for the same Solana wallet', { ...valid, token: aSecond.token }],
      ['another Solana session', { ...valid, token: b.token }],
      ['unsupported signature type', { ...valid, signatureType: 'secp256k1' }],
      ['invalid EVM signature length', { ...valid, evmSignature: '0x' + 'ab'.repeat(64) }],
      ['noncanonical base64', { ...valid, signature: valid.signature + '\n' }],
    ]) {
      r = await call(body, origin);
      check(name + ' cannot establish a link', r.status, 401);
    }
    r = await call(valid, 'https://second.test');
    check('an allowed but different browser origin cannot use this session', r.status, 403);
    for (const [field, value] of [['statement', 'Sign in to OTT. This does not move funds.'], ['nonce', 'a'.repeat(48)],
      ['domain', 'evil.test'], ['uri', 'https://evil.test/app.html'], ['chainId', 'solana:devnet']]) {
      const bytes = solana.messageBytes({ ...c.solanaInput, [field]: value });
      r = await call(proof(a.token, c, S[0], E[0], { bytes }));
      check('a signed alteration to SIWS ' + field + ' cannot link', r.status, 401);
    }
    r = await call({ ...valid, evmSignature: eip191.sign(E[0].privateKey, c.evmMessage.replace('OT+T — link wallets', 'OT+T — show my eSIM codes')) });
    check('an EVM signature for another purpose cannot link', r.status, 401);
    r = await call(valid);
    check('both exact ownership proofs establish the link', [r.status, r.body.linkedWallet], [200, { address: E[0].address, chain: 'evm', chainId: 4663 }]);
    check('link responses are never cached', r.headers['cache-control'], 'no-store');
    r = await call(valid);
    check('a consumed dual-signature challenge cannot be replayed', r.status, 401);
    check('link nonce is deleted after successful consumption', await store.get(links.keys.challenge(c.challengeId)), null);
    const firstRecord = await store.get(links.keys.solana(S[0].address));
    check('forward and reverse mappings are the same persistent pair', await store.get(links.keys.evm(E[0].address)), firstRecord);
    r = await call({ action: 'session', token: a.token });
    check('linking never creates credit or purchase eligibility', r.body.account, { address: S[0].address, chain: 'solana', verified: true, credit: 0, eligible: false });
    check('an existing session can report its verified public link', r.body.linkedWallet.address, E[0].address);
    r = await call({ action: 'link', token: b.token });
    check('another Solana account sees only its own link', r.body.linkedWallet, null);
    const loggedInAgain = await login(S[0]);
    check('fresh login includes the consistent existing link without changing the account', [loggedInAgain.linkedWallet.address, loggedInAgain.account.credit, loggedInAgain.account.eligible], [E[0].address, 0, false]);
    const samePair = (await challenge(aSecond.token, E[0])).body;
    r = await call(proof(aSecond.token, samePair, S[0], E[0]));
    check('fresh proofs for the same pair are idempotent', r.status, 200);
    check('idempotence preserves the original mapping record', await store.get(links.keys.solana(S[0].address)), firstRecord);
    r = await challenge(a.token, E[1]);
    check('a Solana account cannot implicitly overwrite its linked EVM wallet', r.status, 409);
    r = await challenge(b.token, E[0]);
    check('an EVM wallet cannot be implicitly linked to another Solana account', r.status, 409);
    ok('a link EVM proof is not a signed installation read', redeem.checkMessage(c.evmMessage, E[0].address, Math.floor(now / 1000), { action: 'read' }));
    ok('a link EVM proof is not a signed redemption', redeem.checkMessage(c.evmMessage, E[0].address, Math.floor(now / 1000), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '0' }));

    console.log('\natomic conflicts and one-time verification');
    const parallel = await login(S[2]);
    const pc = (await challenge(parallel.token, E[2])).body;
    const racers = await Promise.all(Array.from({ length: 8 }, () => call(proof(parallel.token, pc, S[2], E[2]))));
    check('eight simultaneous verifications establish exactly one link', racers.map(x => x.status).sort(), [200, 401, 401, 401, 401, 401, 401, 401]);
    const conflict = await login(S[3]);
    const c1 = (await challenge(conflict.token, E[3])).body, c2 = (await challenge(conflict.token, E[4])).body;
    const competing = await Promise.all([call(proof(conflict.token, c1, S[3], E[3])), call(proof(conflict.token, c2, S[3], E[4]))]);
    check('competing EVM links for one Solana wallet have one winner', competing.map(x => x.status).sort(), [200, 409]);
    const winningEvm = competing.find(x => x.status === 200).body.linkedWallet.address;
    check('the winning forward and reverse indexes agree', (await store.get(links.keys.solana(S[3].address))).evmAddress, winningEvm);
    check('the losing EVM wallet has no partial reverse index', await store.get(links.keys.evm(winningEvm === E[3].address ? E[4].address : E[3].address)), null);
    const d = await login(S[4]), e = await login(S[5]);
    const dc = (await challenge(d.token, E[5])).body, ec = (await challenge(e.token, E[5])).body;
    const reverseRacers = await Promise.all([call(proof(d.token, dc, S[4], E[5])), call(proof(e.token, ec, S[5], E[5]))]);
    check('two Solana wallets competing for one EVM wallet have one winner', reverseRacers.map(x => x.status).sort(), [200, 409]);
    const owner = (await store.get(links.keys.evm(E[5].address))).solanaAddress;
    check('the losing Solana wallet has no partial forward index', await store.get(links.keys.solana(owner === S[4].address ? S[5].address : S[4].address)), null);

    console.log('\nunlink invalidates old approvals across every session');
    const stale = (await challenge(a.token, E[0])).body;
    r = await call({ action: 'unlink', token: aSecond.token });
    check('explicit unlink removes a linked pair', [r.status, r.body.linkedWallet], [200, null]);
    check('unlink removes both indexes atomically', [await store.get(links.keys.solana(S[0].address)), await store.get(links.keys.evm(E[0].address))], [null, null]);
    r = await call(proof(a.token, stale, S[0], E[0]));
    check('a delayed proof from another active session cannot undo unlink', r.status, 409);
    const pendingFirst = (await challenge(a.token, E[1])).body;
    await call({ action: 'unlink', token: aSecond.token });
    r = await call(proof(a.token, pendingFirst, S[0], E[1]));
    check('unlink while no pair exists cancels pending first-link proofs too', r.status, 409);
    const renewed = (await challenge(a.token, E[1])).body;
    r = await call(proof(a.token, renewed, S[0], E[1]));
    check('new explicit dual proofs can link after unlink', r.status, 200);
    const freed = (await challenge(b.token, E[0])).body;
    r = await call(proof(b.token, freed, S[1], E[0]));
    check('unlink truly frees the old reverse index for another owner', r.status, 200);
    r = await call({ action: 'unlink', token: b.token }, 'https://second.test');
    check('a different origin cannot unlink an account', r.status, 403);

    console.log('\nlive session and challenge deadlines guard authoritative mutations');
    const expiring = await login(S[6]);
    const expires = (await challenge(expiring.token, E[6])).body;
    advance(300000);
    r = await call(proof(expiring.token, expires, S[6], E[6]));
    check('link challenges expire at the exact five-minute boundary', r.status, 401);
    const logoutRace = await login(S[7]);
    const logoutChallenge = (await challenge(logoutRace.token, E[7])).body;
    const trackedMutate = store.compareMutate;
    let revokeOnce = true;
    store.compareMutate = async entries => {
      if (revokeOnce && entries.some(entry => entry.key === links.keys.challenge(logoutChallenge.challengeId) && entry.value === null)) {
        revokeOnce = false; await store.del('auth:session:' + hash(logoutRace.token));
      }
      return trackedMutate(entries);
    };
    try {
      r = await call(proof(logoutRace.token, logoutChallenge, S[7], E[7]));
      check('logout immediately before the atomic write prevents linking', r.status, 401);
      check('logout races cannot leave partial pair indexes', [await store.get(links.keys.solana(S[7].address)), await store.get(links.keys.evm(E[7].address))], [null, null]);
    } finally { store.compareMutate = trackedMutate; }
    const ttlSession = await login(S[8]);
    const ttlChallenge = (await challenge(ttlSession.token, E[8])).body;
    await call(proof(ttlSession.token, ttlChallenge, S[8], E[8]));
    now = ttlSession.expiresAt;
    r = await call({ action: 'unlink', token: ttlSession.token });
    check('linking does not extend the original session TTL', r.status, 401);
    r = await call({ action: 'link-challenge', token: ttlSession.token, evmAddress: E[9].address, domain: 'ott.test', uri: URI });
    check('expired sessions cannot request link approvals', r.status, 401);
    const ownAgain = await login(S[8]);
    r = await call({ action: 'link', token: ownAgain.token });
    check('link mappings persist beyond individual login sessions', r.body.linkedWallet.address, E[8].address);

    const staleUnlink = await login(S[10]), newerSession = await login(S[10]);
    const oldPair = (await challenge(staleUnlink.token, E[10])).body;
    await call(proof(staleUnlink.token, oldPair, S[10], E[10]));
    let replaceOnce = true;
    store.compareMutate = async entries => {
      if (replaceOnce && entries.some(entry => entry.key === links.keys.solana(S[10].address) && entry.value === null)) {
        replaceOnce = false;
        await call({ action: 'unlink', token: newerSession.token });
        const newPair = (await challenge(newerSession.token, E[11])).body;
        const linked = await call(proof(newerSession.token, newPair, S[10], E[11]));
        assert.equal(linked.status, 200);
      }
      return trackedMutate(entries);
    };
    try {
      r = await call({ action: 'unlink', token: staleUnlink.token });
      check('a stale unlink cannot retry across another unlink and remove a newly approved pair', r.status, 409);
      check('the newer linked pair survives the stale unlink', (await store.get(links.keys.solana(S[10].address))).evmAddress, E[11].address);
      check('the surviving pair retains its consistent reverse index', (await store.get(links.keys.evm(E[11].address))).solanaAddress, S[10].address);
    } finally { store.compareMutate = trackedMutate; }
    const sessionDeadline = await login(S[7]);
    now = sessionDeadline.expiresAt - 1000;
    const finalSecond = await call({ action: 'link-challenge', token: sessionDeadline.token, evmAddress: E[7].address, domain: 'ott.test', uri: URI });
    assert.equal(finalSecond.status, 200);
    let expireOnce = true;
    store.compareMutate = async entries => {
      if (expireOnce && entries.some(entry => entry.key === links.keys.challenge(finalSecond.body.challengeId) && entry.value === null)) {
        expireOnce = false; now = sessionDeadline.expiresAt;
      }
      return trackedMutate(entries);
    };
    try {
      r = await call(proof(sessionDeadline.token, finalSecond.body, S[7], E[7]));
      check('session expiry immediately before the atomic write prevents linking', r.status, 401);
      check('an expiry race leaves neither link index behind', [await store.get(links.keys.solana(S[7].address)), await store.get(links.keys.evm(E[7].address))], [null, null]);
    } finally { store.compareMutate = trackedMutate; }

    // Prior account sessions expired while exercising the authoritative deadline; renew to read.
    const reviewSession = await login(S[8]);

    console.log('\nmissing, corrupt and inconsistent indexes fail closed');
    const savedReverse = await store.get(links.keys.evm(E[8].address));
    await store.del(links.keys.evm(E[8].address));
    r = await call({ action: 'link', token: reviewSession.token });
    check('a missing reverse mapping cannot be used', r.status, 503);
    r = await call({ action: 'unlink', token: reviewSession.token });
    check('unlink cannot remove only half of an inconsistent pair', r.status, 503);
    await originalSet(links.keys.evm(E[8].address), savedReverse);
    const savedForward = await store.get(links.keys.solana(S[8].address));
    await store.del(links.keys.solana(S[8].address));
    r = await call({ action: 'link', token: reviewSession.token });
    check('the revision state detects a missing forward mapping', r.status, 503);
    await originalSet(links.keys.solana(S[8].address), false);
    r = await call({ action: 'link', token: reviewSession.token });
    check('malformed false-valued mappings fail closed', r.status, 503);
    await originalSet(links.keys.solana(S[8].address), savedForward);
    const revisionKey = links.keys.revision(S[8].address), savedRevision = await store.get(revisionKey);
    await originalSet(revisionKey, { revision: -1, evmAddress: E[8].address });
    r = await call({ action: 'link', token: reviewSession.token });
    check('corrupt revision state cannot authorize a link', r.status, 503);
    await originalSet(revisionKey, savedRevision);
    ok('all account/link mutations stay in the auth namespace without allowance or order writes', writeKeys.every(key => key.startsWith('auth:')));

    console.log('\ngeneric mutation batches preserve atomicity and expiration');
    const memory = stores.memoryStore();
    await memory.set('one', { value: 1 }, { ex: 1 });
    check('a failed batch changes no keys', await memory.compareMutate([{ key: 'one', expected: { wrong: true }, value: null }, { key: 'two', expected: null, value: { value: 2 } }]), false);
    check('failed batch leaves both prior values intact', [await memory.get('one'), await memory.get('two')], [{ value: 1 }, null]);
    check('a valid batch can compare only and create another key', await memory.compareMutate([{ key: 'one', expected: { value: 1 } }, { key: 'two', expected: null, value: { value: 2 } }]), true);
    advance();
    check('a compare-only entry preserves the original TTL', await memory.get('one'), null);
    await memory.set('ttl', { old: true }, { ex: 1 });
    await memory.compareMutate([{ key: 'ttl', expected: { old: true }, value: { changed: true } }]);
    advance();
    check('batch replacement also preserves prior TTL', await memory.get('ttl'), null);
    const races = await Promise.all([memory.compareMutate([{ key: 'pair', expected: null, value: { owner: 1 } }]), memory.compareMutate([{ key: 'pair', expected: null, value: { owner: 2 } }])]);
    check('competing batch creators have exactly one winner', races.filter(Boolean).length, 1);
    await assert.rejects(memory.compareMutate([{ key: 'dup', expected: null }, { key: 'dup', expected: null }]), /mutation/); checks++;
    await assert.rejects(memory.compareMutate([{ key: 'bad', value: {} }]), /mutation/); checks++;

    console.log('\nproduction REST batches verify and unlink real fixture pairs');
    const values = new Map(), expiry = new Map(), commands = [];
    let readWindow = null;
    const redis = http.createServer((req, res) => {
      let text = ''; req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const reply = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result })); };
        assert.equal(req.headers.authorization, 'Bearer fixture-token');
        const cmd = JSON.parse(text); commands.push(cmd);
        const expire = key => { if (expiry.has(key) && now >= expiry.get(key)) { values.delete(key); expiry.delete(key); } };
        if (cmd[0] === 'GET') {
          expire(cmd[1]);
          const value = values.get(cmd[1]) ?? null;
          if (readWindow && cmd[1] === readWindow.forwardKey && !readWindow.forward) {
            readWindow.forward = { reply, value };
            if (readWindow.revision) readWindow.ready();
            return;
          }
          if (readWindow && cmd[1] === readWindow.revisionKey && !readWindow.revision) {
            readWindow.revision = { reply, value };
            if (readWindow.forward) readWindow.ready();
            return;
          }
          return reply(value);
        }
        if (cmd[0] === 'SET') {
          expire(cmd[1]); if (cmd.includes('NX') && values.has(cmd[1])) return reply(null);
          values.set(cmd[1], cmd[2]); const ex = cmd.indexOf('EX');
          if (ex >= 0) expiry.set(cmd[1], now + Number(cmd[ex + 1]) * 1000); else expiry.delete(cmd[1]);
          return reply('OK');
        }
        if (cmd[0] === 'DEL') { const deleted = values.delete(cmd[1]); expiry.delete(cmd[1]); return reply(deleted ? 1 : 0); }
        if (cmd[0] === 'EVAL') {
          const count = Number(cmd[2]), names = cmd.slice(3, 3 + count), argv = cmd.slice(3 + count);
          names.forEach(expire);
          if (cmd[1].includes('#KEYS')) {
            for (let i = 0; i < count; i++) if (argv[i * 4] === 'missing' ? values.has(names[i]) : values.get(names[i]) !== argv[i * 4 + 1]) return reply(0);
            for (let i = 0; i < count; i++) {
              if (argv[i * 4 + 2] === 'delete') { values.delete(names[i]); expiry.delete(names[i]); }
              else if (argv[i * 4 + 2] === 'set') values.set(names[i], argv[i * 4 + 3]);
            }
            return reply(1);
          }
          const matches = values.get(names[0]) === argv[0];
          if (matches) { values.delete(names[0]); expiry.delete(names[0]); }
          return reply(matches ? 1 : 0);
        }
        throw new Error('unsupported fixture command');
      });
    });
    await new Promise(resolve => redis.listen(0, '127.0.0.1', resolve));
    process.env.STORE = 'upstash'; process.env.STORE_URL = 'http://127.0.0.1:' + redis.address().port; process.env.STORE_TOKEN = 'fixture-token'; process.env.NODE_ENV = 'production';
    try {
      const durable = await login(S[9]);
      const dc = (await challenge(durable.token, E[9])).body;
      const races = await Promise.all(Array.from({ length: 4 }, () => call(proof(durable.token, dc, S[9], E[9]))));
      check('REST multi-key batches consume nonce and create one consistent pair', races.map(x => x.status).sort(), [200, 401, 401, 401]);
      ok('atomic REST batches include all five keys', commands.some(cmd => cmd[0] === 'EVAL' && cmd[2] === '5' && cmd[1].includes('KEEPTTL')));
      ok('every REST batch key retains the deployment prefix', commands.filter(cmd => cmd[0] === 'EVAL').every(cmd => cmd.slice(3, 3 + Number(cmd[2])).every(key => key.startsWith('links-test:'))));
      const expiration = expiry.get('links-test:auth:session:' + hash(durable.token));
      check('link verification keeps the original Redis session expiry', expiration, durable.expiresAt);
      r = await call({ action: 'unlink', token: durable.token });
      check('REST unlink removes both indexes in the same batch', [r.status, values.has('links-test:' + links.keys.solana(S[9].address)), values.has('links-test:' + links.keys.evm(E[9].address))], [200, false, false]);
      const dc1 = (await challenge(durable.token, E[9])).body;
      const anotherSession = await login(S[9]);
      await call({ action: 'unlink', token: anotherSession.token });
      r = await call(proof(durable.token, dc1, S[9], E[9]));
      check('REST persistent revision invalidates proofs across active sessions', r.status, 409);
      ok('REST linking persists no bearer session token in link records or revision', [...values.entries()].filter(([key]) => key.includes('wallet-link:')).every(([, value]) => !value.includes(durable.token)));

      console.log('\nREST index reads straddling a winning atomic verification');
      const interleavedSession = await login(S[11]);
      const interleavedChallenge = (await challenge(interleavedSession.token, E[11])).body;
      const interleavedProof = proof(interleavedSession.token, interleavedChallenge, S[11], E[11]);
      let ready;
      const bothReadsHeld = new Promise(resolve => { ready = resolve; });
      readWindow = {
        forwardKey: 'links-test:' + links.keys.solana(S[11].address),
        revisionKey: 'links-test:' + links.keys.revision(S[11].address), ready,
      };
      const delayedVerification = call(interleavedProof);
      let readTimer;
      try {
        await Promise.race([bothReadsHeld, new Promise((_, reject) => {
          readTimer = setTimeout(() => reject(new Error('REST interleaving reads were not reached')), 4000);
        })]);
      } finally { clearTimeout(readTimer); }
      const winningVerification = await call(interleavedProof);
      check('the competing verifier atomically links while the earlier index reads are held', winningVerification.status, 200);
      const held = readWindow;
      readWindow = null;
      check('the held forward read predates the winning write', held.forward.value, null);
      const freshRevision = values.get(held.revisionKey);
      check('the revision read observes the winning write', JSON.parse(freshRevision).evmAddress, E[11].address);
      held.forward.reply(held.forward.value);
      held.revision.reply(freshRevision);
      check('a consumed proof rejects a mixed index snapshot as replay', (await delayedVerification).status, 401);
      check('the interleaved replay leaves the winning indexes consistent',
        values.get(held.forwardKey), values.get('links-test:' + links.keys.evm(E[11].address)));

      const corruptChallenge = (await challenge(interleavedSession.token, E[11])).body;
      const originalForward = values.get(held.forwardKey);
      values.set(held.forwardKey, 'false');
      r = await call(proof(interleavedSession.token, corruptChallenge, S[11], E[11]));
      check('an unconsumed proof with a corrupt REST index still fails closed', r.status, 503);
      ok('corrupt-index rejection does not consume or authorize the pending proof',
        values.has('links-test:' + links.keys.challenge(corruptChallenge.challengeId)));
      check('corrupt-index rejection does not alter the reverse ownership index',
        values.get('links-test:' + links.keys.evm(E[11].address)), originalForward);
      values.set(held.forwardKey, originalForward);
    } finally { redis.closeAllConnections(); await new Promise(resolve => redis.close(resolve)); }
  } finally { Date.now = realNow; }
  console.log('\nall ' + checks + ' wallet-link checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
