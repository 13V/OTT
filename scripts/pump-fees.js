'use strict';
/**
 * pump-fees.js — the treasury's pump.fun creator fees: how much is waiting, and the instructions
 * that collect it. scripts/treasury.js reports the first; scripts/claim.js sends the second.
 *
 * pump.fun keeps a SOL-paired coin's creator fee in two places until someone pays it out
 * (https://github.com/pump-fun/pump-public-docs, "Fees Kept on the Curve and Pool"):
 *
 *   - on the bonding curve (BondingCurve.creator_fee), swept by pump `sweep_creator_fee` into the
 *     creator vault, a system account (PDA "creator-vault" + creator), and paid to the creator by
 *     pump `collect_creator_fee_v2`;
 *   - after graduation, in the PumpSwap pool (Pool.creator_fees), swept by pump-amm
 *     `sweep_creator_fee` into the PumpSwap creator vault, a wrapped-SOL account owned by the PDA
 *     "creator_vault" + creator, and paid by pump-amm `collect_coin_creator_fee` into the creator's
 *     own wrapped-SOL account, which is closed straight after to unwrap it.
 *
 * Every instruction here is permissionless and can only pay the creator. The account lists follow
 * the official IDLs (idl/pump.json and idl/pump_amm.json) in order; test/claim.test.js checks them
 * against the IDL entries saved in test/fixtures/solana/pump-fee-idl.json.
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const C = require(path.join(__dirname, 'solana-chain.js'));

const WSOL = S.MINTS.wsol;
const TOKEN = S.PROGRAMS.token;
// The creator vault is a data-less system account; its first 890,880 lamports keep it rent-exempt
// and are never paid out.
const RENT_EXEMPT_EMPTY = 890880n;
const DEFAULT_UNITS = 200000;
const DEFAULT_MICRO_LAMPORTS = 50000;

const meta = (address, signer, writable) => ({ address, signer: !!signer, writable: !!writable });

/**
 * Every address the claim needs, for `mint` and its `creator`. `pool` is the decoded PumpSwap
 * pool (with its address) once the coin has graduated, or null before.
 */
async function feeAccounts({ mint, creator, pool = null }) {
  const curve = await C.bondingCurveAddress(mint);
  const vault = await C.creatorVaultAddress(creator);
  const out = {
    mint, creator,
    global: (await S.programAddress(['global'], S.PROGRAMS.pump)).address,
    curve,
    curveQuote: await S.associatedTokenAddress(curve, WSOL, TOKEN),
    vault,
    vaultQuote: await S.associatedTokenAddress(vault, WSOL, TOKEN),
    creatorQuote: await S.associatedTokenAddress(creator, WSOL, TOKEN),
    pumpEvents: await C.eventAuthority(S.PROGRAMS.pump),
    pool: null,
  };
  if (pool) {
    if (pool.quoteMint !== WSOL) throw new Error('the pool is not paired with SOL');
    const authority = await C.ammCreatorVaultAuthority(creator);
    out.pool = {
      address: pool.address, quoteVault: pool.quoteVault,
      globalConfig: (await S.programAddress(['global_config'], S.PROGRAMS.pumpAmm)).address,
      vaultAuthority: authority,
      vault: await S.associatedTokenAddress(authority, WSOL, TOKEN),
      events: await C.eventAuthority(S.PROGRAMS.pumpAmm),
    };
  }
  return out;
}

/** pump `sweep_creator_fee`: the curve's waiting creator fee into the creator vault. */
function sweepCurveFee(payer, a) {
  return {
    programId: S.PROGRAMS.pump,
    keys: [meta(payer, true, true), meta(a.global), meta(a.mint), meta(WSOL), meta(TOKEN), meta(S.PROGRAMS.associatedToken),
      meta(S.PROGRAMS.system), meta(a.curve, false, true), meta(a.curveQuote, false, true), meta(a.vault, false, true),
      meta(a.vaultQuote, false, true), meta(a.pumpEvents), meta(S.PROGRAMS.pump)],
    data: Uint8Array.from(C.IX.sweepCreatorFee),
  };
}

/** pump `collect_creator_fee_v2`: the creator vault's lamports above rent to the creator. */
function collectCurveFee(a) {
  return {
    programId: S.PROGRAMS.pump,
    keys: [meta(a.creator, false, true), meta(a.creatorQuote, false, true), meta(a.vault, false, true), meta(a.vaultQuote, false, true),
      meta(WSOL), meta(TOKEN), meta(S.PROGRAMS.associatedToken), meta(S.PROGRAMS.system), meta(a.pumpEvents), meta(S.PROGRAMS.pump)],
    data: Uint8Array.from(C.IX.collectCreatorFeeV2),
  };
}

/** pump-amm `sweep_creator_fee`: the pool's waiting creator fee into the PumpSwap creator vault. */
function sweepPoolFee(payer, a) {
  const p = a.pool;
  return {
    programId: S.PROGRAMS.pumpAmm,
    keys: [meta(payer, true, true), meta(p.globalConfig), meta(p.address, false, true), meta(WSOL), meta(TOKEN),
      meta(p.quoteVault, false, true), meta(p.vaultAuthority), meta(p.vault, false, true), meta(S.PROGRAMS.system),
      meta(S.PROGRAMS.associatedToken), meta(p.events), meta(S.PROGRAMS.pumpAmm)],
    data: Uint8Array.from(C.IX.sweepCreatorFee),
  };
}

