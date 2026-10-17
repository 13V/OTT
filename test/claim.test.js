#!/usr/bin/env node
'use strict';
/**
 * The creator-fee claim keeper (scripts/claim.js and scripts/pump-fees.js), offline.
 *
 * The instructions are checked against pump.fun's own IDL entries for them (saved in
 * test/fixtures/solana/pump-fee-idl.json): the same number of accounts, the same writable and
 * signer flags in the same order, the fixed program addresses, and every program-derived account
 * re-derived from the IDL's own seed definitions — so the check is pump.fun's description of the
 * instruction, not this file's. The run is driven with a fake RPC built on real mainnet accounts
 * (test/fixtures/solana/pump-accounts.json), and what matters is asserted: a wrong key is refused
 * before any call, nothing is sent without a clean simulation, a dry run and a rehearsal never
 * send, and the log is written only for a confirmed claim, with what the chain says it paid.
 *
 *   node test/claim.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const C = require(path.join(__dirname, '..', 'scripts', 'solana-chain.js'));
const P = require(path.join(__dirname, '..', 'scripts', 'pump-fees.js'));
const CL = require(path.join(__dirname, '..', 'scripts', 'claim.js'));
const IDL = require(path.join(__dirname, 'fixtures', 'solana', 'pump-fee-idl.json'));
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
const rejects = async (what, promise, pattern) => {
  checks++;
  try { await promise; failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); }
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
const newKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return C.keypairFromSecret(S.encodeBase58(new Uint8Array(Buffer.concat([seed, pub]))));
};
const BLOCKHASH = S.encodeBase58(new Uint8Array(32).fill(7));
const WSOL = S.MINTS.wsol;

/** A fixture bonding curve or pool with its creator and waiting fee rewritten for this test. */
function patchCurve(base64, { creator, creatorFee = null, holderReward = null }) {
  const b = Buffer.from(base64, 'base64');
  if (creator) Buffer.from(S.addressBytes(creator)).copy(b, 49);
  if (holderReward !== null) b[124] = holderReward ? 1 : 0;
  if (creatorFee !== null) b.writeBigUInt64LE(BigInt(creatorFee), 125);
  return b.toString('base64');
}
function patchPool(base64, { coinCreator, creatorFees = null }) {
  const b = Buffer.from(base64, 'base64');
  if (coinCreator) Buffer.from(S.addressBytes(coinCreator)).copy(b, 211);
  if (creatorFees !== null) b.writeBigUInt64LE(BigInt(creatorFees), 279);
  return b.toString('base64');
}
const withData = (account, base64) => Object.assign({}, account, { data: [base64, 'base64'] });
const tokenAccount = (amount) => ({ data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } });
/** The first signature in a base64 wire transaction, as base58. */
const signatureOf = (wire64) => S.encodeBase58(S.decodeBase64(wire64).subarray(1, 65));

/**
 * A fake RPC over a map of accounts. Records every call; sendTransaction answers with the
 * transaction's own signature; getTransaction reports `collected` lamports paid to `payee`.
 */
function fakeRpc({ accounts = {}, simulate = null, collected = 0n, payee = null, fee = 15000, failSend = false, confirm = 'confirmed', landed = true } = {}) {
  const calls = [];
  const sent = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'getAccountInfo': return { value: accounts[params[0]] || null };
      case 'getMultipleAccounts': return { value: params[0].map((a) => accounts[a] || null) };
      case 'getBalance': return { value: 5000000000 };
      case 'getLatestBlockhash': return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
      case 'simulateTransaction': return simulate ? simulate(params) : { value: { err: null, unitsConsumed: 110000, logs: [], accounts: null } };
      case 'sendTransaction': if (failSend) throw new Error('should never send'); sent.push(params[0]); return signatureOf(params[0]);
      case 'getSignatureStatuses': return { value: [confirm === 'failed' ? { err: { InstructionError: [2, { Custom: 6000 }] } } : confirm === 'pending' ? null : { confirmationStatus: confirm, err: null }] };
      case 'getBlockHeight': return 10;
      case 'getTransaction': return !landed ? null : {
        meta: { err: confirm === 'failed' ? { InstructionError: [2, { Custom: 6000 }] } : null, fee, preBalances: [5000000000], postBalances: [5000000000 + Number(collected) - fee] },
        transaction: { signatures: [params[0]], message: { accountKeys: [{ pubkey: payee, signer: true, writable: true }] } },
      };
      default: throw new Error('unexpected rpc ' + method);
    }
  };
  return { rpc, calls, sent };
}

