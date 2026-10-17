#!/usr/bin/env node
'use strict';
/**
 * loop.test.js — the whole promise, in order, once, on Solana.
 *
 * The founder's words: "we just need to make sure we have a system that claims fees then buys
 * sims for holders to claim on the dashboard and be able to claim data as well." Every stage of
 * that loop has its own suite (test/claim.test.js, test/fund.test.js, test/allowances.test.js,
 * test/redeem-membership.test.js, test/redeem-wholesale.test.js, test/treasury.test.js), and each
 * invents its own chain, its own week and its own wallets — right for testing a stage alone, and
 * the reason none of them can answer "does the loop actually add up?". This file runs the stages
 * in order against ONE fake Solana and follows the money all the way through:
 *
 *   1. Fees accrue (fixture): trades on the pump.fun bonding curve leave the creator's 0.30% in
 *      the curve, where scripts/pump-fees.js reads it.
 *   2. scripts/claim.js collects it into the treasury (simulate, send, confirm, read back what
 *      the chain says it paid) and appends claims.json.
 *   3. scripts/fund.js turns treasury SOL into sats: a Blink invoice (the mock payer), a FixedFloat
 *      order SOL → BTC Lightning (a localhost fake), one SOL transfer.
 *   4. scripts/allowances.js prices the week's join amount from the curve, finds members in the
 *      incinerator account's history, reads each member's holding at the Monday snapshot from
 *      its token accounts' history, values last week's collections at SOL's hourly price and
 *      writes the capped split.
 *   5. site/api/redeem.js serves each wallet's standing, reading that ledger over HTTP.
 *   6. Members redeem with real ed25519 signatures over the exact messages site/esim.js builds; a
 *      wallet that joins after the ledger claims its welcome eSIM by naming its join transaction;
 *      a holder who never joined is refused weekly credit.
 *   7. The standing's numbers go down by exactly what was redeemed; the welcome eSIM never touches
 *      weekly credit.
 *   8. scripts/treasury.js reports the pool, the fees still waiting and what redemptions cost.
 *
 * Then the coin graduates to PumpSwap, the fees accrue in the pool, a week passes and 2–8 run
 * again: the allowance resets from the new budget instead of accumulating, the new member shares
 * from the first snapshot after their join, and last week's eSIM is topped up rather than doubled.
 *
 * THE CHAIN is not a table of canned answers. It holds every account's lamports, every token
 * account and the pump.fun accounts' bytes, and it executes what it is sent: it decodes each wire
 * transaction, checks every required ed25519 signature and the blockhash, charges the fee
 * (5,000 lamports a signature plus the priority fee), runs the instructions (compute budget,
 * system transfer, associated token CreateIdempotent, token TransferChecked and CloseAccount,
 * pump's sweep_creator_fee and collect_creator_fee_v2, PumpSwap's sweep_creator_fee and
 * collect_coin_creator_fee), refuses one that changes an account the message marked read-only,
 * and records it under every account it names, as getTransaction (jsonParsed) and
 * getSignaturesForAddress report it. So the join site/esim.js builds, the claim scripts/pump-fees.js
 * builds and the transfer scripts/fund.js builds are each run as written, and a lamport claim.js
 * moves is the same lamport fund.js spends, allowances.js values and treasury.js reports. Trades
 * themselves are fixtures (recorded the same way, with their own bookkeeping), because pump.fun's
 * swap program is not ours to rebuild.
 *
 * What is real and what is simulated, so the figures below are read honestly:
 *   REAL:      scripts/claim.js, pump-fees.js, fund.js, allowances.js, treasury.js, solana-chain.js;
 *              site/api/redeem.js with _lib/membership.js, rpc.js, solana-auth.js, keccak.js,
 *              bolt11.js, store.js (STORE=memory) and providers/wholesale.js; site/esim.js's
 *              signInMessage, joinTransaction and publishedJoinMismatch; site/solana.js.
 *   SIMULATED: Solana and pump.fun (the chain below), SOL's dollar price, FixedFloat (localhost
 *              HTTP), the eSIM supplier (test/support/fake-wholesale.js) and the Lightning wallet
 *              (LN_PAYER=mock — no sats ever really move).
 *   NOT PROVEN here or anywhere in this repo: that a real Blink wallet pays a real invoice the real
 *              supplier accepts, or that pump.fun's programs behave as the chain below models them.
 *              claim.js --rehearse simulates the claim against live pump.fun coins for the second.
 *
 *   node test/loop.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const API = path.join(SITE, 'api');

// The API's adapters are chosen from the environment when it is first used. Offline, in memory,
// against the fake supplier and the mock Lightning wallet, and never in production mode.
process.env.ESIM_PROVIDER = 'wholesale';
process.env.LN_PAYER = 'mock';
process.env.STORE = 'memory';
process.env.WHOLESALE_ALLOW_MEMORY_STORE = '1';
process.env.WHOLESALE_COMPLETE_WAIT_MS = '3000';
process.env.SIGNIN_HOST = 'ott.test';
for (const name of ['NODE_ENV', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'REDEMPTIONS_ENABLED', 'FRONTEND_ORIGINS', 'STORE_PREFIX']) delete process.env[name];

const S = require(path.join(SITE, 'solana.js'));
const C = require(path.join(ROOT, 'scripts', 'solana-chain.js'));
const P = require(path.join(ROOT, 'scripts', 'pump-fees.js'));
const CL = require(path.join(ROOT, 'scripts', 'claim.js'));
const F = require(path.join(ROOT, 'scripts', 'fund.js'));
const A = require(path.join(ROOT, 'scripts', 'allowances.js'));
const T = require(path.join(ROOT, 'scripts', 'treasury.js'));
const M = require(path.join(API, '_lib', 'membership.js'));
const mockPayer = require(path.join(API, '_lib', 'payers', 'mock.js'));
const providers = require(path.join(API, '_lib', 'providers'));
const fakeWholesale = require(path.join(__dirname, 'support', 'fake-wholesale.js'));

// The browser's own code, loaded the way test/membership-client.test.js loads it.
global.window = { OTTSolana: S };
global.location = { host: 'ott.test' };
require(path.join(SITE, 'esim.js'));
const page = global.window.WhateverData;

// ---------------------------------------------------------------------------------------------
// House-style check helpers, the same shape as every other suite in test/.
// ---------------------------------------------------------------------------------------------
let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
const check = (what, got, want) => {
  checks++;
  if (norm(got) === norm(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const checkThat = (what, cond, detail) => {
  checks++;
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}${detail !== undefined ? '\n       ' + detail : ''}`); }
};
const round2 = (x) => Math.round(x * 100) / 100;
const usd = (n) => '$' + Number(n).toFixed(2);
const sol = (lamports) => (Number(lamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + ' SOL';
const LAMPORTS = (n) => BigInt(Math.round(n * 1e9));
const OTT = (n) => BigInt(n) * 1000000n;   // whole OTT in base units (6 decimals)

// ---------------------------------------------------------------------------------------------
// A wall clock this file moves by hand. Date.now() alone is not enough: the API, the wholesale
// provider and the bolt11 encoder all call `new Date()`, which V8 does not route through
// Date.now(), so both are replaced together. The subclass keeps every other Date method and every
// `instanceof Date` check working; only "what time is it now" is ours.
// ---------------------------------------------------------------------------------------------
const RealDate = Date;
let clockMs = 0;
global.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(clockMs); else super(...args); }
  static now() { return clockMs; }
};
const restoreClock = () => { global.Date = RealDate; };
const nowS = () => Math.floor(clockMs / 1000);

// Three weeks, Monday to Monday, UTC: the coin launches in W-1 (a Thursday), and W and W+1 are
// the two weeks whose budgets this file follows. A fixed date, so the run is the same any day.
const W = A.weekOf(RealDate.parse('2026-10-19T00:00:00.000Z') / 1000);
const DAY = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const when = (week, day, hh, mm = 0) => A.weekStart(week) + DAY[day] * 86400 + hh * 3600 + mm * 60;
const setClock = (week, day, hh, mm = 0) => { clockMs = when(week, day, hh, mm) * 1000; return nowS(); };
// SOL in dollars: $150 in the launch week, $160 the week after, $170 the week after that.
const solPrice = (t) => (A.weekOf(t) < W ? 150 : A.weekOf(t) < W + 1 ? 160 : 170);
const prices = { now: async () => solPrice(nowS()), at: async (t) => solPrice(t) };

// ---------------------------------------------------------------------------------------------
// Keys. Every wallet is a real ed25519 keypair, so every signature in this file — on a message to
// the API or on a transaction to the chain — is one the real verifier checks.
// ---------------------------------------------------------------------------------------------
const newKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return C.keypairFromSecret(S.encodeBase58(new Uint8Array(Buffer.concat([seed, pub]))));
};
const TREASURY = newKey();   // the wallet that creates the coin on pump.fun, so it is paid the creator fee
const ALICE = newKey();      // a large holder who joins before the first snapshot
const BOB = newKey(), ERIN = newKey(), FRANK = newKey();   // small holders who join before it too
const CAROL = newKey();      // holds OTT and never joins
const DAVE = newKey();       // joins on Monday of week W, after that week's ledger
const TRADER = newKey();     // trading volume, which is what pays the creator fee
const WHALE = newKey();      // buys out the rest of the curve, so the coin graduates
const MIGRATOR = newKey();   // pump.fun's migration, which moves the curve's reserves into PumpSwap
const COIN = newKey().address;   // a pump.fun mint is a keypair address
const FF_DEPOSIT = newKey().address;   // FixedFloat's one-off Solana deposit address

const SYSTEM = S.PROGRAMS.system, TOKEN = S.PROGRAMS.token, T22 = S.PROGRAMS.token2022;
const ATA_PROGRAM = S.PROGRAMS.associatedToken, BUDGET = S.PROGRAMS.computeBudget;
const PUMP = S.PROGRAMS.pump, PUMP_AMM = S.PROGRAMS.pumpAmm, WSOL = S.MINTS.wsol;
const SUPPLY = OTT(1000000000);   // 1,000,000,000 OTT at 6 decimals, all minted to the curve
// Rent-exempt minimums: a data-less system account, a token account, a Token-2022 account with
// its immutable-owner extension, the mint, the curve and the pool.
const RENT = { system: 890880n, token: 2039280n, token2022: 2074080n, mint: 4231680n, curve: 2046240n, pool: 3020160n };

// ---------------------------------------------------------------------------------------------
// THE CHAIN
// ---------------------------------------------------------------------------------------------
function chainError(message) { return new Error(message); }
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const chain = (() => {
  const lamports = new Map();   // address -> bigint: every account holding SOL
  const tokens = new Map();     // token account -> { mint, owner, amount, program }
  const data = new Map();       // program-owned account -> { owner, bytes }
  const history = new Map();    // address -> signature rows, newest first
  const txs = new Map();        // signature -> the getTransaction (jsonParsed) answer
  const blockhashes = new Set();
  const log = { sent: [], simulated: [], fixtures: 0, calls: [] };
  let slot = 412000000, height = 392000000;

  const bal = (address) => lamports.get(address) || 0n;
  const credit = (address, n) => { lamports.set(address, bal(address) + BigInt(n)); };
  const debit = (address, n) => {
    const amount = BigInt(n);
    if (bal(address) < amount) throw chainError(`insufficient lamports in ${address}: ${bal(address)} < ${amount}`);
    lamports.set(address, bal(address) - amount);
  };
  const bytesOf = (address) => {
    const d = data.get(address);
    if (!d) throw chainError('no account data at ' + address);
    return d.bytes;
  };
  const u64 = (address, at) => bytesOf(address).readBigUInt64LE(at);
  const setU64 = (address, at, v) => { bytesOf(address).writeBigUInt64LE(BigInt(v), at); };
  const i128 = (address, at) => { const b = bytesOf(address); return (b.readBigInt64LE(at + 8) << 64n) | b.readBigUInt64LE(at); };
  const setI128 = (address, at, v) => { const b = bytesOf(address); b.writeBigUInt64LE(BigInt.asUintN(64, v), at); b.writeBigInt64LE(BigInt.asIntN(64, v >> 64n), at + 8); };
  const keyAt = (address, at) => S.encodeBase58(new Uint8Array(bytesOf(address).subarray(at, at + 32)));
  const decimalsOf = (mint) => (mint === WSOL ? 9 : bytesOf(mint)[44]);

  function createData(address, owner, bytes, rent, payer) {
    if (data.has(address)) throw chainError('account already in use: ' + address);
    debit(payer, rent);
    credit(address, rent);
    data.set(address, { owner, bytes: Buffer.from(bytes) });
  }
  function openTokenAccount(account, { mint, owner, program, payer }) {
    if (tokens.has(account)) throw chainError('account already in use: ' + account);
    const rent = program === T22 ? RENT.token2022 : RENT.token;
    debit(payer, rent);
    credit(account, rent);
    tokens.set(account, { mint, owner, amount: 0n, program });
  }
  /** Token units between accounts of one mint. Wrapped SOL is lamports too, so they move with it. */
  function moveTokens(from, to, amount) {
    const a = tokens.get(from), b = tokens.get(to);
    if (!a || !b) throw chainError('invalid account data for instruction');
    if (a.mint !== b.mint) throw chainError('account not associated with this mint');
    if (a.amount < amount) throw chainError('insufficient funds');
    a.amount -= amount;
    b.amount += amount;
    if (a.mint === WSOL) { debit(from, amount); credit(to, amount); }
  }
  /** Lamports into a wrapped-SOL account, as its token amount too. */
  function wrap(account, amount) {
    const t = tokens.get(account);
    if (!t || t.mint !== WSOL) throw chainError('not a wrapped-SOL account: ' + account);
    t.amount += amount;
    credit(account, amount);
  }

  const snapshot = () => ({
    lamports: new Map(lamports),
    tokens: new Map([...tokens].map(([k, v]) => [k, Object.assign({}, v)])),
    data: new Map([...data].map(([k, v]) => [k, { owner: v.owner, bytes: Buffer.from(v.bytes) }])),
  });
  function restore(s) {
    lamports.clear(); s.lamports.forEach((v, k) => lamports.set(k, v));
    tokens.clear(); s.tokens.forEach((v, k) => tokens.set(k, v));
    data.clear(); s.data.forEach((v, k) => data.set(k, v));
  }
  /** Every address whose lamports, token account or data differ from `before`. */
  function changedSince(before) {
    const out = new Set();
    for (const a of new Set([...before.lamports.keys(), ...lamports.keys()])) if ((before.lamports.get(a) || 0n) !== bal(a)) out.add(a);
    const tokenKey = (t) => (t ? [t.mint, t.owner, t.amount.toString(), t.program].join('|') : '');
    for (const a of new Set([...before.tokens.keys(), ...tokens.keys()])) if (tokenKey(before.tokens.get(a)) !== tokenKey(tokens.get(a))) out.add(a);
    for (const a of new Set([...before.data.keys(), ...data.keys()])) {
      const x = before.data.get(a), y = data.get(a);
      if (!x || !y || !x.bytes.equals(y.bytes)) out.add(a);
    }
    return out;
  }
  /** As on chain: an account a transaction changes must be one its message marks writable. */
  function requireWritable(before, keys) {
    for (const address of changedSince(before)) {
      const k = keys.find((x) => x.address === address);
      if (!k || !k.writable) throw chainError(`${address} was changed but the message does not mark it writable`);
    }
  }

  const stateOf = (address) => ({ lamports: bal(address), token: tokens.has(address) ? Object.assign({}, tokens.get(address)) : null });
  const balanceRow = (index, t) => ({
    accountIndex: index, mint: t.mint, owner: t.owner, programId: t.program,
    uiTokenAmount: { amount: t.amount.toString(), decimals: decimalsOf(t.mint), uiAmountString: S.tokensOf(t.amount, decimalsOf(t.mint)) },
  });
  /** A landed transaction, recorded the way getTransaction (jsonParsed) and getSignaturesForAddress answer. */
  function commit({ signatures, keys, blockhash, before, fee, units }) {
    slot += 2;
    height += 1;
    const at = nowS();
    const after = keys.map((k) => stateOf(k.address));
    const tx = {
      slot, blockTime: at, version: 'legacy',
      meta: {
        err: null, status: { Ok: null }, fee: Number(fee), computeUnitsConsumed: units,
        preBalances: before.map((s) => Number(s.lamports)), postBalances: after.map((s) => Number(s.lamports)),
        preTokenBalances: before.flatMap((s, i) => (s.token ? [balanceRow(i, s.token)] : [])),
        postTokenBalances: after.flatMap((s, i) => (s.token ? [balanceRow(i, s.token)] : [])),
        logMessages: [], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] },
      },
      transaction: {
        signatures,
        message: { accountKeys: keys.map((k) => ({ pubkey: k.address, signer: k.signer, writable: k.writable, source: 'transaction' })), recentBlockhash: blockhash, instructions: [] },
      },
    };
    txs.set(signatures[0], tx);
    for (const address of new Set(keys.map((k) => k.address))) {
      if (!history.has(address)) history.set(address, []);
      history.get(address).unshift({ signature: signatures[0], slot, blockTime: at, err: null, memo: null, confirmationStatus: 'confirmed' });
    }
    return signatures[0];
  }

  /** A legacy wire transaction: its signatures, message bytes, account keys with roles, blockhash and instructions. */
  function parseWire(base64) {
    const wire = Buffer.from(base64, 'base64');
    let at = 0;
    const len = () => { const { value, next } = S.readCompactLength(wire, at); at = next; return value; };
    const signatureCount = len();
    const sigs = [];
    for (let i = 0; i < signatureCount; i++) { sigs.push(wire.subarray(at, at + 64)); at += 64; }
    const message = wire.subarray(at);
    const required = wire[at], readonlySigned = wire[at + 1], readonlyUnsigned = wire[at + 2];
    if (required & 0x80) throw chainError('only legacy messages are modelled here');
    if (required !== signatureCount) throw chainError('the signature count does not match the message');
    at += 3;
    const count = len();
    const keys = [];
    for (let i = 0; i < count; i++) {
      const signer = i < required;
      keys.push({ address: S.encodeBase58(new Uint8Array(wire.subarray(at, at + 32))), signer, writable: signer ? i < required - readonlySigned : i < count - readonlyUnsigned });
      at += 32;
    }
    const blockhash = S.encodeBase58(new Uint8Array(wire.subarray(at, at + 32)));
    at += 32;
    const instructions = [];
    for (let n = len(); n > 0; n--) {
      const program = keys[wire[at++]].address;
      const accounts = [];
      for (let k = len(); k > 0; k--) accounts.push(keys[wire[at++]].address);
      const size = len();
      instructions.push({ program, accounts, data: Buffer.from(wire.subarray(at, at + size)) });
      at += size;
    }
    return { sigs, message, keys, blockhash, instructions, signature: S.encodeBase58(new Uint8Array(sigs[0])) };
  }

  /** One instruction, against the live state. `signers` are the message's signing addresses. */
  async function instruction(ix, signers) {
    const a = ix.accounts, d = ix.data;
    const signed = (address) => { if (!signers.has(address)) throw chainError('missing required signature for ' + address); };
    switch (ix.program) {
      case BUDGET: return;
      case SYSTEM: {
        if (d.length !== 12 || d.readUInt32LE(0) !== 2) throw chainError('only system transfers are modelled');
        signed(a[0]);
        const amount = d.readBigUInt64LE(4);
        debit(a[0], amount);
        credit(a[1], amount);
        return;
      }
      case ATA_PROGRAM: {
        const [payer, account, owner, mint, system, program] = a;
        if (system !== SYSTEM || !S.TOKEN_PROGRAMS.includes(program)) throw chainError('the associated token accounts are wrong');
        if (account !== await S.associatedTokenAddress(owner, mint, program)) throw chainError('Provided seeds do not result in a valid address');
        if (tokens.has(account)) {
          const t = tokens.get(account);
          if (d.length === 1 && d[0] === 1 && t.owner === owner && t.mint === mint) return;   // CreateIdempotent of an existing account
          throw chainError('account already in use');
        }
        signed(payer);
        openTokenAccount(account, { mint, owner, program, payer });
        return;
      }
      case TOKEN:
      case T22: {
        if (d[0] === 12) {   // TransferChecked
          const [source, mint, destination, owner] = a;
          const src = tokens.get(source), dst = tokens.get(destination);
          if (!src || !dst) throw chainError('invalid account data for instruction');
          if (src.program !== ix.program || dst.program !== ix.program) throw chainError('incorrect program id for the token account');
          if (src.mint !== mint || dst.mint !== mint) throw chainError('account not associated with this mint');
          if (d[9] !== decimalsOf(mint)) throw chainError('the decimals do not match the mint');
          if (src.owner !== owner) throw chainError('owner does not match');
          signed(owner);
          moveTokens(source, destination, d.readBigUInt64LE(1));
          return;
        }
        if (d[0] === 9) {   // CloseAccount
          const [account, destination, owner] = a;
          const t = tokens.get(account);
          if (!t) throw chainError('invalid account data for instruction');
          if (t.owner !== owner) throw chainError('owner does not match');
          signed(owner);
          if (t.mint !== WSOL && t.amount !== 0n) throw chainError('non-native account can only be closed if its balance is zero');
          const all = bal(account);
          debit(account, all);
          credit(destination, all);
          tokens.delete(account);
          lamports.delete(account);
          return;
        }
        throw chainError('token instruction ' + d[0] + ' is not modelled');
      }
      case PUMP: {
        const disc = Array.from(d.subarray(0, 8));
        if (sameList(disc, C.IX.sweepCreatorFee)) {
          const [payer, , mint, , , , , curve, , vault] = a;
          signed(payer);
          if (curve !== await C.bondingCurveAddress(mint)) throw chainError('ConstraintSeeds: bonding_curve');
          if (vault !== await C.creatorVaultAddress(keyAt(curve, 49))) throw chainError('ConstraintSeeds: creator_vault');
          const fee = u64(curve, 125);
          if (fee > 0n) { debit(curve, fee); credit(vault, fee); setU64(curve, 125, 0n); }
          return;
        }
        if (sameList(disc, C.IX.collectCreatorFeeV2)) {
          const [creator, , vault] = a;
          if (vault !== await C.creatorVaultAddress(creator)) throw chainError('ConstraintSeeds: creator_vault');
          const spare = bal(vault) > RENT.system ? bal(vault) - RENT.system : 0n;
          if (spare > 0n) { debit(vault, spare); credit(creator, spare); }
          return;
        }
        throw chainError('pump instruction ' + disc.join(',') + ' is not modelled');
      }
      case PUMP_AMM: {
        const disc = Array.from(d.subarray(0, 8));
        if (sameList(disc, C.IX.sweepCreatorFee)) {
          const [payer, , pool, , , quoteVault, authority, vault] = a;
          signed(payer);
          if (quoteVault !== keyAt(pool, 171)) throw chainError('ConstraintAddress: pool_quote_token_account');
          if (authority !== await C.ammCreatorVaultAuthority(keyAt(pool, 211))) throw chainError('ConstraintSeeds: coin_creator_vault_authority');
          if (vault !== await S.associatedTokenAddress(authority, WSOL, TOKEN)) throw chainError('ConstraintAssociated: coin_creator_vault_ata');
          if (!tokens.has(vault)) openTokenAccount(vault, { mint: WSOL, owner: authority, program: TOKEN, payer });
          const fees = u64(pool, 279);
          if (fees > 0n) { moveTokens(quoteVault, vault, fees); setU64(pool, 279, 0n); setI128(pool, 245, i128(pool, 245) + fees); }
          return;
        }
        if (sameList(disc, C.IX.collectCoinCreatorFee)) {
          const [, , creator, authority, vault, creatorQuote] = a;
          if (authority !== await C.ammCreatorVaultAuthority(creator)) throw chainError('ConstraintSeeds: coin_creator_vault_authority');
          if (vault !== await S.associatedTokenAddress(authority, WSOL, TOKEN)) throw chainError('ConstraintAssociated: coin_creator_vault_ata');
          const dest = tokens.get(creatorQuote);
          if (!dest || dest.owner !== creator || dest.mint !== WSOL) throw chainError('the creator\'s wrapped-SOL account is missing');
          const amount = tokens.has(vault) ? tokens.get(vault).amount : 0n;
          if (amount > 0n) moveTokens(vault, creatorQuote, amount);
          return;
        }
        throw chainError('pump-amm instruction ' + disc.join(',') + ' is not modelled');
      }
      default: throw chainError('program ' + ix.program + ' is not modelled');
    }
  }

  /** Run a parsed transaction against the live state: signatures, blockhash, fee, then each instruction. */
  async function execute(tx, { sigVerify = true, blockhashCheck = true } = {}) {
    const signers = new Set(tx.keys.filter((k) => k.signer).map((k) => k.address));
    if (sigVerify) {
      tx.keys.forEach((k, i) => {
        if (!k.signer) return;
        const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(S.addressBytes(k.address))]), format: 'der', type: 'spki' });
        if (!crypto.verify(null, tx.message, publicKey, tx.sigs[i])) throw chainError('signature verification failed for ' + k.address);
      });
    }
    if (blockhashCheck && !blockhashes.has(tx.blockhash)) throw chainError('Blockhash not found');
    let limit = null, price = 0n, ordinary = 0;
    for (const ix of tx.instructions) {
      if (ix.program !== BUDGET) { ordinary++; continue; }
      if (ix.data[0] === 2) limit = ix.data.readUInt32LE(1);
      else if (ix.data[0] === 3) price = ix.data.readBigUInt64LE(1);
      else throw chainError('compute budget instruction ' + ix.data[0] + ' is not modelled');
    }
    const units = limit === null ? Math.min(1400000, 200000 * ordinary) : limit;
    const fee = 5000n * BigInt(signers.size) + (price * BigInt(units) + 999999n) / 1000000n;
    debit(tx.keys[0].address, fee);
    for (const [i, ix] of tx.instructions.entries()) {
      try { await instruction(ix, signers); } catch (e) { e.instruction = i; throw e; }
    }
    return { fee, units };
  }

  function accountInfo(address, encoding = 'base64') {
    const t = tokens.get(address);
    if (t) {
      const decimals = decimalsOf(t.mint);
      if (encoding === 'jsonParsed') {
        return { lamports: Number(bal(address)), owner: t.program, executable: false, rentEpoch: 0, space: t.program === T22 ? 170 : 165,
          data: { program: t.program === T22 ? 'spl-token-2022' : 'spl-token', space: t.program === T22 ? 170 : 165,
            parsed: { type: 'account', info: { isNative: t.mint === WSOL, mint: t.mint, owner: t.owner, state: 'initialized',
              tokenAmount: { amount: t.amount.toString(), decimals, uiAmountString: S.tokensOf(t.amount, decimals) } } } } };
      }
      const b = Buffer.alloc(165);
      Buffer.from(S.addressBytes(t.mint)).copy(b, 0);
      Buffer.from(S.addressBytes(t.owner)).copy(b, 32);
      b.writeBigUInt64LE(t.amount, 64);
      b[108] = 1;
      return { lamports: Number(bal(address)), owner: t.program, data: [b.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: 165 };
    }
    const d = data.get(address);
    if (d) return { lamports: Number(bal(address)), owner: d.owner, data: [d.bytes.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: d.bytes.length };
    if (bal(address) > 0n) return { lamports: Number(bal(address)), owner: SYSTEM, data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 };
    return null;
  }

  async function rpc(method, params = []) {
    log.calls.push(method);
    switch (method) {
      case 'getSlot': return slot;
      case 'getBlockHeight': return height;
      case 'getFirstAvailableBlock': return 0;
      case 'getLatestBlockhash': {
        const blockhash = S.encodeBase58(new Uint8Array(crypto.randomBytes(32)));
        blockhashes.add(blockhash);
        return { context: { slot }, value: { blockhash, lastValidBlockHeight: height + 150 } };
      }
      case 'getBalance': return { context: { slot }, value: Number(bal(params[0])) };
      case 'getAccountInfo': return { context: { slot }, value: accountInfo(params[0], params[1] && params[1].encoding) };
      case 'getMultipleAccounts': return { context: { slot }, value: params[0].map((a) => accountInfo(a, params[1] && params[1].encoding)) };
      case 'getTokenAccountsByOwner': {
        const [owner, filter = {}, opts = {}] = params;
        return { context: { slot }, value: [...tokens].filter(([, t]) => t.owner === owner && (!filter.mint || t.mint === filter.mint) && (!filter.programId || t.program === filter.programId))
          .map(([pubkey]) => ({ pubkey, account: accountInfo(pubkey, opts.encoding) })) };
      }
      case 'getTokenSupply': {
        const supply = u64(params[0], 36);
        return { context: { slot }, value: { amount: supply.toString(), decimals: decimalsOf(params[0]), uiAmountString: S.tokensOf(supply, decimalsOf(params[0])) } };
      }
      case 'getSignaturesForAddress': {
        const [address, opts = {}] = params;
        let list = history.get(address) || [];
        if (opts.before) { const i = list.findIndex((s) => s.signature === opts.before); list = i >= 0 ? list.slice(i + 1) : []; }
        if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, opts.limit || 1000).map((s) => Object.assign({}, s));
      }
      case 'getTransaction': { const tx = txs.get(params[0]); return tx ? JSON.parse(JSON.stringify(tx)) : null; }
      case 'getSignatureStatuses':
        return { context: { slot }, value: params[0].map((s) => (txs.has(s) ? { slot: txs.get(s).slot, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) };
      case 'simulateTransaction': {
        const [base64, opts = {}] = params;
        const tx = parseWire(base64);
        log.simulated.push({ signature: tx.signature, sigVerify: opts.sigVerify !== false });
        const before = snapshot();
        try {
          const { units } = await execute(tx, { sigVerify: opts.sigVerify !== false, blockhashCheck: !opts.replaceRecentBlockhash });
          requireWritable(before, tx.keys);
          const accounts = opts.accounts ? opts.accounts.addresses.map((a) => accountInfo(a, 'base64')) : null;
          return { context: { slot }, value: { err: null, logs: ['Program log: simulated by the loop\'s chain'], unitsConsumed: units, accounts } };
        } catch (e) {
          return { context: { slot }, value: { err: e.instruction === undefined ? 'SignatureFailure' : { InstructionError: [e.instruction, { Custom: 1 }] }, logs: ['Program log: ' + e.message], unitsConsumed: 0, accounts: null } };
        } finally { restore(before); }
      }
      case 'sendTransaction': {
        const tx = parseWire(params[0]);
        if (txs.has(tx.signature)) return tx.signature;   // a re-send of a landed transaction changes nothing
        const before = snapshot();
        const states = tx.keys.map((k) => stateOf(k.address));
        try {
          const { fee, units } = await execute(tx);
          requireWritable(before, tx.keys);
          log.sent.push(tx.signature);
          return commit({ signatures: tx.sigs.map((s) => S.encodeBase58(new Uint8Array(s))), keys: tx.keys, blockhash: tx.blockhash, before: states, fee, units });
        } catch (e) {
          restore(before);
          throw chainError('Transaction simulation failed: ' + e.message);
        }
      }
      default: throw chainError('the fake chain does not answer ' + method);
    }
  }

  /**
   * A transaction this file writes by hand (a trade, the coin's creation, the migration): `effect`
   * changes the state directly, `keys` must name every account it changes, and it is recorded
   * exactly as a sent transaction is.
   */
  function fixture({ signer, keys = [], effect, fee = 5000n }) {
    const list = [...new Set([signer, ...keys])].map((address, i) => ({ address, signer: i === 0, writable: true }));
    const states = list.map((k) => stateOf(k.address));
    const before = snapshot();
    try {
      debit(signer, fee);
      effect();
      requireWritable(before, list);
    } catch (e) { restore(before); throw e; }
    log.fixtures++;
    return commit({ signatures: [S.encodeBase58(new Uint8Array(crypto.randomBytes(64)))], keys: list, blockhash: S.encodeBase58(new Uint8Array(crypto.randomBytes(32))), before: states, fee, units: 0 });
  }

  return { lamports, tokens, data, history, txs, log, bal, credit, debit, u64, setU64, i128, setI128, keyAt, createData, openTokenAccount, moveTokens, wrap, rpc, fixture };
})();
const rpc = chain.rpc;

// ---------------------------------------------------------------------------------------------
// pump.fun, as fixtures on that chain
// ---------------------------------------------------------------------------------------------
const CURVE = { vt: 8, vq: 16, rt: 24, rq: 32, supply: 40, complete: 48, creator: 49, creatorFee: 125 };
const POOL = { quoteVault: 171, coinCreator: 211, virtualQuote: 245, creatorFees: 279 };
const CURVE_FEE_BPS = 30n;   // the creator's 0.30% of every trade on the curve

function mintBytes() {
  const b = Buffer.alloc(82);   // no mint authority, no freeze authority, as pump.fun leaves a coin
  b.writeBigUInt64LE(SUPPLY, 36);
  b[44] = 6;
  b[45] = 1;
  return b;
}
function curveBytes(creator) {
  const b = Buffer.alloc(166);
  Buffer.from(C.DISC.bondingCurve).copy(b, 0);
  b.writeBigUInt64LE(OTT(1073000000), CURVE.vt);   // pump.fun's starting virtual reserves
  b.writeBigUInt64LE(LAMPORTS(30), CURVE.vq);
  b.writeBigUInt64LE(OTT(793100000), CURVE.rt);    // the tokens the curve sells before it completes
  b.writeBigUInt64LE(0n, CURVE.rq);
  b.writeBigUInt64LE(SUPPLY, CURVE.supply);
  Buffer.from(S.addressBytes(creator)).copy(b, CURVE.creator);   // the quote mint stays the default key: paired with SOL
  return b;
}
function poolBytes({ authority, baseVault, quoteVault, creator }) {
  const b = Buffer.alloc(301);
  Buffer.from(C.DISC.pool).copy(b, 0);
  b[8] = 255;
  b.writeUInt16LE(0, 9);
  for (const [at, key] of [[11, authority], [43, COIN], [75, WSOL], [107, newKey().address], [139, baseVault], [171, quoteVault], [211, creator]]) Buffer.from(S.addressBytes(key)).copy(b, at);
  b.writeBigUInt64LE(OTT(4193388), 203);
  return b;
}

const coin = {};   // the addresses the coin's accounts live at, filled in by launch()
async function addresses() {
  coin.curve = await C.bondingCurveAddress(COIN);
  coin.curveTokens = await S.associatedTokenAddress(coin.curve, COIN, T22);
  coin.vault = await C.creatorVaultAddress(TREASURY.address);
  coin.burnAccount = await S.associatedTokenAddress(S.INCINERATOR, COIN, T22);
  coin.pool = await C.poolAddress(COIN);
  coin.poolAuthority = await C.poolAuthorityAddress(COIN);
  coin.baseVault = await S.associatedTokenAddress(coin.pool, COIN, T22);
  coin.quoteVault = await S.associatedTokenAddress(coin.pool, WSOL, TOKEN);
  coin.ammAuthority = await C.ammCreatorVaultAuthority(TREASURY.address);
  coin.ammVault = await C.ammCreatorVaultAccount(TREASURY.address);
}
const ottAccount = (owner) => S.associatedTokenAddress(owner, COIN, T22);
const held = async (owner) => { const t = chain.tokens.get(await ottAccount(owner)); return t ? t.amount : 0n; };
const curvePriceSol = () => Number(chain.u64(coin.curve, CURVE.vq)) / Number(chain.u64(coin.curve, CURVE.vt)) / 1000;
const poolPriceSol = () => {
  const quote = chain.tokens.get(coin.quoteVault).amount + chain.i128(coin.pool, POOL.virtualQuote);
  return Number(quote) / Number(chain.tokens.get(coin.baseVault).amount) / 1000;
};

/** The coin's creation: the mint, the curve holding the whole supply, and the creator's vault. */
function launch() {
  return chain.fixture({ signer: TREASURY.address, keys: [COIN, coin.curve, coin.curveTokens, coin.vault, PUMP], effect: () => {
    chain.createData(COIN, T22, mintBytes(), RENT.mint, TREASURY.address);
    chain.createData(coin.curve, PUMP, curveBytes(TREASURY.address), RENT.curve, TREASURY.address);
    chain.openTokenAccount(coin.curveTokens, { mint: COIN, owner: coin.curve, program: T22, payer: TREASURY.address });
    chain.tokens.get(coin.curveTokens).amount = SUPPLY;
    chain.debit(TREASURY.address, RENT.system);
    chain.credit(coin.vault, RENT.system);
  } });
}

/**
 * A buy on the curve: `lamports` in, the creator's 0.30% kept on the curve for the creator, the
 * rest into the reserves, and tokens out by the constant product (rounded in the curve's favour).
 * `allRemaining` buys exactly what the curve has left to sell, which completes it.
 */
async function buy(key, lamports, { allRemaining = false } = {}) {
  const account = await ottAccount(key.address);
  let out = 0n, paid = 0n, fee = 0n;
  chain.fixture({ signer: key.address, keys: [account, coin.curve, coin.curveTokens, COIN, PUMP], effect: () => {
    const vt = chain.u64(coin.curve, CURVE.vt), vq = chain.u64(coin.curve, CURVE.vq), rt = chain.u64(coin.curve, CURVE.rt), rq = chain.u64(coin.curve, CURVE.rq);
    let net;
    if (allRemaining) {
      out = rt;
      const vqAfter = (vt * vq + (vt - rt) - 1n) / (vt - rt);
      net = vqAfter - vq;
      paid = (net * 10000n + (10000n - CURVE_FEE_BPS) - 1n) / (10000n - CURVE_FEE_BPS);
      fee = paid - net;
    } else {
      paid = BigInt(lamports);
      fee = paid * CURVE_FEE_BPS / 10000n;
      net = paid - fee;
      const vqAfter = vq + net;
      out = vt - (vt * vq + vqAfter - 1n) / vqAfter;
      if (out > rt) throw chainError('the curve has fewer tokens left than this buy');
    }
    chain.debit(key.address, paid);
    chain.credit(coin.curve, paid);
    chain.setU64(coin.curve, CURVE.vt, vt - out);
    chain.setU64(coin.curve, CURVE.vq, vq + net);
    chain.setU64(coin.curve, CURVE.rt, rt - out);
    chain.setU64(coin.curve, CURVE.rq, rq + net);
    chain.setU64(coin.curve, CURVE.creatorFee, chain.u64(coin.curve, CURVE.creatorFee) + fee);
    if (!chain.tokens.has(account)) chain.openTokenAccount(account, { mint: COIN, owner: key.address, program: T22, payer: key.address });
    chain.moveTokens(coin.curveTokens, account, out);
    if (allRemaining) chain.data.get(coin.curve).bytes[CURVE.complete] = 1;
  } });
  return { tokens: out, paid, fee };
}

/** Round-trip trading volume on the curve: it leaves only the creator's fee behind, `fee` lamports of it. */
const curveVolume = (key, fee) => chain.fixture({ signer: key.address, keys: [coin.curve, PUMP], effect: () => {
  chain.debit(key.address, fee);
  chain.credit(coin.curve, fee);
  chain.setU64(coin.curve, CURVE.creatorFee, chain.u64(coin.curve, CURVE.creatorFee) + BigInt(fee));
} });

/** The completed curve migrates to PumpSwap: its remaining tokens and its SOL reserves become the pool's. */
const migrate = () => chain.fixture({ signer: MIGRATOR.address, keys: [coin.curve, coin.curveTokens, coin.pool, coin.baseVault, coin.quoteVault, PUMP, PUMP_AMM], effect: () => {
  chain.createData(coin.pool, PUMP_AMM, poolBytes({ authority: coin.poolAuthority, baseVault: coin.baseVault, quoteVault: coin.quoteVault, creator: TREASURY.address }), RENT.pool, MIGRATOR.address);
  chain.openTokenAccount(coin.baseVault, { mint: COIN, owner: coin.pool, program: T22, payer: MIGRATOR.address });
  chain.openTokenAccount(coin.quoteVault, { mint: WSOL, owner: coin.pool, program: TOKEN, payer: MIGRATOR.address });
  chain.moveTokens(coin.curveTokens, coin.baseVault, chain.tokens.get(coin.curveTokens).amount);
  const reserves = chain.u64(coin.curve, CURVE.rq);
  chain.debit(coin.curve, reserves);
  chain.wrap(coin.quoteVault, reserves);
  // The curve keeps its creator fee for the creator to collect; its reserves are now the pool's.
  for (const at of [CURVE.vt, CURVE.vq, CURVE.rt, CURVE.rq]) chain.setU64(coin.curve, at, 0n);
} });

/**
 * Round-trip volume in the pool. PumpSwap keeps the creator's fee in the pool's own quote vault,
 * counted in creator_fees and taken out of virtual_quote_reserves so the price ignores it. The
 * first trade opens the creator vault's wrapped-SOL account, which the swap requires.
 */
const poolVolume = (key, fee) => chain.fixture({ signer: key.address, keys: [coin.pool, coin.quoteVault, coin.ammVault, PUMP_AMM], effect: () => {
  if (!chain.tokens.has(coin.ammVault)) chain.openTokenAccount(coin.ammVault, { mint: WSOL, owner: coin.ammAuthority, program: TOKEN, payer: key.address });
  chain.debit(key.address, fee);
  chain.wrap(coin.quoteVault, BigInt(fee));
  chain.setU64(coin.pool, POOL.creatorFees, chain.u64(coin.pool, POOL.creatorFees) + BigInt(fee));
  chain.setI128(coin.pool, POOL.virtualQuote, chain.i128(coin.pool, POOL.virtualQuote) - BigInt(fee));
} });

// ---------------------------------------------------------------------------------------------
// Wallets doing what wallets do, through the chain's front door.
// ---------------------------------------------------------------------------------------------
/** A plain OTT transfer, signed by the sender and sent like any other transaction. */
async function transfer(from, to, units) {
  const source = await ottAccount(from.address), destination = await ottAccount(to);
  const { blockhash } = await C.latestBlockhash(rpc);
  const { wire } = C.signedTransaction({ payer: from.address, blockhash, signers: [from], instructions: [
    S.createAssociatedTokenIdempotent({ payer: from.address, account: destination, owner: to, mint: COIN, tokenProgram: T22 }),
    S.transferChecked({ source, mint: COIN, destination, owner: from.address, amount: units, decimals: 6, tokenProgram: T22 }),
  ] });
  return C.sendTransaction(rpc, wire);
}

/**
 * The join, exactly as the app sends it: site/esim.js's joinTransaction() builds it from the API's
 * `membership` answer (after the app's own publishedJoinMismatch() check against the published
 * config and the coin's supply), the wallet signs the message and sends it, and the app waits for
 * its signature to confirm.
 */
async function join(key, membership) {
  const supply = (await rpc('getTokenSupply', [membership.coin])).value;
  const mismatch = await page.publishedJoinMismatch(CONFIG, membership, supply);
  if (mismatch) throw new Error('the app would refuse this join: ' + mismatch);
  const { blockhash } = await C.latestBlockhash(rpc);
  const { message } = await page.joinTransaction({ owner: key.address, coin: membership.coin, tokenProgram: membership.tokenProgram, decimals: membership.decimals,
    burnOwner: membership.burnOwner, burnAccount: membership.burnAccount, units: membership.requirement.burnUnits, blockhash });
  const signature = await C.sendTransaction(rpc, S.wireTransaction(message, [key.sign(message)]));
  const status = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
  if (!status || status.err || status.confirmationStatus !== 'confirmed') throw new Error('the join did not confirm');
  return signature;
}

// ---------------------------------------------------------------------------------------------
// FixedFloat, faked as test/fund.test.js fakes it: real HTTP and real HMAC checks on localhost.
// Its rates are the same SOL price the keepers are given and the mock wallet's own BTC price
// ($0.0008 a sat), so a quote that matches is the honest case, not a special one.
// ---------------------------------------------------------------------------------------------
const FF_KEY = 'ff-key', FF_SECRET = 'ff-secret';
const ff = { orders: new Map(), log: [] };
const ffServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (j) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    const sign = crypto.createHmac('sha256', FF_SECRET).update(body).digest('hex');
    if (req.headers['x-api-key'] !== FF_KEY || req.headers['x-api-sign'] !== sign) return reply({ code: 501, msg: 'Not have permission', data: null });
    const b = JSON.parse(body);
    ff.log.push({ path: req.url, body: b });
    const solUsd = solPrice(nowS()), rate = mockPayer._state.usdPerSat;
    if (req.url === '/price') {
      const btc = (Number(b.amount) * solUsd / rate) / 1e8;
      return reply({ code: 0, msg: 'OK', data: { from: { code: b.fromCcy, amount: Number(b.amount) }, to: { code: b.toCcy, amount: Number(btc.toFixed(8)) } } });
    }
    if (req.url === '/create') {
      if (b.direction !== 'to' || b.type !== 'fixed' || b.fromCcy !== 'SOL' || b.toCcy !== 'BTCLN' || !/^lnbc/.test(b.toAddress)) return reply({ code: 301, msg: 'Invalid order', data: null });
      const sats = Math.round(Number(b.amount) * 1e8);
      const id = 'FF' + String(ff.orders.size + 1).padStart(4, '0');
      const order = { id, token: 'tok-' + id, type: 'fixed', status: 'NEW', polls: 0,
        from: { code: 'SOL', coin: 'SOL', network: 'SOL', amount: (sats * rate / solUsd).toFixed(8), address: FF_DEPOSIT, tag: null },
        to: { code: 'BTCLN', amount: (sats / 1e8).toFixed(8), address: b.toAddress }, time: { expiration: nowS() + 1800 } };
      ff.orders.set(id, order);
      return reply({ code: 0, msg: 'OK', data: order });
    }
    if (req.url === '/order') {
      const o = ff.orders.get(b.id);
      if (!o || o.token !== b.token) return reply({ code: 401, msg: 'Order not found', data: null });
      o.status = ['PENDING', 'EXCHANGE', 'DONE'][Math.min(o.polls++, 2)];
      // DONE means the sats were paid to the invoice: the pool's wallet receives them.
      if (o.status === 'DONE' && !o.settled) {
        o.settled = true;
        const invoice = mockPayer._state.invoices.find((i) => i.paymentRequest === o.to.address);
        mockPayer._markPaid(invoice.paymentHash);
      }
      return reply({ code: 0, msg: 'OK', data: o });
    }
    reply({ code: 404, msg: 'no such method', data: null });
  });
});

