#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const kit = require('@solana/kit');
const token = require('@solana-program/token');
const transfer = require('../scripts/solana-test-transfer');
const { MAINNET_RPC, MAINNET_GENESIS, USDC_MINT, TOKEN_PROGRAM } = require('../scripts/solana-test-payment');
const { createTransferReadOnlyRpc, deriveUsdcAta, buildUnsignedUsdcTransferMessage, serializeUnsignedUsdcIntent, prepareUnsignedUsdcTransfer } = transfer;
// Throwaway generated public keys; neither is an operator or human wallet.
const WALLET = 'QZSm2BCwLTLGYBNqo2Ab97YiRBhn3H2YN5UXmy8DZnX';
const RECIPIENT = '8QhvXzdq1KsQewMtN3QeuHKkNPuRjHhfLV5Ex3jnWNEb';
const REFERENCE = 'SysvarC1ock11111111111111111111111111111111';
const AUXILIARY = 'SysvarRent111111111111111111111111111111111';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const now = Date.parse('2026-10-07T12:00:00.000Z');
const quote = { schema: 1, supplier: 'nadanada', processor: 'mixpay', network: 'solana-mainnet', mint: USDC_MINT, decimals: 6,
  orderId: 'test-au-001', processorOrderId: 'mixpay-test-001', processorPayeeId: 'merchant-fixture', amountBaseUnits: '1990000',
  recipientOwner: RECIPIENT, recipientTokenAccount: null, merchantCheckoutUrl: 'https://nadanada.me/payment/test-au-001',
  receivedAt: new Date(now - 10000).toISOString(), expiresAt: new Date(now + 300000).toISOString(), references: [REFERENCE] };