(async () => {
  const treasury = newKey();
  const curveCoin = PUMP.curveCoin, gradCoin = PUMP.graduatedCoin;
  const poolState = C.decodePool(gradCoin.poolAccount.data[0]);

  // ------------------------------------------------------------------------------------------
  console.log('the instructions match pump.fun\'s IDL');
  const accounts = await P.feeAccounts({ mint: gradCoin.mint, creator: treasury.address, pool: Object.assign({ address: gradCoin.pool }, poolState) });
  const built = {
    'pump sweep_creator_fee': [P.sweepCurveFee(treasury.address, accounts), IDL.pump],
    'pump collect_creator_fee_v2': [P.collectCurveFee(accounts), IDL.pump],
    'pump-amm sweep_creator_fee': [P.sweepPoolFee(treasury.address, accounts), IDL.pumpAmm],
    'pump-amm collect_coin_creator_fee': [P.collectPoolFee(accounts), IDL.pumpAmm],
  };
  // What each named account must be, where the IDL gives no seeds or fixed address to check.
  const named = {
    payer: treasury.address, base_mint: gradCoin.mint, quote_mint: WSOL, quote_token_program: S.PROGRAMS.token,
    creator: treasury.address, coin_creator: treasury.address, recipient: null, pool: gradCoin.pool,
    pool_quote_token_account: poolState.quoteVault, coin_creator_token_account: accounts.creatorQuote,
    global_config: 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
  };
  for (const [label, [ix, program]] of Object.entries(built)) {
    const name = label.split(' ')[1];
    const spec = program.instructions[name];
    check(`${label}: the program`, ix.programId, program.address);
    check(`${label}: the discriminator is the instruction data`, Array.from(ix.data), spec.discriminator);
    check(`${label}: ${spec.accounts.length} accounts, with the IDL's writable and signer flags`,
      ix.keys.map((k) => [k.writable, k.signer]), spec.accounts.map((a) => [a.writable, a.signer]));
    const byName = Object.fromEntries(spec.accounts.map((a, i) => [a.name, ix.keys[i] && ix.keys[i].address]));
    let pdas = 0, fixed = 0, roles = 0;
    for (const [i, a] of spec.accounts.entries()) {
      const got = ix.keys[i].address;
      if (a.address) { fixed++; check(`${label}: ${a.name} is ${a.address}`, got, a.address); continue; }
      if (a.pda) {
        pdas++;
        const seeds = a.pda.seeds.map((s) => (s.const !== undefined ? (typeof s.const === 'string' ? S.utf8(s.const) : S.decodeBase58(s.const.base58)) : S.addressBytes(byName[s.account])));
        const owner = a.pda.program === null ? program.address : typeof a.pda.program === 'string' ? a.pda.program : byName[a.pda.program.account];
        check(`${label}: ${a.name} re-derives from the IDL's seeds`, got, (await S.programAddress(seeds, owner)).address);
        continue;
      }
      if (a.name === 'program') { roles++; check(`${label}: program is ${program.address}`, got, program.address); continue; }
      if (a.name === 'recipient') {
        roles++;
        const want = label.startsWith('pump-amm') ? await C.ammCreatorVaultAuthority(treasury.address) : await C.creatorVaultAddress(treasury.address);
        check(`${label}: recipient is the creator vault`, got, want);
        continue;
      }
      if (named[a.name] !== undefined) { roles++; check(`${label}: ${a.name}`, got, named[a.name]); continue; }
      checkThat(`${label}: ${a.name} is accounted for`, false, 'no rule for ' + a.name);
    }
    checkThat(`${label}: every account was checked (${fixed} fixed, ${pdas} derived, ${roles} by role)`, fixed + pdas + roles === spec.accounts.length);
  }
  check('pump-amm global_config is the PDA "global_config"', (await S.programAddress(['global_config'], S.PROGRAMS.pumpAmm)).address, 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

  console.log('\nthe claim transaction');
  {
    const curveOnly = await P.feeAccounts({ mint: curveCoin.mint, creator: treasury.address });
    const ixs = P.claimInstructions({ payer: treasury.address, accounts: curveOnly, sources: ['curve'] });
    check('curve only: compute budget, sweep, collect', ixs.map((i) => i.programId),
      [S.PROGRAMS.computeBudget, S.PROGRAMS.computeBudget, S.PROGRAMS.pump, S.PROGRAMS.pump]);
    const both = P.claimInstructions({ payer: treasury.address, accounts, sources: ['curve', 'pool'] });
    check('graduated: then the pool sweep, the wrapped-SOL account, the collect and the close', both.map((i) => i.programId),
      [S.PROGRAMS.computeBudget, S.PROGRAMS.computeBudget, S.PROGRAMS.pump, S.PROGRAMS.pump, S.PROGRAMS.pumpAmm,
        S.PROGRAMS.associatedToken, S.PROGRAMS.pumpAmm, S.PROGRAMS.token]);
    check('the wrapped-SOL account is the treasury\'s own, created idempotently', [Array.from(both[5].data), both[5].keys[1].address, both[5].keys[2].address],
      [[1], await S.associatedTokenAddress(treasury.address, WSOL, S.PROGRAMS.token), treasury.address]);
    check('and closed back into the treasury, unwrapping it', [Array.from(both[7].data), both[7].keys.map((k) => k.address)],
      [[9], [accounts.creatorQuote, treasury.address, treasury.address]]);
    const message = S.compileMessage({ payer: treasury.address, blockhash: BLOCKHASH, instructions: both });
    check('the treasury is the only signer', S.messageSigners(message), [treasury.address]);
    checkThat('the whole claim fits one transaction', S.wireTransaction(message).length <= 1232, 'size ' + S.wireTransaction(message).length);
    let err = null; try { P.claimInstructions({ payer: treasury.address, accounts: curveOnly, sources: ['pool'] }); } catch (e) { err = e.message; }
    check('a pool claim for a coin with no pool is refused', err, 'the coin has no pool to claim from');
  }

  console.log('\nthe plan');
  check('under the floor is nothing', CL.plan({ curveLamports: 2000000n, poolLamports: 1000000n, minLamports: 5000000n }), { sources: [], lamports: 3000000n });
  check('the curve alone', CL.plan({ curveLamports: 9000000n, poolLamports: 0n, minLamports: 5000000n }), { sources: ['curve'], lamports: 9000000n });
  check('both parts together over the floor', CL.plan({ curveLamports: 3000000n, poolLamports: 4000000n, minLamports: 5000000n }), { sources: ['curve', 'pool'], lamports: 7000000n });
  check('nothing waiting is nothing even with no floor', CL.plan({ curveLamports: 0n, poolLamports: 0n, minLamports: 0n }).sources, []);
  check('the log keeps the newest hundred', CL.appendClaims(Array.from({ length: 120 }, (_, i) => ({ i })), [{ i: 'new' }]).length, 100);

  // ------------------------------------------------------------------------------------------
  console.log('\nthe run');
  const vault = await C.creatorVaultAddress(treasury.address);
  const curveAccounts = (fee, extra = {}) => ({
    [curveCoin.curve]: withData(curveCoin.curveAccount, patchCurve(curveCoin.curveAccount.data[0], Object.assign({ creator: treasury.address, creatorFee: fee }, extra))),
    [vault]: { lamports: Number(P.RENT_EXEMPT_EMPTY) + 3000000, owner: S.PROGRAMS.system, data: ['', 'base64'] },
  });
  const config = { coin: curveCoin.mint, treasury: treasury.address };
  const quiet = { confirmOptions: { pollMs: 1 }, measureOptions: { attempts: 1, pauseMs: 0 }, solUsd: async () => 104 };

  let f = fakeRpc({ accounts: curveAccounts(9000000) });
  const stranger = newKey();
  await rejects('a key that is not the treasury is refused', CL.run(Object.assign({ rpc: f.rpc, config, key: stranger }, quiet)), /wrong wallet/);
  check('before any call', f.calls.length, 0);
  await rejects('no treasury configured is refused', CL.run(Object.assign({ rpc: f.rpc, config: { coin: curveCoin.mint, treasury: '' }, key: treasury }, quiet)), /no treasury/);
  await rejects('no coin configured is refused', CL.run(Object.assign({ rpc: f.rpc, config: { coin: '', treasury: treasury.address }, key: treasury }, quiet)), /no coin/);
  await rejects('no key outside a dry run is refused', CL.run(Object.assign({ rpc: f.rpc, config }, quiet)), /TREASURY_PRIVATE_KEY is required/);

  f = fakeRpc({ accounts: curveAccounts(1000000) });
  let r = await CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c1.json') }, quiet));
  check('0.004 SOL waiting is under the 0.005 SOL floor: nothing simulated or sent', [r.claimed, f.calls.filter((c) => /simulate|send/.test(c.method)).length], [[], 0]);
  check('and no log', fs.existsSync(path.join(tmp, 'c1.json')), false);

  f = fakeRpc({ accounts: curveAccounts(9000000), collected: 12000123n, payee: treasury.address });
  const out = path.join(tmp, 'c2.json');
  r = await CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out, now: () => 1800000000000 }, quiet));
  const simCalls = f.calls.filter((c) => c.method === 'simulateTransaction');
  check('a claim is simulated once, signed, before it is sent once', [simCalls.length, simCalls[0].params[1].sigVerify, f.sent.length], [1, true, 1]);
  check('what was simulated is what was sent', simCalls[0].params[0], f.sent[0]);
  const wire = S.decodeBase64(f.sent[0]);
  checkThat('the sent transaction carries the treasury\'s valid signature', crypto.verify(null, Buffer.from(wire.subarray(65)),
    crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(S.addressBytes(treasury.address))]), format: 'der', type: 'spki' }),
    Buffer.from(wire.subarray(1, 65))));
  const logged = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('the log holds what the chain says it paid, valued at the price then', logged, [{
    at: 1800000000, lamports: '12000123', sol: 0.012000123, solUsd: 104, usd: 1.25, tx: signatureOf(f.sent[0]), sources: ['curve'], dryRun: false }]);
  checkThat('read back after confirmation', f.calls.findIndex((c) => c.method === 'getTransaction') > f.calls.findIndex((c) => c.method === 'getSignatureStatuses'));
  r = await CL.run(Object.assign({ rpc: fakeRpc({ accounts: curveAccounts(9000000), collected: 7000000n, payee: treasury.address }).rpc, config, key: treasury, out }, quiet));
  check('a second claim appends', JSON.parse(fs.readFileSync(out, 'utf8')).map((e) => e.lamports), ['12000123', '7000000']);

  f = fakeRpc({ accounts: curveAccounts(9000000), collected: 0n, payee: null });
  r = await CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c3.json') }, quiet));
  check('when the chain cannot say, the log uses what was waiting', JSON.parse(fs.readFileSync(path.join(tmp, 'c3.json'), 'utf8'))[0].lamports, String(9000000 + 3000000));

  f = fakeRpc({ accounts: curveAccounts(9000000), simulate: () => ({ value: { err: { InstructionError: [2, { Custom: 6095 }] }, logs: ['Program log: CreatorFeesNotSwept'] } }) });
  await rejects('a claim that fails in simulation is refused with the program\'s logs', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c4.json') }, quiet)), /would fail.*CreatorFeesNotSwept/);
  check('and never sent, nor logged', [f.sent.length, fs.existsSync(path.join(tmp, 'c4.json'))], [0, false]);

  f = fakeRpc({ accounts: curveAccounts(9000000), confirm: 'failed' });
  await rejects('a claim that fails on chain is reported', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c5.json') }, quiet)), /failed/);
  check('and not logged as collected', fs.existsSync(path.join(tmp, 'c5.json')), false);

  f = fakeRpc({ accounts: curveAccounts(9000000), confirm: 'pending', collected: 12000000n, payee: treasury.address });
  r = await CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c5b.json') }, quiet, { confirmOptions: { pollMs: 1, timeoutMs: 5 } }));
  check('a claim whose confirmation times out but is on chain is still logged', JSON.parse(fs.readFileSync(path.join(tmp, 'c5b.json'), 'utf8'))[0].lamports, '12000000');
  f = fakeRpc({ accounts: curveAccounts(9000000), confirm: 'pending', landed: false });
  await rejects('one that never landed is an error', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, out: path.join(tmp, 'c5c.json') }, quiet, { confirmOptions: { pollMs: 1, timeoutMs: 5 } })), /was not confirmed/);
  check('and is not logged', fs.existsSync(path.join(tmp, 'c5c.json')), false);

  f = fakeRpc({ accounts: curveAccounts(9000000), failSend: true });
  r = await CL.run(Object.assign({ rpc: f.rpc, config, key: treasury, dryRun: true, out: path.join(tmp, 'c6.json') }, quiet));
  check('a dry run with the key simulates the signed claim and sends nothing', [r.dryRun, r.plannedLamports, r.sources, f.calls.find((c) => c.method === 'simulateTransaction').params[1].sigVerify],
    [true, 12000000n, ['curve'], true]);
  check('and writes no log', fs.existsSync(path.join(tmp, 'c6.json')), false);
  f = fakeRpc({ accounts: curveAccounts(9000000), failSend: true });
  r = await CL.run(Object.assign({ rpc: f.rpc, config, dryRun: true }, quiet));
  const unsignedSim = f.calls.find((c) => c.method === 'simulateTransaction').params[1];
  check('a dry run without the key simulates it unsigned, as the treasury', [r.dryRun, unsignedSim.sigVerify, unsignedSim.replaceRecentBlockhash], [true, false, true]);

  f = fakeRpc({ accounts: curveAccounts(9000000, { holderReward: true }) });
  await rejects('a holder-rewards coin is refused: its fee goes to holders', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury }, quiet)), /holder-rewards coin/);
  {
    const sharing = (await S.programAddress(['sharing-config', S.addressBytes(curveCoin.mint)], S.PROGRAMS.pumpFees)).address;
    f = fakeRpc({ accounts: { [curveCoin.curve]: withData(curveCoin.curveAccount, patchCurve(curveCoin.curveAccount.data[0], { creator: sharing })) } });
    await rejects('a coin whose creator is a fee-sharing account is refused, and says why', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury }, quiet)), /fee sharing has been set up/);
    f = fakeRpc({ accounts: { [curveCoin.curve]: withData(curveCoin.curveAccount, patchCurve(curveCoin.curveAccount.data[0], { creator: stranger.address })) } });
    await rejects('a coin created by another wallet is refused', CL.run(Object.assign({ rpc: f.rpc, config, key: treasury }, quiet)), new RegExp('creator on pump.fun is ' + stranger.address + ', not'));
  }

  console.log('\na graduated coin');
  {
    const ammVault = await C.ammCreatorVaultAccount(treasury.address);
    const gradAccounts = {
      [gradCoin.curve]: withData(gradCoin.curveAccount, patchCurve(gradCoin.curveAccount.data[0], { creator: treasury.address, creatorFee: 2000000 })),
      [gradCoin.pool]: withData(gradCoin.poolAccount, patchPool(gradCoin.poolAccount.data[0], { coinCreator: treasury.address, creatorFees: 40000000 })),
      [gradCoin.baseVault]: gradCoin.baseVaultAccount, [gradCoin.quoteVault]: gradCoin.quoteVaultAccount,
      [await C.creatorVaultAddress(treasury.address)]: { lamports: Number(P.RENT_EXEMPT_EMPTY), owner: S.PROGRAMS.system, data: ['', 'base64'] },
      [ammVault]: tokenAccount(60000000),
    };
    const gconfig = { coin: gradCoin.mint, treasury: treasury.address };
    const waiting = await P.claimable(fakeRpc({ accounts: gradAccounts }).rpc, { mint: gradCoin.mint, creator: treasury.address });
    check('what is waiting: the curve\'s fee, the pool\'s fee and the PumpSwap vault, not the vault\'s rent', [waiting.curveLamports, waiting.poolLamports, waiting.totalLamports], [2000000n, 100000000n, 102000000n]);
    f = fakeRpc({ accounts: gradAccounts, collected: 102000000n, payee: treasury.address });
    r = await CL.run(Object.assign({ rpc: f.rpc, config: gconfig, key: treasury, out: path.join(tmp, 'g1.json') }, quiet));
    check('both parts are claimed in one transaction', [r.claimed[0].sources, r.claimed[0].lamports], [['curve', 'pool'], '102000000']);
    const gradMessage = S.decodeBase64(f.sent[0]);
    checkThat('and it carries all eight instructions', gradMessage.length > 600, 'size ' + gradMessage.length);
    const poolOnly = Object.assign({}, gradAccounts, { [gradCoin.curve]: withData(gradCoin.curveAccount, patchCurve(gradCoin.curveAccount.data[0], { creator: treasury.address, creatorFee: 0 })) });
    r = await CL.run(Object.assign({ rpc: fakeRpc({ accounts: poolOnly, failSend: true }).rpc, config: gconfig, key: treasury, dryRun: true }, quiet));
    check('nothing on the curve: only the pool part', r.sources, ['pool']);
    const otherPool = Object.assign({}, gradAccounts, { [gradCoin.pool]: withData(gradCoin.poolAccount, patchPool(gradCoin.poolAccount.data[0], { coinCreator: stranger.address })) });
    await rejects('a pool whose coin creator is someone else is refused', CL.run(Object.assign({ rpc: fakeRpc({ accounts: otherPool }).rpc, config: gconfig, key: treasury }, quiet)), /PumpSwap coin creator is/);
  }

  console.log('\na rehearsal never sends');
  {
    const creator = newKey().address;
    const rehearsalAccounts = {
      [curveCoin.curve]: withData(curveCoin.curveAccount, patchCurve(curveCoin.curveAccount.data[0], { creator, creatorFee: 5000000 })),
    };
    f = fakeRpc({ accounts: rehearsalAccounts, failSend: true,
      simulate: (params) => ({ value: { err: null, unitsConsumed: 51519, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success'], accounts: [{ lamports: 5000000000 + 4990000 }] } }) });
    r = await CL.rehearse({ rpc: f.rpc, mint: curveCoin.mint });
    const opts = f.calls.find((c) => c.method === 'simulateTransaction').params[1];
    check('it simulates unsigned, with the blockhash replaced, watching the creator', [opts.sigVerify, opts.replaceRecentBlockhash, opts.accounts.addresses], [false, true, [creator]]);
    check('and reports what the creator would gain', [r.creator, r.sources, r.waitingCurve, r.balanceChange, r.unitsConsumed], [creator, ['curve'], 5000000n, 4990000n, 51519]);
    check('nothing was sent', f.calls.filter((c) => c.method === 'sendTransaction').length, 0);
    await rejects('a rehearsal needs a mint', CL.rehearse({ rpc: f.rpc, mint: 'not-a-mint' }), /needs a coin mint/);
  }

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