// ---------------------------------------------------------------------------------------------
// What the API reads over HTTP: the config, the ledger and the treasury report this run wrote,
// and Solana itself, served by the same chain the keepers were handed.
// ---------------------------------------------------------------------------------------------
const PACKAGES = [
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE' },
  { code: 'fixed_5GB_30D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 5, days: 30, priceUsd: 5.99, regions: '38 countries' },
];
let CONFIG = null;   // set once the coin's addresses are known

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-loop-'));
const OUT = {
  claims: path.join(tmp, 'claims.json'),
  funding: path.join(tmp, 'funding.json'),
  allowances: path.join(tmp, 'allowances.json'),
  treasury: path.join(tmp, 'treasury.json'),
};
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } };
// However the run ends (a failed check, a crash, a closed pipe), it leaves no files behind.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* already gone */ } });

const fileServer = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const body = p === '/config/esim.json' ? CONFIG : p === '/data/allowances.json' ? readJson(OUT.allowances, null) : p === '/data/treasury.json' ? readJson(OUT.treasury, null) : null;
  if (!body) { res.statusCode = 404; return res.end('not here'); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
});
const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const r = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    try { res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: await rpc(r.method, r.params) })); }
    catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32002, message: e.message } })); }
  });
});

/** The fake req/res pair test/redeem.test.js and test/redeem-membership.test.js drive the handler with. */
function call(handler, { method, url, body }) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    if (body !== undefined) req.body = JSON.stringify(body);
    const headers = {};
    const res = { statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(text) { resolve({ status: res.statusCode, headers, body: JSON.parse(text) }); } };
    handler(req, res).catch((e) => resolve({ status: 'THREW', headers, body: { error: String(e && e.message) } }));
  });
}
let redeem = null;
// Each call starts from what is on the "disk" now: the API keeps the ledger and a standing for a
// little while, which is right for a deployment and wrong for a file whose clock jumps by days.
const GET = async (key) => { redeem._resetCaches(); return call(redeem, { method: 'GET', url: '/api/redeem?address=' + key.address }); };
const POST = async (body) => { redeem._resetCaches(); return call(redeem, { method: 'POST', url: '/api/redeem', body }); };
/** A request signed the way the app signs it: site/esim.js's message, the wallet's ed25519 signature, base58. */
function signed(key, want, extra = {}) {
  const message = page.signInMessage(key.address, want);
  return Object.assign({ address: key.address, message, signature: S.encodeBase58(key.sign(Buffer.from(message, 'utf8'))) }, extra);
}
const redeemBody = (key, packageCode, n) => signed(key, { action: 'redeem', packageCode, n }, { packageCode, n });
const welcomeBody = (key, packageCode, joinTx) => signed(key, { action: 'welcome', packageCode }, Object.assign({ welcome: true, packageCode }, joinTx ? { joinTx } : {}));

