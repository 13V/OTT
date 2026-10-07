#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const payment = require('../scripts/solana-test-payment');
const { MAINNET_RPC, MAINNET_GENESIS, USDC_MINT, TOKEN_PROGRAM, MIXPAY_USDC_ASSET,
  address, decimalUnits, createReadOnlyRpc, readWalletPreflight, validateMerchantQuote, prepareTransferPlan } = payment;
// Public fixture keys. No private wallet or network is used by this suite.
const WALLET = '11111111111111111111111111111111';
const RECIPIENT = USDC_MINT;
const SOURCE = TOKEN_PROGRAM;
const DESTINATION = 'SysvarRent111111111111111111111111111111111';
const SECOND_SOURCE = 'SysvarC1ock11111111111111111111111111111111';
const now = Date.parse('2026-10-07T12:00:00.000Z');
const quote = { schema: 1, supplier: 'nadanada', processor: 'mixpay', network: 'solana-mainnet', mint: USDC_MINT, decimals: 6,
  orderId: 'test-au-001', processorOrderId: 'mixpay-test-001', processorPayeeId: 'merchant-fixture', amountBaseUnits: '1990000',
  recipientOwner: RECIPIENT, recipientTokenAccount: DESTINATION, merchantCheckoutUrl: 'https://nadanada.me/payment/test-au-001',
  receivedAt: new Date(now - 10000).toISOString(), expiresAt: new Date(now + 300000).toISOString(), references: [] };
