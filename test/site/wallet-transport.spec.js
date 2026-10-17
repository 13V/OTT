'use strict';
/**
 * site/wallet.js on its own: how the page finds Solana wallets, connects one, remembers it, signs
 * with it and forgets it. A bare fixture page loads only solana.js and wallet.js, so every call
 * here is the module's own behaviour, not the app's around it.
 *
 * The standard wallet is the shared fake (support/wallet.js): it registers through the Wallet
 * Standard like Phantom and Solflare, signs with a real ed25519 key, and records each request.
 * Wallets that misbehave, and Phantom's older injected provider, are hand-built in this file.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const crypto = require('crypto');
const { stubNetwork, BLOCKHASH } = require('./support/network.js');
const { installWallet, keyFor, walletAddress, TX_SIGNATURE, STORAGE_KEY } = require('./support/wallet.js');
const { S, addressFrom } = require('./support/solana.js');

test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress('holder');
const NEXT = walletAddress('second account');
const MESSAGE = ['OT+T — show my eSIM codes', 'Site: 127.0.0.1', 'Wallet: ' + ADDRESS, 'Issued: 1792245000'].join('\n');

async function openFixture(page) {
  stubNetwork(page);
  await page.route('**/wallet-fixture.html', (route) => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><meta charset="utf-8"><title>Wallet fixture</title></head><body>'
    + '<script src="./solana.js"></script><script src="./wallet.js"></script></body></html>' }));
  await page.goto('/wallet-fixture.html');
}

/** Runs an OTTWallet call in the page and answers { value } or { error: { code, message } }. */
const attempt = (page, script, arg) => page.evaluate(async ({ script, arg }) => {
  try { return { value: await (0, eval)(script)(arg) }; } catch (error) { return { error: { code: error.code, message: error.message } }; }
}, { script: String(script), arg });

const storage = (page) => page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));

/**
 * A hand-built standard wallet, for what the shared fake deliberately does well. `signs` picks how
 * its signMessage misbehaves: 'echo' (well-formed), 'other-bytes', 'short' or 'array'. `late`
 * holds its registration back until the spec calls window.__registerLate().
 */
async function rawWallet(page, { name, address = addressFrom('raw ' + name), chains = ['solana:mainnet'], signs = 'echo', late = false, icon = '',
  features = ['standard:connect', 'standard:events', 'solana:signMessage', 'solana:signAndSendTransaction'] }) {
  await page.addInitScript((o) => {
    window.__raw = window.__raw || {};
    const log = (window.__raw[o.name] = { connects: 0, signs: 0, sends: 0 });
    const account = Object.freeze({ address: o.address, publicKey: new Uint8Array(32), chains: o.chains, features: [] });
    let accounts = [];
    const all = {
      'standard:connect': { version: '1.0.0', async connect() { log.connects++; accounts = [account]; return { accounts: accounts.slice() }; } },
      'standard:events': { version: '1.0.0', on() { return () => {}; } },
      'solana:signMessage': { version: '1.0.0', async signMessage(input) {
        log.signs++;
        const signature = o.signs === 'short' ? new Uint8Array(63).fill(7) : o.signs === 'array' ? Array(64).fill(7) : new Uint8Array(64).fill(7);
        const signedMessage = o.signs === 'other-bytes' ? new TextEncoder().encode('OT+T — authorise a data redemption') : input.message;
        return [{ signedMessage, signature }];
      } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], async signAndSendTransaction() { log.sends++; return [{ signature: new Uint8Array(64).fill(9) }]; } },
    };
    const wallet = { version: '1.0.0', name: o.name, icon: o.icon, chains: o.chains,
      get accounts() { return accounts.slice(); }, features: Object.fromEntries(o.features.map((f) => [f, all[f]])) };
    const announce = (api) => api.register(wallet);
    if (o.late) {
      window.__registerLate = () => window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: announce }));
      return;
    }
    window.addEventListener('wallet-standard:app-ready', (event) => announce(event.detail));
  }, { name, address, chains, signs, late, icon, features });
  return address;
}

/**
 * Phantom's injected provider (window.phantom.solana, or window.solana on older installs), for a
 * browser where Phantom has not registered as a standard wallet. Its key and its record of this
 * site's approval live in Node, so both survive a reload.
 */
