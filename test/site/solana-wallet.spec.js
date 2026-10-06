'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });
const EVM = '0x4444444444444444444444444444444444444444';
function addressOf(byte) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt('0x' + Buffer.alloc(32, byte).toString('hex'));
  let out = '';
  while (number) { out = alphabet[Number(number % 58n)] + out; number /= 58n; }
  return out;
}
const ADDRESS = addressOf(1);
const NEXT = addressOf(2);
const INPUT = { domain: '127.0.0.1', address: ADDRESS, statement: 'Sign in to your OTT account.',
  uri: 'http://127.0.0.1/', version: '1', nonce: 'fixture123', issuedAt: '2026-10-06T00:00:00.000Z' };

async function fixture(page, { legacy = false, missing = false, resumed = false, trusted = true, injected = false } = {}) {
  stubNetwork(page);
  await page.route('**/solana-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><title>Solana wallet fixture</title></head><body><script src="./wallet.js"></script></body></html>' }));
  await page.addInitScript(({ address, evm, legacy, missing, resumed, trusted, injected }) => {
    const handlers = new Map();
    const key = value => value ? { toString: () => value } : null;
    window.fixtureSolana = { connects: [], signs: [], disconnects: 0, evmRequests: [], disconnectedAccounts: [] };
    const provider = {
      isPhantom: true, publicKey: key(address),
      on(event, callback) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(callback);
      },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async connect(options) {
        window.fixtureSolana.connects.push(options || {});
        if (options?.onlyIfTrusted && !trusted) throw Object.assign(new Error('Not trusted.'), { code: 4001 });
        provider.publicKey = key(window.fixtureConnectAddress || address);
        const result = { publicKey: provider.publicKey };
        if (window.deferSolanaConnect) await new Promise(resolve => { window.finishSolanaConnect = resolve; });
        return result;
      },
      async disconnect() {
        window.fixtureSolana.disconnects++;
        if (window.deferSolanaDisconnect) await new Promise(resolve => { window.finishSolanaDisconnect = resolve; });
        provider.publicKey = null;
        for (const callback of handlers.get('disconnect') || []) callback();
      },
      async signIn(input) {
        window.fixtureSolana.signs.push(input);
        if (window.rejectSolanaSignature) throw Object.assign(new Error('User rejected sign-in.'), { code: 4001 });
        const result = { account: { address: window.fixtureSignedAddress || address },
          signedMessage: new TextEncoder().encode('fixture message ' + input.nonce),
          signature: new Uint8Array(64).fill(7), signatureType: 'ed25519' };
        if (window.fixtureBadSignature) result.signature = new Uint8Array(63);
        if (window.deferSolanaSignature) await new Promise(resolve => { window.finishSolanaSignature = resolve; });
        return result;
      },
      async request() { throw new Error('Solana must never receive EVM RPC requests.'); },
    };
    window.fixtureSolanaProvider = provider;
    window.emitSolana = (event, value) => {
      if (event === 'accountChanged') provider.publicKey = key(value);
      if (event === 'disconnect') provider.publicKey = null;
      for (const callback of [...handlers.get(event) || []]) callback(event === 'accountChanged' ? key(value) : value);
    };
    window.solanaListenerCount = () => [...handlers.values()].reduce((n, callbacks) => n + callbacks.size, 0);
    if (!missing) {
      if (legacy) window.solana = provider;
      else window.phantom = { solana: provider };
    }
    if (resumed) localStorage.setItem('ott-wallet-transport:/', 'solana');
    if (injected) window.ethereum = {
      on() {}, off() {},
      async request({ method }) {
        window.fixtureSolana.evmRequests.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [evm];
        if (method === 'eth_chainId') return '0x1237';
        throw new Error('Unexpected EVM fixture action: ' + method);
      },
    };
  }, { address: ADDRESS, evm: EVM, legacy, missing, resumed, trusted, injected });
  await page.goto('/solana-fixture.html');
}

test('missing Phantom reports an actionable error without opening an EVM wallet', async ({ page }) => {
  await fixture(page, { missing: true, injected: true });
  expect(await page.evaluate(() => window.OTTWallet.solanaAvailable())).toBe(false);
  const error = await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }).catch(error => ({ code: error.code, message: error.message })));
  expect(error.code).toBe('WALLET_UNAVAILABLE');
  expect(error.message).toContain('Phantom');
  expect(await page.evaluate(() => window.fixtureSolana.evmRequests)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBeNull();
});

