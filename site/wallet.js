'use strict';
/**
 * Selected EVM or Solana transport for the whole site. Injected wallets stay dependency-free;
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
  let accountRevision = 0;
  let lifecycle = 0;
  let bindings = [];
  let loadingSdk = null;
  let initializingRemote = null;
  let connecting = null;
  let linkSignerLease = null;

  function injected() {
    return window.ethereum && typeof window.ethereum.request === 'function' ? window.ethereum : null;
  }
  function solana() {
    const selected = window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null;
    return selected && typeof selected.connect === 'function' ? selected : null;
  }
  // A Solana public key is exactly 32 bytes of base58 and is case-sensitive.
  function solanaAddress(value) {
    try {
      const address = typeof value === 'string' ? value : value?.toString?.();
      if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null;
      const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let number = 0n;
      for (const character of address) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) return null;
        number = number * 58n + BigInt(digit);
      }
      let bytes = 0;
      while (number > 0n) { bytes++; number >>= 8n; }
      let leading = 0;
      while (address[leading] === '1') leading++;
      return bytes + leading === 32 ? address : null;
    } catch (_) { return null; }
  }
  function accountKey(value, kind = transport) {
    const joined = value.join(',');
    return kind === 'solana' ? joined : joined.toLowerCase();
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
    accountRevision++;
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
    listen(kind === 'solana' ? 'accountChanged' : 'accountsChanged', (value) => {
      if (provider !== source) return;
      generation++;
      accountRevision++;
      const address = kind === 'solana' ? solanaAddress(value) : null;
      accounts = kind === 'solana' ? address ? [address] : [] : normalize(value);
      if (!accounts.length) {
        remember('disconnected');
        clearCurrent({ code: 4900, message: 'Wallet access was removed.' });
        return;
      }
      emit('accountsChanged', accounts.slice());
    });
    if (kind !== 'solana') listen('chainChanged', (value) => {
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
      accountRevision++;
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
    if (remembered() === 'solana') {
      source = solana();
      kind = 'solana';
      if (!source) return [];
      try {
        const result = await source.connect({ onlyIfTrusted: true });
        const address = solanaAddress(result?.publicKey || source.publicKey);
        // Phantom updates publicKey on account changes/revocation even before
        // this boot restoration has installed its normal event listeners.
        if ('publicKey' in source && solanaAddress(source.publicKey) !== address) return [];
        restored = address ? [address] : [];
      } catch { return []; }
    } else if (remembered() === 'walletconnect' && remoteAvailable()) {
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
    if (linkSignerLease) throw failure('Finish or cancel wallet linking before changing wallets.', 'LINK_IN_PROGRESS');
    if (connecting) return connecting;
    connecting = (async () => {
      const choice = options?.transport || 'auto';
      if (!['auto', 'injected', 'walletconnect', 'solana'].includes(choice)) throw failure('Unknown wallet connection method.', 'INVALID_TRANSPORT');
      const kind = choice === 'auto' ? (provider && transport !== 'solana' ? transport : injected() ? 'injected' : 'walletconnect') : choice;
      // A deliberate new connection supersedes an unfinished boot restoration
      // and any private request started under the previous selection.
      const opening = ++lifecycle;
      generation++;
      const source = kind === 'injected' ? injected() : kind === 'solana' ? solana() : await getRemote();
      if (opening !== lifecycle) throw failure('Wallet connection was cancelled. Please connect again.', 4900);
      if (!source) throw failure(kind === 'solana' ? 'Open OTT in Phantom’s browser or install Phantom to sign in with Solana.'
        : 'No browser wallet was found. Open OTT in your wallet browser, or choose a mobile wallet.', 'WALLET_UNAVAILABLE');
      if (provider && provider !== source) {
        const releasing = disconnect();
        const released = lifecycle;
        await releasing;
        if (released !== lifecycle) throw failure('Wallet connection was cancelled. Please connect again.', 4900);
      }
      // Bind before the prompt so that revocations during connection clear state.
      bind(source, kind);
      const op = lifecycle;
      const openingAccounts = accountRevision;
      try {
        const result = kind === 'injected' ? await source.request({ method: 'eth_requestAccounts' }) : await source.connect();
        if (provider !== source || op !== lifecycle) throw failure('Wallet connection changed. Please connect again.', 4900);
        const address = kind === 'solana' ? solanaAddress(result?.publicKey || source.publicKey) : null;
        const next = kind === 'solana' ? address ? [address] : [] : normalize(kind === 'injected' ? result : source.accounts);
        if (!next.length) throw failure('The wallet did not share an account.', 4900);
        // Sharing the requested account may emit accountsChanged normally. A
        // different event-selected account must not be overwritten by an older
        // approval result. Network events alone do not change this selection.
        if (accountRevision !== openingAccounts && accountKey(accounts, kind) !== accountKey(next, kind)) {
          throw failure('Your wallet changed while connecting. Check the connected account and try again.', 4900);
        }
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
  async function evmLinkSigner(options) {
    if (linkSignerLease || connecting) throw failure('A wallet connection or link approval is already in progress.', 'LINK_IN_PROGRESS');
    if (transport !== 'solana' || !provider || accounts.length !== 1) throw failure('Sign in with your Solana wallet before linking an EVM wallet.', 'SOLANA_REQUIRED');
    const choice = options?.transport || 'auto';
    if (!['auto', 'injected', 'walletconnect'].includes(choice)) throw failure('Unknown EVM wallet connection method.', 'INVALID_TRANSPORT');
    const kind = choice === 'auto' ? injected() ? 'injected' : 'walletconnect' : choice;
    const owner = provider;
    const ownerAccount = accounts[0];
    const ownerGeneration = generation;
    const ownerLifecycle = lifecycle;
    const lease = {};
    linkSignerLease = lease;
    let source = null;
    let released = false;
    let releasePromise = null;
    let hadSession = true;
    let cancelled = false;
    let proofAddress = null;
    let eventAccounts = null;
    let updatedNamespaces = null;
    let revision = 0;
    let signing = false;
    const proofBindings = [];
    function listen(target, event, callback) {
      if (typeof target.on !== 'function') return;
      target.on(event, callback);
      proofBindings.push([target, event, callback]);
    }
    function valid() {
      if (released || cancelled || provider !== owner || transport !== 'solana' || accounts[0] !== ownerAccount
        || generation !== ownerGeneration || lifecycle !== ownerLifecycle) throw failure('Your wallet changed during linking. Start the link again.', 4900);
      if (proofAddress && kind === 'walletconnect' && normalize(source.accounts)[0]?.toLowerCase() !== proofAddress) throw failure('Your EVM wallet changed during linking. Start the link again.', 4900);
    }
    function sessionPermits(address, namespaces) {
      return Object.entries(namespaces).filter(([name]) => name === 'eip155' || name.startsWith('eip155:'))
        .some(([, namespace]) => Array.isArray(namespace.methods) && namespace.methods.includes('personal_sign')
          && Array.isArray(namespace.accounts) && namespace.accounts.some(account => typeof account === 'string' && account.split(':').pop().toLowerCase() === address));
    }
    async function release() {
      if (releasePromise) return releasePromise;
      released = true;
      for (const [target, event, callback] of proofBindings) {
        if (typeof target.removeListener === 'function') target.removeListener(event, callback);
        else target.off?.(event, callback);
      }
      proofBindings.length = 0;
      releasePromise = (async () => {
        try {
          // Preserve preexisting sessions and any provider selected after this
          // proof. Only this lease's new, isolated mobile session is closed.
          if (kind === 'walletconnect' && !hadSession && source?.session && source !== provider) await source.disconnect?.();
        } catch (_) {
          if (source === remote) remote = null;
        } finally {
          if (linkSignerLease === lease) linkSignerLease = null;
        }
      })();
      return releasePromise;
    }
    try {
      source = kind === 'injected' ? injected() : await getRemote();
      valid();
      if (!source) throw failure('Open OTT in your EVM wallet’s browser, or install a browser wallet to link it.', 'WALLET_UNAVAILABLE');
      if (source === owner) throw failure('Choose a separate EVM provider for wallet linking.', 'WRONG_WALLET_CHAIN');
      hadSession = kind !== 'walletconnect' || !!source.session;
      listen(source, 'accountsChanged', value => {
        revision++;
        eventAccounts = normalize(value);
        if (!eventAccounts.length || proofAddress && eventAccounts[0].toLowerCase() !== proofAddress) cancelled = true;
      });
      listen(source, 'chainChanged', () => { revision++; if (proofAddress) cancelled = true; });
      listen(source, 'disconnect', () => { revision++; cancelled = true; });
      listen(source, 'session_delete', () => { revision++; cancelled = true; });
      listen(source, 'session_update', value => {
        revision++;
        const namespaces = value?.params?.namespaces || value?.namespaces || source.session?.namespaces;
        if (!namespaces) { cancelled = true; return; }
        updatedNamespaces = namespaces;
        if (proofAddress && !sessionPermits(proofAddress, namespaces)) cancelled = true;
      });
      const result = kind === 'injected' ? await source.request({ method: 'eth_requestAccounts' }) : await source.connect();
      valid();
      const selected = normalize(kind === 'injected' ? result : source.accounts);
      if (!selected.length) throw failure('The EVM wallet did not share an account.', 4900);
      proofAddress = selected[0].toLowerCase();
      if (eventAccounts && eventAccounts[0]?.toLowerCase() !== proofAddress) throw failure('Your EVM wallet changed while connecting. Start the link again.', 4900);
      if (updatedNamespaces && !sessionPermits(proofAddress, updatedNamespaces)) throw failure('The EVM wallet no longer permits this link approval.', 4900);
      valid();
      return Object.freeze({ address: proofAddress, release, async sign(message) {
        valid();
        if (signing) throw failure('An EVM link approval is already in progress.', 'LINK_IN_PROGRESS');
        if (typeof message !== 'string' || !message.length) throw failure('The wallet link message is invalid.', 'INVALID_LINK_MESSAGE');
        const bytes = new TextEncoder().encode(message);
        if (bytes.length > 4096) throw failure('The wallet link message is too long.', 'INVALID_LINK_MESSAGE');
        const hex = '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        const signingRevision = revision;
        signing = true;
        try {
          const signature = await source.request({ method: 'personal_sign', params: [hex, proofAddress] });
          valid();
          if (revision !== signingRevision) throw failure('Your EVM wallet changed during approval. Start the link again.', 4900);
          if (typeof signature !== 'string' || !/^0x[\da-f]{130}$/i.test(signature)) throw failure('The EVM wallet returned an invalid link signature.', 'INVALID_LINK_SIGNATURE');
          return signature;
        } finally { signing = false; }
      } });
    } catch (error) {
      await release();
      throw error;
    }
  }
  async function request(args) {
    const selected = provider;
    const kind = transport;
    const op = generation;
    const originalAccounts = accountKey(accounts, kind);
    if (!selected) throw failure('Connect your wallet first.', 4900);
    if (kind === 'solana') {
      if (args?.method !== 'solana_signIn') throw failure('This action requires an EVM wallet. Choose the Robinhood Chain connection.', 'WRONG_WALLET_CHAIN');
      if (typeof selected.signIn !== 'function') throw failure('Update Phantom to use Sign In With Solana, then try again.', 'SOLANA_SIGNIN_UNAVAILABLE');
      const input = args.params;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('The Solana sign-in request is invalid. Please try again.', 'INVALID_SIGNIN');
      if (input.address && input.address !== accounts[0]) throw failure('The Solana sign-in request belongs to another account.', 'ACCOUNT_MISMATCH');
      const result = await selected.signIn(input);
      if (provider !== selected || transport !== kind || originalAccounts !== accountKey(accounts, kind) || op !== generation) throw failure('Wallet connection changed. Please try again.', 4900);
      const address = solanaAddress(result?.account?.address);
      if (!address || address !== accounts[0]) throw failure('The wallet signed in with another Solana account. Please reconnect and try again.', 'ACCOUNT_MISMATCH');
      if (!(result.signedMessage instanceof Uint8Array) || !result.signedMessage.length || !(result.signature instanceof Uint8Array) || result.signature.length !== 64
        || result.signatureType && result.signatureType !== 'ed25519') throw failure('The wallet returned an invalid Solana sign-in response.', 'INVALID_SIGNIN');
      return { address, signedMessage: result.signedMessage, signature: result.signature, signatureType: result.signatureType || 'ed25519' };
    }
    if (args?.method === 'solana_signIn') throw failure('Connect a Solana wallet to sign in with Solana.', 'WRONG_WALLET_CHAIN');
    const result = await selected.request(args);
    // Switching networks deliberately emits chainChanged while this request is
    // pending. Signatures and other results must still match the original wallet.
    const switching = args?.method === 'wallet_switchEthereumChain' || args?.method === 'wallet_addEthereumChain';
    if (provider !== selected || originalAccounts !== accountKey(accounts, kind) || op !== generation && !switching) throw failure('Wallet connection changed. Please try again.', 4900);
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
    } else if (kind === 'solana') await previous?.disconnect?.();
  }
  function on(event, callback) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => off(event, callback);
  }
  function off(event, callback) { listeners.get(event)?.delete(callback); }
  window.OTTWallet = {
    configure, restore, connect, request, disconnect, on, off, remoteAvailable, evmLinkSigner,
    solanaAvailable: () => !!solana(),
    available: () => !!injected() || remoteAvailable(),
    getProvider: () => provider,
    state: () => ({ transport, chain: transport === 'solana' ? 'solana' : transport ? 'evm' : null,
      accounts: accounts.slice(), connected: !!provider && !!accounts.length, remoteAvailable: remoteAvailable() }),
  };
})();