async function legacyPhantom(page, { at = 'phantom' } = {}) {
  const key = keyFor('legacy phantom');
  const state = { trusted: false, log: [] };
  await page.exposeFunction('__legacyPhantom', (method, payload) => {
    state.log.push(Object.assign({ method }, payload));
    if (method === 'connect') {
      if (payload.onlyIfTrusted && !state.trusted) return { error: { code: 4001, message: 'User rejected the request.' } };
      state.trusted = true;
      return { publicKey: key.address };
    }
    if (method === 'signMessage') return { signature: crypto.sign(null, Buffer.from(payload.message, 'base64'), key.privateKey).toString('base64') };
    if (method === 'signAndSendTransaction') return { signature: TX_SIGNATURE, publicKey: key.address };
    return {};
  });
  await page.addInitScript(({ at }) => {
    const handlers = new Map();
    const keyOf = (value) => (value ? { toString: () => value, toBase58: () => value } : null);
    const toBase64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
    const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const call = async (method, payload) => {
      const out = await window.__legacyPhantom(method, payload || {});
      if (out && out.error) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      return out;
    };
    const emit = (event, value) => { for (const callback of [...(handlers.get(event) || [])]) callback(value); };
    const provider = {
      isPhantom: true,
      publicKey: null,
      on(event, callback) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(callback); },
      removeListener(event, callback) { handlers.get(event)?.delete(callback); },
      async connect(options) {
        const out = await call('connect', { onlyIfTrusted: !!(options && options.onlyIfTrusted) });
        provider.publicKey = keyOf(out.publicKey);
        return { publicKey: provider.publicKey };
      },
      async disconnect() { await call('disconnect'); provider.publicKey = null; emit('disconnect'); },
      async signMessage(bytes, display) {
        const out = await call('signMessage', { message: toBase64(bytes), display });
        return { signature: fromBase64(out.signature), publicKey: provider.publicKey };
      },
      async request({ method, params }) {
        if (method !== 'signAndSendTransaction') throw new Error('Unsupported legacy request ' + method);
        return call('signAndSendTransaction', { params });
      },
    };
    window.__legacyEmit = (event, address) => { provider.publicKey = keyOf(address); emit(event, event === 'accountChanged' ? keyOf(address) : undefined); };
    window.__legacyListeners = () => [...handlers.values()].reduce((n, set) => n + set.size, 0);
    if (at === 'phantom') window.phantom = { solana: provider };
    else window.solana = provider;
  }, { at });
  return { key, state };
}

test('wallets are found through the Wallet Standard, whether they register before or after the page', async ({ page }) => {
  await installWallet(page, { name: 'Phantom' });
  await rawWallet(page, { name: 'Backpack', late: true });
  await openFixture(page);
  expect(await page.evaluate(() => window.OTTWallet.wallets().map((w) => w.name))).toEqual(['Phantom']);
  expect(await page.evaluate(() => window.OTTWallet.available())).toBe(true);
  // The shared fake has a data: icon; a wallet without one gets the chooser's letter mark instead.
  expect(await page.evaluate(() => window.OTTWallet.wallets()[0].icon)).toMatch(/^data:image\/svg\+xml;base64,/);

  await page.evaluate(() => { window.__changes = []; window.OTTWallet.on('walletsChanged', (list) => window.__changes.push(list.map((w) => w.name))); });
  await page.evaluate(() => window.__registerLate());
  expect(await page.evaluate(() => window.__changes)).toEqual([['Phantom', 'Backpack']]);
  expect(await page.evaluate(() => window.OTTWallet.wallets())).toEqual([
    { name: 'Phantom', icon: expect.stringMatching(/^data:image\//) }, { name: 'Backpack', icon: '' }]);
  // Nothing was asked of either wallet just by being found.
  expect(await page.evaluate(() => window.__raw.Backpack)).toEqual({ connects: 0, signs: 0, sends: 0 });
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: null, accounts: [], connected: false });
});

test('only wallets on Solana mainnet that can connect, sign messages and send transactions are offered', async ({ page }) => {
  await rawWallet(page, { name: 'Devnet only', chains: ['solana:devnet'] });
  await rawWallet(page, { name: 'An Ethereum wallet', chains: ['eip155:1'] });
  await rawWallet(page, { name: 'Cannot send', features: ['standard:connect', 'standard:events', 'solana:signMessage'] });
  await rawWallet(page, { name: 'Cannot sign', features: ['standard:connect', 'standard:events', 'solana:signAndSendTransaction'] });
  await rawWallet(page, { name: 'Solflare' });
  await openFixture(page);
  expect(await page.evaluate(() => window.OTTWallet.wallets().map((w) => w.name))).toEqual(['Solflare']);
  // A registration that throws is ignored, and the page carries on.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: () => { throw new Error('broken'); } })));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: 'not a function' })));
  expect(await page.evaluate(() => window.OTTWallet.wallets().map((w) => w.name))).toEqual(['Solflare']);
  expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ value: [expect.any(String)] });
});

