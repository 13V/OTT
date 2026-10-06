'use strict';
const { test, expect } = require('@playwright/test');
const { generateKeyPairSync, sign, verify } = require('node:crypto');
const { stubNetwork } = require('./support/network');
const secp = require('../../site/api/_lib/secp256k1');
const eip191 = require('../../site/api/_lib/eip191');

test.use({ serviceWorkers: 'block' });
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
function solanaMessage(input) {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
}
function evmMessage(input, address) {
  return ['OT+T — link wallets', 'Purpose: Link accounts only; no funds, redemption, or installation-code access.',
    'Site: ' + input.domain, 'URI: ' + input.uri, 'Solana Wallet: ' + input.address,
    'Robinhood Chain Wallet: ' + address, 'Chain ID: 4663', 'Nonce: ' + input.nonce,
    'Issued At: ' + input.issuedAt, 'Expiration Time: ' + input.expirationTime].join('\n');
}

async function customer(page, { mutateChallenge, extraLinkFields = false } = {}) {
  // These disposable, unfunded keys never leave this local fixture process.
  const keys = generateKeyPairSync('ed25519'), evmKey = secp.newPrivateKey();
  const address = base58(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  const other = base58(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  const evm = secp.addressOf(evmKey).toLowerCase();
  const publicLink = { address: evm, chain: 'evm', chainId: 4663 };
  const account = { address, chain: 'solana', verified: true, credit: 0, eligible: false };
  let persistedLink = null, challengeCount = 0, sessionCount = 0, lastLinkChallenge;
  const requests = [], tokens = [], pending = new Map();
  function holdNext(action) {
    let arrived, release;
    const wait = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { arrived = resolve; });
    pending.set(action, { arrived, wait });
    return { started, release };
  }
  stubNetwork(page);
  await page.route('**/holder-link-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><title>Holder link client fixture</title></head><body><script src="./client-config.js"></script><script src="./wallet.js"></script><script src="./solana-login.js"></script></body></html>' }));
  await page.exposeFunction('signHolderSolana', input => {
    const bytes = Buffer.from(solanaMessage(input));
    return { signedMessage: [...bytes], signature: [...sign(null, bytes, keys.privateKey)] };
  });
  await page.exposeFunction('signHolderEvm', hex => eip191.sign(evmKey, Buffer.from(hex.slice(2), 'hex').toString('utf8')));
  await page.route('**/api/auth', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const now = new Date().toISOString(), expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const input = statement => ({ address, domain: body.domain, uri: body.uri, statement, version: '1', chainId: 'solana:mainnet',
      nonce: 'fixtureNonce' + (++challengeCount), issuedAt: now, expirationTime });
    let response, status = 200;
    if (body.action === 'challenge') response = { ok: true, challengeId: 'c'.repeat(48), input: input('Sign in to OTT. This does not move funds.') };
    else if (body.action === 'verify') {
      const token = 'fixture-session-token-' + 'a'.repeat(40) + (++sessionCount); tokens.push(token);
      response = { ok: true, token, expiresAt: Date.now() + 30 * 60 * 1000, account, linkedWallet: persistedLink };
    } else if (body.action === 'link-challenge') {
      const solanaInput = input('Link this Solana account to Robinhood Chain wallet ' + evm + ' on OTT. This does not move funds.');
      lastLinkChallenge = { ok: true, challengeId: 'd'.repeat(48), solanaInput, evmMessage: evmMessage(solanaInput, evm) };
      response = structuredClone(lastLinkChallenge);
      if (mutateChallenge) mutateChallenge(response, { address, other, evm });
    } else if (body.action === 'link-verify') {
      const expected = Buffer.from(solanaMessage(lastLinkChallenge.solanaInput));
      const valid = body.addressSOL === address && body.evmAddress === evm && body.challengeId === lastLinkChallenge.challengeId
        && Buffer.from(body.signedMessage, 'base64').equals(expected)
        && verify(null, expected, keys.publicKey, Buffer.from(body.signature, 'base64'))
        && eip191.recoverAddress(lastLinkChallenge.evmMessage, body.evmSignature) === evm;
      if (!valid) { status = 401; response = { ok: false, error: 'The fixture did not receive both expected ownership proofs.' }; }
      else {
        persistedLink = { ...publicLink };
        response = { ok: true, linkedWallet: extraLinkFields ? { ...publicLink, privateProof: 'fixture-private-proof', token: tokens[0] } : publicLink,
          account: { ...account, credit: 999, eligible: true } };
      }
    } else if (body.action === 'link') response = { ok: true, linkedWallet: persistedLink ? { ...persistedLink } : null };
    else if (body.action === 'unlink') { persistedLink = null; response = { ok: true, linkedWallet: null }; }
    else if (body.action === 'logout') response = { ok: true };
    else { status = 400; response = { ok: false, error: 'Unexpected fixture action.' }; }
    const held = pending.get(body.action);
    if (held) { pending.delete(body.action); held.arrived(body); await held.wait; }
    await route.fulfill({ status, json: response });
  });
  await page.addInitScript(({ address, other, evm }) => {
    const handlers = new Map();
    const key = value => ({ toString: () => value });
    window.approvals = [];
    window.linkRouteCurrent = true;
    window.evmReleases = 0;
    const solanaProvider = {
      isPhantom: true, publicKey: key(address),
      on(event, callback) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(callback); },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async connect() { solanaProvider.publicKey = key(address); return { publicKey: solanaProvider.publicKey }; },
      async disconnect() { solanaProvider.publicKey = null; },
      async signIn(input) {
        const linking = input.statement.startsWith('Link ');
        window.approvals.push(linking ? 'solana-link' : 'solana-login');
        if (linking && window.rejectSolanaLink) throw Object.assign(new Error('User rejected Solana linking.'), { code: 4001 });
        if (linking && window.deferSolanaLink) await new Promise(resolve => { window.finishSolanaLink = resolve; });
        const signed = await window.signHolderSolana(input);
        return { account: { address: input.address }, signedMessage: new Uint8Array(signed.signedMessage), signature: new Uint8Array(signed.signature), signatureType: 'ed25519' };
      },
    };
    window.phantom = { solana: solanaProvider };
    window.ethereum = {
      on() {}, off() {},
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') {
          window.approvals.push('evm-connect');
          if (window.rejectEvmLinkConnection) throw Object.assign(new Error('User rejected EVM connection.'), { code: 4001 });
          return [evm];
        }
        if (method === 'personal_sign') {
          window.approvals.push('evm-link');
          if (window.rejectEvmLink) throw Object.assign(new Error('User rejected EVM linking.'), { code: 4001 });
          if (window.deferEvmLink) await new Promise(resolve => { window.finishEvmLink = resolve; });
          if (params[1] !== evm) throw new Error('Wrong fixture EVM account.');
          return window.signHolderEvm(params[0]);
        }
        throw new Error('No transaction or chain action is allowed: ' + method);
      },
    };
    window.changeLinkAccount = () => {
      solanaProvider.publicKey = key(other);
      for (const callback of handlers.get('accountChanged') || []) callback(solanaProvider.publicKey);
    };
  }, { address, other, evm });
  await page.goto('/holder-link-fixture.html');
  await page.evaluate(async address => {
    window.OTTWallet.on('accountsChanged', () => { void window.OTTSolanaLogin.reset(); });
    await window.OTTWallet.connect({ transport: 'solana' });
    await window.OTTSolanaLogin.login(address);
    const createSigner = window.OTTWallet.evmLinkSigner;
    window.OTTWallet.evmLinkSigner = async options => {
      const signer = await createSigner(options);
      return { ...signer, release: async () => { window.evmReleases++; await signer.release(); } };
    };
    window.startLink = () => window.OTTSolanaLogin.linkWallet({ isCurrent: () => window.linkRouteCurrent });
    window.approvals = [];
  }, address);
  return { address, other, evm, publicLink, account, requests, tokens, holdNext,
    replacePersistedLink(value) { persistedLink = value ? { ...value } : null; } };
}

