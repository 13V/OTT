'use strict';
/**
 * solana.js — the Solana primitives OT+T needs, with no dependencies, for three callers:
 *
 *   - the browser (index.html loads this file; it defines window.OTTSolana), which builds the
 *     join transaction and reads balances;
 *   - the API (site/api/_lib requires it), which checks join transactions;
 *   - the keepers in scripts/, which build, sign and parse transactions.
 *
 * Everything is plain JavaScript over Uint8Array and BigInt. sha256 comes from WebCrypto
 * (globalThis.crypto.subtle), which browsers and Node 22 both have, so the address helpers are
 * async. test/solana.test.js checks this file against @solana/kit and @solana-program/token.
 *
 * Covered: base58 and base64, canonical addresses, the ed25519 on-curve test that program
 * addresses depend on, program-derived and associated token addresses, the few instructions OT+T
 * builds, legacy transaction messages, and reading balances out of jsonParsed transactions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTTSolana = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PROGRAMS = Object.freeze({
    system: '11111111111111111111111111111111',
    computeBudget: 'ComputeBudget111111111111111111111111111111',
    token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  });
  const MINTS = Object.freeze({
    wsol: 'So11111111111111111111111111111111111111112',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  });
  // Solana's well-known burn address. Nobody holds its key, so tokens sent to its token account
  // can never move again.
  const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
  const TOKEN_PROGRAMS = [PROGRAMS.token, PROGRAMS.token2022];

  // ============================================================================ base58 / base64
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const DIGIT = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) DIGIT[ALPHABET.charCodeAt(i)] = i;

  function encodeBase58(bytes) {
    const input = toBytes(bytes);
    let zeros = 0;
    while (zeros < input.length && input[zeros] === 0) zeros++;
    const digits = [];
    for (let i = zeros; i < input.length; i++) {
      let carry = input[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '1'.repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }

  /** The bytes of a base58 string. Throws on anything that is not base58. */
  function decodeBase58(text) {
    if (typeof text !== 'string') throw new Error('base58 text required');
    let zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros++;
    const bytes = [];
    for (let i = zeros; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const value = code < 128 ? DIGIT[code] : -1;
      if (value < 0) throw new Error('not base58');
      let carry = value;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function encodeBase64(bytes) {
    const input = toBytes(bytes);
    let out = '';
    for (let i = 0; i < input.length; i += 3) {
      const a = input[i], b = input[i + 1], c = input[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)]
        + (b === undefined ? '=' : B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)])
        + (c === undefined ? '=' : B64[c & 63]);
    }
    return out;
  }
  function decodeBase64(text) {
    const clean = String(text || '').replace(/[\s=]/g, '');
    if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) throw new Error('not base64');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, value = 0, n = 0;
    for (const ch of clean) {
      value = (value << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[n++] = (value >> bits) & 0xff; }
    }
    return out.subarray(0, n);
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    throw new Error('bytes required');
  }
  const utf8 = (text) => new TextEncoder().encode(String(text));

  // ============================================================================ addresses
  /** The 32 bytes of a canonical base58 address, or null. Canonical means it encodes back to itself. */
  function addressBytes(address) {
    if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null;
    let bytes;
    try { bytes = decodeBase58(address); } catch (e) { return null; }
    return bytes.length === 32 && encodeBase58(bytes) === address ? bytes : null;
  }
  const isAddress = (value) => addressBytes(value) !== null;
  /** A transaction signature: 64 bytes of base58. */
  function isSignature(value) {
    if (typeof value !== 'string' || value.length < 64 || value.length > 90) return false;
    try {
      const bytes = decodeBase58(value);
      return bytes.length === 64 && encodeBase58(bytes) === value;
    } catch (e) { return false; }
  }
  function requireAddress(value, what) {
    const bytes = addressBytes(value);
    if (!bytes) throw new Error((what || 'address') + ' is not a Solana address');
    return bytes;
  }

  // ed25519 over GF(2^255 - 19). A program-derived address must NOT be a point on the curve, so
  // deriving one needs the same test the runtime uses: curve25519-dalek's decompress(), which
  // reduces the y coordinate mod p and accepts it when (y² - 1) / (d·y² + 1) is a square.
  const P = (1n << 255n) - 19n;
  const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
  function powMod(base, exp) {
    let result = 1n, b = mod(base), e = exp;
    while (e > 0n) { if (e & 1n) result = (result * b) % P; b = (b * b) % P; e >>= 1n; }
    return result;
  }
  const D = mod(-121665n * powMod(121666n, P - 2n));
  function isOnCurve(bytes) {
    const input = toBytes(bytes);
    if (input.length !== 32) return false;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(input[i]);
    y = mod(y & ((1n << 255n) - 1n));
    const yy = (y * y) % P;
    const u = mod(yy - 1n);
    const v = mod(D * yy + 1n);
    const v3 = (((v * v) % P) * v) % P;
    const v7 = (((v3 * v3) % P) * v) % P;
    const r = (((u * v3) % P) * powMod((u * v7) % P, (P - 5n) / 8n)) % P;
    const check = (((v * r) % P) * r) % P;
    return check === u || check === mod(-u);
  }

  async function sha256(...chunks) {
    const parts = chunks.map(toBytes);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('WebCrypto is not available here');
    return new Uint8Array(await subtle.digest('SHA-256', joined));
  }

  const PDA_MARKER = utf8('ProgramDerivedAddress');
  /** findProgramAddress: the first bump, from 255 down, whose hash is off the curve. */
  async function programAddress(seeds, programId) {
    const program = requireAddress(programId, 'program id');
    const seedBytes = seeds.map((s) => (typeof s === 'string' ? utf8(s) : toBytes(s)));
    if (seedBytes.length > 15 || seedBytes.some((s) => s.length > 32)) throw new Error('too many or too long seeds');
    for (let bump = 255; bump >= 0; bump--) {
      const hash = await sha256(...seedBytes, Uint8Array.of(bump), program, PDA_MARKER);
      if (!isOnCurve(hash)) return { address: encodeBase58(hash), bump };
    }
    throw new Error('no program address found');
  }

  /** The associated token account of `owner` for `mint` under `tokenProgram` (Token or Token-2022). */
  async function associatedTokenAddress(owner, mint, tokenProgram) {
    if (!TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error('unknown token program');
    const { address } = await programAddress([requireAddress(owner, 'owner'), requireAddress(tokenProgram), requireAddress(mint, 'mint')], PROGRAMS.associatedToken);
    return address;
  }

  // ============================================================================ instructions
  // An instruction is { programId, keys: [{ address, signer, writable }], data: Uint8Array }.
  const meta = (address, signer, writable) => ({ address, signer: !!signer, writable: !!writable });
  function u64(value) {
    const n = BigInt(value);
    if (n < 0n || n >= (1n << 64n)) throw new Error('u64 out of range');
    const out = new Uint8Array(8);
    let x = n;
    for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }
  function u32(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error('u32 out of range');
    return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  /** SPL Token TransferChecked (instruction 12): `amount` base units of `mint` from `source` to `destination`. */
  function transferChecked({ source, mint, destination, owner, amount, decimals, tokenProgram }) {
    if (!TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error('unknown token program');
    const d = Number(decimals);
    if (!Number.isInteger(d) || d < 0 || d > 255) throw new Error('decimals out of range');
    if (BigInt(amount) <= 0n) throw new Error('amount must be positive');
    return {
      programId: tokenProgram,
      keys: [meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(owner, true, false)],
      data: concat(Uint8Array.of(12), u64(amount), Uint8Array.of(d)),
    };
  }

  /** Associated Token CreateIdempotent (instruction 1): creates `owner`'s account for `mint` if it is missing. */
  function createAssociatedTokenIdempotent({ payer, account, owner, mint, tokenProgram }) {
    if (!TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error('unknown token program');
    return {
      programId: PROGRAMS.associatedToken,
      keys: [meta(payer, true, true), meta(account, false, true), meta(owner, false, false), meta(mint, false, false),
        meta(PROGRAMS.system, false, false), meta(tokenProgram, false, false)],
      data: Uint8Array.of(1),
    };
  }

  /** SPL Token CloseAccount (instruction 9): close `account`, sending its lamports to `destination`. */
  function closeAccount({ account, destination, owner, tokenProgram }) {
    if (!TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error('unknown token program');
    return { programId: tokenProgram, keys: [meta(account, false, true), meta(destination, false, true), meta(owner, true, false)], data: Uint8Array.of(9) };
  }

  /** System Transfer (instruction 2). */
  function systemTransfer({ from, to, lamports }) {
    if (BigInt(lamports) <= 0n) throw new Error('lamports must be positive');
    return { programId: PROGRAMS.system, keys: [meta(from, true, true), meta(to, false, true)], data: concat(u32(2), u64(lamports)) };
  }

  const computeUnitLimit = (units) => ({ programId: PROGRAMS.computeBudget, keys: [], data: concat(Uint8Array.of(2), u32(units)) });
  const computeUnitPrice = (microLamports) => ({ programId: PROGRAMS.computeBudget, keys: [], data: concat(Uint8Array.of(3), u64(microLamports)) });

  // ============================================================================ messages
  function compactLength(n) {
    const out = [];
    let rest = n;
    for (;;) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest) byte |= 0x80;
      out.push(byte);
      if (!rest) break;
    }
    return Uint8Array.from(out);
  }
  function readCompactLength(bytes, at) {
    let value = 0, shift = 0, i = at;
    for (;;) {
      const byte = bytes[i++];
      if (byte === undefined) throw new Error('truncated length');
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
      if (shift > 14) throw new Error('length too long');
    }
    return { value, next: i };
  }

  /**
   * A legacy transaction message: the fee payer first, then writable signers, read-only signers,
   * writable accounts and read-only accounts, each group in order of first appearance.
   */
  function compileMessage({ payer, blockhash, instructions }) {
    requireAddress(payer, 'fee payer');
    const blockhashBytes = decodeBase58(String(blockhash || ''));
    if (blockhashBytes.length !== 32) throw new Error('a recent blockhash is required');
    const order = [];
    const roles = new Map();
    const add = (address, signer, writable) => {
      requireAddress(address);
      const prior = roles.get(address);
      if (prior) { prior.signer = prior.signer || signer; prior.writable = prior.writable || writable; return; }
      roles.set(address, { signer, writable });
      order.push(address);
    };
    add(payer, true, true);
    for (const ix of instructions) {
      for (const key of ix.keys) add(key.address, !!key.signer, !!key.writable);
      add(ix.programId, false, false);
    }
    const group = (signer, writable) => order.filter((a) => a !== payer && roles.get(a).signer === signer && roles.get(a).writable === writable);
    const keys = [payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
    if (keys.length > 256) throw new Error('too many accounts');
    const index = new Map(keys.map((a, i) => [a, i]));
    const signers = keys.filter((a) => roles.get(a).signer);
    const header = Uint8Array.of(signers.length, signers.filter((a) => !roles.get(a).writable).length,
      keys.filter((a) => !roles.get(a).signer && !roles.get(a).writable).length);
    const parts = [header, compactLength(keys.length), ...keys.map((a) => addressBytes(a)), blockhashBytes, compactLength(instructions.length)];
    for (const ix of instructions) {
      parts.push(Uint8Array.of(index.get(ix.programId)), compactLength(ix.keys.length), Uint8Array.from(ix.keys.map((k) => index.get(k.address))),
        compactLength(ix.data.length), toBytes(ix.data));
    }
    return concat(...parts);
  }

  /** The signer addresses a compiled message needs, in signature order. */
  function messageSigners(message) {
    const bytes = toBytes(message);
    if (bytes[0] & 0x80) throw new Error('versioned messages are not supported here');
    const count = bytes[0];
    const { value: keyCount, next } = readCompactLength(bytes, 3);
    if (keyCount < count) throw new Error('malformed message');
    const out = [];
    for (let i = 0; i < count; i++) out.push(encodeBase58(bytes.subarray(next + i * 32, next + (i + 1) * 32)));
    return out;
  }

  /** The wire form: a signature slot per required signer (zeros where unsigned), then the message. */
  function wireTransaction(message, signatures = []) {
    const bytes = toBytes(message);
    const count = messageSigners(bytes).length;
    const slots = [];
    for (let i = 0; i < count; i++) {
      const sig = signatures[i];
      if (sig === undefined || sig === null) slots.push(new Uint8Array(64));
      else { const s = toBytes(sig); if (s.length !== 64) throw new Error('a signature is 64 bytes'); slots.push(s); }
    }
    return concat(compactLength(count), ...slots, bytes);
  }

  // ============================================================================ amounts
  /** A decimal token amount ("100000", "0.5") in base units, exactly. */
  function unitsOf(tokens, decimals) {
    const d = Number(decimals);
    if (!Number.isSafeInteger(d) || d < 0 || d > 36) throw new Error('token decimals must be a whole number from 0 to 36');
    const [whole, fraction = ''] = String(tokens).split('.');
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error('not a token amount: ' + tokens);
    if (fraction.replace(/0+$/, '').length > d) throw new Error(tokens + ' has more decimal places than the token');
    return BigInt(whole) * 10n ** BigInt(d) + BigInt((fraction + '0'.repeat(d)).slice(0, d) || '0');
  }
  /** Base units as a decimal token string, trailing zeros dropped. */
  function tokensOf(units, decimals) {
    const n = BigInt(units);
    const d = BigInt(Number(decimals));
    const base = 10n ** d;
    const whole = n / base;
    const fraction = (n % base).toString().padStart(Number(d), '0').replace(/0+$/, '');
    return fraction ? whole + '.' + fraction : whole.toString();
  }

  // ============================================================================ reading transactions
  /** Every account key of a getTransaction result, lookup-table addresses included, as base58. */
  function accountKeys(tx) {
    const message = tx && tx.transaction && tx.transaction.message;
    if (!message || !Array.isArray(message.accountKeys)) return [];
    const keys = message.accountKeys.map((k) => (typeof k === 'string' ? k : k && k.pubkey));
    // jsonParsed already lists lookup-table addresses (source "lookupTable"); json encoding does not.
    const parsed = message.accountKeys.some((k) => k && typeof k === 'object');
    const loaded = tx.meta && tx.meta.loadedAddresses;
    if (!parsed && loaded) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
    return keys;
  }
  const succeeded = (tx) => !!(tx && tx.meta && tx.meta.err === null);

  /**
   * Token balance changes for one mint: [{ account, owner, pre, post }] in base units (BigInt),
   * from meta.preTokenBalances/postTokenBalances. An account missing on one side counts as 0.
   */
  function tokenChanges(tx, mint) {
    const keys = accountKeys(tx);
    const rows = new Map();
    const take = (list, side) => {
      for (const b of (tx && tx.meta && tx.meta[list]) || []) {
        if (!b || b.mint !== mint) continue;
        const account = keys[b.accountIndex];
        if (!account) continue;
        const row = rows.get(account) || { account, owner: null, pre: 0n, post: 0n, programId: b.programId || null };
        let amount = 0n;
        try { amount = BigInt(b.uiTokenAmount && b.uiTokenAmount.amount); } catch (e) { amount = 0n; }
        row[side] = amount;
        if (b.owner) row.owner = side === 'post' || !row.owner ? b.owner : row.owner;
        rows.set(account, row);
      }
    };
    take('preTokenBalances', 'pre');
    take('postTokenBalances', 'post');
    return [...rows.values()];
  }

  /** How many lamports `address` gained (negative: lost) in a transaction, or null if not in it. */
  function lamportsChange(tx, address) {
    const i = accountKeys(tx).indexOf(address);
    const pre = tx && tx.meta && tx.meta.preBalances, post = tx && tx.meta && tx.meta.postBalances;
    if (i < 0 || !Array.isArray(pre) || !Array.isArray(post) || pre[i] === undefined || post[i] === undefined) return null;
    return BigInt(post[i]) - BigInt(pre[i]);
  }
  const feePayer = (tx) => accountKeys(tx)[0] || null;

  // ============================================================================ launch config
  /**
   * Whether a config (site/config/esim.json, or the API's view of it) names a launched coin: the
   * Solana chain, the mint, the Token or Token-2022 program that owns it, the treasury and the
   * incinerator's token account for it. None of the addresses may be the all-zero key, which is
   * what an unset address reads as. The site, the API and the launch checks all use this one rule.
   */
  const isLaunchAddress = (value) => isAddress(value) && value !== PROGRAMS.system;
  function launchedConfig(cfg) {
    const m = cfg && cfg.membership;
    return !!cfg && cfg.chain === 'solana' && isLaunchAddress(cfg.coin) && TOKEN_PROGRAMS.includes(cfg.tokenProgram)
      && isLaunchAddress(cfg.treasury) && !!m && typeof m === 'object' && !Array.isArray(m) && isLaunchAddress(m.burnAccount);
  }

  // ============================================================================ JSON-RPC
  /**
   * A JSON-RPC caller that rotates over `endpoints`. Each call tries every endpoint at most
   * `rounds` times. A null result can mean "not found", "this node is behind" or "this node
   * doesn't keep that much history", so it is only returned once every endpoint has said it. When
   * some said null and the rest only failed, the answer is unknown, and the call throws.
   */
  function createRpc(endpoints, { fetchImpl, timeoutMs = 8000, rounds = 2, headers = {}, pauseMs = 250, log = () => {} } = {}) {
    const urls = (endpoints || []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
    const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    let turn = 0;
    return async function call(method, params = []) {
      if (!urls.length) throw new Error('no Solana RPC endpoint is configured');
      let lastError = null;
      const nulls = new Set();
      const attempts = urls.length * rounds;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const url = urls[turn++ % urls.length];
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
        try {
          const res = await doFetch(url, {
            method: 'POST', signal: ctl ? ctl.signal : undefined,
            headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, headers),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          let body = null;
          try { body = await res.json(); } catch (e) { body = null; }
          if (!res.ok || !body) throw new Error('HTTP ' + res.status);
          if (body.error) throw new Error((body.error && body.error.message) || 'RPC error');
          if (body.result === null || body.result === undefined) {
            nulls.add(url);
            if (nulls.size >= urls.length) return null;
            continue;
          }
          return body.result;
        } catch (e) {
          lastError = e;
          log('  rpc ' + method + ' on ' + url.replace(/[?#].*$/, '') + ': ' + (e && e.message));
          if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs * Math.min(4, 1 + Math.floor(attempt / urls.length))));
        } finally { if (timer) clearTimeout(timer); }
      }
      if (nulls.size) throw new Error(method + ' found nothing on ' + nulls.size + ' of ' + urls.length + ' Solana endpoints and failed on the rest: ' + (lastError && lastError.message));
      throw new Error(method + ' failed on every Solana endpoint: ' + (lastError && lastError.message));
    };
  }

  return {
    PROGRAMS, MINTS, INCINERATOR, TOKEN_PROGRAMS,
    encodeBase58, decodeBase58, encodeBase64, decodeBase64, utf8,
    addressBytes, isAddress, isSignature, isOnCurve, sha256, programAddress, associatedTokenAddress,
    transferChecked, createAssociatedTokenIdempotent, closeAccount, systemTransfer, computeUnitLimit, computeUnitPrice,
    compileMessage, messageSigners, wireTransaction, compactLength, readCompactLength, u64, u32, concat,
    unitsOf, tokensOf,
    accountKeys, succeeded, tokenChanges, lamportsChange, feePayer,
    isLaunchAddress, launchedConfig,
    createRpc,
  };
});
