'use strict';
/**
 * A Solana wallet for the browser specs. It registers through the Wallet Standard the way Phantom
 * and Solflare do, so the page finds it by the same code path it finds them by. The key lives in
 * Node: messages are signed with a real ed25519 key, so a spec can check a signature the way the
 * API would, and transactions are recorded rather than sent and answered with a fixed signature.
 * What the wallet does when asked (approve, decline, fail, or wait to be told) is held in Node too,
 * and a spec can change it between steps.
 *
 *   const wallet = await installWallet(page, {
 *     name: 'Phantom',       // shown in the wallet chooser
 *     trusted: true,         // already approved for this site: the page reconnects it on load
 *     connect: 'approve',    // 'approve' | 'reject' | 'hold'
 *     sign: 'approve',       // signMessage: 'approve' | 'reject' | 'hold'
 *     send: 'approve',       // signAndSendTransaction: 'approve' | 'reject' | 'error' | 'hold'
 *     register: true,        // false: installed but not announced (no wallet in this browser)
 *   });
 *   wallet.address                          the account it shares (base58)
 *   wallet.calls('signMessage')             [{ method, message }]   (message is the signed text)
 *   wallet.calls('signAndSendTransaction')  [{ method, wire, transaction }]   (decoded, see solana.js)
 *   wallet.verify(message, signature)       whether `signature` (base58) is this wallet's over `message`
 *   wallet.behave({ send: 'reject' })       change what it does next
 *   wallet.release('connect')               answer a call held by 'hold' with the current behaviour
 *   await wallet.switchTo(page, 'other')    change the account, as a person does in their wallet
 *   await wallet.switchTo(page, null)       revoke this site's access
 */
const crypto = require('crypto');
const { S, decodeTransaction } = require('./solana.js');

const STORAGE_KEY = 'ott-solana-wallet:/';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#5b4bff"/></svg>').toString('base64');
/** What every transaction the wallet "sends" is answered with. */
const TX_SIGNATURE = S.encodeBase58(Buffer.concat([crypto.createHash('sha256').update('ott-test-tx-a').digest(), crypto.createHash('sha256').update('ott-test-tx-b').digest()]));

/** A deterministic ed25519 key for a label, and its base58 address. */
function keyFor(label) {
  const seed = crypto.createHash('sha256').update('ott-test-wallet:' + label).digest();
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKey, raw: Array.from(raw), address: S.encodeBase58(raw) };
}
const walletAddress = (label = 'holder') => keyFor(label).address;

const rejection = () => ({ error: { code: 4001, message: 'User rejected the request.' } });