test('both explicit approvals occur in order and linking exposes only public metadata without changing Solana credit', async ({ page }) => {
  const customerState = await customer(page, { extraLinkFields: true });
  await page.evaluate(() => {
    window.deferSolanaLink = true; window.deferEvmLink = true;
    window.pendingLink = window.startLink();
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishSolanaLink)).toBe('function');
  expect(await page.evaluate(() => window.approvals)).toEqual(['evm-connect', 'solana-link']);
  expect(customerState.requests.some(request => request.action === 'link-verify')).toBe(false);
  await page.evaluate(() => window.finishSolanaLink());
  await expect.poll(() => page.evaluate(() => typeof window.finishEvmLink)).toBe('function');
  expect(await page.evaluate(() => window.approvals)).toEqual(['evm-connect', 'solana-link', 'evm-link']);
  expect(customerState.requests.some(request => request.action === 'link-verify')).toBe(false);
  expect(await page.evaluate(async () => { window.finishEvmLink(); return window.pendingLink; })).toEqual(customerState.publicLink);
  const state = await page.evaluate(() => window.OTTSolanaLogin.state());
  expect(state.account).toEqual(customerState.account);
  expect(state.linkedWallet).toEqual(customerState.publicLink);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('solana');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const exposed = JSON.stringify(state);
  for (const token of customerState.tokens) { expect(storage).not.toContain(token); expect(exposed).not.toContain(token); }
  const proof = customerState.requests.find(request => request.action === 'link-verify');
  for (const value of [proof.signature, proof.signedMessage, proof.evmSignature, proof.challengeId, customerState.evm]) expect(storage).not.toContain(value);
  expect(exposed).not.toContain('fixture-private-proof');
  expect(await page.evaluate(() => window.evmReleases)).toBe(1);
});

