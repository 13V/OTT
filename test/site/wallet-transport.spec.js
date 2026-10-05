'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });

const ADDRESS = '0x4444444444444444444444444444444444444444';
const NEXT_ADDRESS = '0x5555555555555555555555555555555555555555';
const SETTINGS = { projectId: '11111111111111111111111111111111', chainId: 4663,
  rpc: 'https://rpc.fixture.example', explorer: 'https://explorer.fixture.example' };

// Exercise the production transport with a local EIP-1193 provider. No relay,
// wallet application, real signature or provider order is involved.
async function fixture(page, { injected = false, resumed = false } = {}) {
  stubNetwork(page);
  await page.route('**/wallet-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><title>Wallet fixture</title></head><body><script src="./wallet.js"></script></body></html>' }));
  await page.addInitScript(({ address, injected, resumed }) => {
    window.fixtureWallet = { initCalls: [], connectCalls: 0, disconnectCalls: 0, requests: [], injectedRequests: [] };
    const handlers = new Map();
    const emit = (event, value) => { for (const callback of [...(handlers.get(event) || [])]) callback(value); };
    const provider = {
      accounts: resumed ? [address] : [], session: resumed ? { topic: 'fixture-session' } : null,
      on(event, callback) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(callback); },
      off(event, callback) { handlers.get(event)?.delete(callback); },
      async connect() { window.fixtureWallet.connectCalls++; provider.accounts = [address]; provider.session = { topic: 'fixture-session' }; },
      async disconnect() { window.fixtureWallet.disconnectCalls++; provider.accounts = []; provider.session = null; emit('disconnect', { code: 4900 }); },
      async request(args) {
        window.fixtureWallet.requests.push(args);
        if (args.method === 'eth_accounts') return provider.accounts;
        if (args.method === 'eth_chainId') return '0x1237';
        if (args.method === 'personal_sign') {
          if (window.deferFixtureSignature) return new Promise(resolve => { window.finishFixtureSignature = () => resolve('0xfixture-signature'); });
          return '0xfixture-signature';
        }
        if (args.method === 'wallet_switchEthereumChain') { emit('chainChanged', args.params[0].chainId); return null; }
        throw new Error('Unexpected fixture request: ' + args.method);
      },
    };
    window.fixtureProvider = provider;
    window.emitFixtureWalletEvent = (event, value) => {
      if (event === 'accountsChanged') provider.accounts = value;
      emit(event, value);
    };
    window.OTTWalletConnectSDK = { init: async options => {
      window.fixtureWallet.initCalls.push(options);
      if (window.deferFixtureInitialization) await new Promise(resolve => { window.finishFixtureInitialization = resolve; });
      return provider;
    } };
    if (resumed) localStorage.setItem('ott-wallet-transport:/', 'walletconnect');
    if (injected) window.ethereum = {
      request: async args => {
        window.fixtureWallet.injectedRequests.push(args);
        if (args.method === 'eth_accounts') return [address];
        if (args.method === 'eth_requestAccounts') {
          if (window.rejectFixtureInjected) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          return [address];
        }
        return provider.request(args);
      }, on: provider.on, off: provider.off,
    };
  }, { address: ADDRESS, injected, resumed });
  await page.goto('/wallet-fixture.html');
  await page.evaluate(settings => window.OTTWallet.configure(settings), SETTINGS);
}

test('injected sessions restore without prompting and rejection never opens another wallet', async ({ page }) => {
  await fixture(page, { injected: true });
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.fixtureWallet.injectedRequests.map(item => item.method))).toEqual(['eth_accounts']);
  expect(await page.evaluate(() => window.OTTWallet.connect())).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.OTTWallet.state().transport)).toBe('injected');
  await page.evaluate(() => { window.rejectFixtureInjected = true; });
  const rejected = await page.evaluate(async () => {
    try { await window.OTTWallet.connect(); return null; } catch (error) { return error.code; }
  });
  expect(rejected).toBe(4001);
  expect(await page.evaluate(() => window.fixtureWallet.initCalls)).toEqual([]);
  await page.evaluate(() => window.OTTWallet.disconnect());
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  const requestCount = await page.evaluate(() => window.fixtureWallet.injectedRequests.length);
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
  expect(await page.evaluate(() => window.fixtureWallet.injectedRequests.length)).toBe(requestCount);
});

