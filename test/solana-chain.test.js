#!/usr/bin/env node
'use strict';
/**
 * scripts/solana-chain.js, offline: RPC pacing and endpoint order, history paging, a token
 * account's balance at a past moment, the pump.fun account decoders and addresses (against real
 * mainnet accounts saved in test/fixtures/solana/pump-accounts.json, and vault addresses that hold
 * real fees on mainnet), the coin's price from curve or pool, SOL prices with their fallback,
 * keypairs, signing, simulation and confirmation.
 *
 *   node test/solana-chain.test.js
 */
const path = require('path');
const crypto = require('crypto');
const kit = require('@solana/kit');
const C = require(path.join(__dirname, '..', 'scripts', 'solana-chain.js'));
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const PUMP = require(path.join(__dirname, 'fixtures', 'solana', 'pump-accounts.json'));

let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x instanceof Uint8Array ? Array.from(x) : x));
const check = (what, got, want) => {
  checks++;
  if (norm(got) === norm(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const checkThat = (what, cond, detail) => {
  checks++;
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
};
async function rejects(what, promise, pattern) {
  checks++;
  try { await promise; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); }
  }
}
const newKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { secret: new Uint8Array(Buffer.concat([seed, pub])), address: S.encodeBase58(new Uint8Array(pub)), publicKey };
};