const invalidChallenges = [
  ['Solana purpose', response => { response.solanaInput.statement = 'Approve a payment on OTT.'; }],
  ['EVM purpose', response => { response.evmMessage = response.evmMessage.replace('Link accounts only', 'Authorize redemption'); }],
  ['site', response => { response.solanaInput.domain = 'other.fixture.example'; }],
  ['URI', response => { response.solanaInput.uri += '?different=1'; }],
  ['Solana wallet', (response, data) => { response.solanaInput.address = data.other; }],
  ['EVM wallet', response => { response.evmMessage = response.evmMessage.replace('Robinhood Chain Wallet: 0x', 'Robinhood Chain Wallet: 0x00'); }],
  ['challenge identifier', response => { response.challengeId = 'wrong'; }],
  ['expiry', response => { response.solanaInput.expirationTime = new Date(Date.now() - 1000).toISOString(); }],
];
for (const [name, mutateChallenge] of invalidChallenges) {
  test('an altered ' + name + ' challenge is refused before either ownership approval', async ({ page }) => {
    const { requests } = await customer(page, { mutateChallenge });
    expect(await page.evaluate(() => window.startLink().catch(error => error.message))).toContain('invalid wallet-link request');
    expect(await page.evaluate(() => window.approvals)).toEqual(['evm-connect']);
    expect(requests.some(request => request.action === 'link-verify')).toBe(false);
    expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
    expect(await page.evaluate(() => window.evmReleases)).toBe(1);
  });
}

for (const rejected of ['connection', 'Solana approval', 'EVM approval']) {
  test('rejected ' + rejected + ' never submits link verification and leaves the Solana session usable', async ({ page }) => {
    const { requests, account } = await customer(page);
    await page.evaluate(rejected => {
      window.rejectEvmLinkConnection = rejected === 'connection';
      window.rejectSolanaLink = rejected === 'Solana approval';
      window.rejectEvmLink = rejected === 'EVM approval';
    }, rejected);
    expect(await page.evaluate(() => window.startLink().catch(error => error.message))).toContain('User rejected');
    expect(requests.some(request => request.action === 'link-verify')).toBe(false);
    expect(await page.evaluate(() => window.OTTSolanaLogin.state().account)).toEqual(account);
    expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
    await page.evaluate(() => { window.rejectEvmLinkConnection = window.rejectSolanaLink = window.rejectEvmLink = false; });
    expect(await page.evaluate(() => window.startLink())).toMatchObject({ chain: 'evm', chainId: 4663 });
  });
}

test('a stale link refresh cannot restore metadata removed by a later unlink', async ({ page }) => {
  const { holdNext, account } = await customer(page);
  await page.evaluate(() => window.startLink());
  const refresh = holdNext('link');
  await page.evaluate(() => { window.pendingRefresh = window.OTTSolanaLogin.refreshLink(); });
  await refresh.started;
  await page.evaluate(() => window.OTTSolanaLogin.unlinkWallet());
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
  refresh.release();
  expect(await page.evaluate(() => window.pendingRefresh)).toBeNull();
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().account)).toEqual(account);
});

