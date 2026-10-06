'use strict';

const crypto = require('node:crypto');
const solana = require('./solana-auth');
const eip191 = require('./eip191');
const CHAIN_ID = 4663;
const SECONDS = 5 * 60;
const keys = {
  solana: address => 'auth:wallet-link:solana:' + address,
  evm: address => 'auth:wallet-link:evm:' + address,
  revision: address => 'auth:wallet-link:revision:' + address,
  challenge: id => 'auth:wallet-link:challenge:' + id,
};
function fail(status, message) { const error = new Error(message); error.status = status; return error; }
function evmAddress(address) { return typeof address === 'string' && /^0x[0-9a-f]{40}$/.test(address) && !/^0x0{40}$/.test(address); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function linkedWallet(address) { return { address, chain: 'evm', chainId: CHAIN_ID }; }
function validRecord(record) {
  return record && record.version === 1 && solana.decodeAddress(record.solanaAddress)
    && evmAddress(record.evmAddress) && record.chainId === CHAIN_ID && Number.isFinite(Date.parse(record.linkedAt));
}
function validRevision(state) {
  return state && Number.isSafeInteger(state.revision) && state.revision >= 0
    && (state.evmAddress === null || evmAddress(state.evmAddress));
}
function assertLive(session) {
  if (!session || !solana.decodeAddress(session.address) || !Number.isSafeInteger(session.expiresAt)
    || Date.now() >= session.expiresAt) throw fail(401, 'session is invalid or expired');
}

// The revision state remembers whether a forward index should exist, and survives unlinking.
// That both detects missing indexes and invalidates old proofs across every session of this wallet.
async function ownPair(store, address) {
  const [forward, revision] = await Promise.all([store.get(keys.solana(address)), store.get(keys.revision(address))]);
  if (revision !== null && !validRevision(revision)) throw fail(503, 'wallet link requires review');
  if (forward === null) {
    if (revision?.evmAddress) throw fail(503, 'wallet link requires review');
    return { forward: null, reverse: null, revision };
  }
  if (!validRecord(forward) || forward.solanaAddress !== address || !revision || revision.evmAddress !== forward.evmAddress) {
    throw fail(503, 'wallet link requires review');
  }
  const reverse = await store.get(keys.evm(forward.evmAddress));
  if (!same(forward, reverse)) throw fail(503, 'wallet link requires review');
  return { forward, reverse, revision };
}

async function targetPair(store, address, target) {
  const own = await ownPair(store, address);
  if (own.forward && own.forward.evmAddress !== target) throw fail(409, 'this Solana wallet is already linked; unlink it before choosing another wallet');
  const reverse = own.forward ? own.reverse : await store.get(keys.evm(target));
  if (reverse !== null) {
    if (!validRecord(reverse) || reverse.evmAddress !== target) throw fail(503, 'wallet link requires review');
    const owner = reverse.solanaAddress === address ? own : await ownPair(store, reverse.solanaAddress);
    if (!owner.forward || !same(owner.forward, reverse)) throw fail(503, 'wallet link requires review');
    if (reverse.solanaAddress !== address) throw fail(409, 'this Robinhood Chain wallet is already linked to another Solana wallet');
  }
  return { ...own, reverse };
}

function evmMessage(input, target) {
  return [
    'OT+T — link wallets',
    'Purpose: Link accounts only; no funds, redemption, or installation-code access.',
    'Site: ' + input.domain, 'URI: ' + input.uri, 'Solana Wallet: ' + input.address,
    'Robinhood Chain Wallet: ' + target, 'Chain ID: ' + CHAIN_ID,
    'Nonce: ' + input.nonce, 'Issued At: ' + input.issuedAt, 'Expiration Time: ' + input.expirationTime,
  ].join('\n');
}

async function challenge(store, { sessionKey, session, sessionHash, site, evmAddress: target }) {
  assertLive(session);
  if (!evmAddress(target)) throw fail(400, 'a canonical lowercase Robinhood Chain wallet address is required');
  if (site.origin !== session.origin) throw fail(403, 'session belongs to another frontend');
  const pair = await targetPair(store, session.address, target);
  if (!(await store.set('auth:rate:wallet-link:' + session.address, {}, { nx: true, ex: 1 }))) throw fail(429, 'please wait a moment before linking again');
  const now = Date.now();
  const input = {
    domain: site.domain, address: session.address,
    statement: 'Link this Solana account to Robinhood Chain wallet ' + target + ' on OTT. This does not move funds.',
    uri: site.uri, version: '1', chainId: 'solana:mainnet', nonce: crypto.randomBytes(24).toString('hex'),
    issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + SECONDS * 1000).toISOString(),
  };
  const challengeId = crypto.randomBytes(24).toString('hex');
  const record = { input, evmAddress: target, evmMessage: evmMessage(input, target), origin: site.origin,
    sessionHash, linkRevision: pair.revision?.revision || 0, expiresAt: now + SECONDS * 1000 };
  assertLive(session);
  if (!(await store.compareMutate([
    { key: sessionKey, expected: session }, { key: keys.revision(session.address), expected: pair.revision },
    { key: keys.solana(session.address), expected: pair.forward },
  ]))) throw fail(409, 'wallet links changed; reload and sign again');
  if (!(await store.set(keys.challenge(challengeId), record, { nx: true, ex: SECONDS }))) throw fail(503, 'wallet link is temporarily unavailable');
  return { ok: true, challengeId, solanaInput: input, evmMessage: record.evmMessage };
}