const price = { usdPerSol: '117.71', receivedAt: new Date(now - 1000).toISOString() };
let sourceAta, destinationAta;
function account(owner, amount = '2200000', extra = {}) {
  return { lamports: 1488440, space: 165, owner: TOKEN_PROGRAM, executable: false,
    data: { program: 'spl-token', parsed: { type: 'account', info: { owner, mint: USDC_MINT, isNative: false, state: 'initialized',
      tokenAmount: { amount, decimals: 6 }, ...extra } } } };
}
function fixture({ genesis = MAINNET_GENESIS, sol = 3000000, source = account(WALLET), destination = account(RECIPIENT, '0'),
  accounts = null, finalAccounts = null, payerOwner = '11111111111111111111111111111111', mintDecimals = 6, fee = 5000,
  rent = 1488440, reserve = 650240, height = 900, lastHeight = 1000, blockhash = BLOCKHASH, staleFee = false,
  earlierSol = sol, finalSol = sol, finalPayerOwner = payerOwner } = {}) {
  const calls = []; let slot = 100, inventoryReads = 0, payerReads = 0;
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return genesis;
    const response = value => ({ context: { slot: ++slot }, value });
    if (method === 'getAccountInfo' && params[0] === USDC_MINT) return response({ owner: TOKEN_PROGRAM, executable: false,
      data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: mintDecimals, isInitialized: true } } } });
    if (method === 'getBalance') return response(sol);
    if (method === 'getTokenAccountsByOwner') {
      inventoryReads++;
      return response(inventoryReads > 1 && finalAccounts !== null ? finalAccounts : accounts || (source ? [{ pubkey: sourceAta, account: source }] : []));
    }
    if (method === 'getAccountInfo' && params[0] === WALLET) {
      payerReads++;
      const amount = payerReads > 1 ? finalSol : earlierSol;
      return response(amount > 0 ? { owner: payerReads > 1 ? finalPayerOwner : payerOwner, executable: false,
        lamports: amount, space: 0, data: ['', 'base64'] } : null);
    }
    if (method === 'getAccountInfo' && params[0] === sourceAta) return response(source);
    if (method === 'getAccountInfo' && params[0] === destinationAta) return response(destination);
    if (method === 'getAccountInfo' && params[0] === AUXILIARY) return response(destination);
    if (method === 'getLatestBlockhash') return response({ blockhash, lastValidBlockHeight: lastHeight });
    if (method === 'getFeeForMessage') {
      const decoded = kit.getCompiledTransactionMessageDecoder().decode(Buffer.from(params[0], 'base64'));
      assert.equal(decoded.lifetimeToken, BLOCKHASH); assert.equal(decoded.header.numSignerAccounts, 1);
      return staleFee ? { context: { slot: 1 }, value: fee } : response(fee);
    }
    if (method === 'getMinimumBalanceForRentExemption') return params[0] === 165 ? rent : reserve;
    if (method === 'getBlockHeight') return height;
    throw new Error('Fixture rejects non-reviewed read method: ' + method);
  };
  return { rpc, calls };
}
function decodeArtifact(artifact) {
  const wire = Buffer.from(artifact.unsignedTransactionBase64, 'base64');
  const transaction = kit.getTransactionDecoder().decode(wire);
  const compiled = kit.getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = kit.decompileTransactionMessage(compiled);
  return { wire, transaction, compiled, message };
}
function pureIntent(changed = {}) {
  return { purpose: 'merchant-test', walletAddress: WALLET, sourceTokenAccount: sourceAta, recipientOwner: RECIPIENT,
    destinationTokenAccount: destinationAta, amountBaseUnits: quote.amountBaseUnits, createSourceAta: false, createDestinationAta: true,
    references: quote.references, blockhash: BLOCKHASH, lastValidBlockHeight: '1000', orderBinding: {
      supplier: quote.supplier, processor: quote.processor, orderId: quote.orderId, processorOrderId: quote.processorOrderId,
      processorPayeeId: quote.processorPayeeId, merchantCheckoutUrl: quote.merchantCheckoutUrl, expiresAt: quote.expiresAt }, ...changed };
}
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('ok ' + name); }
(async () => {
  sourceAta = await deriveUsdcAta(WALLET); destinationAta = await deriveUsdcAta(RECIPIENT);
  await check('native USDC ATA derivation uses the standard token program', () => {
    assert.equal(sourceAta, 'B5p8pxFDUrmq6S8MAuwgVw4TVZepUZFF2shbG8sMPERP');
    assert.notEqual(sourceAta, destinationAta);
  });
  await check('actual serialized message contains only idempotent ATA and six-decimal TransferChecked', async () => {
    const artifact = await buildUnsignedUsdcTransferMessage(pureIntent());
    const { transaction, compiled, message } = decodeArtifact(artifact);
    assert.equal(compiled.version, 0); assert.equal(compiled.header.numSignerAccounts, 1); assert.equal(compiled.staticAccounts[0], WALLET);
    assert.deepEqual(Object.keys(transaction.signatures), [WALLET]); assert.equal(transaction.signatures[WALLET], null);
    assert.deepEqual(Buffer.from(transaction.messageBytes), Buffer.from(artifact.messageBase64, 'base64'));
    assert.equal(message.instructions.length, 2);
    const creation = token.parseCreateAssociatedTokenIdempotentInstruction(message.instructions[0]);
    assert.equal(creation.programAddress, token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS); assert.equal(creation.data.discriminator, 1);
    assert.equal(creation.accounts.payer.address, WALLET); assert.equal(creation.accounts.ata.address, destinationAta);
    assert.equal(creation.accounts.owner.address, RECIPIENT); assert.equal(creation.accounts.mint.address, USDC_MINT);
    assert.equal(creation.accounts.tokenProgram.address, TOKEN_PROGRAM); assert.equal(creation.accounts.payer.role, kit.AccountRole.WRITABLE_SIGNER);
    const payment = token.parseTransferCheckedInstruction(message.instructions[1]);
    assert.equal(payment.programAddress, TOKEN_PROGRAM); assert.equal(payment.data.discriminator, 12);
    assert.equal(payment.data.amount, 1990000n); assert.equal(payment.data.decimals, 6);
    assert.equal(payment.accounts.source.address, sourceAta); assert.equal(payment.accounts.destination.address, destinationAta);
    assert.equal(payment.accounts.mint.address, USDC_MINT); assert.equal(payment.accounts.authority.address, WALLET);
    const reference = message.instructions[1].accounts[4]; assert.equal(reference.address, REFERENCE); assert.equal(reference.role, kit.AccountRole.READONLY);
    assert.equal(artifact.messageHash, crypto.createHash('sha256').update(transaction.messageBytes).digest('hex'));
    assert.equal(artifact.intentHash, crypto.createHash('sha256').update(JSON.stringify(artifact.intent)).digest('hex'));
    assert.ok(Object.isFrozen(artifact.intent)); assert.ok(Object.isFrozen(artifact.intent.references));
    assert.equal(artifact.signed, false); assert.equal(artifact.paymentReady, false); assert.equal(artifact.sendAvailable, false);
  });
  await check('exact amount, destination, order and lifetime changes alter the review binding', async () => {
    const baseline = await buildUnsignedUsdcTransferMessage(pureIntent());
    for (const changed of [{ amountBaseUnits: '1989999' }, { lastValidBlockHeight: '1001' },
      { orderBinding: { ...pureIntent().orderBinding, orderId: 'test-au-002' } }, { references: [] }]) {
      const revised = await buildUnsignedUsdcTransferMessage(pureIntent(changed)); assert.notEqual(revised.intentHash, baseline.intentHash);
    }
  });
  await check('canonical intent reserialization binds metadata to the precise unsigned message', async () => {
    const artifact = await buildUnsignedUsdcTransferMessage(pureIntent());
    const restored = await serializeUnsignedUsdcIntent(JSON.parse(JSON.stringify(artifact.intent)));
    assert.equal(restored.messageBase64, artifact.messageBase64); assert.equal(restored.unsignedTransactionBase64, artifact.unsignedTransactionBase64);
    assert.equal(restored.messageHash, artifact.messageHash); assert.equal(restored.intentHash, artifact.intentHash);
    for (const changed of [{ mint: TOKEN_PROGRAM }, { decimals: 18 }, { tokenProgram: USDC_MINT }, { network: 'solana-devnet' },
      { privateKey: 'not-a-field' }]) await assert.rejects(serializeUnsignedUsdcIntent({ ...artifact.intent, ...changed }));
  });
  await check('serializer refuses noncanonical amounts, defaults, wrong ATA targets and extra secret fields', async () => {
    for (const changed of [{ amountBaseUnits: 1990000 }, { amountBaseUnits: '01990000' }, { amountBaseUnits: '2500001' },
      { amountBaseUnits: '0' }, { createSourceAta: true, sourceTokenAccount: AUXILIARY },
      { createDestinationAta: true, destinationTokenAccount: AUXILIARY }, { blockhash: '11111111111111111111111111111111' },
      { references: [WALLET] }, { references: [REFERENCE, REFERENCE] }, { privateKey: 'do-not-use' }]) await assert.rejects(buildUnsignedUsdcTransferMessage(pureIntent(changed)));
    const absent = pureIntent(); delete absent.amountBaseUnits; await assert.rejects(buildUnsignedUsdcTransferMessage(absent));
  });
  await check('recovery serializer needs an explicit different owner and excludes merchant metadata', async () => {
    const artifact = await buildUnsignedUsdcTransferMessage(pureIntent({ purpose: 'recovery', amountBaseUnits: '4000000', references: [], orderBinding: null }));
    assert.equal(artifact.intent.purpose, 'recovery'); assert.equal(artifact.merchantAuthenticated, false);
    await assert.rejects(buildUnsignedUsdcTransferMessage(pureIntent({ purpose: 'recovery' })), /Recovery/);
    await assert.rejects(buildUnsignedUsdcTransferMessage(pureIntent({ recipientOwner: WALLET })), /different/);
    await assert.rejects(buildUnsignedUsdcTransferMessage(pureIntent({ walletAddress: sourceAta })), /signing wallet/);
  });
  await check('planner quotes the actual serialized message and a bounded rent reserve', async () => {
    const f = fixture(); const result = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: f.rpc, now, solUsdQuote: price });
    assert.equal(result.gas.feeLamports, '5000'); assert.equal(result.gas.ataRentEachLamports, '1488440');
    assert.equal(result.gas.ataRentLamports, '1488440'); assert.equal(result.gas.ataRentExpectedLamports, '0');
    assert.equal(result.gas.feePayerReserveLamports, '650240'); assert.equal(result.gas.requiredSolLamports, '2143680');
    assert.equal(result.gas.priorityFeeLamports, '0'); assert.equal(result.fundingReady, true);
    assert.ok(result.gas.confirmedSlot < result.wallet.confirmedSlot);
    assert.equal(f.calls.find(call => call.method === 'getFeeForMessage').params[0], result.messageBase64);
    assert.equal(result.funding.additionalSolLamports, '0'); assert.equal(result.paymentReady, false);
    assert.equal(result.merchantAuthenticated, false); assert.ok(result.blockers.includes('merchant-route-unverified'));
    assert.ok(f.calls.every(call => !/sign|send|simulate/i.test(call.method)));
  });
  await check('absent source and destination serialize idempotent creations and remain unfunded', async () => {
    const result = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, solUsdQuote: price,
      rpc: fixture({ sol: 0, source: null, destination: null }).rpc });
    const decoded = decodeArtifact(result); assert.equal(decoded.message.instructions.length, 3);
    assert.equal(token.parseCreateAssociatedTokenIdempotentInstruction(decoded.message.instructions[0]).accounts.ata.address, sourceAta);
    assert.equal(result.gas.ataRentExpectedLamports, '2976880'); assert.equal(result.gas.ataRentLamports, '2976880');
    assert.equal(result.gas.requiredSolLamports, '3632120'); assert.equal(result.funding.additionalUsdcBaseUnits, '1990000');
    assert.equal(result.fundingReady, false); assert.ok(result.blockers.includes('fee-payer-missing'));
    assert.ok(result.blockers.includes('insufficient-available-usdc'));
  });
  await check('existing auxiliary destination is verified and never fabricated', async () => {
    const result = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote: { ...quote, recipientTokenAccount: AUXILIARY },
      now, solUsdQuote: price, rpc: fixture().rpc });
    assert.equal(result.intent.destinationTokenAccount, AUXILIARY); assert.equal(result.intent.createDestinationAta, false);
    assert.equal(result.gas.ataRentLamports, '0'); assert.equal(decodeArtifact(result).message.instructions.length, 1);
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote: { ...quote, recipientTokenAccount: AUXILIARY },
      now, rpc: fixture({ destination: null }).rpc }), /cannot be fabricated/);
  });
  await check('native mint, wrong owners, frozen/delegated accounts and non-system payer fail before payment', async () => {
    for (const changed of [{ genesis: 'devnet' }, { mintDecimals: 18 }, { payerOwner: TOKEN_PROGRAM },
      { source: account(RECIPIENT) }, { source: account(WALLET, '2200000', { state: 'frozen' }) },
      { source: account(WALLET, '2200000', { delegate: RECIPIENT }) }, { destination: account(WALLET) },
      { destination: account(RECIPIENT, '0', { state: 'frozen' }) }]) {
      await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: fixture(changed).rpc, now }));
    }
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, sourceTokenAccount: AUXILIARY, rpc: fixture().rpc, now }), /eligible/);
  });
  await check('null fees, stale slots, zero rent, expired lifetime and unsafe RPC integers fail closed', async () => {
    for (const changed of [{ fee: null }, { fee: 0 }, { fee: Number.MAX_SAFE_INTEGER + 1 }, { staleFee: true },
      { rent: 0 }, { reserve: -1 }, { height: 1000 }, { lastHeight: 900 }]) {
      await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, rpc: fixture(changed).rpc }));
    }
  });
  await check('quote and price must remain fresh through the read-only review', async () => {
    let clock = now;
    const f = fixture(); const advancingRpc = async (...args) => { const result = await f.rpc(...args); if (args[0] === 'getBlockHeight') clock += 301000; return result; };
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: advancingRpc, now: () => clock }), /expired|stale/);
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: fixture().rpc, now,
      solUsdQuote: { ...price, receivedAt: new Date(now - 60001).toISOString() } }), /stale/);
  });
  await check('insufficient SOL and unquoted USD are explicit funding blockers', async () => {
    const result = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: fixture({ sol: 10000 }).rpc, now });
    assert.equal(result.fundingReady, false); assert.equal(result.funding.additionalSolLamports, '2133680');
    assert.ok(result.blockers.includes('insufficient-sol-for-fee-rent-and-reserve')); assert.ok(result.blockers.includes('sol-usd-unquoted'));
    assert.equal(result.gas.usdMicros, null);
  });
  await check('USD wallet and minimum funding caps include valued SOL and quoted possible rent', async () => {
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: fixture({ sol: 1000000000 }).rpc, now, solUsdQuote: price }), /\$4/);
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, rpc: fixture({ fee: 1000000000 }).rpc, now, solUsdQuote: price }), /\$4/);
  });
  await check('late source deposits cannot bypass the dedicated USDC wallet cap', async () => {
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, solUsdQuote: price,
      rpc: fixture({ accounts: [{ pubkey: sourceAta, account: account(WALLET, '2200000') }], source: account(WALLET, '5000000') }).rpc }), /\$4.*cap/);
  });
  await check('final monotonic inventory detects late deposits into other token accounts', async () => {
    const f = fixture({ finalAccounts: [{ pubkey: sourceAta, account: account(WALLET, '2200000') },
      { pubkey: AUXILIARY, account: account(WALLET, '1900000') }] });
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, rpc: f.rpc, solUsdQuote: price }), /Final.*\$4/);
    const inventories = f.calls.filter(call => call.method === 'getTokenAccountsByOwner');
    assert.equal(inventories.length, 2); assert.ok(inventories[1].params[2].minContextSlot > inventories[0].params[2].minContextSlot);
  });
  await check('report contains final inventory and conservative maximum observed balance', async () => {
    const result = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, solUsdQuote: price,
      rpc: fixture({ accounts: [{ pubkey: sourceAta, account: account(WALLET, '2200000') }], source: account(WALLET, '3000000'),
        finalAccounts: [{ pubkey: sourceAta, account: account(WALLET, '2500000') }] }).rpc });
    assert.equal(result.wallet.usdc.totalBaseUnits, '2500000'); assert.equal(result.wallet.usdc.amount, '2.500000');
    assert.equal(result.wallet.usdc.capObservedBaseUnits, '3000000'); assert.equal(result.fundingReady, true);
    const drained = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, solUsdQuote: price,
      rpc: fixture({ finalAccounts: [] }).rpc });
    assert.equal(drained.wallet.usdc.totalBaseUnits, '0'); assert.equal(drained.fundingReady, false);
    assert.ok(drained.blockers.includes('insufficient-available-usdc'));
  });
  await check('blockhash expiry is rechecked after a slow final wallet inventory read', async () => {
    const f = fixture(); let inventoryReads = 0, height = 900;
    const rpc = async (method, params) => {
      if (method === 'getTokenAccountsByOwner' && ++inventoryReads === 2) height = 1000;
      if (method === 'getBlockHeight') {
        const inventory = f.calls.filter(call => call.method === 'getTokenAccountsByOwner');
        assert.equal(inventory.length, 2); assert.ok(params[0].minContextSlot > inventory[0].params[2].minContextSlot);
        return height;
      }
      return f.rpc(method, params);
    };
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, rpc, solUsdQuote: price }), /blockhash expired/);
  });
  await check('late SOL deposits are reread after final token inventory and cannot weaken the USD cap', async () => {
    const late = fixture({ finalSol: 1000000000 });
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now, rpc: late.rpc, solUsdQuote: price }), /\$4 wallet funding cap/);
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ earlierSol: 1000000000, finalSol: 3000000 }).rpc, solUsdQuote: price }), /\$4 wallet funding cap/);
    const inventories = late.calls.filter(call => call.method === 'getTokenAccountsByOwner');
    const payerReads = late.calls.filter(call => call.method === 'getAccountInfo' && call.params[0] === WALLET);
    assert.equal(payerReads.length, 2);
    assert.ok(payerReads[1].params[1].minContextSlot > inventories[1].params[2].minContextSlot);
    assert.ok(late.calls.findIndex(call => call === payerReads[1]) > late.calls.findIndex(call => call === inventories[1]));
    assert.ok(late.calls.findIndex(call => call.method === 'getBlockHeight') > late.calls.findIndex(call => call === payerReads[1]));
    const allowed = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ finalSol: 4000000 }).rpc, solUsdQuote: price });
    assert.equal(allowed.wallet.sol.lamports, '4000000'); assert.equal(allowed.wallet.sol.amount, '0.004000000');
    assert.equal(allowed.wallet.sol.capObservedLamports, '4000000'); assert.equal(allowed.gas.availableSolLamports, '3000000');
    assert.equal(allowed.wallet.sol.confirmedSlot, allowed.wallet.confirmedSlot);
    assert.ok(allowed.wallet.sol.confirmedSlot > allowed.wallet.usdc.confirmedSlot); assert.equal(allowed.fundingReady, true);
  });
  await check('late SOL drains use the minimum observed funds and validate the final fee payer state', async () => {
    const drained = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ finalSol: 10000 }).rpc, solUsdQuote: price });
    assert.equal(drained.wallet.sol.lamports, '10000'); assert.equal(drained.wallet.sol.amount, '0.000010000');
    assert.equal(drained.wallet.sol.capObservedLamports, '3000000'); assert.equal(drained.gas.availableSolLamports, '10000');
    assert.equal(drained.funding.additionalSolLamports, '2133680'); assert.equal(drained.fundingReady, false);
    assert.ok(drained.blockers.includes('insufficient-sol-for-fee-rent-and-reserve')); assert.equal(drained.sendAvailable, false);
    const restored = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ earlierSol: 10000, finalSol: 3000000 }).rpc, solUsdQuote: price });
    assert.equal(restored.wallet.sol.lamports, '3000000'); assert.equal(restored.gas.availableSolLamports, '10000');
    assert.equal(restored.fundingReady, false);
    const emptied = await prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ finalSol: 0 }).rpc, solUsdQuote: price });
    assert.equal(emptied.wallet.sol.lamports, '0'); assert.equal(emptied.fundingReady, false);
    assert.ok(emptied.blockers.includes('fee-payer-missing'));
    await assert.rejects(prepareUnsignedUsdcTransfer({ walletAddress: WALLET, quote, now,
      rpc: fixture({ finalPayerOwner: TOKEN_PROGRAM }).rpc, solUsdQuote: price }), /plain system wallet/);
  });
  await check('RPC transport pins official HTTPS and cannot simulate, sign or send', async () => {
    let reads = 0;
    const rpc = createTransferReadOnlyRpc({ fetchImpl: async (url, options) => {
      reads++; assert.equal(url, MAINNET_RPC); assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: MAINNET_GENESIS }) };
    } });
    await rpc('getGenesisHash');
    for (const method of ['sendTransaction', 'simulateTransaction', 'requestAirdrop']) await assert.rejects(rpc(method), /read-only/);
    assert.equal(reads, 1);
    assert.ok(Object.keys(transfer).every(key => !/sign|broadcast|send/i.test(key.replace('Unsigned', ''))));
  });
  console.log('Solana unsigned transfer: ' + checks + ' checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