test('pending unlink blocks overlapping operations and a later refresh reads another session’s new mapping', async ({ page }) => {
  const { holdNext, replacePersistedLink, requests, account } = await customer(page);
  await page.evaluate(() => window.startLink());
  const unlink = holdNext('unlink');
  await page.evaluate(() => { window.pendingUnlink = window.OTTSolanaLogin.unlinkWallet(); });
  await unlink.started;
  const requestCount = requests.length;
  const approvals = await page.evaluate(() => window.approvals);
  for (const operation of ['refreshLink', 'linkWallet', 'unlinkWallet']) {
    const result = await page.evaluate(operation => window.OTTSolanaLogin[operation]().then(() => 'accepted').catch(error => error.message), operation);
    expect(result).toContain('current wallet link change');
  }
  expect(requests).toHaveLength(requestCount);
  expect(await page.evaluate(() => window.approvals)).toEqual(approvals);
  // The pending request has already removed the old mapping in the fixture API.
  // A different authenticated session can subsequently confirm a new pair.
  const newer = { address: secp.addressOf(secp.newPrivateKey()).toLowerCase(), chain: 'evm', chainId: 4663 };
  replacePersistedLink(newer);
  unlink.release();
  await page.evaluate(() => window.pendingUnlink);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
  expect(await page.evaluate(() => window.OTTSolanaLogin.refreshLink())).toEqual(newer);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toEqual(newer);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().account)).toEqual(account);
  expect(requests.slice(requestCount).map(request => request.action)).toEqual(['link']);
});

for (const changed of ['route', 'account', 'session']) {
  test('a changed ' + changed + ' during ownership approval abandons the proof before verification', async ({ page }) => {
    const { requests } = await customer(page);
    await page.evaluate(() => {
      window.deferSolanaLink = true;
      window.pendingLink = window.startLink().then(() => 'accepted').catch(error => error.message);
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishSolanaLink)).toBe('function');
    await page.evaluate(async changed => {
      if (changed === 'route') window.linkRouteCurrent = false;
      else if (changed === 'account') window.changeLinkAccount();
      else await window.OTTSolanaLogin.reset();
      window.finishSolanaLink();
    }, changed);
    expect(await page.evaluate(() => window.pendingLink)).not.toBe('accepted');
    expect(requests.some(request => request.action === 'link-verify')).toBe(false);
    expect(await page.evaluate(() => window.approvals)).toEqual(['evm-connect', 'solana-link']);
    expect(await page.evaluate(() => window.evmReleases)).toBe(1);
    const state = await page.evaluate(() => window.OTTSolanaLogin.state());
    expect(state?.linkedWallet || null).toBeNull();
  });
}

test('an account changed while verification returns cannot populate the new session with an old link', async ({ page }) => {
  const { holdNext } = await customer(page);
  const verification = holdNext('link-verify');
  await page.evaluate(() => { window.pendingLink = window.startLink().then(() => 'accepted').catch(error => error.message); });
  await verification.started;
  await page.evaluate(() => window.changeLinkAccount());
  verification.release();
  expect(await page.evaluate(() => window.pendingLink)).toContain('account changed');
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBeNull();
  expect(await page.evaluate(() => window.evmReleases)).toBe(1);
});

test('a fresh login reads persisted public link metadata and unlink preserves the verified zero-credit identity', async ({ page }) => {
  const { address, publicLink, account, requests } = await customer(page);
  await page.evaluate(() => window.startLink());
  await page.evaluate(() => window.OTTSolanaLogin.reset());
  expect(await page.evaluate(() => window.OTTSolanaLogin.state())).toBeNull();
  await page.evaluate(address => window.OTTSolanaLogin.login(address), address);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toEqual(publicLink);
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().account)).toEqual(account);
  await page.evaluate(() => window.OTTSolanaLogin.unlinkWallet());
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().linkedWallet)).toBeNull();
  expect(await page.evaluate(() => window.OTTSolanaLogin.state().account)).toEqual(account);
  expect(requests.filter(request => request.action === 'verify')).toHaveLength(2);
});