// ---------------------------------------------------------------------------------------------
// The keepers, each called the way its workflow calls it, against the same chain and files.
// ---------------------------------------------------------------------------------------------
const quiet = () => {};
const keeperLog = [];
const remember = (m) => keeperLog.push(String(m));
async function runClaim() {
  return CL.run({ rpc, config: CONFIG, key: TREASURY, out: OUT.claims, solUsd: prices.now, confirmOptions: { pollMs: 1 }, measureOptions: { attempts: 1, pauseMs: 0 }, log: remember });
}
async function runFund(ffClient) {
  return F.run({ rpc, chain: C, config: CONFIG, key: TREASURY, payer: mockPayer, ff: ffClient, solUsd: prices.now,
    targetUsd: 100, minUsd: 20, maxUsd: 500, maxPoolUsd: 1000, waitMs: 5000, pollMs: 5, confirmOptions: { pollMs: 1 },
    out: OUT.funding, treasuryPath: OUT.treasury, log: remember });
}
async function runAllowances() {
  return A.run({ config: CONFIG, rpc, historyRpc: rpc, out: OUT.allowances, prices, log: remember });
}
async function runTreasury() {
  return T.run({ rpc, config: CONFIG, provider: providers.provider(), claims: readJson(OUT.claims, []), out: OUT.treasury, allowancesPath: OUT.allowances, solUsd: prices.now, log: quiet });
}

