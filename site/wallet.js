'use strict';
/**
 * The Solana wallet connection for the whole site. Wallets are found through the Wallet Standard
 * (https://github.com/wallet-standard/wallet-standard): the page announces itself with a
 * `wallet-standard:app-ready` event and installed wallets (Phantom, Solflare, Backpack and others)
 * register through `wallet-standard:register-wallet`. Phantom's older injected provider is the
 * fallback when no standard wallet has registered. Nothing here is stored but the name of the
 * wallet last connected, so a reload can reconnect it silently.
 *
 *   OTTWallet.wallets()                 -> [{ name, icon }] installed wallets
 *   OTTWallet.connect({ wallet })       -> [address]
 *   OTTWallet.restore()                 -> [address] or [] (silent; never prompts)
 *   OTTWallet.signMessage(text)         -> base58 signature over the UTF-8 bytes of `text`
 *   OTTWallet.signAndSendTransaction(wire, message) -> base58 transaction signature
 *   OTTWallet.disconnect(), on(event, fn), off(event, fn), state(), available(), openIn(name)
 *
 * Events: 'accountsChanged' ([address] or []), 'disconnect', 'walletsChanged'.
 */
(function () {
  const BASE = new URL('./', document.currentScript?.src || location.href);
  const STORAGE_KEY = 'ott-solana-wallet:' + BASE.pathname;
  const CHAIN = 'solana:mainnet';
  const listeners = new Map();
  const standard = new Set();
  let selected = null;       // { name, icon, adapter }
  let accounts = [];
  let generation = 0;
  let unbind = null;
  let connecting = null;

  const S = () => window.OTTSolana;
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
  const remembered = () => { try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; } };
  const remember = (value) => { try { if (value) localStorage.setItem(STORAGE_KEY, value); else localStorage.removeItem(STORAGE_KEY); } catch (_) { /* works without storage */ } };
  const validAddress = (value) => (typeof value === 'string' && S()?.isAddress(value) ? value : null);
  const rejected = (error) => error && (error.code === 4001 || /reject|denied|cancel|declin/i.test(String(error.message || error)));

  // ============================================================================ discovery
  function isSolanaWallet(wallet) {
    const f = wallet && wallet.features;
    return !!f && Array.isArray(wallet.chains) && wallet.chains.includes(CHAIN)
      && !!f['standard:connect'] && !!f['solana:signMessage'] && !!f['solana:signAndSendTransaction'];
  }
  const registry = Object.freeze({
    register(...wallets) {
      const added = wallets.filter(isSolanaWallet);
      added.forEach((w) => standard.add(w));
      if (added.length) emit('walletsChanged', list());
      return () => { added.forEach((w) => standard.delete(w)); emit('walletsChanged', list()); };
    },
  });
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    try { if (typeof event.detail === 'function') event.detail(registry); } catch (_) { /* a broken wallet must not break the page */ }
  });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry })); } catch (_) { /* old browsers */ }

  /** A standard wallet behind the four calls this site makes. */
  function standardAdapter(wallet) {
    const f = wallet.features;
    let account = null;
    const pick = (list) => (Array.isArray(list) ? list.find((a) => a && validAddress(a.address) && (!a.chains || a.chains.includes(CHAIN))) : null) || null;
    return {
      kind: 'standard',
      async connect(silent) {
        const out = await f['standard:connect'].connect(silent ? { silent: true } : undefined);
        account = pick(out && out.accounts) || pick(wallet.accounts);
        return account ? [account.address] : [];
      },
      async disconnect() { await f['standard:disconnect']?.disconnect?.(); account = null; },
      async signMessage(bytes) {
        if (!account) throw failure('Connect your wallet first.', 4900);
        const [out] = await f['solana:signMessage'].signMessage({ account, message: bytes });
        if (!out || !(out.signature instanceof Uint8Array) || out.signature.length !== 64) throw failure('The wallet returned an invalid signature.', 'INVALID_SIGNATURE');
        if (out.signedMessage && S().encodeBase64(out.signedMessage) !== S().encodeBase64(bytes)) throw failure('The wallet signed a different message. Nothing was sent.', 'INVALID_SIGNATURE');
        return out.signature;
      },
      async signAndSendTransaction(wire) {
        if (!account) throw failure('Connect your wallet first.', 4900);
        const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain: CHAIN, transaction: wire, options: { commitment: 'confirmed' } });
        if (!out || !(out.signature instanceof Uint8Array) || out.signature.length !== 64) throw failure('The wallet did not return a transaction signature. Check your wallet before trying again.', 'INVALID_SIGNATURE');
        return out.signature;
      },
      subscribe(onAccounts) {
        const off = f['standard:events']?.on?.('change', (change) => {
          if (change && 'accounts' in change) {
            account = pick(change.accounts);
            onAccounts(account ? [account.address] : []);
          }
        });
        return typeof off === 'function' ? off : () => {};
      },
    };
  }

  /** Phantom's injected provider, for browsers where it has not registered as a standard wallet. */
  function legacyPhantom() {
    const p = window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null;
    return p && typeof p.connect === 'function' && typeof p.signMessage === 'function' ? p : null;
  }
  function legacyAdapter(provider) {
    const keyOf = (value) => validAddress(typeof value === 'string' ? value : value?.toString?.());
    return {
      kind: 'legacy',
      async connect(silent) {
        const out = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
        const address = keyOf(out?.publicKey || provider.publicKey);
        return address ? [address] : [];
      },
      async disconnect() { await provider.disconnect?.(); },
      async signMessage(bytes) {
        const out = await provider.signMessage(bytes, 'utf8');
        const sig = out && out.signature;
        if (!(sig instanceof Uint8Array) || sig.length !== 64) throw failure('The wallet returned an invalid signature.', 'INVALID_SIGNATURE');
        return sig;
      },
      async signAndSendTransaction(wire, message) {
        const out = await provider.request({ method: 'signAndSendTransaction', params: { message: S().encodeBase58(message) } });
        const sig = out && out.signature;
        if (typeof sig !== 'string' || !S().isSignature(sig)) throw failure('The wallet did not return a transaction signature. Check your wallet before trying again.', 'INVALID_SIGNATURE');
        return S().decodeBase58(sig);
      },
      subscribe(onAccounts) {
        const changed = (value) => { const a = keyOf(value); onAccounts(a ? [a] : []); };
        const gone = () => onAccounts([]);
        provider.on?.('accountChanged', changed);
        provider.on?.('disconnect', gone);
        return () => { provider.removeListener?.('accountChanged', changed); provider.removeListener?.('disconnect', gone); };
      },
    };
  }

  /** Installed wallets, standard ones first; Phantom's injected provider only if Phantom did not register. */
  function list() {
    const out = [...standard].map((w) => ({ name: String(w.name || 'Wallet'), icon: typeof w.icon === 'string' && /^data:image\//.test(w.icon) ? w.icon : '', wallet: w }));
    if (!out.some((w) => /phantom/i.test(w.name)) && legacyPhantom()) out.push({ name: 'Phantom', icon: '', legacy: legacyPhantom() });
    return out;
  }
  function adapterFor(name) {
    const entries = list();
    const entry = (name && entries.find((w) => w.name === name)) || (entries.length === 1 ? entries[0] : null);
    if (!entry) return null;
    return { name: entry.name, icon: entry.icon, adapter: entry.legacy ? legacyAdapter(entry.legacy) : standardAdapter(entry.wallet) };
  }

  // ============================================================================ connection
  function bind(choice) {
    if (unbind) unbind();
    selected = choice;
    const own = choice;
    unbind = choice.adapter.subscribe((next) => {
      if (selected !== own) return;
      generation++;
      accounts = next.slice(0, 1);
      if (!accounts.length) { remember(null); clear({ code: 4900, message: 'Wallet access was removed.' }); return; }
      emit('accountsChanged', accounts.slice());
    });
  }
  function clear(reason) {
    generation++;
    if (unbind) unbind();
    unbind = null;
    selected = null;
    accounts = [];
    emit('accountsChanged', []);
    emit('disconnect', reason || { code: 4900, message: 'Wallet disconnected.' });
  }

  async function connect(options) {
    if (connecting) return connecting;
    connecting = (async () => {
      const name = options && options.wallet;
      const choice = adapterFor(name);
      if (!choice) {
        throw failure(list().length > 1 ? 'Choose which wallet to connect.' : 'No Solana wallet was found. Open OTT in Phantom or Solflare, or install a Solana wallet.', 'WALLET_UNAVAILABLE');
      }
      const opening = ++generation;
      let next;
      try { next = await choice.adapter.connect(false); }
      catch (error) { throw rejected(error) ? failure('The connection was not approved.', 4001) : error; }
      if (opening !== generation) throw failure('Wallet connection was cancelled. Please connect again.', 4900);
      if (!next.length) throw failure('The wallet did not share an account.', 4900);
      bind(choice);
      accounts = next.slice(0, 1);
      remember(choice.name);
      return accounts.slice();
    })().finally(() => { connecting = null; });
    return connecting;
  }

  /** Reconnect the remembered wallet without a prompt. Wallets that cannot do that silently answer []. */
  async function restore() {
    const name = remembered();
    if (!name) return [];
    // Wallets can register a moment after the page; give them that moment.
    for (let i = 0; i < 10 && !list().some((w) => w.name === name); i++) await new Promise((r) => setTimeout(r, 100));
    const choice = adapterFor(name);
    if (!choice || choice.name !== name) return [];
    const opening = ++generation;
    try {
      const next = await choice.adapter.connect(true);
      if (opening !== generation || !next.length) return [];
      bind(choice);
      accounts = next.slice(0, 1);
      return accounts.slice();
    } catch (_) { return []; }
  }

  async function disconnect() {
    const previous = selected;
    remember(null);
    clear();
    try { await previous?.adapter.disconnect(); } catch (_) { /* the page has already forgotten it */ }
  }

  /** Runs `work` against the selected wallet and refuses its result if the wallet changed meanwhile. */
  async function guarded(work) {
    const choice = selected;
    const op = generation;
    const account = accounts[0];
    if (!choice || !account) throw failure('Connect your wallet first.', 4900);
    let out;
    try { out = await work(choice.adapter, account); }
    catch (error) { throw rejected(error) ? failure('The request was not approved in your wallet.', 4001) : error; }
    if (selected !== choice || op !== generation || accounts[0] !== account) throw failure('Your wallet changed. Please try again.', 4900);
    return out;
  }

  async function signMessage(text) {
    if (typeof text !== 'string' || !text.length || text.length > 2048) throw failure('The message to sign is invalid.', 'INVALID_MESSAGE');
    const signature = await guarded((adapter) => adapter.signMessage(S().utf8(text)));
    return S().encodeBase58(signature);
  }

  async function signAndSendTransaction(wire, message) {
    if (!(wire instanceof Uint8Array) || !(message instanceof Uint8Array)) throw failure('The transaction is invalid.', 'INVALID_TRANSACTION');
    const signature = await guarded((adapter) => adapter.signAndSendTransaction(wire, message));
    return S().encodeBase58(signature);
  }

  /** A link that opens `url` inside a mobile wallet's own browser, where the wallet can connect. */
  function openIn(name, url = location.href) {
    const target = encodeURIComponent(url);
    const ref = encodeURIComponent(location.origin);
    if (/solflare/i.test(name)) return 'https://solflare.com/ul/v1/browse/' + target + '?ref=' + ref;
    return 'https://phantom.app/ul/browse/' + target + '?ref=' + ref;
  }

  function on(event, callback) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => off(event, callback);
  }
  function off(event, callback) { listeners.get(event)?.delete(callback); }

  window.OTTWallet = {
    configure() { /* nothing to configure: Solana mainnet only */ },
    wallets: () => list().map(({ name, icon }) => ({ name, icon })),
    available: () => list().length > 0,
    connect, restore, disconnect, signMessage, signAndSendTransaction, openIn, on, off,
    state: () => ({ chain: 'solana', wallet: selected ? selected.name : null, accounts: accounts.slice(), connected: !!selected && !!accounts.length }),
  };
})();
