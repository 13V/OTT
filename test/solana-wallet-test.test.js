'use strict';
const assert = require('node:assert/strict');
const path = require('path');
const { parse, run, privateQuoteFile } = require('../scripts/solana-wallet-test');
const { PRIVATE_BASE } = require('../scripts/operator-test-files');

async function main() {
  assert.equal(parse([]).mode, 'preflight');
  for (const args of [['--send'], ['--sign'], ['--private-key', 'PRIVATE'], ['--create', '--preflight'],
    ['--plan'], ['--quote-file', 'anything.json'], ['--create', '--quote-file', 'anything.json']]) assert.throws(() => parse(args));
  const quotePath = path.join(PRIVATE_BASE, 'solana-quotes', 'review.json');
  assert.equal(privateQuoteFile(quotePath, value => value), quotePath);
  for (const file of [PRIVATE_BASE, path.join(PRIVATE_BASE, 'solana-wallet.json'), path.join(PRIVATE_BASE, 'elsewhere', 'review.json')]) {
    assert.throws(() => privateQuoteFile(file, value => value));
  }
  const address = '11111111111111111111111111111111';
  let unlocked = 0, created = 0, reads = 0;
  const deps = { walletFileExists: () => true, privatePath: value => value,
    wallet: { createWallet: () => { created++; return { address, file: 'PRIVATE-ENCRYPTED-FILE' }; },
      readWalletInfo: () => ({ address }), loadWallet: () => { unlocked++; throw new Error('must not unlock'); } },
    rpc: { sign: () => { throw new Error('must not sign'); }, send: () => { throw new Error('must not send'); } },
    payment: { readWalletPreflight: async input => { reads++; assert.equal(input.walletAddress, address); return { status: 'needs-funding' }; } },
    transfer: { prepareUnsignedUsdcTransfer: async input => { reads++; assert.equal(input.walletAddress, address); return {
      intent: { sourceTokenAccount: 'PUBLIC-SOURCE', destinationTokenAccount: 'PUBLIC-DESTINATION' },
      messageHash: 'PUBLIC-MESSAGE-HASH', intentHash: 'PUBLIC-INTENT-HASH',
      gas: { feeLamports: '5000' }, funding: { additionalSolLamports: '650000' },
      quote: { orderId: 'PRIVATE-ORDER-ACCESS' }, messageBase64: 'PRIVATE-UNSIGNED-BYTES',
      unsignedTransactionBase64: 'PRIVATE-UNSIGNED-WIRE', blockers: ['merchant-route-unverified'],
    }; } },
    readQuoteFile: () => ({ orderId: 'PRIVATE-ORDER-ACCESS', merchantCheckoutUrl: 'PRIVATE-CHECKOUT-LINK',
      amountBaseUnits: '1990000', recipientOwner: address, recipientTokenAccount: null, expiresAt: '2026-10-07T00:05:00Z' }),
  };
  const missing = await run(parse([]), { ...deps, walletFileExists: () => false });
  assert.equal(missing.status, 'wallet-setup-required'); assert.deepEqual([unlocked, created, reads], [0, 0, 0]);
  const fresh = await run(parse(['--create']), deps);
  assert.equal(fresh.address, address); assert.equal(fresh.paymentReady, false); assert.equal(fresh.sendAvailable, false);
  assert.deepEqual([unlocked, created, reads], [0, 1, 0]);
  const checked = await run(parse(['--preflight']), deps);
  assert.equal(checked.keyUnlocked, false); assert.equal(checked.paymentReady, false); assert.equal(checked.sendAvailable, false);
  const planned = await run(parse(['--plan', '--quote-file', quotePath]), deps);
  assert.equal(planned.keyUnlocked, false); assert.equal(planned.paymentReady, false); assert.equal(planned.sendAvailable, false);
  assert.equal(planned.orderFingerprint.length, 12); assert.equal(planned.amountBaseUnits, '1990000');
  assert.equal(planned.unsignedTransactionBuilt, true); assert.equal(planned.signed, false); assert.equal(planned.gas.feeLamports, '5000');
  for (const secret of ['PRIVATE-ORDER-ACCESS', 'PRIVATE-CHECKOUT-LINK', 'PRIVATE-UNSIGNED-BYTES', 'PRIVATE-UNSIGNED-WIRE']) assert.ok(!JSON.stringify(planned).includes(secret));
  assert.deepEqual([unlocked, created, reads], [0, 1, 2]);
  console.log('solana wallet CLI: unsafe modes refused, private quotes contained/redacted, no key unlock/sign/send during preparation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