test('connecting shares one account and remembers only which wallet it was', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  // One installed wallet connects without being named.
  expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ value: [ADDRESS] });
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: 'Phantom', accounts: [ADDRESS], connected: true });
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: false }]);
  // The wallet's name, and nothing about the account, is all the browser keeps.
  expect(await storage(page)).toEqual({ local: { [STORAGE_KEY]: 'Phantom' }, session: {} });
});

test('a first visit never connects by itself, and a reload reconnects silently only while the wallet still trusts this site', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
  expect(wallet.calls()).toEqual([]);

  await attempt(page, () => window.OTTWallet.connect({ wallet: 'Phantom' }));
  await page.reload();
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [ADDRESS] });
  expect(wallet.calls().slice(1)).toEqual([{ method: 'connect', silent: true }]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(true);

  // The holder removed this site in their wallet: the reload asks quietly and takes no for an answer.
  wallet.trusted = false;
  await page.reload();
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
  expect(wallet.calls().slice(2)).toEqual([{ method: 'connect', silent: true }]);
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: null, accounts: [], connected: false });
});

test('a remembered wallet that is no longer installed is not swapped for another one', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom', trusted: true });
  await page.addInitScript((key) => localStorage.setItem(key, 'Solflare'), STORAGE_KEY);
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
  expect(wallet.calls()).toEqual([]);
});

test('a declined connection is reported and leaves nothing connected or remembered', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom', connect: 'reject' });
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ error: { code: 4001, message: 'The connection was not approved.' } });
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await storage(page)).toEqual({ local: {}, session: {} });
  // A later, deliberate attempt works.
  wallet.behave({ connect: 'approve' });
  expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ value: [ADDRESS] });
});

test('disconnecting forgets the wallet, tells the page, and a reload does not reconnect it', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  await attempt(page, () => window.OTTWallet.connect());
  await page.evaluate(() => {
    window.__events = [];
    window.OTTWallet.on('accountsChanged', (accounts) => window.__events.push(['accountsChanged', accounts]));
    window.OTTWallet.on('disconnect', (reason) => window.__events.push(['disconnect', reason]));
  });
  await attempt(page, () => window.OTTWallet.disconnect());
  expect(await page.evaluate(() => window.__events)).toEqual([['accountsChanged', []], ['disconnect', { code: 4900, message: 'Wallet disconnected.' }]]);
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: null, accounts: [], connected: false });
  expect(wallet.calls().map((c) => c.method)).toEqual(['connect', 'disconnect']);
  expect(await storage(page)).toEqual({ local: {}, session: {} });
  // A signature can no longer be asked for.
  expect(await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE)).toEqual({ error: { code: 4900, message: 'Connect your wallet first.' } });

  await page.reload();
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
  expect(wallet.calls()).toHaveLength(2);
});

