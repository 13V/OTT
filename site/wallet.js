'use strict';
/**
 * One EIP-1193 transport for the whole site. Injected wallets stay dependency-free;
 * the locally bundled WalletConnect SDK is loaded only for an explicit mobile
 * connection or a remembered WalletConnect session. No account or signature is
 * stored here. WalletConnect owns its encrypted pairing/session storage.
 */
(function () {
  const BASE = new URL('./', document.currentScript?.src || location.href);
  const STORAGE_KEY = 'ott-wallet-transport:' + BASE.pathname;
  const listeners = new Map();
  let settings = {};
  let provider = null;
  let remote = null;
  let transport = null;
  let accounts = [];
  let generation = 0;
  let lifecycle = 0;
  let bindings = [];
  let loadingSdk = null;
  let initializingRemote = null;
  let connecting = null;

  function injected() {
    return window.ethereum && typeof window.ethereum.request === 'function' ? window.ethereum : null;
  }
  function remembered() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }
  function remember(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (_) { /* Connection still works without storage. */ }
  }
  function normalize(value) {
    return Array.isArray(value) ? value.filter((a) => typeof a === 'string' && /^0x[\da-f]{40}$/i.test(a)) : [];
  }
  function failure(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function emit(event, value) {
    for (const callback of listeners.get(event) || []) {
      try { callback(value); } catch (error) { console.error('Wallet listener failed', error); }
    }
  }
  function detach() {
    for (const [source, event, callback] of bindings) {
      if (typeof source.removeListener === 'function') source.removeListener(event, callback);
      else source.off?.(event, callback);
    }
    bindings = [];
  }
  function clearCurrent(reason) {
    generation++;
    lifecycle++;
    detach();
    provider = null;
    transport = null;
    accounts = [];
    emit('accountsChanged', []);
    emit('disconnect', reason || { code: 4900, message: 'Wallet disconnected.' });
  }
  function bind(source, kind) {
    detach();
    provider = source;
    transport = kind;
    function listen(event, callback) {
      if (typeof source.on !== 'function') return;
      source.on(event, callback);
      bindings.push([source, event, callback]);
    }
    listen('accountsChanged', (value) => {
      if (provider !== source) return;
      generation++;
      accounts = normalize(value);
      if (!accounts.length) {
        remember('disconnected');
        clearCurrent({ code: 4900, message: 'Wallet access was removed.' });
        return;
      }
      emit('accountsChanged', accounts.slice());
    });
    listen('chainChanged', (value) => {
      if (provider !== source) return;
      generation++;
      emit('chainChanged', value);
    });
    listen('disconnect', (reason) => {
      if (provider !== source) return;
      remember('disconnected');
      clearCurrent(reason);
    });
    // EthereumProvider normally translates session_delete into disconnect. Some
    // compatible providers expose the original event too; never retain access.
    listen('session_delete', (reason) => {
      if (provider !== source) return;
      remember('disconnected');
      clearCurrent(reason);
    });
    listen('session_update', (value) => {
      if (provider !== source || kind !== 'walletconnect') return;
      const namespaces = value?.params?.namespaces || value?.namespaces || source.session?.namespaces;
      if (!namespaces) return;
      const approved = normalize(Object.entries(namespaces).filter(([name]) => name === 'eip155' || name.startsWith('eip155:'))
        .flatMap(([, namespace]) => namespace.accounts || []).map((account) => typeof account === 'string' ? account.split(':').pop() : null));
      const retained = accounts.filter((account) => approved.some((a) => a.toLowerCase() === account.toLowerCase()));
      generation++;
      accounts = retained;
      // Even unchanged accounts may have lost signing permissions. Invalidate
      // private reads and let the next user action check the updated session.
      if (!accounts.length) {
        remember('disconnected');
        clearCurrent({ code: 4900, message: 'The wallet session no longer includes this account.' });
        return;
      }
      emit('accountsChanged', accounts.slice());
    });
  }
  function configure(config) {
    settings = Object.assign({}, config || {});
  }
  function remoteAvailable() {
    return typeof settings.projectId === 'string' && /^[\da-f]{32}$/i.test(settings.projectId.trim()) &&
      Number.isSafeInteger(Number(settings.chainId)) && Number(settings.chainId) > 0 && typeof settings.rpc === 'string' && /^https:\/\//.test(settings.rpc);
  }
  async function sdk() {
    if (window.OTTWalletConnectSDK?.init) return window.OTTWalletConnectSDK;
    if (!loadingSdk) loadingSdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('vendor/walletconnect.js', BASE).href;
      script.async = true;
      script.onload = () => window.OTTWalletConnectSDK?.init ? resolve(window.OTTWalletConnectSDK) : reject(failure('The wallet connector could not start. Refresh and try again.', 'SDK_UNAVAILABLE'));
      script.onerror = () => { script.remove(); reject(failure('The mobile wallet connector could not load. Go online and try again.', 'SDK_UNAVAILABLE')); };
      document.head.appendChild(script);
    }).catch((error) => { loadingSdk = null; throw error; });
    return loadingSdk;
  }
  async function getRemote() {
    if (remote) return remote;
    if (!remoteAvailable()) throw failure('Mobile wallet connection needs a Reown project ID and network settings. Open OTT in your wallet browser for now.', 'WALLETCONNECT_UNCONFIGURED');
    if (!initializingRemote) initializingRemote = (async () => {
      const factory = await sdk();
      remote = await factory.init({
        projectId: settings.projectId.trim(),
        chainId: Number(settings.chainId),
        rpc: settings.rpc,
        explorer: settings.explorer || '',
        metadata: {
          name: 'OT+T',
          description: 'Mobile data for eligible OTT holders.',
          url: BASE.href,
          icons: [new URL('assets/app/icon-192.png', BASE).href],
        },
      });
      return remote;
    })().finally(() => { initializingRemote = null; });
    return initializingRemote;
  }
  async function restore() {
    if (remembered() === 'disconnected') return [];
    const op = generation;
    let source = null;
    let kind = null;
    let restored = [];
    if (remembered() === 'walletconnect' && remoteAvailable()) {
      source = await getRemote();
      kind = 'walletconnect';
      restored = source.session ? normalize(source.accounts) : [];
    } else if (injected()) {
      source = injected();
      kind = 'injected';
      restored = normalize(await source.request({ method: 'eth_accounts' }));
    }
    if (op !== generation || !source || !restored.length) return [];
    bind(source, kind);
    accounts = restored;
    return accounts.slice();
  }
  async function connect(options) {
    if (connecting) return connecting;
    connecting = (async () => {
      const choice = options?.transport || 'auto';
      if (!['auto', 'injected', 'walletconnect'].includes(choice)) throw failure('Unknown wallet connection method.', 'INVALID_TRANSPORT');
      const kind = choice === 'auto' ? (provider ? transport : injected() ? 'injected' : 'walletconnect') : choice;
      // A deliberate new connection supersedes an unfinished boot restoration
      // and any private request started under the previous selection.
      const opening = ++lifecycle;
      generation++;
      const source = kind === 'injected' ? injected() : await getRemote();
      if (opening !== lifecycle) throw failure('Wallet connection was cancelled. Please connect again.', 4900);
      if (!source) throw failure('No browser wallet was found. Open OTT in your wallet browser, or choose a mobile wallet.', 'WALLET_UNAVAILABLE');
      if (provider && provider !== source) {
        const releasing = disconnect();
        const released = lifecycle;
        await releasing;
        if (released !== lifecycle) throw failure('Wallet connection was cancelled. Please connect again.', 4900);
      }
      // Bind before the prompt so that revocations during connection clear state.
      bind(source, kind);
      const op = lifecycle;
      try {
        const result = kind === 'injected' ? await source.request({ method: 'eth_requestAccounts' }) : await source.connect();
        if (provider !== source || op !== lifecycle) throw failure('Wallet connection changed. Please connect again.', 4900);
        const next = normalize(kind === 'injected' ? result : source.accounts);
        if (!next.length) throw failure('The wallet did not share an account.', 4900);
        accounts = next;
        remember(kind);
        return accounts.slice();
      } catch (error) {
        // Keep user rejection visible. Never quietly connect through another wallet.
        if (provider === source && !accounts.length) { detach(); provider = null; transport = null; }
        throw error;
      }
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function request(args) {
    const selected = provider;
    const op = generation;
    const originalAccounts = accounts.join(',').toLowerCase();
    if (!selected) throw failure('Connect your wallet first.', 4900);
    const result = await selected.request(args);
    // Switching networks deliberately emits chainChanged while this request is
    // pending. Signatures and other results must still match the original wallet.
    const switching = args?.method === 'wallet_switchEthereumChain' || args?.method === 'wallet_addEthereumChain';
    if (provider !== selected || originalAccounts !== accounts.join(',').toLowerCase() || op !== generation && !switching) throw failure('Wallet connection changed. Please try again.', 4900);
    return result;
  }
  async function disconnect() {
    const previous = provider;
    const kind = transport;
    remember('disconnected');
    clearCurrent();
    if (kind === 'walletconnect') {
      // Clear the selected account before waiting for any relay acknowledgement.
      // A disconnected provider is safe to reuse for a new explicit connection;
      // keeping it avoids duplicate AppKit instances and relay subscriptions.
      try { await previous?.disconnect?.(); } catch (error) { remote = null; throw error; }
    }
  }
  function on(event, callback) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => off(event, callback);
  }
  function off(event, callback) { listeners.get(event)?.delete(callback); }
  window.OTTWallet = {
    configure, restore, connect, request, disconnect, on, off, remoteAvailable,
    available: () => !!injected() || remoteAvailable(),
    getProvider: () => provider,
    state: () => ({ transport, accounts: accounts.slice(), connected: !!provider && !!accounts.length, remoteAvailable: remoteAvailable() }),
  };
})();