// The repo's own published files, which nothing here may touch: snapshotted now, compared at the end.
const REAL_DATA = ['allowances.json', 'claims.json', 'funding.json', 'treasury.json'].map((f) => path.join(SITE, 'data', f));
const realDataBefore = Object.fromEntries(REAL_DATA.map((f) => [f, fs.readFileSync(f, 'utf8')]));

async function main() {
  console.log('the loop on Solana, start to finish — fees, claim, fund, ledger, redeem, and round again a week later');
  await addresses();
  CONFIG = {
    chain: 'solana', coin: COIN, tokenProgram: T22, treasury: TREASURY.address, budgetBps: 8000,
    membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: coin.burnAccount, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } },
    provider: 'wholesale', catalogueAt: '2026-10-05', packages: PACKAGES,
  };

  await new Promise((r) => ffServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  const fake = await fakeWholesale.start({ mockPayer });
  const ffClient = F.fixedFloat({ key: FF_KEY, secret: FF_SECRET, api: 'http://127.0.0.1:' + ffServer.address().port });
  const files = 'http://127.0.0.1:' + fileServer.address().port;
  const chainUrl = 'http://127.0.0.1:' + rpcServer.address().port;
  process.env.ESIM_CONFIG_URL = files + '/config/esim.json';
  process.env.ALLOWANCES_URL = files + '/data/allowances.json';
  process.env.TREASURY_URL = files + '/data/treasury.json';
  process.env.WHOLESALE_BASE_URL = fake.base;
  process.env.SOLANA_RPC_URL = chainUrl;
  // Offline: everything this process fetches is on this machine. The API's RPC list also names the
  // public endpoints in config/addresses.json; they are answered by the same chain.
  const realFetch = global.fetch;
  const PUBLIC_RPCS = require(path.join(ROOT, 'config', 'addresses.json')).rpcs;
  const refused = [];
  global.fetch = (url, opts) => {
    if (/^http:\/\/127\.0\.0\.1:/.test(String(url))) return realFetch(url, opts);
    if (PUBLIC_RPCS.includes(String(url))) return realFetch(chainUrl, opts);
    refused.push(String(url));
    return Promise.reject(new Error('offline test: ' + String(url)));
  };
  redeem = require(path.join(API, 'redeem.js'));
  mockPayer._reset();
  mockPayer._state.sats = 0;   // the Lightning pool starts empty

  try {
    // ===========================================================================================
    console.log('\nLAUNCH — week ' + (W - 1) + ', Thursday: the treasury creates the coin on pump.fun');
    // ===========================================================================================
    setClock(W - 1, 'thu', 10);
    for (const [key, amount] of [[TREASURY, 2], [ALICE, 25], [CAROL, 2], [TRADER, 5], [WHALE, 100], [MIGRATOR, 1], [BOB, 0.05], [ERIN, 0.05], [FRANK, 0.05], [DAVE, 0.05]]) chain.credit(key.address, LAMPORTS(amount));
    const treasuryStart = chain.bal(TREASURY.address);
    launch();
    const devBuy = await buy(TREASURY, LAMPORTS(0.5));
    check('the curve starts with the whole supply, paired with SOL, created by the treasury',
      [chain.tokens.get(coin.curveTokens).amount + devBuy.tokens, (await C.coinState(rpc, COIN)).creator, (await C.coinState(rpc, COIN)).quoteMint], [SUPPLY, TREASURY.address, WSOL]);

    setClock(W - 1, 'thu', 10, 5);
    let ledger = (await runAllowances()).data;
    // $5 of OTT at about 30.4985 SOL / 1,055,461,700 tokens × $150 a SOL is about 1,153,560 tokens, rounded up to two figures.
    check('the first ledger after launch prices the week\'s join amount from the curve: 1,200,000 OTT, about $5',
      [ledger.week, ledger.membership.requirement.burnTokens, ledger.membership.requirement.source, ledger.membership.requirements], [W - 1, '1200000', 'bonding-curve', { [W - 1]: '1200000000000' }]);
    check('the join amount is what $5 buys at the curve\'s price, rounded up to two figures',
      ledger.membership.requirement.burnTokens, M.burnTokensFor(5, curvePriceSol() * 150));
    check('nobody has joined, nothing has been collected, and there is no budget yet', [ledger.members, ledger.wallets, ledger.budgetUsd], [{}, {}, 0]);
    await runTreasury();
    let r = await GET(ALICE);
    check('the API offers no join while the pool cannot pay for a welcome eSIM', [r.status, r.body.membership.enrolment.open, r.body.membership.requirement.burnTokens],
      [200, false, '1200000']);

    // ===========================================================================================
    console.log('\nSTAGE 1 — fees accrue on the curve (fixture)');
    // ===========================================================================================
    setClock(W - 1, 'thu', 11);
    const aliceBuy = await buy(ALICE, LAMPORTS(20));
    const carolBuy = await buy(CAROL, LAMPORTS(1));
    // Thursday's trading volume tops the creator's fees up to exactly 0.8 SOL.
    const thursday = LAMPORTS(0.8);
    curveVolume(TRADER, thursday - devBuy.fee - aliceBuy.fee - carolBuy.fee);
    let waiting = await P.claimable(rpc, { mint: COIN, creator: TREASURY.address });
    check('0.8 SOL of creator fees waits on the curve: 0.30% of every trade', [waiting.curveLamports, waiting.poolLamports, waiting.accounts.pool], [thursday, 0n, null]);

    // ===========================================================================================
    console.log('\nSTAGE 2 — Friday 06:17: scripts/claim.js collects them');
    // ===========================================================================================
    setClock(W - 1, 'fri', 6, 17);
    const treasuryBeforeClaim = chain.bal(TREASURY.address);
    const claim1 = await runClaim();
    const claim1Tx = chain.txs.get(claim1.claimed[0].tx);
    check('it collected exactly what was waiting, from the curve, valued at $150 a SOL: $120.00',
      [claim1.claimed[0].lamports, claim1.claimed[0].sources, claim1.claimed[0].solUsd, claim1.claimed[0].usd], [thursday.toString(), ['curve'], 150, 120]);
    check('the treasury gained exactly that, less the 0.000015 SOL fee it paid', chain.bal(TREASURY.address) - treasuryBeforeClaim, thursday - BigInt(claim1Tx.meta.fee));
    check('the fee: one signature and 200,000 compute units at 50,000 micro-lamports', claim1Tx.meta.fee, 15000);
    check('the curve\'s fee and the vault are back to nothing above rent', [chain.u64(coin.curve, CURVE.creatorFee), chain.bal(coin.vault)], [0n, RENT.system]);
    checkThat('simulated, signed, before it was sent', chain.log.simulated.some((s) => s.signature === claim1.claimed[0].tx && s.sigVerify), JSON.stringify(chain.log.simulated));
    check('claims.json records it', readJson(OUT.claims, []).map((e) => [e.tx, e.lamports, e.usd]), [[claim1.claimed[0].tx, '800000000', 120]]);

    // ===========================================================================================
    console.log('\nSTAGE 3 — scripts/fund.js turns treasury SOL into Lightning sats');
    // ===========================================================================================
    const treasuryBeforeFund = chain.bal(TREASURY.address);
    const fund1 = await runFund(ffClient);
    const fund1Entry = readJson(OUT.funding, [])[0];
    const fund1Tx = chain.txs.get(fund1Entry.depositTx);
    // $100 at $150 is 0.666666 SOL quoted; FixedFloat asks 125,000 sats × $0.0008 ÷ $150 = 0.66666667 SOL.
    check('the pool is filled to its $100 floor: 125,000 sats, done', [fund1.action, fund1.amountUsd, fund1.sats, fund1.status], ['funded', 100, 125000, 'done']);
    check('FixedFloat was paid exactly what it asked, from the treasury, in one plain transfer',
      [fund1Entry.solSent, fund1Entry.lamports, chain.bal(FF_DEPOSIT)], [0.66666667, '666666670', 666666670n]);
    check('and the treasury paid that plus its 15,000-lamport fee, nothing more', treasuryBeforeFund - chain.bal(TREASURY.address), 666666670n + BigInt(fund1Tx.meta.fee));
    check('the pool\'s wallet holds exactly the sats funded', mockPayer._state.sats, 125000);
    setClock(W - 1, 'fri', 6, 30);
    let report = (await runTreasury()).data;
    check('the treasury report: funded, $100 in the pool, nothing owed in a week with no budget', [report.status, report.reseller.balanceUsd, report.owedUsd], ['funded', 100, 0]);

    // ===========================================================================================
    console.log('\nJOINING — Friday: four wallets join through the app; the treasury sends some OTT too');
    // ===========================================================================================
    setClock(W - 1, 'fri', 10);
    for (const key of [BOB, ERIN, FRANK]) await transfer(ALICE, key.address, OTT(3200000));
    r = await GET(ALICE);
    check('with the pool funded, the API offers the join: open, 1,200,000 OTT', [r.body.membership.enrolment, r.body.membership.requirement.burnUnits], [{ open: true, reason: '' }, '1200000000000']);
    const joins = {};
    for (const key of [ALICE, BOB, ERIN, FRANK]) joins[key.address] = await join(key, (await GET(key)).body.membership);
    // The creator's own bag: a project wallet's send is never a membership.
    const treasuryMembership = (await GET(TREASURY)).body.membership;
    const treasurySend = await join(TREASURY, Object.assign({}, treasuryMembership, { requirement: Object.assign({}, treasuryMembership.requirement, { burnUnits: OTT(1000000).toString() }) }));
    check('the incinerator\'s account holds every OTT sent to it', chain.tokens.get(coin.burnAccount).amount, OTT(4 * 1200000 + 1000000));
    check('BOB, ERIN and FRANK each hold 2,000,000 OTT now', [await held(BOB.address), await held(ERIN.address), await held(FRANK.address)], [OTT(2000000), OTT(2000000), OTT(2000000)]);
    const joinTx = chain.txs.get(joins[ALICE.address]);
    check('the app\'s join paid one signature and 40,000 units at 50,000 micro-lamports, plus the incinerator account\'s rent once',
      [joinTx.meta.fee, joinTx.meta.preBalances[0] - joinTx.meta.postBalances[0]], [7000, 7000 + Number(RENT.token2022)]);

    setClock(W - 1, 'fri', 12);
    keeperLog.length = 0;
    ledger = (await runAllowances()).data;
    check('the ledger now lists the four as members, since their own join transactions',
      Object.keys(ledger.members).sort(), [ALICE.address, BOB.address, ERIN.address, FRANK.address].sort());
    check('each burned exactly the week\'s amount', Object.values(ledger.members).map((m) => m.burned), Array(4).fill('1200000000000'));
    check('ALICE\'s membership dates from her join', ledger.members[ALICE.address].since, { at: joinTx.blockTime, slot: joinTx.slot, tx: joins[ALICE.address] });
    checkThat('the treasury\'s own send was skipped as a project wallet\'s', !(TREASURY.address in ledger.members) && !(TREASURY.address in ledger.joins)
      && keeperLog.some((l) => l.includes(treasurySend) && /project wallet/.test(l)), keeperLog.join('\n'));
    check('nobody shares yet: the four joined after this week\'s snapshot', [ledger.wallets, ledger.holders], [{}, 0]);
    check('the week\'s amount was priced once and is not repriced, though ALICE\'s buy moved the price', ledger.membership.requirement.burnTokens, '1200000');

    // ===========================================================================================
    console.log('\nThe rest of the week: more trading, and Sunday\'s claim');
    // ===========================================================================================
    setClock(W - 1, 'sat', 15);
    curveVolume(TRADER, LAMPORTS(0.4));
    setClock(W - 1, 'sun', 6, 17);
    const claim2 = await runClaim();
    check('Sunday collects the 0.4 SOL since Friday: $60.00', [claim2.claimed[0].lamports, claim2.claimed[0].usd], ['400000000', 60]);
    const fund2 = await runFund(ffClient);
    check('the pool is still at its floor and nothing is owed: nothing to move', fund2.action, 'none');
    setClock(W - 1, 'sun', 6, 30);
    await runTreasury();

    // ===========================================================================================
    console.log('\nSTAGE 4 — week ' + W + ', Monday 00:30: scripts/allowances.js writes the week\'s ledger');
    // ===========================================================================================
    setClock(W, 'mon', 0, 30);
    const heldAtSnapshot = { [ALICE.address]: await held(ALICE.address), [BOB.address]: OTT(2000000), [ERIN.address]: OTT(2000000), [FRANK.address]: OTT(2000000) };
    ledger = (await runAllowances()).data;
    check('the budget is 80% of the creator fees collected last week: 1.2 SOL × $150 × 0.8 = $144.00',
      [ledger.week, ledger.fees.weekUsd[W - 1], ledger.budgetUsd, ledger.budgetSource], [W, 180, 144, 'creator fees collected in week ' + (W - 1)]);
    check('both collections are in it, each at its own hour\'s price', ledger.fees.collections.map((c) => [c.tx, c.lamports, c.solUsd]),
      [[claim1.claimed[0].tx, '800000000', 150], [claim2.claimed[0].tx, '400000000', 150]]);
    check('the four members share, at what they held at Monday 00:00', Object.fromEntries(Object.entries(ledger.wallets).map(([w, row]) => [w, BigInt(row.tokens)])),
      Object.fromEntries(Object.keys(heldAtSnapshot).sort().map((w) => [w, heldAtSnapshot[w]])));
    check('CAROL holds OTT and never joined, so she shares nothing', CAROL.address in ledger.wallets, false);
    // ALICE holds most of the members' OTT, so her share is held at 3 × $144 ÷ 4 = $108, and the
    // other $36 is shared by holdings among three equal holders: $12.00 each.
    check('the capped split: ALICE at the $108.00 cap, BOB, ERIN and FRANK $12.00 each',
      [ledger.wallets[ALICE.address].allowanceUsd, ledger.wallets[BOB.address].allowanceUsd, ledger.wallets[ERIN.address].allowanceUsd, ledger.wallets[FRANK.address].allowanceUsd], [108, 12, 12, 12]);
    check('every dollar of the budget is placed', [ledger.membership.capUsd, ledger.membership.allocatedUsd, ledger.membership.unallocatedUsd], [108, 144, 0]);
    check('memberTokens is the four holdings together', ledger.memberTokens, Object.values(heldAtSnapshot).reduce((a, b) => a + b, 0n).toString());
    // $5 at about 51.4355 SOL / 625,834,000 tokens × $160 is about 380,230 tokens, rounded up to two figures.
    check('this week\'s join amount is priced afresh at Monday\'s price: 390,000 OTT', [ledger.membership.requirement.burnTokens, ledger.membership.requirement.solUsd], ['390000', 160]);
    check('and it is what $5 buys now', ledger.membership.requirement.burnTokens, M.burnTokensFor(5, curvePriceSol() * 160));

    // ===========================================================================================
    console.log('\nMonday morning: the budget is published before the pool is topped up');
    // ===========================================================================================
    setClock(W, 'mon', 0, 35);
    report = (await runTreasury()).data;
    check('the report: $144.00 promised against a $100.00 pool', [report.weekBudgetUsd, report.owedUsd, report.reseller.balanceUsd, report.status], [144, 144, 100, 'funded']);
    r = await GET(ALICE);
    check('so the API closes joining until a welcome eSIM is covered beyond what the week owes',
      r.body.membership.enrolment, { open: false, reason: 'The reserve is too low to pay for a welcome eSIM right now. Try again after the next top-up.' });
    setClock(W, 'mon', 6, 17);
    const sentBeforeClaim3 = chain.log.sent.length;
    const claim3 = await runClaim();
    check('the daily claim finds nothing since Sunday and sends nothing', [claim3.claimed, chain.log.sent.length - sentBeforeClaim3], [[], 0]);
    const fund3 = await runFund(ffClient);
    check('the daily top-up aims at what the week owes plus a five-welcome reserve: $144 + $20 − $100 = $64, 80,000 sats',
      [fund3.action, fund3.amountUsd, fund3.sats, fund3.status], ['funded', 64, 80000, 'done']);
    setClock(W, 'mon', 6, 30);
    report = (await runTreasury()).data;
    r = await GET(ALICE);
    check('with $164.00 in the pool, joining opens again', [report.reseller.balanceUsd, r.body.membership.enrolment.open], [164, true]);

    // ===========================================================================================
    console.log('\nSTAGE 5 — site/api/redeem.js serves the week\'s standings');
    // ===========================================================================================
    setClock(W, 'mon', 7);
    r = await GET(ALICE);
    check('ALICE: her snapshot holding, $108.00 to spend, nothing used, a sharing member',
      [r.status, r.body.week, r.body.tokens, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.stale, r.body.membership.member, r.body.membership.sharing],
      [200, W, heldAtSnapshot[ALICE.address].toString(), 108, 0, 108, false, true, true]);
    check('her membership dates from her join, and her welcome eSIM is unclaimed', [r.body.membership.memberSince, r.body.membership.welcomeOrder],
      [{ at: joinTx.blockTime, slot: joinTx.slot, tx: joins[ALICE.address] }, null]);
    r = await GET(BOB);
    check('BOB: $12.00 to spend, and his share of the members\' OTT as the ledger has it', [r.body.allowanceUsd, r.body.remainingUsd, r.body.share], [12, 12, ledger.wallets[BOB.address].share]);
    r = await GET(CAROL);
    check('CAROL: a holder who never joined has no weekly credit and is offered the join',
      [r.body.allowanceUsd, r.body.tokens, r.body.membership.member, r.body.membership.sharing, r.body.membership.enrolment.open], [0, '0', false, false, true]);

    // ===========================================================================================
    console.log('\nSTAGE 6 — redemptions, welcome eSIMs, and a wallet that joins after the ledger');
    // ===========================================================================================
    const paidBefore = mockPayer._state.log.length;
    const aliceWelcome = await POST(welcomeBody(ALICE, 'fixed_1GB_7D_DE'));
    check('ALICE claims her welcome eSIM without naming a join: the ledger lists her',
      [aliceWelcome.status, aliceWelcome.body.order.welcome, aliceWelcome.body.order.week, aliceWelcome.body.order.packageCode, aliceWelcome.body.order.stage], [200, true, null, 'fixed_1GB_7D_DE', 'done']);
    checkThat('a real eSIM: a 19-digit ICCID and an activation code', /^\d{19}$/.test(aliceWelcome.body.order.iccid) && aliceWelcome.body.order.ac.startsWith('LPA:1$'), JSON.stringify(aliceWelcome.body.order));
    r = await GET(ALICE);
    check('the welcome eSIM does not touch her weekly credit: still $108.00', [r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.length, r.body.membership.welcomeOrder.packageCode], [0, 108, 0, 'fixed_1GB_7D_DE']);

    const europe = await POST(redeemBody(ALICE, 'fixed_5GB_30D_EUROPE', 0));
    check('ALICE redeems Europe 5 GB ($5.99) at slot 0: $102.01 left', [europe.status, europe.body.order.n, europe.body.order.week, europe.body.remainingUsd], [200, 0, W, 102.01]);
    const germany = await POST(redeemBody(ALICE, 'fixed_1GB_7D_DE', 1));
    check('then Germany ($1.99) at slot 1: $100.02 left', [germany.status, germany.body.order.n, germany.body.remainingUsd], [200, 1, 100.02]);
    check('Germany queues on the profile her welcome eSIM issued instead of a second eSIM', [germany.body.order.toppedUp, germany.body.order.topupOf], [true, aliceWelcome.body.order.iccid]);
    const replay = await POST(redeemBody(ALICE, 'fixed_5GB_30D_EUROPE', 0));
    check('replaying slot 0 returns the same order and spends nothing', [replay.status, replay.body.replayed, replay.body.order.iccid, replay.body.remainingUsd], [200, true, europe.body.order.iccid, 100.02]);
    const bobGermany = await POST(redeemBody(BOB, 'fixed_1GB_7D_DE', 0));
    check('BOB redeems Germany from his own $12.00: $10.01 left', [bobGermany.status, bobGermany.body.remainingUsd], [200, 10.01]);

    const carolTry = await POST(redeemBody(CAROL, 'fixed_1GB_7D_DE', 0));
    check('CAROL\'s weekly redemption is refused: weekly credit is for members', [carolTry.status, carolTry.body.error], [409, 'weekly credit is for members, from the first Monday snapshot after they join']);
    const carolWelcome = await POST(welcomeBody(CAROL, 'fixed_1GB_7D_DE'));
    check('and so is a welcome eSIM: she never joined', [carolWelcome.status, carolWelcome.body.error], [409, 'join OT+T first']);

    // DAVE joins now, after this week's ledger: ALICE sends him enough to join and keep 2,000,000.
    const daveMembership = (await GET(DAVE)).body.membership;
    await transfer(ALICE, DAVE.address, OTT(2000000) + BigInt(daveMembership.requirement.burnUnits));
    setClock(W, 'mon', 7, 30);
    const daveJoin = await join(DAVE, daveMembership);
    r = await GET(DAVE);
    check('the API does not list DAVE yet: the ledger was written before his join', [r.body.membership.member, r.body.membership.burned], [false, '0']);
    const daveWelcome = await POST(welcomeBody(DAVE, 'fixed_1GB_7D_DE', daveJoin));
    check('DAVE claims his welcome eSIM by naming his join, which the API reads from the chain', [daveWelcome.status, daveWelcome.body.order.welcome, daveWelcome.body.order.stage], [200, true, 'done']);
    const daveWeekly = await POST(redeemBody(DAVE, 'fixed_1GB_7D_DE', 0));
    check('but he has no weekly credit until the next snapshot', [daveWeekly.status, daveWeekly.body.error], [409, 'weekly credit is for members, from the first Monday snapshot after they join']);

    // ===========================================================================================
    console.log('\nSTAGE 7 — what the standings say now');
    // ===========================================================================================
    r = await GET(ALICE);
    check('ALICE: $7.98 used of $108.00, $100.02 left, two weekly orders, and her welcome eSIM apart from them',
      [r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders.map((o) => [o.n, o.packageCode]), r.body.membership.welcomeOrder.welcome], [108, 7.98, 100.02, [[0, 'fixed_5GB_30D_EUROPE'], [1, 'fixed_1GB_7D_DE']], true]);
    check('no codes on a public read', [r.body.orders.map((o) => o.ac), r.body.membership.welcomeOrder.ac], [['', ''], '']);
    check('ALICE\'s two eSIMs: Germany (welcome, topped up) and Europe', r.body.sims.map((s) => s.slug).sort(), ['europe', 'germany']);
    r = await GET(BOB);
    check('BOB: $1.99 used, $10.01 left', [r.body.redeemedUsd, r.body.remainingUsd], [1.99, 10.01]);
    r = await GET(ERIN);
    check('ERIN, who redeemed nothing, is untouched: $12.00', [r.body.redeemedUsd, r.body.remainingUsd], [0, 12]);
    const paidThisWeek = mockPayer._state.log.slice(paidBefore);
    check('the Lightning wallet paid one invoice per eSIM bundle: five', paidThisWeek.length, 5);

    // ===========================================================================================
    console.log('\nSTAGE 8 — scripts/treasury.js reports the pool');
    // ===========================================================================================
    setClock(W, 'mon', 8);
    report = (await runTreasury()).data;
    const paidSats = paidThisWeek.reduce((s, l) => s + l.sats, 0);
    check('the pool is what was funded less what was paid: 205,000 sats less the invoices', [report.reseller.sats, report.reseller.balanceUsd], [205000 - paidSats, round2((205000 - paidSats) * 0.0008)]);
    // Wholesale charges 95% of list for Lightning: $1.89 for each of the four Germany bundles, $5.69 for Europe.
    check('the 30-day spend is what wholesale actually charged, for all five', [report.redemptions30d, report.spend30dUsd], [5, 13.25]);
    check('the treasury wallet and the fees waiting, read from the chain', [report.walletSol, report.claimableSol], [Number(chain.bal(TREASURY.address)) / 1e9, 0]);
    // What this week's members can still spend: $144 less the three weekly orders ($9.97). The
    // two welcome eSIMs came out of the reserve, not out of anybody's weekly credit.
    check('what the week still owes is its budget less the weekly redemptions only: $134.03', [report.weekRedeemedUsd, report.owedUsd], [9.97, 134.03]);
    check('the last claim on the card is Sunday\'s', report.lastClaim, { at: claim2.claimed[0].at, sol: 0.4, usd: 60, tx: claim2.claimed[0].tx });

    // ===========================================================================================
    console.log('\nWeek ' + W + ': the coin graduates, and the fees move to PumpSwap');
    // ===========================================================================================
    setClock(W, 'wed', 14);
    const whaleBuy = await buy(WHALE, 0n, { allRemaining: true });
    migrate();
    const state = await C.coinState(rpc, COIN);
    check('the curve completed and migrated: PumpSwap now prices the coin, with the treasury as its coin creator',
      [state.complete, state.source, state.pool, state.creator], [true, 'pool', coin.pool, TREASURY.address]);
    check('the pool holds the 206,900,000 OTT the curve never sold, and its SOL reserves', [chain.tokens.get(coin.baseVault).amount, chain.tokens.get(coin.curveTokens).amount], [OTT(206900000), 0n]);
    setClock(W, 'fri', 18);
    const weekFees = LAMPORTS(0.6);
    poolVolume(TRADER, weekFees - whaleBuy.fee);
    waiting = await P.claimable(rpc, { mint: COIN, creator: TREASURY.address });
    check('0.6 SOL waits for the treasury: the WHALE\'s 0.30% on the curve, the rest in the pool', [waiting.curveLamports, waiting.poolLamports, waiting.totalLamports], [whaleBuy.fee, weekFees - whaleBuy.fee, weekFees]);
    setClock(W, 'sun', 6, 17);
    const treasuryBeforeClaim4 = chain.bal(TREASURY.address);
    const claim4 = await runClaim();
    const claim4Tx = chain.txs.get(claim4.claimed[0].tx);
    check('one transaction collects both: 0.6 SOL at $160 = $96.00', [claim4.claimed[0].sources, claim4.claimed[0].lamports, claim4.claimed[0].usd], [['curve', 'pool'], weekFees.toString(), 96]);
    check('the treasury gained exactly 0.6 SOL less its fee: the wrapped SOL was unwrapped into it', chain.bal(TREASURY.address) - treasuryBeforeClaim4, weekFees - BigInt(claim4Tx.meta.fee));
    check('and is left with no wrapped-SOL account', chain.tokens.has(await S.associatedTokenAddress(TREASURY.address, WSOL, TOKEN)), false);
    check('the pool\'s creator fees are swept, and its price is where it was', [chain.u64(coin.pool, POOL.creatorFees), chain.i128(coin.pool, POOL.virtualQuote), chain.tokens.get(coin.ammVault).amount], [0n, 0n, 0n]);
    const fund4 = await runFund(ffClient);
    check('the pool still covers the week\'s promise and the reserve: nothing to move', fund4.action, 'none');

    // ===========================================================================================
    console.log('\nTHE WEEK ROLLS — week ' + (W + 1) + ', Monday: the ledger, the standings and the redemptions again');
    // ===========================================================================================
    setClock(W + 1, 'mon', 0, 30);
    const heldNext = { [ALICE.address]: await held(ALICE.address), [BOB.address]: OTT(2000000), [DAVE.address]: OTT(2000000), [ERIN.address]: OTT(2000000), [FRANK.address]: OTT(2000000) };
    ledger = (await runAllowances()).data;
    check('the budget is last week\'s fees, not added to the week before: 0.6 SOL × $160 × 0.8 = $76.80',
      [ledger.week, ledger.fees.weekUsd, ledger.budgetUsd], [W + 1, { [W - 1]: 180, [W]: 96 }, 76.8]);
    check('DAVE joined before this snapshot, so he shares now', [DAVE.address in ledger.members, ledger.members[DAVE.address].since.tx, DAVE.address in ledger.wallets], [true, daveJoin, true]);
    check('five members share, at what they held at Monday 00:00', Object.fromEntries(Object.entries(ledger.wallets).map(([w, row]) => [w, BigInt(row.tokens)])),
      Object.fromEntries(Object.keys(heldNext).sort().map((w) => [w, heldNext[w]])));
    // 3 × $76.80 ÷ 5 = $46.08 for ALICE; $30.72 shared by four equal holders: $7.68 each.
    check('the capped split again: ALICE $46.08, the other four $7.68 each',
      [ALICE, BOB, DAVE, ERIN, FRANK].map((k) => ledger.wallets[k.address].allowanceUsd), [46.08, 7.68, 7.68, 7.68, 7.68]);
    // $5 at the pool's price, 85.005 SOL / 206,900,000 OTT × $170.
    check('the join amount is priced from the pool now: 72,000 OTT', [ledger.membership.requirement.source, ledger.membership.requirement.burnTokens], ['pool', '72000']);
    check('and it is what $5 buys at the pool\'s price', ledger.membership.requirement.burnTokens, M.burnTokensFor(5, poolPriceSol() * 170));
    check('every week\'s amount is kept, so an old send is still judged by its own week', ledger.membership.requirements,
      { [W - 1]: '1200000000000', [W]: '390000000000', [W + 1]: '72000000000' });

    setClock(W + 1, 'mon', 0, 35);
    await runTreasury();
    setClock(W + 1, 'mon', 7);
    r = await GET(ALICE);
    check('ALICE\'s new week: $46.08, nothing used — last week\'s $100.02 did not carry over',
      [r.body.week, r.body.allowanceUsd, r.body.redeemedUsd, r.body.remainingUsd, r.body.orders], [W + 1, 46.08, 0, 46.08, []]);
    check('last week\'s orders are history now, without codes', r.body.history.map((o) => [o.week, o.n, o.packageCode, o.ac]),
      [[W, 0, 'fixed_5GB_30D_EUROPE', ''], [W, 1, 'fixed_1GB_7D_DE', '']]);
    check('and her welcome eSIM is still claimed, once', [r.body.membership.welcomeOrder.welcome, r.body.membership.welcomeOrder.iccid], [true, aliceWelcome.body.order.iccid]);
    const again = await POST(redeemBody(ALICE, 'fixed_1GB_7D_DE', 0));
    check('ALICE redeems Germany at slot 0 of the new week: a new order on the same Germany profile, $44.09 left',
      [again.status, again.body.order.week, again.body.order.n, again.body.order.topupOf, again.body.remainingUsd], [200, W + 1, 0, aliceWelcome.body.order.iccid, 44.09]);
    checkThat('a new transaction id, not last week\'s order replayed', again.body.order.transactionId !== germany.body.order.transactionId, again.body.order.transactionId);
    const welcomeAgain = await POST(welcomeBody(ALICE, 'fixed_1GB_7D_DE'));
    check('asking for the welcome eSIM again returns the one already issued, nothing new', [welcomeAgain.status, welcomeAgain.body.replayed, welcomeAgain.body.order.iccid], [200, true, aliceWelcome.body.order.iccid]);
    const daveNow = await POST(redeemBody(DAVE, 'fixed_1GB_7D_DE', 0));
    check('DAVE has weekly credit now: Germany tops up his welcome profile, $5.69 left', [daveNow.status, daveNow.body.order.topupOf, daveNow.body.remainingUsd], [200, daveWelcome.body.order.iccid, 5.69]);

    setClock(W + 1, 'mon', 8);
    report = (await runTreasury()).data;
    check('the new week owes $76.80 less the $3.98 redeemed so far', [report.weekBudgetUsd, report.weekRedeemedUsd, report.owedUsd], [76.8, 3.98, 72.82]);
    check('seven bundles paid in the last 30 days', report.redemptions30d, 7);

    // ===========================================================================================
    console.log('\nFOLLOW THE MONEY — every stage against the one chain');
    // ===========================================================================================
    const claims = readJson(OUT.claims, []);
    const funding = readJson(OUT.funding, []);
    const collected = claims.reduce((n, c) => n + BigInt(c.lamports), 0n);
    const fundedUsd = funding.reduce((n, f) => n + f.amountUsd, 0);
    const sentToFixedFloat = funding.reduce((n, f) => n + BigInt(f.lamports), 0n);
    const allPaid = mockPayer._state.log.reduce((s, l) => s + l.sats, 0);
    console.log(`  creator fees collected: ${sol(collected)}, ${usd(claims.reduce((n, c) => n + c.usd, 0))} (claims.json, ${claims.length} collections)`);
    console.log(`  sent to FixedFloat:     ${sol(sentToFixedFloat)} for ${usd(fundedUsd)} of sats (funding.json, ${funding.length} top-ups)`);
    console.log(`  paid to wholesale:      ${allPaid} sats, ${usd(allPaid * 0.0008)}, for ${mockPayer._state.log.length} bundles`);
    console.log(`  left in the pool:       ${mockPayer._state.sats} sats, ${usd(mockPayer._state.sats * 0.0008)}`);
    check('collected: 0.8 + 0.4 + 0.6 = 1.8 SOL, $276.00', [collected, claims.reduce((n, c) => n + c.usd, 0)], [LAMPORTS(1.8), 276]);
    check('the ledger valued the same collections', Object.values(ledger.fees.weekUsd).reduce((a, b) => a + b, 0), 276);
    check('FixedFloat received exactly what funding.json says the treasury sent', chain.bal(FF_DEPOSIT), sentToFixedFloat);
    check('the pool\'s sats are exactly what was funded less what was paid', mockPayer._state.sats, 125000 + 80000 - allPaid);
    const fees = [...chain.txs.values()].filter((tx) => tx.transaction.message.accountKeys[0].pubkey === TREASURY.address).reduce((n, tx) => n + BigInt(tx.meta.fee), 0n);
    const spentOnLaunch = RENT.mint + RENT.curve + RENT.token2022 + RENT.system + devBuy.paid + RENT.token2022;
    check('the treasury\'s SOL is its start, less the launch and its own fees, plus every collection, less every top-up',
      chain.bal(TREASURY.address), treasuryStart - spentOnLaunch - fees + collected - sentToFixedFloat);
    check('the treasury report agrees with the chain', report.walletSol, Number(chain.bal(TREASURY.address)) / 1e9);
    checkThat('what was paid to wholesale is covered by what was funded, which is covered by what was collected',
      allPaid * 0.0008 <= fundedUsd && fundedUsd <= 276, `paid ${allPaid * 0.0008}, funded ${fundedUsd}`);
    const supplyNow = [...chain.tokens.values()].filter((t) => t.mint === COIN).reduce((n, t) => n + t.amount, 0n);
    check('and no OTT was made or lost: every token account together still holds the supply', supplyNow, SUPPLY);

    // ===========================================================================================
    console.log('\nHOUSEKEEPING');
    // ===========================================================================================
    check('the repo\'s own site/data/*.json were never touched', Object.fromEntries(REAL_DATA.map((f) => [f, fs.readFileSync(f, 'utf8')])), realDataBefore);
    check('and nothing tried to reach past this machine', refused, []);
  } finally {
    restoreClock();
    global.fetch = realFetch;
    for (const name of ['ESIM_CONFIG_URL', 'ALLOWANCES_URL', 'TREASURY_URL', 'WHOLESALE_BASE_URL', 'SOLANA_RPC_URL']) delete process.env[name];
    await Promise.all([fake.close(), new Promise((r) => ffServer.close(r)), new Promise((r) => fileServer.close(r)), new Promise((r) => rpcServer.close(r))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { restoreClock(); console.error(e); process.exit(1); });