test('a message is signed as its exact UTF-8 bytes and comes back as a base58 signature of the account’s key', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  expect(await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE)).toEqual({ error: { code: 4900, message: 'Connect your wallet first.' } });
  await attempt(page, () => window.OTTWallet.connect());
  const { value: signature } = await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE);
  expect(S.isSignature(signature)).toBe(true);
  expect(wallet.verify(MESSAGE, signature)).toBe(true);
  expect(wallet.verify(MESSAGE.replace('codes', 'code'), signature)).toBe(false);
  expect(wallet.calls('signMessage')).toEqual([{ method: 'signMessage', message: MESSAGE, account: ADDRESS }]);

  // Messages the site would never build are refused before the wallet sees them.
  for (const bad of ['', 'x'.repeat(2049), 42]) {
    expect(await attempt(page, (text) => window.OTTWallet.signMessage(text), bad)).toEqual({ error: { code: 'INVALID_MESSAGE', message: 'The message to sign is invalid.' } });
  }
  expect(wallet.calls('signMessage')).toHaveLength(1);

  wallet.behave({ sign: 'reject' });
  expect(await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE)).toEqual({ error: { code: 4001, message: 'The request was not approved in your wallet.' } });
  // Declining a signature leaves the connection as it was.
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([ADDRESS]);
});

for (const [signs, message] of [
  ['other-bytes', 'The wallet signed a different message. Nothing was sent.'],
  ['short', 'The wallet returned an invalid signature.'],
  ['array', 'The wallet returned an invalid signature.'],
]) {
  test('a wallet whose signature is ' + { 'other-bytes': 'over other bytes', short: 'too short', array: 'not bytes' }[signs] + ' is refused', async ({ page }) => {
    await rawWallet(page, { name: 'Odd wallet', signs });
    await openFixture(page);
    await attempt(page, () => window.OTTWallet.connect());
    expect(await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE)).toEqual({ error: { code: 'INVALID_SIGNATURE', message } });
    expect(await page.evaluate(() => window.__raw['Odd wallet'].signs)).toBe(1);
  });
}

test('a wallet that shares an invalid address, or none, does not connect', async ({ page }) => {
  await rawWallet(page, { name: 'Odd wallet', address: '1'.repeat(31) });
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ error: { code: 4900, message: 'The wallet did not share an account.' } });
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await storage(page)).toEqual({ local: {}, session: {} });
});

test('a transaction goes to the wallet as its exact wire bytes on Solana mainnet, and the wallet’s signature comes back in base58', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  await attempt(page, () => window.OTTWallet.connect());
  const to = addressFrom('recipient');
  const build = (arg) => {
    const S = window.OTTSolana;
    const message = S.compileMessage({ payer: arg.from, blockhash: arg.blockhash, instructions: [S.systemTransfer({ from: arg.from, to: arg.to, lamports: 5000 })] });
    return { wire: S.wireTransaction(message), message };
  };
  const sent = await page.evaluate(async ({ build, arg }) => {
    const { wire, message } = (0, eval)(build)(arg);
    return { signature: await window.OTTWallet.signAndSendTransaction(wire, message), wire: window.OTTSolana.encodeBase64(wire) };
  }, { build: String(build), arg: { from: ADDRESS, to, blockhash: BLOCKHASH } });
  expect(sent.signature).toBe(TX_SIGNATURE);
  const [call] = wallet.calls('signAndSendTransaction');
  expect(call.chain).toBe('solana:mainnet');
  expect(call.options).toEqual({ commitment: 'confirmed' });
  expect(call.account).toBe(ADDRESS);
  expect(call.wire.toString('base64')).toBe(sent.wire);
  expect(call.transaction.blockhash).toBe(BLOCKHASH);
  expect(call.transaction.signatures).toBe(1);
  expect(call.transaction.instructions).toEqual([{ program: S.PROGRAMS.system, accounts: [ADDRESS, to],
    data: Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from([0x88, 0x13, 0, 0, 0, 0, 0, 0])]) }]);

  // Not bytes: refused before the wallet is asked.
  expect(await attempt(page, () => window.OTTWallet.signAndSendTransaction('not bytes', new Uint8Array(1)))).toEqual({ error: { code: 'INVALID_TRANSACTION', message: 'The transaction is invalid.' } });
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);

  // A declined send, and a wallet that cannot send it, say which.
  const again = async () => page.evaluate(async ({ build, arg }) => {
    const { wire, message } = (0, eval)(build)(arg);
    try { return { value: await window.OTTWallet.signAndSendTransaction(wire, message) }; } catch (error) { return { error: { code: error.code, message: error.message } }; }
  }, { build: String(build), arg: { from: ADDRESS, to, blockhash: BLOCKHASH } });
  wallet.behave({ send: 'reject' });
  expect(await again()).toEqual({ error: { code: 4001, message: 'The request was not approved in your wallet.' } });
  wallet.behave({ send: 'error' });
  expect(await again()).toEqual({ error: { code: -32603, message: 'Transaction simulation failed: insufficient funds for fee.' } });
});