for (const legacy of [false, true]) {
  test('Phantom ' + (legacy ? 'legacy' : 'preferred') + ' provider shares a case-sensitive address and signs only a native SIWS request', async ({ page }) => {
    await fixture(page, { legacy });
    expect(await page.evaluate(() => window.OTTWallet.solanaAvailable())).toBe(true);
    expect(await page.evaluate(() => window.OTTWallet.available())).toBe(false);
    expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }))).toEqual([ADDRESS]);
    const result = await page.evaluate(async input => {
      const response = await window.OTTWallet.request({ method: 'solana_signIn', params: input });
      return { ...response, signedMessage: [...response.signedMessage], signature: [...response.signature] };
    }, INPUT);
    expect(result.address).toBe(ADDRESS);
    expect(result.signature).toHaveLength(64);
    expect(result.signedMessage.length).toBeGreaterThan(0);
    expect(result.signatureType).toBe('ed25519');
    expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('solana');
    expect(await page.evaluate(() => window.fixtureSolana.signs)).toEqual([INPUT]);
    expect(await page.evaluate(() => window.fixtureSolana.evmRequests)).toEqual([]);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(storage).not.toContain(ADDRESS);
    expect(storage).not.toContain(INPUT.nonce);
    expect(storage).not.toContain('fixture message');
  });
}

test('explicit Solana restoration uses onlyIfTrusted and never requests a signature or EVM account', async ({ page }) => {
  await fixture(page, { resumed: true, injected: true });
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.fixtureSolana.connects)).toEqual([{ onlyIfTrusted: true }]);
  expect(await page.evaluate(() => window.fixtureSolana.signs)).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSolana.evmRequests)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('solana');
});

test('an untrusted remembered Solana wallet remains disconnected without falling back to EVM', async ({ page }) => {
  await fixture(page, { resumed: true, trusted: false, injected: true });
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSolana.connects)).toEqual([{ onlyIfTrusted: true }]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await page.evaluate(() => window.fixtureSolana.evmRequests)).toEqual([]);
});

test('a first visit never connects Phantom implicitly and disconnect during trusted restoration cannot revive a session', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSolana.connects)).toEqual([]);
  await page.evaluate(() => {
    localStorage.setItem('ott-wallet-transport:/', 'solana');
    window.deferSolanaConnect = true;
    window.pendingSolanaRestore = window.OTTWallet.restore();
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishSolanaConnect)).toBe('function');
  await page.evaluate(async () => { await window.OTTWallet.disconnect(); window.finishSolanaConnect(); });
  expect(await page.evaluate(() => window.pendingSolanaRestore)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

for (const disconnect of [false, true]) {
  test('a native ' + (disconnect ? 'revocation' : 'account change') + ' before trusted restoration finishes cannot restore an older key', async ({ page }) => {
    await fixture(page, { resumed: true });
    await page.evaluate(() => {
      window.deferSolanaConnect = true;
      window.pendingSolanaRestore = window.OTTWallet.restore();
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishSolanaConnect)).toBe('function');
    await page.evaluate(({ disconnect, next }) => {
      window.emitSolana(disconnect ? 'disconnect' : 'accountChanged', disconnect ? null : next);
      window.finishSolanaConnect();
    }, { disconnect, next: NEXT });
    expect(await page.evaluate(() => window.pendingSolanaRestore)).toEqual([]);
    expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
    expect(await page.evaluate(() => window.solanaListenerCount())).toBe(0);
  });
}

test('a missing native signIn method asks for an update without downgrading to arbitrary message signing', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    delete window.fixtureSolanaProvider.signIn;
    window.fixtureSolanaProvider.signMessage = () => { throw new Error('Must not sign an arbitrary message.'); };
    await window.OTTWallet.connect({ transport: 'solana' });
  });
  const error = await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).catch(error => ({ code: error.code, message: error.message })), INPUT);
  expect(error.code).toBe('SOLANA_SIGNIN_UNAVAILABLE');
  expect(error.message).toContain('Update Phantom');
});

test('case-sensitive input and signed account mismatches cannot authenticate another Solana account', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }));
  const wrongInput = await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).catch(error => error.code), { ...INPUT, address: ADDRESS.toLowerCase() });
  expect(wrongInput).toBe('ACCOUNT_MISMATCH');
  expect(await page.evaluate(() => window.fixtureSolana.signs)).toEqual([]);
  await page.evaluate(address => { window.fixtureSignedAddress = address; }, NEXT);
  expect(await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).catch(error => error.code), INPUT)).toBe('ACCOUNT_MISMATCH');
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([ADDRESS]);
});

test('invalid public keys and malformed signature bytes are refused', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { window.fixtureConnectAddress = '1'.repeat(31); });
  expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }).catch(error => error.code))).toBe(4900);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  await page.evaluate(() => { delete window.fixtureConnectAddress; window.fixtureBadSignature = true; });
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }));
  expect(await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).catch(error => error.code), INPUT)).toBe('INVALID_SIGNIN');
});

