'use strict';
/**
 * solana-chain.js — what the keepers (allowances, treasury, claim, fund) need from Solana and
 * pump.fun, on top of site/solana.js:
 *
 *   - an RPC caller over SOLANA_RPC_URL (comma-separated, tried first) and config/addresses.json's
 *     `rpcs`, paced so a public endpoint's rate limit is not tripped;
 *   - transaction history: signatures newer than a cursor, transactions, and a token account's
 *     balance at a past moment, from its own history (no archive state is needed);
 *   - pump.fun accounts: the bonding curve, the PumpSwap pool, the creator vaults, and the coin's
 *     price from whichever of the curve and pool is live;
 *   - SOL's dollar price, now and at a past hour (Coinbase, then Kraken);
 *   - a keypair from TREASURY_PRIVATE_KEY, and sending, simulating and confirming transactions.
 *
 * Read-only unless sendTransaction() is called. Everything that touches the network takes the
 * rpc (or fetch) it uses, so the tests hand in fakes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));

const ADDRESSES_PATH = path.join(__dirname, '..', 'config', 'addresses.json');
const TX_OPTIONS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------------

function endpoints(env = process.env, addressesPath = ADDRESSES_PATH) {
  const fromEnv = String(env.SOLANA_RPC_URL || '').split(',').map((u) => u.trim()).filter((u) => /^https:\/\//i.test(u));
  let fromFile = [];
  try { fromFile = JSON.parse(fs.readFileSync(addressesPath, 'utf8')).rpcs || []; } catch (e) { fromFile = []; }
  return [...new Set([...fromEnv, ...fromFile.filter((u) => /^https:\/\//i.test(u))])];
}

/**
 * An RPC caller with at least `minIntervalMs` between requests. The public mainnet endpoint
 * allows about 100 requests per 10 seconds per address, 40 for any one method; eight a second
 * stays under both with room for a second job.
 */
function makeRpc({ urls = endpoints(), minIntervalMs = 125, log = () => {}, fetchImpl } = {}) {
  const call = S.createRpc(urls, { timeoutMs: 20000, rounds: 3, pauseMs: 1000, log, fetchImpl });
  let next = 0;
  return async function rpc(method, params) {
    const wait = next - Date.now();
    next = Math.max(Date.now(), next) + minIntervalMs;
    if (wait > 0) await sleep(wait);
    return call(method, params);
  };
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

/**
 * Every signature on `address` newer than `until` (a signature, or null for the whole history),
 * oldest first. Pages of up to 1000 newest-first, so a long history costs a page per thousand.
 * Throws rather than return a partial list when `maxPages` is not enough.
 */
async function signaturesAfter(rpc, address, { until = null, maxPages = 50, pageSize = 1000 } = {}) {
  const out = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const opts = { limit: pageSize, commitment: 'confirmed' };
    if (until) opts.until = until;
    if (before) opts.before = before;
    const list = await rpc('getSignaturesForAddress', [address, opts]);
    if (!Array.isArray(list)) throw new Error('getSignaturesForAddress returned no list for ' + address);
    out.push(...list);
    if (list.length < pageSize) return out.reverse();
    before = list[list.length - 1].signature;
  }
  throw new Error(`more than ${maxPages * pageSize} new transactions on ${address}; raise maxPages`);
}

/** One transaction, jsonParsed, any version. null when no endpoint has it. */
async function getTransaction(rpc, signature) {
  return rpc('getTransaction', [signature, TX_OPTIONS]);
}

/** A token account's balance (base units) in a transaction it appears in, from postTokenBalances. */
function balanceInTransaction(tx, tokenAccount) {
  const keys = S.accountKeys(tx);
  const row = ((tx && tx.meta && tx.meta.postTokenBalances) || []).find((b) => keys[b.accountIndex] === tokenAccount);
  // Not among the post balances: the account was closed by this transaction, or never held this
  // mint. Either way it holds nothing afterwards.
  return row ? BigInt(row.uiTokenAmount.amount) : 0n;
}

/**
 * What `tokenAccount` held at unix time `at`: its balance after the last transaction that landed
 * at or before `at`, found by walking its history back from now. 0 when it has no history that
 * old (it did not exist yet). Throws when the history is too long to walk in `maxPages`.
 */