async function verify(store, { sessionKey, session, sessionHash, body, checkFrontend }) {
  assertLive(session);
  if (typeof body.challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(body.challengeId)
    || body.addressSOL !== session.address || !evmAddress(body.evmAddress)
    || (body.signatureType !== undefined && body.signatureType !== 'ed25519')) throw fail(401, 'wallet link challenge is invalid or expired');
  const key = keys.challenge(body.challengeId);
  const record = await store.get(key);
  if (!record || !Number.isSafeInteger(record.expiresAt) || Date.now() >= record.expiresAt
    || record.sessionHash !== sessionHash || record.input?.address !== session.address
    || record.evmAddress !== body.evmAddress || record.origin !== session.origin
    || !Number.isSafeInteger(record.linkRevision)) throw fail(401, 'wallet link challenge is invalid or expired');
  checkFrontend(record.input);
  const expectedStatement = 'Link this Solana account to Robinhood Chain wallet ' + body.evmAddress + ' on OTT. This does not move funds.';
  if (record.input.statement !== expectedStatement || record.evmMessage !== evmMessage(record.input, body.evmAddress)
    || !solana.verify(record.input, body.signedMessage, body.signature)
    || typeof body.evmSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.evmSignature)
    || eip191.recoverAddress(record.evmMessage, body.evmSignature) !== body.evmAddress) throw fail(401, 'both wallet signatures are required to link accounts');
  for (let attempt = 0; attempt < 3; attempt++) {
    assertLive(session);
    if (Date.now() >= record.expiresAt) throw fail(401, 'wallet link challenge is invalid or expired');
    const pair = await targetPair(store, session.address, body.evmAddress);
    if ((pair.revision?.revision || 0) !== record.linkRevision) throw fail(409, 'wallet links changed; reload and sign again');
    const link = pair.forward || { version: 1, solanaAddress: session.address, evmAddress: body.evmAddress,
      chainId: CHAIN_ID, linkedAt: new Date().toISOString() };
    assertLive(session);
    if (await store.compareMutate([
      { key: sessionKey, expected: session }, { key, expected: record, value: null },
      { key: keys.revision(session.address), expected: pair.revision, value: { revision: record.linkRevision, evmAddress: body.evmAddress } },
      { key: keys.solana(session.address), expected: pair.forward, value: link },
      { key: keys.evm(body.evmAddress), expected: pair.reverse, value: link },
    ])) return { ok: true, linkedWallet: linkedWallet(body.evmAddress) };
    if (!same(await store.get(sessionKey), session)) throw fail(401, 'session is invalid or expired');
    if (!same(await store.get(key), record)) throw fail(401, 'wallet link challenge is invalid or expired');
  }
  throw fail(409, 'wallet links changed; reload and sign again');
}

async function unlink(store, { sessionKey, session }) {
  let baseline;
  for (let attempt = 0; attempt < 3; attempt++) {
    assertLive(session);
    const pair = await ownPair(store, session.address);
    const currentRevision = pair.revision?.revision || 0;
    if (baseline !== undefined && currentRevision !== baseline) {
      if (!pair.forward) return { ok: true, linkedWallet: null };
      throw fail(409, 'wallet links changed; reload and try again');
    }
    baseline = currentRevision;
    const revision = currentRevision + 1;
    if (!Number.isSafeInteger(revision)) throw fail(503, 'wallet link requires review');
    const entries = [
      { key: sessionKey, expected: session },
      { key: keys.revision(session.address), expected: pair.revision, value: { revision, evmAddress: null } },
      { key: keys.solana(session.address), expected: pair.forward, value: null },
    ];
    if (pair.forward) entries.push({ key: keys.evm(pair.forward.evmAddress), expected: pair.reverse, value: null });
    assertLive(session);
    if (await store.compareMutate(entries)) return { ok: true, linkedWallet: null };
    if (!same(await store.get(sessionKey), session)) throw fail(401, 'session is invalid or expired');
  }
  throw fail(409, 'wallet links changed; reload and try again');
}

async function read(store, address) {
  const pair = await ownPair(store, address);
  return pair.forward ? linkedWallet(pair.forward.evmAddress) : null;
}

module.exports = { challenge, verify, unlink, read, evmMessage, evmAddress, keys };