test('declining a native sign-in keeps only the shared address and permits a later deliberate retry', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => { await window.OTTWallet.connect({ transport: 'solana' }); window.rejectSolanaSignature = true; });
  expect(await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).catch(error => error.code), INPUT)).toBe(4001);
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([ADDRESS]);
  await page.evaluate(() => { window.rejectSolanaSignature = false; });
  expect(await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).then(response => response.address), INPUT)).toBe(ADDRESS);
});

for (const revoke of [false, true]) {
  test('a pending Solana signature is revoked by ' + (revoke ? 'disconnect' : 'account change') + ' and a later explicit connection works', async ({ page }) => {
    await fixture(page);
    await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }));
    await page.evaluate(input => {
      window.deferSolanaSignature = true;
      window.pendingSolanaSignIn = window.OTTWallet.request({ method: 'solana_signIn', params: input }).then(() => 'accepted').catch(error => error.code);
    }, INPUT);
    await expect.poll(() => page.evaluate(() => typeof window.finishSolanaSignature)).toBe('function');
    await page.evaluate(({ revoke, next }) => {
      window.emitSolana(revoke ? 'disconnect' : 'accountChanged', revoke ? null : next);
      window.finishSolanaSignature();
    }, { revoke, next: NEXT });
    expect(await page.evaluate(() => window.pendingSolanaSignIn)).toBe(4900);
    expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual(revoke ? [] : [NEXT]);
    await page.evaluate(() => { window.deferSolanaSignature = false; });
    expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }))).toEqual([ADDRESS]);
    expect(await page.evaluate(input => window.OTTWallet.request({ method: 'solana_signIn', params: input }).then(response => response.address), INPUT)).toBe(ADDRESS);
  });
}

test('a repeated account event also revokes a pending native sign-in', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }));
  await page.evaluate(input => {
    window.deferSolanaSignature = true;
    window.pendingSolanaSignIn = window.OTTWallet.request({ method: 'solana_signIn', params: input }).then(() => 'accepted').catch(error => error.code);
  }, INPUT);
  await expect.poll(() => page.evaluate(() => typeof window.finishSolanaSignature)).toBe('function');
  await page.evaluate(address => { window.emitSolana('accountChanged', address); window.finishSolanaSignature(); }, ADDRESS);
  expect(await page.evaluate(() => window.pendingSolanaSignIn)).toBe(4900);
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([ADDRESS]);
});

test('revocation during native connection cannot revive a captured public key', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.deferSolanaConnect = true;
    window.pendingSolanaConnect = window.OTTWallet.connect({ transport: 'solana' }).then(() => 'accepted').catch(error => error.code);
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishSolanaConnect)).toBe('function');
  await page.evaluate(() => { window.emitSolana('accountChanged', null); window.finishSolanaConnect(); });
  expect(await page.evaluate(() => window.pendingSolanaConnect)).toBe(4900);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([]);
});

test('local disconnect clears Solana immediately, detaches events and prevents automatic restoration', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    await window.OTTWallet.connect({ transport: 'solana' });
    window.deferSolanaDisconnect = true;
    window.pendingSolanaDisconnect = window.OTTWallet.disconnect();
  });
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([]);
  expect(await page.evaluate(() => window.solanaListenerCount())).toBe(0);
  await page.evaluate(address => window.emitSolana('accountChanged', address), NEXT);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  await page.evaluate(async () => { window.finishSolanaDisconnect(); await window.pendingSolanaDisconnect; });
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
  expect(await page.evaluate(() => window.fixtureSolana.connects)).toHaveLength(1);
});

test('switching between EVM and Solana revokes the former selection and the EVM automatic default is preserved', async ({ page }) => {
  await fixture(page, { injected: true });
  await page.evaluate(() => { window.OTTWallet.on('accountsChanged', accounts => window.fixtureSolana.disconnectedAccounts.push(accounts)); });
  expect(await page.evaluate(() => window.OTTWallet.connect())).toEqual([EVM]);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('evm');
  expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'solana' }))).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.fixtureSolana.disconnectedAccounts)).toContainEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.request({ method: 'personal_sign', params: [] }).catch(error => error.code))).toBe('WRONG_WALLET_CHAIN');
  expect(await page.evaluate(() => window.OTTWallet.connect())).toEqual([EVM]);
  expect(await page.evaluate(() => window.fixtureSolana.disconnects)).toBe(1);
  expect(await page.evaluate(() => window.solanaListenerCount())).toBe(0);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('evm');
  expect(await page.evaluate(() => window.OTTWallet.request({ method: 'solana_signIn', params: {} }).catch(error => error.code))).toBe('WRONG_WALLET_CHAIN');
  expect(await page.evaluate(() => window.fixtureSolana.evmRequests)).toEqual(['eth_requestAccounts', 'eth_requestAccounts']);
});
