'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');

test.use({ serviceWorkers: 'block' });
const SOLANA = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const NEXT_SOLANA = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const EVM = '0x' + 'aB'.repeat(20);
const NEXT_EVM = '0x' + 'cD'.repeat(20);
const SIGNATURE = '0x' + 'ab'.repeat(65);
const MESSAGE = 'OT+T — link these wallets\nSolana: ' + SOLANA + '\nEVM: ' + EVM.toLowerCase() + '\nNonce: fixture123';

async function fixture(page, { injected = true, preexisting = false, selected = true } = {}) {
  stubNetwork(page);
  await page.route('**/link-wallet-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><title>Isolated link fixture</title></head><body><script src="./wallet.js"></script></body></html>' }));
  await page.addInitScript(({ solana, evm, signature, injected, preexisting }) => {
    const solanaHandlers = new Map(), evmHandlers = new Map();
    const add = (handlers, event, callback) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(callback);
    };
    const key = address => address ? { toString: () => address } : null;
    window.linkFixture = { evmCalls: [], solanaSigns: 0, remoteConnections: 0, remoteDisconnects: 0, globalEvents: [] };
    const solanaProvider = {
      isPhantom: true, publicKey: key(solana),
      on(event, callback) { add(solanaHandlers, event, callback); },
      off(event, callback) { solanaHandlers.get(event)?.delete(callback); },
      async connect() { solanaProvider.publicKey = key(solana); return { publicKey: solanaProvider.publicKey }; },
      async disconnect() { solanaProvider.publicKey = null; },
      async signIn() {
        window.linkFixture.solanaSigns++;
        return { account: { address: solana }, signedMessage: new Uint8Array([1, 2]), signature: new Uint8Array(64).fill(7) };
      },
      async request() { throw new Error('An EVM request must never reach the selected Solana provider.'); },
    };
    const namespaces = () => ({ eip155: { accounts: ['eip155:4663:' + evm], methods: ['personal_sign'] } });
    const evmProvider = {
      accounts: preexisting || injected ? [evm] : [], session: preexisting ? { topic: 'fixture-existing', namespaces: namespaces() } : null,
      on(event, callback) { add(evmHandlers, event, callback); },
      off(event, callback) { evmHandlers.get(event)?.delete(callback); },
      async connect() {
        window.linkFixture.remoteConnections++;
        if (window.rejectEvmConnection) throw Object.assign(new Error('User rejected EVM connection.'), { code: 4001 });
        if (window.deferEvmConnection) await new Promise(resolve => { window.finishEvmConnection = resolve; });
        evmProvider.accounts = [evm];
        evmProvider.session ||= { topic: 'fixture-temporary', namespaces: namespaces() };
        if (window.emitInitialSession) {
          for (const callback of evmHandlers.get('session_update') || []) callback({ params: { namespaces: namespaces() } });
          for (const callback of evmHandlers.get('chainChanged') || []) callback('0x1237');
        }
      },
      async disconnect() {
        window.linkFixture.remoteDisconnects++;
        evmProvider.session = null; evmProvider.accounts = [];
        for (const callback of evmHandlers.get('disconnect') || []) callback({ code: 4900 });
      },
      async request(args) {
        window.linkFixture.evmCalls.push(args);
        if (args.method === 'eth_requestAccounts') {
          if (window.rejectEvmConnection) throw Object.assign(new Error('User rejected EVM connection.'), { code: 4001 });
          if (window.deferEvmConnection) await new Promise(resolve => { window.finishEvmConnection = resolve; });
          return [evm];
        }
        if (args.method === 'personal_sign') {
          if (window.deferEvmSignature) await new Promise(resolve => { window.finishEvmSignature = resolve; });
          return window.badEvmSignature === undefined ? signature : window.badEvmSignature;
        }
        throw new Error('Unexpected EVM action: ' + args.method);
      },
    };
    window.emitEvm = (event, value) => {
      if (event === 'accountsChanged') evmProvider.accounts = value;
      if (event === 'disconnect' || event === 'session_delete') { evmProvider.accounts = []; evmProvider.session = null; }
      for (const callback of [...evmHandlers.get(event) || []]) callback(value);
    };
    window.emitSolana = (event, value) => {
      if (event === 'accountChanged') solanaProvider.publicKey = key(value);
      if (event === 'disconnect') solanaProvider.publicKey = null;
      for (const callback of [...solanaHandlers.get(event) || []]) callback(event === 'accountChanged' ? key(value) : value);
    };
    window.evmListenerCount = () => [...evmHandlers.values()].reduce((count, callbacks) => count + callbacks.size, 0);
    window.linkSolanaProvider = solanaProvider;
    window.phantom = { solana: solanaProvider };
    if (injected) window.ethereum = evmProvider;
    window.OTTWalletConnectSDK = { init: async () => evmProvider };
  }, { solana: SOLANA, evm: EVM, signature: SIGNATURE, injected, preexisting });
  await page.goto('/link-wallet-fixture.html');
  await page.evaluate(async selected => {
    window.OTTWallet.configure({ projectId: '11111111111111111111111111111111', chainId: 4663, rpc: 'https://rpc.fixture.example' });
    if (selected) await window.OTTWallet.connect({ transport: 'solana' });
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) window.OTTWallet.on(event, value => window.linkFixture.globalEvents.push({ event, value }));
  }, selected);
}