async function installWallet(page, opts = {}) {
  const keys = new Map();
  const remember = (label) => { const key = keyFor(label); keys.set(key.address, key); return key; };
  let current = remember(opts.account || 'holder');
  const held = new Map();
  const wallet = {
    name: opts.name || 'Phantom',
    get address() { return current ? current.address : null; },
    signature: opts.signature || TX_SIGNATURE,
    trusted: !!opts.trusted,
    behaviour: { connect: opts.connect || 'approve', sign: opts.sign || 'approve', send: opts.send || 'approve' },
    log: [],
    calls(method) { return this.log.filter((c) => !method || c.method === method); },
    behave(next) { Object.assign(this.behaviour, next); },
    release(method) { const waiting = held.get(method) || []; held.delete(method); waiting.forEach((resolve) => resolve()); return waiting.length; },
    verify(message, signature, address = this.address) {
      const key = keys.get(address);
      let sig;
      try { sig = Buffer.from(S.decodeBase58(signature)); } catch (_) { return false; }
      return !!key && sig.length === 64 && crypto.verify(null, Buffer.from(message, 'utf8'), key.publicKey, sig);
    },
    async switchTo(target, label) {
      current = label === null ? null : remember(label);
      await target.evaluate((account) => window.__ottTestWalletChange(account), current ? { address: current.address, publicKey: current.raw } : null);
    },
  };

  // Waits while a behaviour is 'hold', then answers with whatever the behaviour is by then.
  const settle = async (method, kind) => {
    while (wallet.behaviour[kind] === 'hold') await new Promise((resolve) => held.set(method, [...(held.get(method) || []), resolve]));
    return wallet.behaviour[kind];
  };

  await page.exposeFunction('__ottTestWallet', async (method, payload = {}) => {
    if (method === 'connect') {
      wallet.log.push({ method, silent: !!payload.silent });
      if (payload.silent) return { accounts: wallet.trusted && current ? [current.address] : [] };
      const outcome = await settle(method, 'connect');
      if (outcome === 'reject') return rejection();
      wallet.trusted = true;
      return { accounts: current ? [current.address] : [] };
    }
    if (method === 'disconnect') { wallet.log.push({ method }); return {}; }
    if (method === 'signMessage') {
      const bytes = Buffer.from(payload.message, 'base64');
      wallet.log.push({ method, message: bytes.toString('utf8'), account: payload.account });
      const outcome = await settle(method, 'sign');
      if (outcome === 'reject') return rejection();
      const key = keys.get(payload.account);
      if (!key) return { error: { code: -32603, message: 'Unknown account.' } };
      return { signature: crypto.sign(null, bytes, key.privateKey).toString('base64') };
    }
    if (method === 'signAndSendTransaction') {
      const wire = Buffer.from(payload.transaction, 'base64');
      let transaction = null;
      try { transaction = decodeTransaction(wire); } catch (e) { transaction = { error: String(e.message || e) }; }
      wallet.log.push({ method, wire, transaction, chain: payload.chain, options: payload.options, account: payload.account });
      const outcome = await settle(method, 'send');
      if (outcome === 'reject') return rejection();
      if (outcome === 'error') return { error: { code: -32603, message: 'Transaction simulation failed: insufficient funds for fee.' } };
      return { signature: Buffer.from(S.decodeBase58(wallet.signature)).toString('base64') };
    }
    return { error: { code: -32601, message: 'Unsupported wallet method ' + method } };
  });

  await page.addInitScript(({ name, icon, account, trusted, register, storageKey }) => {
    if (trusted) {
      // Seeded once per tab, so a spec that disconnects and reloads sees the page forget the wallet.
      try {
        if (!sessionStorage.getItem('ott-test-wallet-seeded')) {
          localStorage.setItem(storageKey, name);
          sessionStorage.setItem('ott-test-wallet-seeded', '1');
        }
      } catch (_) { /* storage blocked: the spec connects by hand */ }
    }
    const CHAINS = ['solana:mainnet', 'solana:devnet'];
    const FEATURES = ['solana:signMessage', 'solana:signAndSendTransaction'];
    const listeners = new Set();
    const known = new Map([[account.address, account]]);
    let selected = account;
    let accounts = [];
    const asAccount = (a) => Object.freeze({ address: a.address, publicKey: Uint8Array.from(a.publicKey), chains: CHAINS, features: FEATURES });
    const toBase64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
    const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    async function call(method, payload) {
      const out = await window.__ottTestWallet(method, payload || {});
      if (out && out.error) { const error = new Error(out.error.message); error.code = out.error.code; throw error; }
      return out || {};
    }
    const wallet = {
      version: '1.0.0',
      name,
      icon,
      chains: CHAINS,
      get accounts() { return accounts.slice(); },
      features: {
        'standard:connect': {
          version: '1.0.0',
          async connect(input) {
            const out = await call('connect', { silent: !!(input && input.silent) });
            accounts = (out.accounts || []).map((address) => asAccount(known.get(address) || selected));
            return { accounts: wallet.accounts };
          },
        },
        'standard:disconnect': { version: '1.0.0', async disconnect() { await call('disconnect'); accounts = []; } },
        'standard:events': {
          version: '1.0.0',
          on(event, listener) {
            if (event !== 'change') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        'solana:signMessage': {
          version: '1.0.0',
          async signMessage(...inputs) {
            const out = [];
            for (const input of inputs) {
              const r = await call('signMessage', { message: toBase64(input.message), account: input.account && input.account.address });
              out.push({ signedMessage: input.message, signature: fromBase64(r.signature) });
            }
            return out;
          },
        },
        'solana:signAndSendTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          async signAndSendTransaction(...inputs) {
            const out = [];
            for (const input of inputs) {
              const r = await call('signAndSendTransaction', { transaction: toBase64(input.transaction), chain: input.chain, options: input.options || null, account: input.account && input.account.address });
              out.push({ signature: fromBase64(r.signature) });
            }
            return out;
          },
        },
      },
    };
    // A spec switches the account (or revokes access with null), the way a person does in their wallet.
    window.__ottTestWalletChange = (next) => {
      if (next) { known.set(next.address, next); selected = next; accounts = [asAccount(next)]; } else accounts = [];
      for (const listener of [...listeners]) listener({ accounts: wallet.accounts });
    };
    if (!register) return;
    const announce = (api) => { try { api.register(wallet); } catch (_) { /* the page is not listening */ } };
    window.addEventListener('wallet-standard:app-ready', (event) => announce(event.detail));
    try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: announce })); } catch (_) { /* no listener yet */ }
  }, { name: wallet.name, icon: opts.icon === undefined ? ICON : opts.icon, account: { address: current.address, publicKey: current.raw },
    trusted: !!opts.trusted, register: opts.register !== false, storageKey: STORAGE_KEY });

  return wallet;
}

module.exports = { installWallet, walletAddress, keyFor, TX_SIGNATURE, STORAGE_KEY };