async function balanceAt(rpc, tokenAccount, at, { maxPages = 10, pageSize = 1000 } = {}) {
  let before;
  for (let page = 0; page < maxPages; page++) {
    const opts = { limit: pageSize, commitment: 'confirmed' };
    if (before) opts.before = before;
    const list = await rpc('getSignaturesForAddress', [tokenAccount, opts]);
    if (!Array.isArray(list)) throw new Error('getSignaturesForAddress returned no list for ' + tokenAccount);
    const hit = list.find((s) => Number.isFinite(Number(s.blockTime)) && Number(s.blockTime) <= at);
    if (hit) {
      const tx = await getTransaction(rpc, hit.signature);
      if (!tx) throw new Error('transaction ' + hit.signature + ' could not be read');
      return balanceInTransaction(tx, tokenAccount);
    }
    if (list.length < pageSize) return 0n;
    before = list[list.length - 1].signature;
  }
  throw new Error(`${tokenAccount} has more than ${maxPages * pageSize} transactions since the snapshot`);
}

/**
 * Every token account `owner` has for `mint` now, plus its associated account even if closed.
 * getTokenAccountsByOwner is an indexed call some endpoints refuse; the associated account alone
 * is the fallback, and it is where wallets keep a coin.
 */
async function tokenAccountsOf(rpc, owner, mint, tokenProgram) {
  const ata = await S.associatedTokenAddress(owner, mint, tokenProgram);
  const found = new Set([ata]);
  try {
    const res = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const row of (res && res.value) || []) if (row && S.isAddress(row.pubkey)) found.add(row.pubkey);
  } catch (e) { /* the associated account alone */ }
  return [...found];
}

/** `owner`'s OTT across its token accounts at unix time `at`. */
async function holdingAt(rpc, owner, mint, tokenProgram, at) {
  let total = 0n;
  for (const account of await tokenAccountsOf(rpc, owner, mint, tokenProgram)) total += await balanceAt(rpc, account, at);
  return total;
}

// ---------------------------------------------------------------------------------------------
// pump.fun
// ---------------------------------------------------------------------------------------------

const DISC = {
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
};
// The Anchor discriminators of the instructions claim.js sends (idl/pump.json and idl/pump_amm.json
// in pump-fun/pump-public-docs). test/solana-chain.test.js recomputes them from their names.
const IX = {
  sweepCreatorFee: [32, 246, 191, 52, 8, 201, 73, 186],
  collectCreatorFeeV2: [207, 17, 138, 242, 4, 34, 19, 56],
  collectCoinCreatorFee: [160, 57, 89, 42, 181, 139, 43, 66],
};
const sameBytes = (buf, at, list) => list.every((b, i) => buf[at + i] === b);
const key = (buf, at) => S.encodeBase58(new Uint8Array(buf.subarray(at, at + 32)));
const u64At = (buf, at) => (buf.length >= at + 8 ? buf.readBigUInt64LE(at) : 0n);
const DEFAULT_KEY = S.PROGRAMS.system; // Pubkey::default(), all zeros

/**
 * A BondingCurve account (base64 data). Fields appended over time read as 0 on older, shorter
 * accounts, as pump.fun's docs say to. `quoteMint` is the wrapped-SOL mint for a SOL-paired coin
 * (stored as the default key).
 */
function decodeBondingCurve(base64) {
  const b = Buffer.from(base64, 'base64');
  if (b.length < 81 || !sameBytes(b, 0, DISC.bondingCurve)) throw new Error('not a pump.fun bonding curve');
  const quote = b.length >= 115 ? key(b, 83) : DEFAULT_KEY;
  return {
    virtualTokenReserves: u64At(b, 8), virtualQuoteReserves: u64At(b, 16),
    realTokenReserves: u64At(b, 24), realQuoteReserves: u64At(b, 32), tokenTotalSupply: u64At(b, 40),
    complete: b[48] === 1, creator: key(b, 49),
    isMayhemMode: b.length > 81 && b[81] === 1, isCashbackCoin: b.length > 82 && b[82] === 1,
    quoteMint: quote === DEFAULT_KEY ? S.MINTS.wsol : quote,
    isHolderReward: b.length > 124 && b[124] === 1,
    creatorFee: u64At(b, 125), protocolFees: u64At(b, 133),
  };
}