async function unchangedSolana(page) {
  expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual([SOLANA]);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('solana');
  expect(await page.evaluate(() => window.OTTWallet.getProvider() === window.linkSolanaProvider)).toBe(true);
  expect(await page.evaluate(() => window.linkFixture.globalEvents)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('ott-wallet-transport:/'))).toBe('solana');
}

test('linking requires a selected Solana wallet before any EVM connection request', async ({ page }) => {
  await fixture(page, { selected: false });
  expect(await page.evaluate(() => window.OTTWallet.evmLinkSigner().catch(error => error.code))).toBe('SOLANA_REQUIRED');
  expect(await page.evaluate(() => window.linkFixture.evmCalls)).toEqual([]);
});

test('isolated EVM ownership proof returns a canonical immutable address and leaves Solana usable', async ({ page }) => {
  await fixture(page);
  const address = await page.evaluate(async () => { window.linkSigner = await window.OTTWallet.evmLinkSigner(); return window.linkSigner.address; });
  expect(address).toBe(EVM.toLowerCase());
  expect(await page.evaluate(() => Object.isFrozen(window.linkSigner))).toBe(true);
  await unchangedSolana(page);
  expect(await page.evaluate(address => window.OTTWallet.request({ method: 'solana_signIn', params: { address } }).then(result => result.address), SOLANA)).toBe(SOLANA);
  expect(await page.evaluate(message => window.linkSigner.sign(message), MESSAGE)).toBe(SIGNATURE);
  const calls = await page.evaluate(() => window.linkFixture.evmCalls);
  expect(calls.map(call => call.method)).toEqual(['eth_requestAccounts', 'personal_sign']);
  expect(Buffer.from(calls[1].params[0].slice(2), 'hex').toString('utf8')).toBe(MESSAGE);
  expect(calls[1].params[1]).toBe(EVM.toLowerCase());
  await unchangedSolana(page);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain(EVM.toLowerCase());
  expect(storage).not.toContain(SIGNATURE);
  expect(storage).not.toContain('fixture123');
  await page.evaluate(() => window.linkSigner.release());
});

test('missing or rejected EVM connections leave Solana selected and release the proof lease', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { window.rejectEvmConnection = true; });
  expect(await page.evaluate(() => window.OTTWallet.evmLinkSigner().catch(error => error.code))).toBe(4001);
  await unchangedSolana(page);
  expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
  await page.evaluate(() => { window.rejectEvmConnection = false; });
  await page.evaluate(async () => { const signer = await window.OTTWallet.evmLinkSigner(); await signer.release(); });
  await page.evaluate(() => { delete window.ethereum; window.OTTWallet.configure({}); });
  expect(await page.evaluate(() => window.OTTWallet.evmLinkSigner().catch(error => error.code))).toBe('WALLETCONNECT_UNCONFIGURED');
  await unchangedSolana(page);
});

test('a changed EVM account during connection cannot become the proof address', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.deferEvmConnection = true;
    window.pendingLink = window.OTTWallet.evmLinkSigner().then(() => 'accepted').catch(error => error.code);
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishEvmConnection)).toBe('function');
  await page.evaluate(address => { window.emitEvm('accountsChanged', [address]); window.finishEvmConnection(); }, NEXT_EVM);
  expect(await page.evaluate(() => window.pendingLink)).toBe(4900);
  expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
  await unchangedSolana(page);
});

for (const event of ['accountsChanged', 'chainChanged', 'disconnect', 'session_delete', 'session_update']) {
  test('EVM ' + event + ' cancels a pending proof without changing the selected Solana account', async ({ page }) => {
    await fixture(page);
    await page.evaluate(async message => {
      window.linkSigner = await window.OTTWallet.evmLinkSigner();
      window.deferEvmSignature = true;
      window.pendingProof = window.linkSigner.sign(message).then(() => 'accepted').catch(error => error.code);
    }, MESSAGE);
    await expect.poll(() => page.evaluate(() => typeof window.finishEvmSignature)).toBe('function');
    await page.evaluate(({ event, next }) => {
      const value = event === 'accountsChanged' ? [next] : event === 'session_update' ? { params: { namespaces: { eip155: { accounts: [], methods: [] } } } } : '0x1';
      window.emitEvm(event, value); window.finishEvmSignature();
    }, { event, next: NEXT_EVM });
    expect(await page.evaluate(() => window.pendingProof)).toBe(4900);
    await unchangedSolana(page);
    await page.evaluate(() => window.linkSigner.release());
    expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
  });
}