test('a send the wallet answers after the account changed still reports its signature and the account that sent it', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom', send: 'hold', sign: 'hold' });
  await openFixture(page);
  await attempt(page, () => window.OTTWallet.connect());
  const to = addressFrom('recipient');
  await page.evaluate(({ arg }) => {
    const S = window.OTTSolana;
    const message = S.compileMessage({ payer: arg.from, blockhash: arg.blockhash, instructions: [S.systemTransfer({ from: arg.from, to: arg.to, lamports: 5000 })] });
    const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error: { code: error.code, message: error.message, signature: error.signature, account: error.account } }));
    window.__send = settle(window.OTTWallet.signAndSendTransaction(S.wireTransaction(message), message));
    window.__sign = settle(window.OTTWallet.signMessage(arg.text));
  }, { arg: { from: ADDRESS, to, blockhash: BLOCKHASH, text: MESSAGE } });
  await expect.poll(() => wallet.calls('signAndSendTransaction').length + wallet.calls('signMessage').length).toBe(2);

  // The person switches account while both prompts are open, then approves them.
  await wallet.switchTo(page, 'second account');
  wallet.behave({ send: 'approve', sign: 'approve' });
  wallet.release('signAndSendTransaction');
  wallet.release('signMessage');
  // The transaction may land, so the page is told what was sent and by whom...
  expect(await page.evaluate(() => window.__send)).toEqual({ error: { code: 4900, message: 'Your wallet changed while the transaction was being sent. It may still go through.', signature: TX_SIGNATURE, account: ADDRESS } });
  // ...while a message signature for the account the page has left is simply dropped.
  expect(await page.evaluate(() => window.__sign)).toEqual({ error: { code: 4900, message: 'Your wallet changed. Please try again.' } });
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([NEXT]);
});

test('connecting a wallet the chooser named never connects a different one instead', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.connect({ wallet: 'Solflare' }))).toEqual({ error: { code: 'WALLET_UNAVAILABLE', message: 'Solflare is no longer available. Choose another wallet.' } });
  expect(wallet.calls()).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await attempt(page, () => window.OTTWallet.connect({ wallet: 'Phantom' }))).toEqual({ value: [ADDRESS] });
});

test('account changes in the wallet follow through, and revoking this site’s access disconnects and forgets it', async ({ page }) => {
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  await attempt(page, () => window.OTTWallet.connect());
  await page.evaluate(() => {
    window.__events = [];
    window.OTTWallet.on('accountsChanged', (accounts) => window.__events.push(['accountsChanged', accounts]));
    window.OTTWallet.on('disconnect', (reason) => window.__events.push(['disconnect', reason]));
  });
  await wallet.switchTo(page, 'second account');
  expect(await page.evaluate(() => window.__events)).toEqual([['accountsChanged', [NEXT]]]);
  expect(await page.evaluate(() => window.OTTWallet.state())).toEqual({ chain: 'solana', wallet: 'Phantom', accounts: [NEXT], connected: true });
  // The new account signs with its own key.
  const { value: signature } = await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE);
  expect(wallet.verify(MESSAGE, signature, NEXT)).toBe(true);
  expect(wallet.verify(MESSAGE, signature, ADDRESS)).toBe(false);

  await wallet.switchTo(page, null);
  expect(await page.evaluate(() => window.__events.slice(1))).toEqual([['accountsChanged', []], ['disconnect', { code: 4900, message: 'Wallet access was removed.' }]]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await storage(page)).toEqual({ local: {}, session: {} });
});

