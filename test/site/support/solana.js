'use strict';
/**
 * Solana fixtures for the browser specs: a made-up coin, treasury and holder, the incinerator's
 * token account for that coin, and builders for the RPC answers the page reads. Addresses are
 * derived here synchronously (Node's sha256) by the same rule site/solana.js applies in the
 * browser, so a spec can name them as constants, and the page's own derivation still has to agree
 * with them for a join to go through.
 */
const crypto = require('crypto');
const path = require('path');
const S = require(path.join(__dirname, '..', '..', '..', 'site', 'solana.js'));

const TOKEN_2022 = S.PROGRAMS.token2022;
const INCINERATOR = S.INCINERATOR;

/** A stable made-up address: 32 bytes of sha256 over a label. */
const addressFrom = (label) => S.encodeBase58(crypto.createHash('sha256').update('ott-test:' + label).digest());

/** findProgramAddress, synchronously. */
function programAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const seed of seeds) h.update(seed);
    h.update(Buffer.from([bump]));
    h.update(S.addressBytes(programId));
    h.update('ProgramDerivedAddress');
    const out = new Uint8Array(h.digest());
    if (!S.isOnCurve(out)) return S.encodeBase58(out);
  }
  throw new Error('no program address');
}
const ata = (owner, mint, tokenProgram = TOKEN_2022) => programAddress(
  [S.addressBytes(owner), S.addressBytes(tokenProgram), S.addressBytes(mint)], S.PROGRAMS.associatedToken);

const COIN = addressFrom('coin');
const TREASURY = addressFrom('treasury');
const BURN_ACCOUNT = ata(INCINERATOR, COIN);

/** A made-up transaction signature: 64 bytes, base58. */
const signatureFrom = (label) => S.encodeBase58(Buffer.concat([
  crypto.createHash('sha256').update('ott-test-sig-a:' + label).digest(),
  crypto.createHash('sha256').update('ott-test-sig-b:' + label).digest()]));

/**
 * A jsonParsed getTransaction answer for a join: `wallet` sends `amount` base units of `coin` from
 * its own account to the incinerator's, which the transaction creates when `creates` is set.
 */
function joinTransactionResult({ signature, wallet, amount, before = 250000000000n, slot = 400000100, blockTime = Math.floor(Date.now() / 1000) - 60,
  coin = COIN, burnAccount = BURN_ACCOUNT, tokenProgram = TOKEN_2022, err = null, creates = false }) {
  const source = ata(wallet, coin, tokenProgram);
  const key = (pubkey, signer, writable) => ({ pubkey, signer, writable, source: 'transaction' });
  const sent = BigInt(amount);
  const balance = (accountIndex, owner, value) => ({ accountIndex, mint: coin, owner, programId: tokenProgram,
    uiTokenAmount: { amount: String(value), decimals: 6, uiAmountString: S.tokensOf(BigInt(value), 6) } });
  const pre = [balance(1, wallet, before)];
  if (!creates) pre.push(balance(2, INCINERATOR, 0n));
  return {
    slot, blockTime, version: 'legacy',
    meta: {
      err, status: err ? { Err: err } : { Ok: null }, fee: 7000,
      preBalances: [1000000000, 2039280, creates ? 0 : 2039280, 1, 1, 1, 1, 1],
      postBalances: [997953720, 2039280, 2039280, 1, 1, 1, 1, 1],
      preTokenBalances: pre,
      postTokenBalances: err ? pre : [balance(1, wallet, BigInt(before) - sent), balance(2, INCINERATOR, sent)],
      logMessages: [], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [key(wallet, true, true), key(source, false, true), key(burnAccount, false, true), key(INCINERATOR, false, false),
          key(coin, false, false), key(tokenProgram, false, false), key(S.PROGRAMS.associatedToken, false, false), key(S.PROGRAMS.computeBudget, false, false)],
        recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
        instructions: [],
      },
    },
  };
}

/**
 * The parts of a legacy wire transaction a spec asserts on: how many signature slots it has, its
 * accounts with their roles, the blockhash, and each instruction's program, accounts and data.
 */
function decodeTransaction(wire) {
  const bytes = Buffer.from(wire);
  let at = 0;
  const length = () => { let n = 0, shift = 0, b; do { b = bytes[at++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return n; };
  const signatures = length();
  at += 64 * signatures;
  const message = bytes.subarray(at);
  const required = bytes[at++], readonlySigned = bytes[at++], readonlyUnsigned = bytes[at++];
  if (required & 0x80) throw new Error('not a legacy message');
  const count = length();
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const signer = i < required;
    const writable = signer ? i < required - readonlySigned : i < count - readonlyUnsigned;
    accounts.push({ address: S.encodeBase58(bytes.subarray(at, at + 32)), signer, writable });
    at += 32;
  }
  const blockhash = S.encodeBase58(bytes.subarray(at, at + 32));
  at += 32;
  const instructions = [];
  for (let n = length(); n > 0; n--) {
    const program = accounts[bytes[at++]].address;
    const keys = [];
    for (let k = length(); k > 0; k--) keys.push(accounts[bytes[at++]].address);
    const size = length();
    instructions.push({ program, accounts: keys, data: Buffer.from(bytes.subarray(at, at + size)) });
    at += size;
  }
  return { signatures, message, accounts, blockhash, instructions };
}

module.exports = { S, TOKEN_2022, INCINERATOR, COIN, TREASURY, BURN_ACCOUNT, addressFrom, ata, programAddress, signatureFrom, joinTransactionResult, decodeTransaction };