/** A PumpSwap Pool account (base64 data). */
function decodePool(base64) {
  const b = Buffer.from(base64, 'base64');
  if (b.length < 245 || !sameBytes(b, 0, DISC.pool)) throw new Error('not a PumpSwap pool');
  const virtualQuoteReserves = b.length >= 261 ? (b.readBigInt64LE(253) << 64n) | b.readBigUInt64LE(245) : 0n;
  return {
    index: b.readUInt16LE(9), creator: key(b, 11), baseMint: key(b, 43), quoteMint: key(b, 75), lpMint: key(b, 107),
    baseVault: key(b, 139), quoteVault: key(b, 171), lpSupply: u64At(b, 203), coinCreator: key(b, 211),
    isMayhemMode: b[243] === 1, isCashbackCoin: b[244] === 1, virtualQuoteReserves,
    isHolderReward: b.length > 270 && b[270] === 1,
    protocolFees: u64At(b, 271), creatorFees: u64At(b, 279),
  };
}

const bytesOf = (address) => S.addressBytes(address);
const bondingCurveAddress = async (mint) => (await S.programAddress(['bonding-curve', bytesOf(mint)], S.PROGRAMS.pump)).address;
const poolAuthorityAddress = async (mint) => (await S.programAddress(['pool-authority', bytesOf(mint)], S.PROGRAMS.pump)).address;
/** The canonical PumpSwap pool a graduated coin migrates to (index 0, created by its pool authority). */
async function poolAddress(mint, quoteMint = S.MINTS.wsol) {
  return (await S.programAddress(['pool', Uint8Array.of(0, 0), bytesOf(await poolAuthorityAddress(mint)), bytesOf(mint), bytesOf(quoteMint)], S.PROGRAMS.pumpAmm)).address;
}
/** Where the bonding curve's creator fee lands once swept: a system account holding lamports. */
const creatorVaultAddress = async (creator) => (await S.programAddress(['creator-vault', bytesOf(creator)], S.PROGRAMS.pump)).address;
/** PumpSwap's creator vault: a PDA that owns a wrapped-SOL account holding the pool's creator fee. */
const ammCreatorVaultAuthority = async (creator) => (await S.programAddress(['creator_vault', bytesOf(creator)], S.PROGRAMS.pumpAmm)).address;
const ammCreatorVaultAccount = async (creator, quoteMint = S.MINTS.wsol) => S.associatedTokenAddress(await ammCreatorVaultAuthority(creator), quoteMint, S.PROGRAMS.token);
const eventAuthority = async (program) => (await S.programAddress(['__event_authority'], program)).address;

/**
 * Where the coin trades and at what price: the bonding curve until it completes, then the
 * canonical pool. priceSol is SOL per whole token (the coin has 6 decimals, SOL 9). Throws for a
 * coin that is not SOL-paired; v1 values fees in SOL only.
 */
