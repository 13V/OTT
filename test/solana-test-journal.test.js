#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const kit = require('@solana/kit');
const { PRIVATE_BASE, privatePath, writePrivate } = require('../scripts/operator-test-files');
const { encodeAddress, decodeAddress } = require('../site/api/_lib/solana-auth');
const { buildUnsignedUsdcTransferMessage, deriveUsdcAta, prepareUnsignedUsdcTransfer } = require('../scripts/solana-test-transfer');
const { MAINNET_GENESIS, USDC_MINT, TOKEN_PROGRAM } = require('../scripts/solana-test-payment');
const journal = require('../scripts/solana-test-journal');
const FAILURE = /^Error: Could not use the private Solana test journal\./;
const copy = value => JSON.parse(JSON.stringify(value));
function generatedKey() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return { ...keys, address: encodeAddress(Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url')) };
}
// All fixture addresses/keys are freshly generated. No credential or live-wallet loader.
const source = generatedKey(), merchant = generatedKey(), owner = generatedKey(), other = generatedKey();
const clock = Date.now();
const caps = { maxFeeLamports: '10000', maxRentLamports: '2000000', maxRequiredSolLamports: '3000000' };
let sourceAta, merchantAta, ownerAta, root, checks = 0, sequence = 0;
const base = () => path.join(root, 'case-' + (++sequence));
const options = baseDir => ({ baseDir, now: clock });
const walletDirectory = baseDir => path.join(baseDir, 'wallet-' + crypto.createHash('sha256').update(source.address).digest('hex'));
async function check(name, fn) { await fn(); checks++; console.log('ok ' + name); }
async function prepared(changes = {}, gasChanges = {}) {
  const artifact = await buildUnsignedUsdcTransferMessage({
    purpose: 'merchant-test', walletAddress: source.address, sourceTokenAccount: sourceAta,
    recipientOwner: merchant.address, destinationTokenAccount: merchantAta,
    amountBaseUnits: '1990000', createSourceAta: false, createDestinationAta: true, references: [],
    blockhash: encodeAddress(crypto.randomBytes(32)), lastValidBlockHeight: '1000',
    orderBinding: { supplier: 'nadanada', processor: 'mixpay', orderId: 'fixture-au-001', processorOrderId: 'fixture-mixpay-001',
      processorPayeeId: 'fixture-merchant', merchantCheckoutUrl: 'https://nadanada.me/payment/fixture-au-001',
      expiresAt: new Date(clock + 300000).toISOString() }, ...changes,
  });
  return { ...artifact, gas: { status: 'rpc-quoted', feeLamports: '5000', ataRentEachLamports: '1000000',
    ataRentLamports: '1000000', feePayerReserveLamports: '100000', requiredSolLamports: '1105000',
    checkedAt: new Date(clock).toISOString(), confirmedSlot: 50, priorityFeeLamports: '0', ...gasChanges } };
}
function reservation(review, changes = {}) {
  return { purpose: 'merchant-payment', runId: 'fixture-run-original', ownerReturnAddress: owner.address,
    prepared: review, limits: caps, ...changes };
}
function signedInput(review, preparedId, signer = source, changes = {}) {
  const transaction = kit.getTransactionDecoder().decode(Buffer.from(review.unsignedTransactionBase64, 'base64'));
  const signatureBytes = crypto.sign(null, transaction.messageBytes, signer.privateKey);
  const wire = kit.getTransactionEncoder().encode({ ...transaction, signatures: { [source.address]: signatureBytes } });
  return { preparedId, transactionBase64: Buffer.from(wire).toString('base64'),
    signature: kit.getBase58Decoder().decode(signatureBytes), currentBlockHeight: '900', ...changes };
}
function statusEvidence(signature, value = null) {
  return { method: 'getSignatureStatuses', network: 'solana-mainnet', signature, observedAtISO: new Date(clock).toISOString(),
    response: { context: { slot: 100 }, value: [value] } };
}
async function childReserve(input, opts) {
  const script = `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c);
process.stdin.on('end',async()=>{try{const p=JSON.parse(input);const result=await require(process.argv[1]).reserveIntent(p.input,p.opts);
process.stdout.write(JSON.stringify({runId:result.reservation.runId,id:result.reservation.reservationId}));}
catch{process.stderr.write('fixture reservation refused');process.exitCode=2;}});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, require.resolve('../scripts/solana-test-journal')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ input, opts }));
  });
}
async function rejected(action) { await assert.rejects(action, FAILURE); }
(async () => {
  fs.mkdirSync(PRIVATE_BASE, { recursive: true });
  root = fs.mkdtempSync(path.join(PRIVATE_BASE, 'unit-solana-journal-'));
  sourceAta = await deriveUsdcAta(source.address); merchantAta = await deriveUsdcAta(merchant.address); ownerAta = await deriveUsdcAta(owner.address);
  try {
    await check('default journal is private and exposes no signing, wallet loading, release or send API', () => {
      assert.equal(journal.BASE, path.join(PRIVATE_BASE, 'solana-journal'));
      assert.deepEqual(Object.keys(journal).sort(), ['BASE', 'readJournal', 'reconcile', 'recordPrepared', 'reserveIntent', 'storeSigned']);
      assert.ok(!root.toLowerCase().includes('onedrive')); assert.equal(privatePath(root), fs.realpathSync(root));
    });
    await check('reading a missing reservation is read-only', async () => {
      const dir = base(); assert.equal(await journal.readJournal(source.address, options(dir)), null); assert.equal(fs.existsSync(dir), false);
    });
    await check('case-sensitive public keys cannot share a Windows reservation filename', async () => {
      const dir = base(); await journal.reserveIntent(reservation(await prepared()), options(dir));
      let changed = null;
      for (let index = 0; index < source.address.length; index++) {
        const char = source.address[index], alternate = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
        const candidate = source.address.slice(0, index) + alternate + source.address.slice(index + 1);
        if (candidate !== source.address && decodeAddress(candidate)) { changed = candidate; break; }
      }
      assert.ok(changed); assert.equal(await journal.readJournal(changed, options(dir)), null);
      assert.equal((await journal.readJournal(source.address, options(dir))).reservationActive, true);
    });
    await check('exclusive active record durably contains the original intent, limits and approved return owner', async () => {
      const dir = base(), review = await prepared(), result = await journal.reserveIntent(reservation(review), options(dir));
      assert.equal(result.stage, 'reserved'); assert.equal(result.reservationActive, true);
      assert.equal(result.paymentReady, false); assert.equal(result.sendAvailable, false); assert.equal(result.signed, null);
      assert.equal(result.reservation.runId, 'fixture-run-original'); assert.equal(result.reservation.ownerReturnAddress, owner.address);
      assert.deepEqual(result.reservation.limits, caps); assert.deepEqual(result.prepared[0].artifact.intent, review.intent);
      assert.deepEqual(fs.readdirSync(walletDirectory(dir)), ['active.json']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(walletDirectory(dir), 'active.json'), 'utf8')).initialPrepared.preparedId, result.prepared[0].preparedId);
    });
    await check('actual read-only builder output can be reserved without a hand-built gas adapter', async () => {
      const baseline = await prepared(), calls = []; let slot = 100;
      const tokenAccount = (address, amount) => ({ owner: TOKEN_PROGRAM, executable: false,
        data: { program: 'spl-token', parsed: { type: 'account', info: { owner: address, mint: USDC_MINT,
          isNative: false, state: 'initialized', tokenAmount: { amount, decimals: 6 } } } } });
      const sourceAccount = tokenAccount(source.address, '2200000'), destinationAccount = tokenAccount(merchant.address, '0');
      const response = value => ({ context: { slot: ++slot }, value });
      const rpc = async (method, params = []) => {
        calls.push(method);
        if (method === 'getGenesisHash') return MAINNET_GENESIS;
        if (method === 'getBalance') return response(3000000);
        if (method === 'getTokenAccountsByOwner') return response([{ pubkey: sourceAta, account: sourceAccount }]);
        if (method === 'getAccountInfo') {
          if (params[0] === USDC_MINT) return response({ owner: TOKEN_PROGRAM, executable: false,
            data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } });
          if (params[0] === source.address) return response({ owner: '11111111111111111111111111111111', executable: false,
            lamports: 3000000, space: 0, data: ['', 'base64'] });
          if (params[0] === sourceAta) return response(sourceAccount);
          if (params[0] === merchantAta) return response(destinationAccount);
        }
        if (method === 'getLatestBlockhash') return response({ blockhash: baseline.intent.blockhash, lastValidBlockHeight: 1000 });
        if (method === 'getFeeForMessage') return response(5000);
        if (method === 'getMinimumBalanceForRentExemption') return params[0] === 165 ? 1000000 : 100000;
        if (method === 'getBlockHeight') return 900;
        throw new Error('Unreviewed fixture RPC method');
      };
      const quote = { schema: 1, ...baseline.intent.orderBinding, network: 'solana-mainnet', mint: USDC_MINT, decimals: 6,
        amountBaseUnits: baseline.intent.amountBaseUnits, recipientOwner: merchant.address, recipientTokenAccount: null,
        receivedAt: new Date(clock - 1000).toISOString(), references: [] };
      const review = await prepareUnsignedUsdcTransfer({ walletAddress: source.address, quote, rpc, now: () => clock });
      assert.ok(calls.includes('getFeeForMessage')); assert.ok(calls.includes('getBlockHeight'));
      const result = await journal.reserveIntent(reservation(review), options(base()));
      assert.deepEqual(result.prepared[0].gas, { status: 'rpc-quoted', feeLamports: '5000', ataRentEachLamports: '1000000',
        ataRentLamports: '1000000', feePayerReserveLamports: '100000', requiredSolLamports: '1105000',
        checkedAt: review.gas.checkedAt, confirmedSlot: review.gas.confirmedSlot, priorityFeeLamports: '0', usdMicros: null,
        ataRentExpectedLamports: '0', availableSolLamports: '3000000' });
      assert.deepEqual(result.prepared[0].artifact.intent, review.intent); assert.equal(result.stage, 'reserved');
      assert.equal(result.sendAvailable, false); assert.equal(result.paymentReady, false);
    });
    await check('an alternate run ID resumes the original reservation without refreshing its immutable first record', async () => {
      const dir = base(), review = await prepared(); const first = await journal.reserveIntent(reservation(review), options(dir));
      const bytes = fs.readFileSync(path.join(walletDirectory(dir), 'active.json'));
      const refreshed = await prepared({ orderBinding: { ...review.intent.orderBinding, expiresAt: new Date(clock + 600000).toISOString() } });
      const retry = await journal.reserveIntent(reservation(refreshed, { runId: 'another-run-id' }), options(dir));
      assert.equal(retry.reservation.runId, first.reservation.runId); assert.equal(retry.reservation.reservationId, first.reservation.reservationId);
      assert.deepEqual(fs.readFileSync(path.join(walletDirectory(dir), 'active.json')), bytes); assert.equal(retry.prepared.length, 1);
    });
    await check('new orders, amounts, payees, references and sources cannot bypass a wallet reservation', async () => {
      const dir = base(), review = await prepared(); await journal.reserveIntent(reservation(review), options(dir));
      const variants = [
        { orderBinding: { ...review.intent.orderBinding, orderId: 'another-order' } },
        { orderBinding: { ...review.intent.orderBinding, processorOrderId: 'another-processor-order' } },
        { orderBinding: { ...review.intent.orderBinding, processorPayeeId: 'another-payee' } },
        { amountBaseUnits: '1989999' }, { recipientOwner: other.address, destinationTokenAccount: await deriveUsdcAta(other.address) },
        { references: [other.address] }, { sourceTokenAccount: other.address },
      ];
      for (const change of variants) await rejected(journal.reserveIntent(reservation(await prepared(change), { runId: 'alternate' }), options(dir)));
      assert.equal((await journal.readJournal(source.address, options(dir))).prepared.length, 1);
    });
    await check('limits and independent owner approval cannot change on retry', async () => {
      const dir = base(), review = await prepared(); await journal.reserveIntent(reservation(review), options(dir));
      await rejected(journal.reserveIntent(reservation(review, { limits: { ...caps, maxFeeLamports: '10001' } }), options(dir)));
      await rejected(journal.reserveIntent(reservation(review, { ownerReturnAddress: other.address }), options(dir)));
      await rejected(journal.reserveIntent(reservation(review, { ownerReturnAddress: source.address }), options(base())));
      await rejected(journal.reserveIntent(reservation(review, { limits: { ...caps, maxFeeLamports: '1.0' } }), options(base())));
      await rejected(journal.reserveIntent(reservation(review, { limits: { ...caps, unreviewedAllowance: '1' } }), options(base())));
    });
    await check('prepared metadata must rebuild the exact canonical SDK message', async () => {
      const review = await prepared();
      for (const field of ['messageHash', 'intentHash', 'messageBase64', 'unsignedTransactionBase64']) {
        const altered = copy(review); altered[field] += 'A'; await rejected(journal.reserveIntent(reservation(altered), options(base())));
      }
      for (const change of [{ mint: other.address }, { decimals: 9 }, { network: 'solana-devnet' }, { refundAddress: other.address }]) {
        const altered = copy(review); Object.assign(altered.intent, change); await rejected(journal.reserveIntent(reservation(altered), options(base())));
      }
      const otherMessage = await prepared({ amountBaseUnits: '1989999' });
      await rejected(journal.reserveIntent(reservation({ ...review, messageHash: otherMessage.messageHash, messageBase64: otherMessage.messageBase64,
        unsignedTransactionBase64: otherMessage.unsignedTransactionBase64 }), options(base())));
    });
    await check('quoted fee, ATA rent and payer reserve arithmetic must fit immutable caps', async () => {
      for (const changes of [
        { feeLamports: '10001', requiredSolLamports: '1110001' }, { ataRentEachLamports: '3000000', ataRentLamports: '3000000', requiredSolLamports: '3105000' },
        { ataRentLamports: '0', requiredSolLamports: '105000' }, { requiredSolLamports: '1104999' },
        { priorityFeeLamports: '1' }, { feeLamports: '-1' }, { feeLamports: 5000 }, { ataRentExpectedLamports: '1000001' },
      ]) await rejected(journal.reserveIntent(reservation(await prepared({}, changes)), options(base())));
    });
    await check('new reservations require a live quote and a recent non-future fee review', async () => {
      const review = await prepared();
      await rejected(journal.reserveIntent(reservation(review), { ...options(base()), now: clock + 300000 }));
      await rejected(journal.reserveIntent(reservation(await prepared({}, { checkedAt: new Date(clock - 60001).toISOString() })), options(base())));
      await rejected(journal.reserveIntent(reservation(await prepared({}, { checkedAt: new Date(clock + 1).toISOString() })), options(base())));
    });
    await check('expiry during protected staging prevents reservation or signed-record publication', async () => {
      const review = await prepared(), empty = base(); let calls = 0;
      await rejected(journal.reserveIntent(reservation(review), { baseDir: empty, now: () => ++calls < 3 ? clock : clock + 300000 }));
      assert.equal(await journal.readJournal(source.address, options(empty)), null);
      const dir = base(), first = await journal.reserveIntent(reservation(review), options(dir)); calls = 0;
      const input = signedInput(review, first.prepared[0].preparedId);
      await rejected(journal.storeSigned(source.address, input, { baseDir: dir, now: () => ++calls < 3 ? clock : clock + 300000 }));
      assert.equal((await journal.readJournal(source.address, options(dir))).stage, 'reserved');
      assert.equal(fs.existsSync(path.join(walletDirectory(dir), 'signed.json')), false);
    });
    await check('quote and blockhash refreshes append records while preserving original order identity and bounds', async () => {
      const dir = base(), review = await prepared(), first = await journal.reserveIntent(reservation(review), options(dir));
      const refresh = await prepared({ lastValidBlockHeight: '1100', orderBinding: { ...review.intent.orderBinding, expiresAt: new Date(clock + 600000).toISOString() } },
        { feeLamports: '6000', requiredSolLamports: '1106000' });
      const result = await journal.recordPrepared(source.address, refresh, options(dir));
      assert.equal(result.prepared.length, 2); assert.equal(result.reservation.reservationId, first.reservation.reservationId);
      assert.deepEqual(result.reservation.initialPrepared, first.reservation.initialPrepared);
      assert.equal(result.prepared[1].artifact.intent.orderBinding.orderId, review.intent.orderBinding.orderId);
      assert.equal(result.prepared[1].artifact.intent.lastValidBlockHeight, '1100');
      assert.equal((await journal.recordPrepared(source.address, refresh, options(dir))).prepared.length, 2);
      await rejected(journal.recordPrepared(source.address, await prepared({ amountBaseUnits: '1980000' }), options(dir)));
    });
    await check('expiry never deletes or releases an existing reservation', async () => {
      const dir = base(), review = await prepared(); await journal.reserveIntent(reservation(review), options(dir));
      const later = { ...options(dir), now: clock + 86400000 };
      assert.equal((await journal.readJournal(source.address, later)).reservationActive, true);
      assert.equal((await journal.reserveIntent(reservation(review, { runId: 'late-retry' }), later)).reservation.runId, 'fixture-run-original');
      await rejected(journal.recordPrepared(source.address, review, later));
      await rejected(journal.reserveIntent(reservation(await prepared({ orderBinding: { ...review.intent.orderBinding, orderId: 'late-new-order' } })), later));
    });
    await check('owner recovery binds only the independently approved owner and has no merchant references', async () => {
      const review = await prepared({ purpose: 'recovery', recipientOwner: owner.address, destinationTokenAccount: ownerAta, orderBinding: null });
      const dir = base(), input = reservation(review, { purpose: 'owner-recovery' });
      const result = await journal.reserveIntent(input, options(dir));
      assert.equal(result.reservation.initialPrepared.artifact.intent.recipientOwner, owner.address);
      assert.equal(result.reservation.initialPrepared.artifact.intent.orderBinding, null);
      await rejected(journal.reserveIntent(reservation(await prepared({ purpose: 'recovery', orderBinding: null }), { purpose: 'owner-recovery' }), options(base())));
      await rejected(journal.reserveIntent({ ...input, ownerReturnAddress: merchant.address }, options(base())));
      const altered = copy(review); altered.intent.refundAddress = merchant.address;
      await rejected(journal.reserveIntent(reservation(altered, { purpose: 'owner-recovery' }), options(base())));
      const merchantDir = base(); await journal.reserveIntent(reservation(await prepared()), options(merchantDir));
      await rejected(journal.reserveIntent(input, options(merchantDir)));
    });
    await check('unsigned, forged, wrong-key and noncanonical signed transactions are refused before storage', async () => {
      const dir = base(), review = await prepared(), result = await journal.reserveIntent(reservation(review), options(dir));
      const id = result.prepared[0].preparedId, valid = signedInput(review, id);
      await rejected(journal.storeSigned(source.address, signedInput(review, id, other), options(dir)));
      await rejected(journal.storeSigned(source.address, { ...valid, transactionBase64: review.unsignedTransactionBase64 }, options(dir)));
      await rejected(journal.storeSigned(source.address, { ...valid, signature: signedInput(review, id, other).signature }, options(dir)));
      await rejected(journal.storeSigned(source.address, { ...valid, transactionBase64: Buffer.concat([Buffer.from(valid.transactionBase64, 'base64'), Buffer.from([0])]).toString('base64') }, options(dir)));
      await rejected(journal.storeSigned(source.address, { ...valid, transactionBase64: valid.transactionBase64 + '\n' }, options(dir)));
      assert.equal(fs.existsSync(path.join(walletDirectory(dir), 'signed.json')), false);
    });
    await check('valid proof for another prepared message cannot masquerade as the reserved one', async () => {
      const dir = base(), review = await prepared(), result = await journal.reserveIntent(reservation(review), options(dir));
      const different = await prepared();
      await rejected(journal.storeSigned(source.address, signedInput(different, result.prepared[0].preparedId), options(dir)));
      await rejected(journal.storeSigned(source.address, signedInput(review, 'a'.repeat(64)), options(dir)));
    });
    await check('signed bytes require a recent fee review, live checkout and unexpired blockheight evidence', async () => {
      const dir = base(), review = await prepared(), result = await journal.reserveIntent(reservation(review), options(dir));
      const input = signedInput(review, result.prepared[0].preparedId);
      for (const height of ['1000', '1001', '-1', '01', 900]) await rejected(journal.storeSigned(source.address, { ...input, currentBlockHeight: height }, options(dir)));
      await rejected(journal.storeSigned(source.address, input, { ...options(dir), now: clock + 60001 }));
      await rejected(journal.storeSigned(source.address, input, { ...options(dir), now: clock + 300000 }));
      assert.equal((await journal.readJournal(source.address, options(dir))).stage, 'reserved');
    });
    await check('exact signed wire and deterministic source signature are persisted without sending', async () => {
      const dir = base(), review = await prepared(), result = await journal.reserveIntent(reservation(review), options(dir));
      const input = signedInput(review, result.prepared[0].preparedId), saved = await journal.storeSigned(source.address, input, options(dir));
      assert.equal(saved.stage, 'signed'); assert.equal(saved.signed.transactionBase64, input.transactionBase64); assert.equal(saved.signed.signature, input.signature);
      assert.equal(saved.reservationActive, true); assert.equal(saved.paymentReady, false); assert.equal(saved.sendAvailable, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(walletDirectory(dir), 'signed.json'), 'utf8')), saved.signed);
      const bytes = fs.readFileSync(path.join(walletDirectory(dir), 'signed.json'));
      const retry = await journal.storeSigned(source.address, { ...input, currentBlockHeight: '9999' }, { ...options(dir), now: clock + 86400000 });
      assert.deepEqual(retry.signed, saved.signed); assert.deepEqual(fs.readFileSync(path.join(walletDirectory(dir), 'signed.json')), bytes);
      await rejected(journal.recordPrepared(source.address, await prepared(), options(dir)));
    });
    await check('concurrent signatures for refreshed messages persist one winner and never overwrite it', async () => {
      const dir = base(), a = await prepared(), first = await journal.reserveIntent(reservation(a), options(dir));
      const b = await prepared({ lastValidBlockHeight: '1100' }), updated = await journal.recordPrepared(source.address, b, options(dir));
      const inputA = signedInput(a, first.prepared[0].preparedId), inputB = signedInput(b, updated.prepared[1].preparedId);
      const results = await Promise.allSettled([journal.storeSigned(source.address, inputA, options(dir)), journal.storeSigned(source.address, inputB, options(dir))]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      const winner = await journal.readJournal(source.address, options(dir));
      assert.ok([inputA.signature, inputB.signature].includes(winner.signed.signature));
      assert.equal(fs.readdirSync(walletDirectory(dir)).filter(name => name === 'signed.json').length, 1);
    });
    await check('independent processes with different order/run IDs share one exclusive wallet reservation', async () => {
      const dir = base(), a = await prepared(), b = await prepared({ orderBinding: { ...a.intent.orderBinding, orderId: 'fixture-competing-order' } });
      const results = await Promise.all([childReserve(reservation(a), options(dir)), childReserve(reservation(b, { runId: 'competing-run' }), options(dir))]);
      assert.deepEqual(results.map(result => result.code).sort(), [0, 2]);
      const saved = await journal.readJournal(source.address, options(dir)); assert.equal(saved.reservationActive, true);
      assert.deepEqual(fs.readdirSync(walletDirectory(dir)), ['active.json']);
    });
    await check('independent processes retrying the same order retain the winning original run ID', async () => {
      const dir = base(), review = await prepared();
      const results = await Promise.all([childReserve(reservation(review, { runId: 'run-a' }), options(dir)), childReserve(reservation(review, { runId: 'run-b' }), options(dir))]);
      assert.deepEqual(results.map(result => result.code), [0, 0]);
      assert.equal(JSON.parse(results[0].stdout).runId, JSON.parse(results[1].stdout).runId);
      assert.equal((await journal.readJournal(source.address, options(dir))).reservation.runId, JSON.parse(results[0].stdout).runId);
    });
    await check('pre-publication fsync failure publishes nothing; post-publication failure preserves the reservation', async () => {
      const review = await prepared(), before = base(), after = base(), original = fs.fsyncSync;
      try {
        fs.fsyncSync = () => { throw new Error('fixture fsync failure'); };
        await rejected(journal.reserveIntent(reservation(review), options(before)));
      } finally { fs.fsyncSync = original; }
      assert.equal(await journal.readJournal(source.address, options(before)), null);
      let calls = 0;
      try {
        fs.fsyncSync = fd => { if (++calls === 2) throw new Error('fixture post-publication failure'); return original(fd); };
        await rejected(journal.reserveIntent(reservation(review), options(after)));
      } finally { fs.fsyncSync = original; }
      assert.equal((await journal.readJournal(source.address, options(after))).reservationActive, true);
      assert.deepEqual(fs.readdirSync(walletDirectory(after)), ['active.json']);
    });
    await check('post-publication signed-record failure preserves the original bytes for recovery', async () => {
      const dir = base(), review = await prepared(), first = await journal.reserveIntent(reservation(review), options(dir));
      const input = signedInput(review, first.prepared[0].preparedId), original = fs.fsyncSync; let calls = 0;
      try {
        fs.fsyncSync = fd => { if (++calls === 2) throw new Error('fixture signed flush failure'); return original(fd); };
        await rejected(journal.storeSigned(source.address, input, options(dir)));
      } finally { fs.fsyncSync = original; }
      const retained = await journal.readJournal(source.address, options(dir)); assert.equal(retained.signed.signature, input.signature);
      assert.equal((await journal.storeSigned(source.address, input, options(dir))).signed.transactionBase64, input.transactionBase64);
    });
    await check('orphan signed or prepared evidence refuses replacement when the active reservation is missing', async () => {
      for (const signed of [false, true]) {
        const dir = base(), review = await prepared(), first = await journal.reserveIntent(reservation(review), options(dir));
        if (signed) await journal.storeSigned(source.address, signedInput(review, first.prepared[0].preparedId), options(dir));
        else await journal.recordPrepared(source.address, await prepared(), options(dir));
        const directory = walletDirectory(dir); fs.unlinkSync(path.join(directory, 'active.json'));
        const names = fs.readdirSync(directory), retained = names.map(name => fs.readFileSync(path.join(directory, name)));
        await rejected(journal.readJournal(source.address, options(dir)));
        await rejected(journal.reserveIntent(reservation(review, { runId: 'unsafe-replacement' }), options(dir)));
        assert.equal(fs.existsSync(path.join(directory, 'active.json')), false);
        assert.deepEqual(fs.readdirSync(directory), names);
        names.forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(directory, name)), retained[index]));
      }
    });
    await check('null, pending, failed and finalized RPC observations cannot release or replace a signed reservation', async () => {
      const dir = base(), review = await prepared(), first = await journal.reserveIntent(reservation(review), options(dir));
      const input = signedInput(review, first.prepared[0].preparedId);
      await rejected(journal.reconcile(source.address, statusEvidence(input.signature), options(dir)));
      await journal.storeSigned(source.address, input, options(dir));
      const statuses = [null,
        { slot: 90, confirmations: 1, err: null, confirmationStatus: 'processed' },
        { slot: 90, confirmations: 2, err: { InstructionError: [0, 'InsufficientFunds'] }, confirmationStatus: 'confirmed' },
        { slot: 90, confirmations: null, err: null, confirmationStatus: 'finalized' }];
      for (const value of statuses) {
        const result = await journal.reconcile(source.address, statusEvidence(input.signature, value), options(dir));
        assert.equal(result.reservationActive, true); assert.equal(result.stage, 'signed'); assert.equal(result.signed.signature, input.signature);
        assert.equal(result.paymentReady, false); assert.equal(result.sendAvailable, false);
      }
      assert.equal((await journal.reconcile(source.address, statusEvidence(input.signature), options(dir))).observations.length, 4);
    });
    await check('unknown methods, networks, signatures and malformed status claims fail closed', async () => {
      const dir = base(), review = await prepared(), first = await journal.reserveIntent(reservation(review), options(dir));
      const input = signedInput(review, first.prepared[0].preparedId); await journal.storeSigned(source.address, input, options(dir));
      const good = statusEvidence(input.signature);
      for (const change of [{ method: 'sendTransaction' }, { network: 'solana-devnet' }, { signature: 'bad' },
        { observedAtISO: new Date(clock + 1).toISOString() }, { released: true },
        { response: { context: { slot: 100 }, value: [{ slot: 90, confirmations: 0, err: null, confirmationStatus: 'expired' }] } },
        { response: { context: { slot: 100 }, value: [] } }]) {
        await rejected(journal.reconcile(source.address, { ...good, ...change }, options(dir)));
      }
      assert.equal((await journal.readJournal(source.address, options(dir))).observations.length, 0);
    });
    await check('private paths reject workspace destinations and ancestor links or junctions', async () => {
      await rejected(journal.readJournal(source.address, options(path.join(__dirname, 'unused-journal'))));
      const destination = base(), linked = base(); fs.mkdirSync(destination);
      fs.symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await rejected(journal.readJournal(source.address, options(linked)));
    });
    await check('tampered records, unexpected files and permissive ACLs are refused without leaking their content', async () => {
      const dir = base(), review = await prepared(); await journal.reserveIntent(reservation(review), options(dir));
      const file = path.join(walletDirectory(dir), 'active.json'), original = fs.readFileSync(file, 'utf8');
      const changed = JSON.parse(original); changed.initialPrepared.artifact.intent.amountBaseUnits = '1000000';
      writePrivate(file, JSON.stringify(changed)); await rejected(journal.readJournal(source.address, options(dir)));
      const wrongType = JSON.parse(original); wrongType.runId = 123;
      writePrivate(file, JSON.stringify(wrongType)); await rejected(journal.readJournal(source.address, options(dir)));
      writePrivate(file, original); writePrivate(path.join(walletDirectory(dir), 'unreviewed.json'), '{"secret":"fixture-marker"}');
      await rejected(journal.readJournal(source.address, options(dir))); fs.unlinkSync(path.join(walletDirectory(dir), 'unreviewed.json'));
      if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$item = New-Object System.IO.FileInfo($payload.file)
$acl = $item.GetAccessControl(); $acl.SetAccessRuleProtection($false, $true); $item.SetAccessControl($acl)
`], { input: JSON.stringify({ file }), stdio: 'pipe', windowsHide: true });
      } else fs.chmodSync(file, 0o644);
      await rejected(journal.readJournal(source.address, options(dir)));
    });
    await check('fixture journals contain public transaction evidence only and no generated private key export', () => {
      const forbidden = [source, merchant, owner, other].map(key => key.privateKey.export({ format: 'jwk' }).d);
      function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) inspect(target);
          else { const text = fs.readFileSync(target, 'utf8'); for (const secret of forbidden) assert.ok(!text.includes(secret)); }
        }
      }
      inspect(root);
    });
    console.log(checks + ' Solana private journal checks passed');
  } finally {
    // Only this generated fixture tree is removed, after checking its resolved containment.
    const resolved = fs.realpathSync(root), privateResolved = fs.realpathSync(PRIVATE_BASE);
    assert.equal(privatePath(resolved), resolved);
    const relative = path.relative(privateResolved, resolved);
    assert.ok(relative.startsWith('unit-solana-journal-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true }); assert.equal(fs.existsSync(resolved), false);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