(async () => {
  console.log('endpoints and pacing');
  check('SOLANA_RPC_URL comes first, then config, without repeats',
    C.endpoints({ SOLANA_RPC_URL: 'https://key.example/rpc, http://insecure.example, https://api.mainnet-beta.solana.com' }),
    ['https://key.example/rpc', 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']);
  {
    const times = [];
    const rpc = C.makeRpc({ urls: ['https://a.test'], minIntervalMs: 40, fetchImpl: async () => { times.push(Date.now()); return { ok: true, status: 200, json: async () => ({ result: 1 }) }; } });
    await Promise.all([rpc('getSlot', []), rpc('getSlot', []), rpc('getSlot', [])]);
    checkThat('requests are spaced by the minimum interval', times[1] - times[0] >= 35 && times[2] - times[1] >= 35, JSON.stringify(times.map((t) => t - times[0])));
  }

  console.log('\nhistory');
  {
    // Newest first, as the RPC answers: s5 … s1.
    const all = [5, 4, 3, 2, 1].map((n) => ({ signature: 's' + n, slot: n * 10, blockTime: 1000 + n, err: null }));
    const calls = [];
    const rpc = async (method, [address, opts]) => {
      calls.push(opts);
      let list = all;
      if (opts.until) list = list.slice(0, list.findIndex((s) => s.signature === opts.until));
      if (opts.before) list = list.slice(list.findIndex((s) => s.signature === opts.before) + 1);
      return list.slice(0, opts.limit);
    };
    check('signatures newer than the cursor, oldest first', (await C.signaturesAfter(rpc, 'x', { until: 's2', pageSize: 2 })).map((s) => s.signature), ['s3', 's4', 's5']);
    check('paged with before, stopping at the cursor', calls.map((o) => [o.until || null, o.before || null]), [['s2', null], ['s2', 's4']]);
    check('no cursor reads the whole history', (await C.signaturesAfter(rpc, 'x', { pageSize: 10 })).map((s) => s.signature), ['s1', 's2', 's3', 's4', 's5']);
    await rejects('too long a history is refused rather than cut short', C.signaturesAfter(rpc, 'x', { pageSize: 1, maxPages: 2 }), /raise maxPages/);
  }
  {
    const ACCOUNT = newKey().address, OTHER = newKey().address, MINT = newKey().address;
    const txFor = (amount, present = true) => ({
      meta: { err: null, postTokenBalances: present ? [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: String(amount), decimals: 6 } }] : [] },
      transaction: { message: { accountKeys: [{ pubkey: OTHER }, { pubkey: ACCOUNT }] } },
    });
    const history = [ // newest first
      { signature: 'h4', blockTime: 400 }, { signature: 'h3', blockTime: 300 }, { signature: 'h2', blockTime: 200 }, { signature: 'h1', blockTime: 100 }];
    const txs = { h4: txFor(40), h3: txFor(30), h2: txFor(20, false), h1: txFor(10) };
    let reads = 0;
    const rpc = async (method, params) => {
      if (method === 'getSignaturesForAddress') {
        const opts = params[1];
        let list = history;
        if (opts.before) list = list.slice(list.findIndex((s) => s.signature === opts.before) + 1);
        return list.slice(0, opts.limit);
      }
      reads++;
      return txs[params[0]];
    };
    check('the balance after the last transaction at or before the moment', await C.balanceAt(rpc, ACCOUNT, 350), 30n);
    check('found on a later page', await C.balanceAt(rpc, ACCOUNT, 150, { pageSize: 2 }), 10n);
    check('an account closed by that transaction held nothing', await C.balanceAt(rpc, ACCOUNT, 250), 0n);
    check('an account with no history that old held nothing', await C.balanceAt(rpc, ACCOUNT, 50), 0n);
    await rejects('a history too long to walk is refused', C.balanceAt(rpc, ACCOUNT, 50, { pageSize: 1, maxPages: 2 }), /more than 2 transactions/);
    checkThat('one transaction is read per lookup', reads === 3, 'reads: ' + reads);
  }
  {
    const owner = newKey().address, mint = newKey().address, extra = newKey().address;
    const ata = await S.associatedTokenAddress(owner, mint, S.PROGRAMS.token2022);
    check('token accounts: the indexed list plus the associated account',
      await C.tokenAccountsOf(async () => ({ value: [{ pubkey: ata }, { pubkey: extra }] }), owner, mint, S.PROGRAMS.token2022), [ata, extra]);
    check('an endpoint that refuses the indexed call still yields the associated account',
      await C.tokenAccountsOf(async () => { throw new Error('Indexed requests require a personal token'); }, owner, mint, S.PROGRAMS.token2022), [ata]);
  }

  console.log('\npump.fun accounts (real mainnet data)');
  const curveCoin = PUMP.curveCoin, gradCoin = PUMP.graduatedCoin;
  check('the bonding curve address derives from the mint', await C.bondingCurveAddress(curveCoin.mint), curveCoin.curve);
  check('so does a graduated coin\'s', await C.bondingCurveAddress(gradCoin.mint), gradCoin.curve);
  check('the canonical pool address derives from the mint', await C.poolAddress(gradCoin.mint), gradCoin.pool);
  const curve = C.decodeBondingCurve(curveCoin.curveAccount.data[0]);
  check('a live curve: not complete, SOL-paired, a wallet creator', [curve.complete, curve.quoteMint, S.isAddress(curve.creator), curve.isHolderReward],
    [false, S.MINTS.wsol, true, false]);
  checkThat('a live curve has reserves', curve.virtualTokenReserves > 0n && curve.virtualQuoteReserves > 0n);
  const graduated = C.decodeBondingCurve(gradCoin.curveAccount.data[0]);
  check('a graduated coin\'s curve is complete', graduated.complete, true);
  const pool = C.decodePool(gradCoin.poolAccount.data[0]);
  check('the pool names the coin, SOL, its vaults and its creator', [pool.baseMint, pool.quoteMint, pool.baseVault, pool.quoteVault, pool.index],
    [gradCoin.mint, S.MINTS.wsol, gradCoin.baseVault, gradCoin.quoteVault, 0]);
  check('the pool\'s creator is the coin\'s pump.fun pool authority', pool.creator, await C.poolAuthorityAddress(gradCoin.mint));
  checkThat('the pool carries a coin creator and waiting creator fees', S.isAddress(pool.coinCreator) && pool.creatorFees >= 0n);
  // Both vaults below held real fees on mainnet when they were derived, so the derivations are right.
  check('the bonding-curve creator vault', await C.creatorVaultAddress('PPZhYDsW6zKZhYMiQCZwSYgoKx5PX38EEhAHatdWC15'), 'CxfuBdmnSYT4H9mAL4oGZDE4cHyVMVTzyyoJipRFpoMP');
  check('the PumpSwap creator vault authority', await C.ammCreatorVaultAuthority('BZbF2e44VMiyziSh2DkUFPJgq5vKpjTFtkQSAb8U11rr'), 'Bf1HbUoFMhtBHfWa7PGYibrpGqEeQcYUd3XUj9Xrcroe');
  check('and its wrapped-SOL account', await C.ammCreatorVaultAccount('BZbF2e44VMiyziSh2DkUFPJgq5vKpjTFtkQSAb8U11rr'), 'Hjys4QCz9TES4SeDAjWkhNLuXY4Aj8t1DYde6VwNoRyf');
  check('pump.fun\'s event authority', await C.eventAuthority(S.PROGRAMS.pump), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  for (const [name, bytes] of Object.entries({ sweep_creator_fee: C.IX.sweepCreatorFee, collect_creator_fee_v2: C.IX.collectCreatorFeeV2, collect_coin_creator_fee: C.IX.collectCoinCreatorFee })) {
    check(`the ${name} discriminator is sha256("global:${name}")`, bytes, Array.from(crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8)));
  }
  check('the account discriminators are sha256("account:…")', [C.DISC.bondingCurve, C.DISC.pool],
    ['BondingCurve', 'Pool'].map((n) => Array.from(crypto.createHash('sha256').update('account:' + n).digest().subarray(0, 8))));

  const accountRpc = (map) => async (method, params) => {
    if (method === 'getAccountInfo') return { value: map[params[0]] || null };
    if (method === 'getMultipleAccounts') return { value: params[0].map((a) => map[a] || null) };
    throw new Error('unexpected ' + method);
  };
  {
    const state = await C.coinState(accountRpc({ [curveCoin.curve]: curveCoin.curveAccount }), curveCoin.mint);
    check('a live coin is priced from its curve', [state.source, state.complete, state.creator], ['bonding-curve', false, curve.creator]);
    check('at virtual SOL over virtual tokens, per whole token', state.priceSol, Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves) / 1000);
  }
  {
    const map = { [gradCoin.curve]: gradCoin.curveAccount, [gradCoin.pool]: gradCoin.poolAccount, [gradCoin.baseVault]: gradCoin.baseVaultAccount, [gradCoin.quoteVault]: gradCoin.quoteVaultAccount };
    const state = await C.coinState(accountRpc(map), gradCoin.mint);
    const base = BigInt(gradCoin.baseVaultAccount.data.parsed.info.tokenAmount.amount);
    const quote = BigInt(gradCoin.quoteVaultAccount.data.parsed.info.tokenAmount.amount) + pool.virtualQuoteReserves;
    check('a graduated coin is priced from its pool', [state.source, state.pool, state.creator], ['pool', gradCoin.pool, pool.coinCreator]);
    check('at effective SOL reserves over tokens', state.priceSol, Number(quote) / Number(base) / 1000);
    const unmigrated = await C.coinState(accountRpc({ [gradCoin.curve]: gradCoin.curveAccount }), gradCoin.mint);
    check('complete but not yet migrated: the last curve price', unmigrated.source, 'bonding-curve');
  }
  await rejects('a mint with no curve is not a pump.fun coin', C.coinState(accountRpc({}), curveCoin.mint), /no pump.fun bonding curve/);
  {
    const usdcPaired = Buffer.from(curveCoin.curveAccount.data[0], 'base64');
    Buffer.from(S.decodeBase58(S.MINTS.usdc)).copy(usdcPaired, 83);
    await rejects('a coin paired with anything but SOL is refused', C.coinState(accountRpc({ [curveCoin.curve]: Object.assign({}, curveCoin.curveAccount, { data: [usdcPaired.toString('base64'), 'base64'] }) }), curveCoin.mint), /SOL-paired coins only/);
  }

  console.log('\nSOL prices');
  const respond = (routes) => async (url) => {
    const host = new URL(url).host;
    const r = routes[host];
    if (!r) throw new Error('offline');
    if (r instanceof Error) throw r;
    return { ok: true, status: 200, json: async () => (typeof r === 'function' ? r(url) : r) };
  };
  check('spot from Coinbase', await C.solUsdNow({ fetchImpl: respond({ 'api.coinbase.com': { data: { amount: '103.75' } } }) }), 103.75);
  check('spot from Kraken when Coinbase is down', await C.solUsdNow({ fetchImpl: respond({ 'api.kraken.com': { result: { SOLUSD: { c: ['104.10', '1'] } } } }) }), 104.1);
  await rejects('no source, no price', C.solUsdNow({ fetchImpl: respond({}) }), /no SOL price/);
  const hour = 1791763200;
  check('an hour\'s close from Coinbase candles', await C.solUsdAt(hour + 1234, { fetchImpl: respond({ 'api.exchange.coinbase.com': [[hour, 100, 106, 101, 105.5, 9]] }) }), 105.5);
  check('from Kraken when Coinbase has no candle', await C.solUsdAt(hour + 1234, { fetchImpl: respond({ 'api.exchange.coinbase.com': [], 'api.kraken.com': { result: { SOLUSD: [[hour - 3600, '1', '1', '1', '99', '1'], [hour, '1', '1', '1', '101.25', '1']], last: hour } } }) }), 101.25);

  console.log('\nkeys, signing and sending');
  {
    const k = newKey();
    const fromBase58 = C.keypairFromSecret(S.encodeBase58(k.secret));
    const fromJson = C.keypairFromSecret(JSON.stringify(Array.from(k.secret)));
    check('a base58 secret key (Phantom\'s export) gives its address', fromBase58.address, k.address);
    check('so does a solana-keygen JSON array', fromJson.address, k.address);
    const msg = S.utf8('hello');
    checkThat('signatures verify against the public key', crypto.verify(null, Buffer.from(msg), k.publicKey, Buffer.from(fromBase58.sign(msg))));
    const wrong = k.secret.slice(); wrong[40] ^= 1;
    let err = null; try { C.keypairFromSecret(S.encodeBase58(wrong)); } catch (e) { err = e.message; }
    check('a secret whose halves disagree is refused', err, 'the secret key does not match its own public key');
    err = null; try { C.keypairFromSecret(S.encodeBase58(k.secret.subarray(0, 32))); } catch (e) { err = e.message; }
    check('a 32-byte seed alone is refused', err, 'a Solana secret key is 64 bytes; this one is 32');
    const to = newKey().address;
    const { wire, signature } = C.signedTransaction({ payer: fromBase58.address, blockhash: S.encodeBase58(new Uint8Array(32).fill(9)),
      instructions: [S.systemTransfer({ from: fromBase58.address, to, lamports: 1000n })], signers: [fromBase58] });
    const decoded = kit.getTransactionDecoder().decode(wire);
    check('the wire transaction carries the payer\'s signature', S.encodeBase58(new Uint8Array(decoded.signatures[fromBase58.address])), signature);
    checkThat('which verifies over the message', crypto.verify(null, Buffer.from(decoded.messageBytes), k.publicKey, Buffer.from(decoded.signatures[fromBase58.address])));
    let missing = null; try { C.signedTransaction({ payer: fromBase58.address, blockhash: S.encodeBase58(new Uint8Array(32).fill(9)), instructions: [], signers: [] }); } catch (e) { missing = e.message; }
    check('a missing signer is refused before anything is sent', missing, 'no key for signer ' + fromBase58.address);
    await rejects('a failing simulation is refused with its logs', C.simulateTransaction(async () => ({ value: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ['Program log: NotAuthorized'] } }), wire), /would fail.*NotAuthorized/);
  }
  {
    let polls = 0;
    const rpc = async (method) => {
      if (method === 'getSignatureStatuses') { polls++; return { value: [polls < 2 ? null : { confirmationStatus: 'confirmed', err: null }] }; }
      if (method === 'getBlockHeight') return 10;
      return 'resent';
    };
    check('confirmation waits for the status', await C.confirmTransaction(rpc, 'sig', { pollMs: 1, lastValidBlockHeight: 100 }), 'confirmed');
    await rejects('a failed transaction is reported', C.confirmTransaction(async (m) => (m === 'getSignatureStatuses' ? { value: [{ err: { InstructionError: [1, 'x'] } }] } : 1), 'sig', { pollMs: 1 }), /failed/);
    await rejects('an expired blockhash is reported', C.confirmTransaction(async (m) => (m === 'getSignatureStatuses' ? { value: [null] } : 200), 'sig', { pollMs: 1, lastValidBlockHeight: 100 }), /expired/);
  }

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