const price = { usdPerSol: '150.123456', receivedAt: new Date(now - 1000).toISOString() };
function account(owner = WALLET, amount = '2200000', extra = {}) {
  return { owner: TOKEN_PROGRAM, executable: false, data: { program: 'spl-token', parsed: { type: 'account', info: {
    owner, mint: USDC_MINT, isNative: false, state: 'initialized', tokenAmount: { amount, decimals: 6 }, ...extra } } } };
}
function fixture({ genesis = MAINNET_GENESIS, sol = 10000, accounts = [{ pubkey: SOURCE, account: account() }],
  destination = account(RECIPIENT, '0'), mintDecimals = 6, tokenSlot = 102 } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return genesis;
    if (method === 'getBalance') return { context: { slot: 101 }, value: sol };
    if (method === 'getTokenAccountsByOwner') return { context: { slot: tokenSlot }, value: accounts };
    if (method === 'getAccountInfo' && params[0] === USDC_MINT) return { context: { slot: 100 }, value: {
      owner: TOKEN_PROGRAM, executable: false, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: mintDecimals, isInitialized: true } } } } };
    if (method === 'getAccountInfo' && params[0] === DESTINATION) return { context: { slot: 103 }, value: destination };
    throw new Error('Fixture rejects unreviewed RPC method');
  };
  return { rpc, calls };
}
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('ok ' + name); }
(async () => {
  await check('public keys must decode to 32 bytes', () => {
    assert.equal(address(WALLET), WALLET);
    for (const bad of ['1'.repeat(33), '1'.repeat(31), '0'.repeat(32), 'z'.repeat(44), 'secret']) assert.throws(() => address(bad));
  });
  await check('decimal amounts use exact integer units without floating point', () => {
    assert.equal(decimalUnits('1.99'), 1990000n); assert.equal(decimalUnits('0.000001'), 1n);
    for (const bad of [1.99, '1e-6', '1.0000001', '-1', '01', '0.0.1']) assert.throws(() => decimalUnits(bad));
  });
  await check('read-only RPC pins HTTPS official endpoint and rejects writes before fetch', async () => {
    let calls = 0;
    const rpc = createReadOnlyRpc({ fetchImpl: async (url, options) => {
      calls++; assert.equal(url, MAINNET_RPC); assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body); assert.equal(request.method, 'getGenesisHash');
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: MAINNET_GENESIS }) };
    } });
    assert.equal(await rpc('getGenesisHash'), MAINNET_GENESIS);
    for (const method of ['sendTransaction', 'requestAirdrop', 'simulateTransaction']) await assert.rejects(rpc(method), /read-only/);
    assert.equal(calls, 1);
  });
  await check('RPC failures redact upstream details', async () => {
    const rpc = createReadOnlyRpc({ fetchImpl: async () => { throw new Error('secret raw response'); } });
    await assert.rejects(rpc('getGenesisHash'), error => !error.message.includes('secret') && error.message.includes('no payment'));
    const badId = createReadOnlyRpc({ fetchImpl: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 999, result: MAINNET_GENESIS }) }) });
    await assert.rejects(badId('getGenesisHash'));
  });
  await check('mainnet and mint verification precede wallet reads', async () => {
    const wrong = fixture({ genesis: 'devnet' });
    await assert.rejects(readWalletPreflight({ walletAddress: WALLET, rpc: wrong.rpc, now }), /mainnet/);
    assert.equal(wrong.calls.length, 1);
    const decimals = fixture({ mintDecimals: 18 });
    await assert.rejects(readWalletPreflight({ walletAddress: WALLET, rpc: decimals.rpc, now }), /mint verification/);
    assert.equal(decimals.calls.length, 2);
  });
  await check('preflight reads only confirmed balances with monotonic context slots', async () => {
    const f = fixture(); const result = await readWalletPreflight({ walletAddress: WALLET, rpc: f.rpc, now });
    assert.equal(result.usdc.totalBaseUnits, '2200000'); assert.equal(result.sol.lamports, '10000');
    assert.equal(result.paymentReady, false); assert.equal(result.sendAvailable, false);
    assert.equal(f.calls[2].params[1].commitment, 'confirmed'); assert.equal(f.calls[3].params[2].minContextSlot, 101);
    await assert.rejects(readWalletPreflight({ walletAddress: WALLET, rpc: fixture({ tokenSlot: 100 }).rpc, now }), /stale/);
  });
  await check('malformed and foreign token account balances fail closed', async () => {
    const badAccounts = [account(RECIPIENT), { ...account(), owner: RECIPIENT }, account(WALLET, '2.2'),
      account(WALLET, '18446744073709551616'), account(WALLET, '1', { tokenAmount: { amount: '1', decimals: 18 } }),
      account(WALLET, '1', { mint: TOKEN_PROGRAM }), { ...account(), executable: true }];
    for (const bad of badAccounts) await assert.rejects(readWalletPreflight({ walletAddress: WALLET,
      rpc: fixture({ accounts: [{ pubkey: SOURCE, account: bad }] }).rpc, now }));
    await assert.rejects(readWalletPreflight({ walletAddress: WALLET, rpc: fixture({ sol: Number.MAX_SAFE_INTEGER + 1 }).rpc, now }));
  });
  await check('frozen and delegated USDC count toward wallet cap but are unavailable', async () => {
    const result = await readWalletPreflight({ walletAddress: WALLET, now, rpc: fixture({ accounts: [
      { pubkey: SOURCE, account: account(WALLET, '2200000', { state: 'frozen' }) },
      { pubkey: SECOND_SOURCE, account: account(WALLET, '2200000', { delegate: RECIPIENT }) }] }).rpc });
    assert.equal(result.usdc.totalBaseUnits, '4400000'); assert.equal(result.usdc.availableBaseUnits, '0');
    assert.ok(result.blockers.includes('wallet-usdc-over-cap'));
  });
  await check('duplicate accounts cannot inflate balances', async () => {
    await assert.rejects(readWalletPreflight({ walletAddress: WALLET, now, rpc: fixture({ accounts: [
      { pubkey: SOURCE, account: account() }, { pubkey: SOURCE, account: account() }] }).rpc }), /duplicate/);
  });
  await check('quote validation never authenticates merchant-supplied claims', () => {
    const result = validateMerchantQuote({ ...quote, processorAssetId: MIXPAY_USDC_ASSET }, { now });
    assert.equal(result.merchantAuthenticated, false); assert.equal(result.provenance, 'user-supplied-unverified');
    assert.throws(() => validateMerchantQuote({ ...quote, merchantAuthenticated: true }, { now }), /unreviewed/);
  });
  await check('quote rejects wrong chain, mint, processor decimals and invoice cap', () => {
    for (const changed of [{ network: 'solana-devnet' }, { mint: TOKEN_PROGRAM }, { decimals: 18 }, { processor: 'other' },
      { amountBaseUnits: '2500001' }, { amountBaseUnits: '0' }, { amountBaseUnits: 1990000 }, { processorAssetId: TOKEN_PROGRAM }]) {
      assert.throws(() => validateMerchantQuote({ ...quote, ...changed }, { now }));
    }
  });
  await check('quote rejects stale, future, expired or unlimited deadlines', () => {
    for (const changed of [{ receivedAt: new Date(now + 1).toISOString() }, { receivedAt: new Date(now - 300001).toISOString() },
      { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 900001).toISOString() },
      { receivedAt: '2026-02-30T00:00:00Z' }]) assert.throws(() => validateMerchantQuote({ ...quote, ...changed }, { now }));
  });
  await check('merchant URL requires exact HTTPS supplier domain', () => {
    for (const url of ['http://nadanada.me/test', 'https://nadanada.me.evil.test/test', 'https://user:password@nadanada.me/test',
      'https://nadanada.me:444/test', 'https://mixpay.me/test', 'https://nadanada.me/test#bad']) assert.throws(() => validateMerchantQuote({ ...quote, merchantCheckoutUrl: url }, { now }));
  });
  await check('payment references and destination public keys remain explicit and bounded', () => {
    assert.deepEqual(validateMerchantQuote({ ...quote, references: [SOURCE] }, { now }).references, [SOURCE]);
    for (const changed of [{ references: [SOURCE, SOURCE] }, { references: ['bad'] }, { references: null },
      { recipientTokenAccount: 'bad' }, { processorPayeeId: '' }, { processorOrderId: 'a b' }]) assert.throws(() => validateMerchantQuote({ ...quote, ...changed }, { now }));
  });
  await check('funded valid plan checks recipient on chain and keeps send disabled', async () => {
    const f = fixture(); const result = await prepareTransferPlan({ walletAddress: WALLET, quote, rpc: f.rpc, now, solUsdQuote: price });
    assert.equal(result.sourceAccount, SOURCE); assert.equal(result.destinationVerified, true); assert.equal(result.amountUsdc, '1.990000');
    assert.equal(result.walletSolUsdMicros, '1502'); assert.equal(result.transactionBuilt, false);
    assert.equal(result.paymentReady, false); assert.equal(result.sendAvailable, false); assert.equal(result.gas.status, 'unquoted');
    assert.deepEqual(result.blockers, ['merchant-route-unverified', 'transaction-builder-unavailable', 'gas-unquoted']);
    assert.doesNotThrow(() => JSON.stringify(result)); assert.ok(f.calls.every(call => !/send|sign/i.test(call.method)));
  });
  await check('wallet caps include all USDC plus fresh USD valuation of SOL', async () => {
    await assert.rejects(prepareTransferPlan({ walletAddress: WALLET, quote, now, rpc: fixture({ accounts: [{ pubkey: SOURCE,
      account: account(WALLET, '4000001') }] }).rpc }), /\$4/);
    await assert.rejects(prepareTransferPlan({ walletAddress: WALLET, quote, now, solUsdQuote: price,
      rpc: fixture({ sol: 1000000000 }).rpc }), /funding cap/);
    await assert.rejects(prepareTransferPlan({ walletAddress: WALLET, quote, now, solUsdQuote: { ...price,
      receivedAt: new Date(now - 60001).toISOString() }, rpc: fixture().rpc }), /stale/);
  });
  await check('unquoted gas and wallet SOL never imply fully budgeted payment', async () => {
    const result = await prepareTransferPlan({ walletAddress: WALLET, quote, rpc: fixture({ sol: 0 }).rpc, now });
    assert.equal(result.walletSolUsdMicros, null); assert.ok(result.blockers.includes('wallet-sol-usd-unquoted'));
    assert.ok(result.blockers.includes('wallet-needs-sol')); assert.equal(result.gas.lamports, null);
  });
  await check('insufficient or fragmented token balances cannot be transferred as one source', async () => {
    const insufficient = await prepareTransferPlan({ walletAddress: WALLET, quote, now, rpc: fixture({ accounts: [] }).rpc });
    assert.equal(insufficient.sourceAccount, null); assert.ok(insufficient.blockers.includes('insufficient-available-usdc'));
    const fragmented = await prepareTransferPlan({ walletAddress: WALLET, quote, now, rpc: fixture({ accounts: [
      { pubkey: SOURCE, account: account(WALLET, '1100000') }, { pubkey: SECOND_SOURCE, account: account(WALLET, '1100000') }] }).rpc });
    assert.equal(fragmented.sourceAccount, null); assert.ok(fragmented.blockers.includes('usdc-source-fragmented'));
  });
  await check('destination must match exact owner, native mint and transferable account state', async () => {
    for (const destination of [account(WALLET, '0'), account(RECIPIENT, '0', { mint: TOKEN_PROGRAM }),
      account(RECIPIENT, '0', { state: 'frozen' }), account(RECIPIENT, '0', { delegate: WALLET })]) {
      await assert.rejects(prepareTransferPlan({ walletAddress: WALLET, quote, now, rpc: fixture({ destination }).rpc }));
    }
    const missing = await prepareTransferPlan({ walletAddress: WALLET, quote, now, rpc: fixture({ destination: null }).rpc });
    assert.ok(missing.blockers.includes('destination-token-account-missing')); assert.equal(missing.destinationVerified, false);
    const unresolved = await prepareTransferPlan({ walletAddress: WALLET, quote: { ...quote, recipientTokenAccount: null }, now, rpc: fixture().rpc });
    assert.ok(unresolved.blockers.includes('destination-token-account-unresolved'));
  });
  await check('no signing or broadcast API is exported', () => {
    assert.ok(Object.keys(payment).every(key => !/sign|send|broadcast|purchase/i.test(key)));
  });
  console.log('Solana test payment: ' + checks + ' checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