for (const at of ['phantom', 'solana']) {
  test('Phantom’s injected provider (window.' + (at === 'phantom' ? 'phantom.solana' : 'solana') + ') is used when Phantom has not registered as a standard wallet', async ({ page }) => {
    const legacy = await legacyPhantom(page, { at });
    await openFixture(page);
    expect(await page.evaluate(() => window.OTTWallet.wallets())).toEqual([{ name: 'Phantom', icon: '' }]);
    expect(await attempt(page, () => window.OTTWallet.connect())).toEqual({ value: [legacy.key.address] });
    expect(legacy.state.log).toEqual([{ method: 'connect', onlyIfTrusted: false }]);

    const { value: signature } = await attempt(page, (text) => window.OTTWallet.signMessage(text), MESSAGE);
    expect(legacy.state.log[1]).toEqual({ method: 'signMessage', message: Buffer.from(MESSAGE, 'utf8').toString('base64'), display: 'utf8' });
    expect(crypto.verify(null, Buffer.from(MESSAGE, 'utf8'), legacy.key.publicKey, Buffer.from(S.decodeBase58(signature)))).toBe(true);

    // The injected provider takes the message itself, base58-encoded, and answers a base58 signature.
    const sent = await page.evaluate(async ({ from, blockhash }) => {
      const S = window.OTTSolana;
      const message = S.compileMessage({ payer: from, blockhash, instructions: [S.computeUnitLimit(40000)] });
      return { signature: await window.OTTWallet.signAndSendTransaction(S.wireTransaction(message), message), message: S.encodeBase58(message) };
    }, { from: legacy.key.address, blockhash: BLOCKHASH });
    expect(sent.signature).toBe(TX_SIGNATURE);
    expect(legacy.state.log[2]).toEqual({ method: 'signAndSendTransaction', params: { message: sent.message } });

    // Account events follow the provider; a reload reconnects only through onlyIfTrusted.
    await page.evaluate((address) => window.__legacyEmit('accountChanged', address), NEXT);
    expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([NEXT]);
    await page.reload();
    expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [legacy.key.address] });
    expect(legacy.state.log[3]).toEqual({ method: 'connect', onlyIfTrusted: true });
    await attempt(page, () => window.OTTWallet.disconnect());
    expect(legacy.state.log[4]).toEqual({ method: 'disconnect' });
    expect(await page.evaluate(() => window.__legacyListeners())).toBe(0);
    await page.reload();
    expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
    expect(legacy.state.log).toHaveLength(5);
  });
}

test('a reload asks Phantom’s injected provider only for a trusted reconnection, and stays disconnected when it says no', async ({ page }) => {
  const legacy = await legacyPhantom(page);
  await page.addInitScript((key) => localStorage.setItem(key, 'Phantom'), STORAGE_KEY);
  await openFixture(page);
  expect(await attempt(page, () => window.OTTWallet.restore())).toEqual({ value: [] });
  expect(legacy.state.log).toEqual([{ method: 'connect', onlyIfTrusted: true }]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

test('a standard Phantom is used instead of its injected provider, which is never touched', async ({ page }) => {
  const legacy = await legacyPhantom(page);
  const wallet = await installWallet(page, { name: 'Phantom' });
  await openFixture(page);
  const listed = await page.evaluate(() => window.OTTWallet.wallets());
  expect(listed).toHaveLength(1);
  expect(listed[0]).toEqual({ name: 'Phantom', icon: expect.stringMatching(/^data:image\//) });
  expect(await attempt(page, () => window.OTTWallet.connect({ wallet: 'Phantom' }))).toEqual({ value: [ADDRESS] });
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: false }]);
  expect(legacy.state.log).toEqual([]);
});

test('openIn links open this page inside the Phantom or Solflare app', async ({ page }) => {
  await openFixture(page);
  const target = 'https://13v.github.io/OTT/#/app';
  const links = await page.evaluate((url) => ({ phantom: window.OTTWallet.openIn('Phantom', url), solflare: window.OTTWallet.openIn('Solflare', url), here: window.OTTWallet.openIn('Phantom') }), target);
  const origin = new URL(page.url()).origin;
  expect(links.phantom).toBe('https://phantom.app/ul/browse/' + encodeURIComponent(target) + '?ref=' + encodeURIComponent(origin));
  expect(links.solflare).toBe('https://solflare.com/ul/v1/browse/' + encodeURIComponent(target) + '?ref=' + encodeURIComponent(origin));
  expect(links.here).toBe('https://phantom.app/ul/browse/' + encodeURIComponent(page.url()) + '?ref=' + encodeURIComponent(origin));
});