test('mobile connection uses its own provider and disconnect clears the selected session immediately', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
  expect(await page.evaluate(() => window.fixtureWallet.initCalls)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'walletconnect' }))).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.ethereum)).toBeUndefined();
  expect(await page.evaluate(() => window.OTTWallet.state().transport)).toBe('walletconnect');
  expect(await page.evaluate(() => window.fixtureWallet.connectCalls)).toBe(1);
  expect(await page.evaluate(() => window.OTTWallet.request({ method: 'personal_sign', params: ['0xfixture', window.OTTWallet.state().accounts[0]] }))).toBe('0xfixture-signature');
  await page.evaluate(address => window.emitFixtureWalletEvent('accountsChanged', [address]), NEXT_ADDRESS);
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([NEXT_ADDRESS]);
  await page.evaluate(() => window.OTTWallet.disconnect());
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.getProvider())).toBeNull();
  expect(await page.evaluate(() => window.fixtureWallet.disconnectCalls)).toBe(1);
  const saved = await page.evaluate(() => ({ ...localStorage }));
  expect(saved['ott-wallet-transport:/']).toBe('disconnected');
  expect(JSON.stringify(saved)).not.toContain(ADDRESS);
  expect(JSON.stringify(saved)).not.toContain('0xfixture-signature');
});

test('remembered mobile session resumes without a connection or signing prompt', async ({ page }) => {
  await fixture(page, { resumed: true });
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([ADDRESS]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(true);
  expect(await page.evaluate(() => window.fixtureWallet.initCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.fixtureWallet.connectCalls)).toBe(0);
  expect(await page.evaluate(() => window.fixtureWallet.requests)).toEqual([]);
});

test('session deletion invalidates a signature that was still waiting on the wallet', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'walletconnect' }));
  await page.evaluate(() => {
    window.deferFixtureSignature = true;
    window.pendingFixtureSignature = window.OTTWallet.request({ method: 'personal_sign', params: ['0xfixture', window.OTTWallet.state().accounts[0]] })
      .then(value => ({ value })).catch(error => ({ code: error.code }));
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishFixtureSignature)).toBe('function');
  await page.evaluate(() => { window.emitFixtureWalletEvent('session_delete', {}); window.finishFixtureSignature(); });
  expect(await page.evaluate(() => window.pendingFixtureSignature)).toEqual({ code: 4900 });
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
});

test('expected network switching succeeds while a later chain change cancels a pending signature', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'walletconnect' }));
  expect(await page.evaluate(() => window.OTTWallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }))).toBeNull();
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(true);
  await page.evaluate(() => {
    window.deferFixtureSignature = true;
    window.pendingFixtureSignature = window.OTTWallet.request({ method: 'personal_sign', params: ['0xfixture', window.OTTWallet.state().accounts[0]] })
      .then(value => ({ value })).catch(error => ({ code: error.code }));
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishFixtureSignature)).toBe('function');
  await page.evaluate(() => { window.emitFixtureWalletEvent('chainChanged', '0x1'); window.finishFixtureSignature(); });
  expect(await page.evaluate(() => window.pendingFixtureSignature)).toEqual({ code: 4900 });
});

test('missing mobile project configuration never initializes the SDK or pretends to connect', async ({ page }) => {
  await fixture(page);
  await page.evaluate(settings => window.OTTWallet.configure({ ...settings, projectId: '' }), SETTINGS);
  expect(await page.evaluate(() => window.OTTWallet.available())).toBe(false);
  const result = await page.evaluate(async () => {
    try { await window.OTTWallet.connect({ transport: 'walletconnect' }); return null; } catch (error) { return { code: error.code, message: error.message }; }
  });
  expect(result.code).toBe('WALLETCONNECT_UNCONFIGURED');
  expect(result.message).toContain('project ID');
  expect(await page.evaluate(() => window.fixtureWallet.initCalls)).toEqual([]);
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});

test('disconnect cancels a mobile connection that was still initializing', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.deferFixtureInitialization = true;
    window.pendingFixtureConnection = window.OTTWallet.connect({ transport: 'walletconnect' })
      .then(value => ({ value })).catch(error => ({ code: error.code }));
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishFixtureInitialization)).toBe('function');
  await page.evaluate(async () => { await window.OTTWallet.disconnect(); window.finishFixtureInitialization(); });
  expect(await page.evaluate(() => window.pendingFixtureConnection)).toEqual({ code: 4900 });
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
  expect(await page.evaluate(() => window.fixtureWallet.connectCalls)).toBe(0);
  expect(await page.evaluate(() => window.OTTWallet.restore())).toEqual([]);
});

test('a session update that removes account approval cancels a pending signature', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.OTTWallet.connect({ transport: 'walletconnect' }));
  await page.evaluate(() => {
    window.deferFixtureSignature = true;
    window.pendingFixtureSignature = window.OTTWallet.request({ method: 'personal_sign', params: ['0xfixture', window.OTTWallet.state().accounts[0]] })
      .then(value => ({ value })).catch(error => ({ code: error.code }));
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishFixtureSignature)).toBe('function');
  await page.evaluate(() => {
    window.emitFixtureWalletEvent('session_update', { params: { namespaces: { eip155: { accounts: [], methods: [] } } } });
    window.finishFixtureSignature();
  });
  expect(await page.evaluate(() => window.pendingFixtureSignature)).toEqual({ code: 4900 });
  expect(await page.evaluate(() => window.OTTWallet.state().connected)).toBe(false);
});