for (const stage of ['connect', 'sign']) {
  for (const disconnect of [false, true]) {
    test('Solana ' + (disconnect ? 'disconnect' : 'account change') + ' during EVM ' + stage + ' refuses stale proof', async ({ page }) => {
      await fixture(page);
      await page.evaluate(async ({ stage, message }) => {
        if (stage === 'connect') {
          window.deferEvmConnection = true;
          window.pendingLink = window.OTTWallet.evmLinkSigner().then(() => 'accepted').catch(error => error.code);
        } else {
          window.linkSigner = await window.OTTWallet.evmLinkSigner();
          window.deferEvmSignature = true;
          window.pendingLink = window.linkSigner.sign(message).then(() => 'accepted').catch(error => error.code);
        }
      }, { stage, message: MESSAGE });
      await expect.poll(() => page.evaluate(stage => typeof window[stage === 'connect' ? 'finishEvmConnection' : 'finishEvmSignature'], stage)).toBe('function');
      await page.evaluate(async ({ stage, disconnect, next }) => {
        if (disconnect) await window.OTTWallet.disconnect();
        else window.emitSolana('accountChanged', next);
        window[stage === 'connect' ? 'finishEvmConnection' : 'finishEvmSignature']();
      }, { stage, disconnect, next: NEXT_SOLANA });
      expect(await page.evaluate(() => window.pendingLink)).toBe(4900);
      expect(await page.evaluate(() => window.OTTWallet.state().accounts)).toEqual(disconnect ? [] : [NEXT_SOLANA]);
      if (stage === 'sign') await page.evaluate(() => window.linkSigner.release());
      expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
    });
  }
}

test('malformed proof signatures are refused and releasing is idempotent with immediate listener cleanup', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => { window.linkSigner = await window.OTTWallet.evmLinkSigner(); });
  for (const signature of ['0x1234', '0x' + 'gg'.repeat(65), { signature: SIGNATURE }]) {
    await page.evaluate(signature => { window.badEvmSignature = signature; }, signature);
    expect(await page.evaluate(message => window.linkSigner.sign(message).catch(error => error.code), MESSAGE)).toBe('INVALID_LINK_SIGNATURE');
  }
  await page.evaluate(() => Promise.all([window.linkSigner.release(), window.linkSigner.release()]));
  expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
  expect(await page.evaluate(message => window.linkSigner.sign(message).catch(error => error.code), MESSAGE)).toBe(4900);
  await unchangedSolana(page);
  expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'injected' }))).toEqual([EVM]);
  expect(await page.evaluate(() => window.OTTWallet.state().chain)).toBe('evm');
});

for (const preexisting of [false, true]) {
  test('releasing a ' + (preexisting ? 'preexisting' : 'new temporary') + ' WalletConnect proof keeps Solana and closes only a new session', async ({ page }) => {
    await fixture(page, { injected: false, preexisting });
    await page.evaluate(() => { window.emitInitialSession = true; });
    expect(await page.evaluate(async () => { window.linkSigner = await window.OTTWallet.evmLinkSigner(); return window.linkSigner.address; })).toBe(EVM.toLowerCase());
    expect(await page.evaluate(message => window.linkSigner.sign(message), MESSAGE)).toBe(SIGNATURE);
    await page.evaluate(() => window.linkSigner.release());
    expect(await page.evaluate(() => window.linkFixture.remoteDisconnects)).toBe(preexisting ? 0 : 1);
    expect(await page.evaluate(() => window.evmListenerCount())).toBe(0);
    await unchangedSolana(page);
  });
}

test('concurrent leases and approvals are refused without sharing prompts, while Solana signing still works', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.deferEvmConnection = true;
    window.pendingLink = window.OTTWallet.evmLinkSigner().then(signer => { window.linkSigner = signer; });
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishEvmConnection)).toBe('function');
  expect(await page.evaluate(() => window.OTTWallet.evmLinkSigner().catch(error => error.code))).toBe('LINK_IN_PROGRESS');
  expect(await page.evaluate(() => window.OTTWallet.connect({ transport: 'injected' }).catch(error => error.code))).toBe('LINK_IN_PROGRESS');
  await page.evaluate(async () => { window.finishEvmConnection(); await window.pendingLink; });
  await page.evaluate(message => {
    window.deferEvmSignature = true;
    window.pendingProof = window.linkSigner.sign(message);
  }, MESSAGE);
  await expect.poll(() => page.evaluate(() => typeof window.finishEvmSignature)).toBe('function');
  expect(await page.evaluate(message => window.linkSigner.sign(message).catch(error => error.code), MESSAGE)).toBe('LINK_IN_PROGRESS');
  expect(await page.evaluate(address => window.OTTWallet.request({ method: 'solana_signIn', params: { address } }).then(result => result.address), SOLANA)).toBe(SOLANA);
  await page.evaluate(async () => { window.finishEvmSignature(); await window.pendingProof; await window.linkSigner.release(); });
  expect(await page.evaluate(() => window.linkFixture.evmCalls.map(call => call.method))).toEqual(['eth_requestAccounts', 'personal_sign']);
  await unchangedSolana(page);
});