async function coinState(rpc, mint, { decimals = 6 } = {}) {
  const curve = await bondingCurveAddress(mint);
  const info = await rpc('getAccountInfo', [curve, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!info || !info.value) throw new Error(`${mint} has no pump.fun bonding curve at ${curve}`);
  if (info.value.owner !== S.PROGRAMS.pump) throw new Error(`${curve} is not owned by the pump.fun program`);
  const c = decodeBondingCurve(info.value.data[0]);
  if (c.quoteMint !== S.MINTS.wsol) throw new Error(`${mint} is paired with ${c.quoteMint}, not SOL; v1 handles SOL-paired coins only`);
  const scale = 10 ** (9 - decimals);
  const state = { curve, curveState: c, creator: c.creator, complete: c.complete, quoteMint: c.quoteMint, pool: null, poolState: null };
  if (!c.complete) {
    if (!(c.virtualTokenReserves > 0n)) throw new Error('the bonding curve has no reserves');
    return Object.assign(state, { source: 'bonding-curve', priceSol: Number(c.virtualQuoteReserves) / Number(c.virtualTokenReserves) / scale });
  }
  const pool = await poolAddress(mint);
  const poolInfo = await rpc('getAccountInfo', [pool, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!poolInfo || !poolInfo.value) {
    // Completed, not yet migrated: nothing trades, and the last curve price is the price.
    return Object.assign(state, { source: 'bonding-curve', priceSol: Number(c.virtualQuoteReserves) / Number(c.virtualTokenReserves) / scale });
  }
  const p = decodePool(poolInfo.value.data[0]);
  if (p.baseMint !== mint) throw new Error(`pool ${pool} is not for ${mint}`);
  const vaults = await rpc('getMultipleAccounts', [[p.baseVault, p.quoteVault], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const amount = (v) => BigInt(v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.tokenAmount && v.data.parsed.info.tokenAmount.amount);
  const base = amount(vaults && vaults.value && vaults.value[0]);
  // Fees kept in the pool are subtracted from virtual_quote_reserves, so effective reserves are
  // the vault plus that (signed) figure; pump.fun guarantees the sum is never negative.
  const quote = amount(vaults && vaults.value && vaults.value[1]) + p.virtualQuoteReserves;
  if (!(base > 0n) || quote < 0n) throw new Error('the pool has no reserves');
  return Object.assign(state, { pool, poolState: p, creator: p.coinCreator, source: 'pool', priceSol: Number(quote) / Number(base) / scale });
}

// ---------------------------------------------------------------------------------------------
// SOL in dollars
// ---------------------------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 15000;
async function getJson(url, fetchImpl = globalThis.fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'ott-keeper' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

/** SOL's spot price in dollars. */
async function solUsdNow({ fetchImpl } = {}) {
  const errors = [];
  try {
    const j = await getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot', fetchImpl);
    const v = positive(Number(j && j.data && j.data.amount));
    if (v) return v;
    errors.push('Coinbase gave no price');
  } catch (e) { errors.push('Coinbase: ' + e.message); }
  try {
    const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=SOLUSD', fetchImpl);
    const row = j && j.result && Object.values(j.result)[0];
    const v = positive(Number(row && row.c && row.c[0]));
    if (v) return v;
    errors.push('Kraken gave no price');
  } catch (e) { errors.push('Kraken: ' + e.message); }
  throw new Error('no SOL price: ' + errors.join('; '));
}

/** SOL's price in dollars at unix time `at`: the close of the hour that contains it. */
async function solUsdAt(at, { fetchImpl } = {}) {
  const hour = Math.floor(Number(at) / 3600) * 3600;
  const errors = [];
  try {
    const iso = (s) => new Date(s * 1000).toISOString();
    const rows = await getJson(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${iso(hour)}&end=${iso(hour + 3600)}`, fetchImpl);
    const row = Array.isArray(rows) && rows.find((r) => Array.isArray(r) && Number(r[0]) === hour);
    const v = positive(Number(row && row[4]));
    if (v) return v;
    errors.push('Coinbase has no candle for ' + hour);
  } catch (e) { errors.push('Coinbase: ' + e.message); }
  try {
    const j = await getJson(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=60&since=${hour - 1}`, fetchImpl);
    const rows = j && j.result && Object.entries(j.result).find(([k]) => k !== 'last');
    const row = rows && Array.isArray(rows[1]) && rows[1].find((r) => Number(r[0]) === hour);
    const v = positive(Number(row && row[4]));
    if (v) return v;
    errors.push('Kraken has no candle for ' + hour);
  } catch (e) { errors.push('Kraken: ' + e.message); }
  throw new Error('no SOL price for ' + new Date(hour * 1000).toISOString() + ': ' + errors.join('; '));
}

// ---------------------------------------------------------------------------------------------
// Keys and sending
// ---------------------------------------------------------------------------------------------

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * A signer from a Solana secret key: base58 of the 64-byte secret key (what Phantom exports), or
 * the JSON array of the same 64 bytes (a solana-keygen file's contents). The second half must be
 * the public key of the first, or the key is refused.
 */
function keypairFromSecret(secret) {
  const text = String(secret || '').trim();
  if (!text) throw new Error('no secret key');
  let bytes;
  if (text.startsWith('[')) {
    let list;
    try { list = JSON.parse(text); } catch (e) { throw new Error('the secret key is not a JSON array of bytes'); }
    if (!Array.isArray(list) || list.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('the secret key is not a JSON array of bytes');
    bytes = Uint8Array.from(list);
  } else {
    try { bytes = S.decodeBase58(text); } catch (e) { throw new Error('the secret key is not base58'); }
  }
  if (bytes.length !== 64) throw new Error('a Solana secret key is 64 bytes; this one is ' + bytes.length);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(bytes.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  const publicKey = new Uint8Array(crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12));
  if (!Buffer.from(publicKey).equals(Buffer.from(bytes.subarray(32)))) throw new Error('the secret key does not match its own public key');
  const address = S.encodeBase58(publicKey);
  return Object.freeze({ address, sign: (message) => new Uint8Array(crypto.sign(null, Buffer.from(message), privateKey)) });
}

async function latestBlockhash(rpc) {
  const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = r && r.value;
  if (!value || !value.blockhash) throw new Error('no recent blockhash');
  return { blockhash: value.blockhash, lastValidBlockHeight: Number(value.lastValidBlockHeight) };
}

/** Compile, sign with every signer the message needs, and return the wire bytes and signature. */
function signedTransaction({ payer, blockhash, instructions, signers }) {
  const message = S.compileMessage({ payer, blockhash, instructions });
  const needed = S.messageSigners(message);
  const signatures = needed.map((address) => {
    const signer = signers.find((s) => s.address === address);
    if (!signer) throw new Error('no key for signer ' + address);
    return signer.sign(message);
  });
  return { wire: S.wireTransaction(message, signatures), signature: S.encodeBase58(signatures[0]), message };
}

/** Simulate a signed transaction; throws with the program's logs when it would fail. */
async function simulateTransaction(rpc, wire) {
  const r = await rpc('simulateTransaction', [S.encodeBase64(wire), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
  const value = r && r.value;
  if (!value) throw new Error('the simulation returned nothing');
  if (value.err) {
    const logs = (value.logs || []).slice(-6).join(' | ');
    throw new Error('the transaction would fail: ' + JSON.stringify(value.err) + (logs ? ' — ' + logs : ''));
  }
  return value;
}

/** Broadcast a signed transaction. Returns its signature. */
async function sendTransaction(rpc, wire) {
  const sig = await rpc('sendTransaction', [S.encodeBase64(wire), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
  if (!S.isSignature(sig)) throw new Error('the node did not return a signature');
  return sig;
}

/**
 * Wait until `signature` is confirmed, it fails, or its blockhash expires. Returns 'confirmed' or
 * 'finalized'; throws on failure or expiry. Re-sends the same bytes while waiting, which is safe:
 * one signature can only land once.
 */
async function confirmTransaction(rpc, signature, { wire = null, lastValidBlockHeight = null, timeoutMs = 90000, pollMs = 2000, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]).catch(() => null);
    const status = r && r.value && r.value[0];
    if (status && status.err) throw new Error('transaction ' + signature + ' failed: ' + JSON.stringify(status.err));
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return status.confirmationStatus;
    if (lastValidBlockHeight) {
      const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
      if (Number(height) > lastValidBlockHeight) throw new Error('transaction ' + signature + ' expired before it landed');
    }
    if (now() >= deadline) throw new Error('transaction ' + signature + ' was not confirmed in ' + Math.round(timeoutMs / 1000) + 's');
    if (wire) await rpc('sendTransaction', [S.encodeBase64(wire), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => null);
    await sleep(pollMs);
  }
}

module.exports = {
  TX_OPTIONS, endpoints, makeRpc,
  signaturesAfter, getTransaction, balanceInTransaction, balanceAt, tokenAccountsOf, holdingAt,
  DISC, IX, decodeBondingCurve, decodePool, bondingCurveAddress, poolAuthorityAddress, poolAddress,
  creatorVaultAddress, ammCreatorVaultAuthority, ammCreatorVaultAccount, eventAuthority, coinState,
  solUsdNow, solUsdAt,
  keypairFromSecret, latestBlockhash, signedTransaction, simulateTransaction, sendTransaction, confirmTransaction,
};