/** pump-amm `collect_coin_creator_fee`: the PumpSwap creator vault into the creator's wrapped-SOL account. */
function collectPoolFee(a) {
  const p = a.pool;
  return {
    programId: S.PROGRAMS.pumpAmm,
    keys: [meta(WSOL), meta(TOKEN), meta(a.creator), meta(p.vaultAuthority), meta(p.vault, false, true),
      meta(a.creatorQuote, false, true), meta(p.events), meta(S.PROGRAMS.pumpAmm)],
    data: Uint8Array.from(C.IX.collectCoinCreatorFee),
  };
}

/**
 * The claim, as instructions: compute budget, then the curve part and/or the pool part. The pool
 * part opens the creator's wrapped-SOL account first (a no-op if it exists) because the collect
 * requires it, and closes it last, which unwraps everything in it to the creator.
 */
function claimInstructions({ payer, accounts, sources, units = DEFAULT_UNITS, microLamports = DEFAULT_MICRO_LAMPORTS }) {
  if (!sources.length) throw new Error('nothing to claim');
  if (sources.includes('pool') && !accounts.pool) throw new Error('the coin has no pool to claim from');
  const ixs = [S.computeUnitLimit(units), S.computeUnitPrice(microLamports)];
  if (sources.includes('curve')) ixs.push(sweepCurveFee(payer, accounts), collectCurveFee(accounts));
  if (sources.includes('pool')) {
    ixs.push(sweepPoolFee(payer, accounts),
      S.createAssociatedTokenIdempotent({ payer, account: accounts.creatorQuote, owner: accounts.creator, mint: WSOL, tokenProgram: TOKEN }),
      collectPoolFee(accounts),
      S.closeAccount({ account: accounts.creatorQuote, destination: accounts.creator, owner: accounts.creator, tokenProgram: TOKEN }));
  }
  return ixs;
}

const lamportsOf = (info) => (info && info.value ? BigInt(info.value.lamports) : 0n);
function tokenAmountOf(account) {
  const amount = account && account.data && account.data.parsed && account.data.parsed.info && account.data.parsed.info.tokenAmount && account.data.parsed.info.tokenAmount.amount;
  return amount === undefined ? 0n : BigInt(amount);
}

/**
 * What is waiting for `creator`, in lamports: on the curve (its waiting fee plus the creator
 * vault above rent) and, once graduated, in the pool (its waiting fee plus the PumpSwap creator
 * vault). `state` is scripts/solana-chain.js coinState() for the mint; it is read when not given.
 * Throws when the coin's pump.fun creator is not `creator`, or when its fee does not go to a
 * creator at all (a holder-rewards coin).
 */
async function claimable(rpc, { mint, creator, state = null }) {
  const s = state || await C.coinState(rpc, mint);
  if (s.curveState.isHolderReward || (s.poolState && s.poolState.isHolderReward)) throw new Error(`${mint} is a holder-rewards coin: its creator fee goes to holders, not to a creator`);
  if (s.curveState.creator !== creator) {
    // A coin that set up fee sharing has a program account as its creator, and its fees are paid
    // out through pump.fun's fee-sharing distribution instead, which this does not do.
    const bytes = S.addressBytes(s.curveState.creator);
    const shared = bytes && !S.isOnCurve(bytes) ? ' (a program account: fee sharing has been set up, so these instructions cannot collect it)' : '';
    throw new Error(`${mint}'s creator on pump.fun is ${s.curveState.creator}${shared}, not ${creator}`);
  }
  if (s.poolState && s.poolState.coinCreator !== creator) throw new Error(`${mint}'s PumpSwap coin creator is ${s.poolState.coinCreator}, not ${creator}`);
  const pool = s.poolState ? Object.assign({ address: s.pool }, s.poolState) : null;
  const accounts = await feeAccounts({ mint, creator, pool });
  const vaultInfo = await rpc('getAccountInfo', [accounts.vault, { encoding: 'base64', commitment: 'confirmed' }]);
  const vaultLamports = lamportsOf(vaultInfo);
  const vaultSpare = vaultLamports > RENT_EXEMPT_EMPTY ? vaultLamports - RENT_EXEMPT_EMPTY : 0n;
  const curveLamports = s.curveState.creatorFee + vaultSpare;
  let poolLamports = 0n;
  if (accounts.pool) {
    const res = await rpc('getMultipleAccounts', [[accounts.pool.vault], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    poolLamports = pool.creatorFees + tokenAmountOf(res && res.value && res.value[0]);
  }
  return { state: s, accounts, curveLamports, poolLamports, totalLamports: curveLamports + poolLamports };
}

module.exports = {
  RENT_EXEMPT_EMPTY, DEFAULT_UNITS, DEFAULT_MICRO_LAMPORTS,
  feeAccounts, sweepCurveFee, collectCurveFee, sweepPoolFee, collectPoolFee, claimInstructions, claimable,
};
