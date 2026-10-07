#!/usr/bin/env node
'use strict';
// Local wallet preparation only. No CLI path unlocks a signer or broadcasts a payment.
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { PRIVATE_BASE, privatePath } = require('./operator-test-files');

function parse(argv) {
  const opts = { mode: 'preflight' };
  let selected = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') opts.help = true;
    else if (['--create', '--preflight', '--plan'].includes(arg)) {
      if (selected) throw new Error('Choose one wallet preparation mode.');
      selected = true; opts.mode = arg.slice(2);
    } else if (arg === '--quote-file' && !opts.quoteFile && argv[i + 1] && !argv[i + 1].startsWith('--')) opts.quoteFile = argv[++i];
    else throw new Error('Unsupported preparation option. No sign or send mode is available.');
  }
  if ((opts.mode === 'plan') !== Boolean(opts.quoteFile)) throw new Error('Only --plan accepts and requires a private --quote-file.');
  return opts;
}

function dependencies() {
  const wallet = require('./solana-test-wallet-credentials');
  const payment = require('./solana-test-payment');
  return {
    wallet, payment, rpc: payment.createReadOnlyRpc(),
    walletFileExists: () => fs.existsSync(wallet.FILE),
    privatePath,
    readQuoteFile: file => {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 16384) throw new Error('Use a small private merchant quote JSON file.');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
  };
}

function privateQuoteFile(file, guard) {
  const resolved = guard(file);
  const rel = path.relative(path.join(PRIVATE_BASE, 'solana-quotes'), resolved);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Keep quote files in the private solana-quotes directory.');
  return resolved;
}

async function run(opts, deps) {
  if (opts.mode === 'create') {
    const wallet = deps.wallet.createWallet();
    return { mode: 'create', status: 'unfunded-local-wallet-created', address: wallet.address,
      chain: 'solana', file: wallet.file, encrypted: true, paymentReady: false, sendAvailable: false,
      note: 'A new local keypair was encrypted for this Windows user. No account registration, funding, signing or blockchain transaction occurred. Keep the previously exposed wallet unfunded.' };
  }
  if (!deps.walletFileExists()) return { mode: opts.mode, status: 'wallet-setup-required',
    paymentReady: false, sendAvailable: false, nextAction: 'npm run solana:wallet:create',
    note: 'No private key was loaded and no transaction was signed or sent.' };
  const info = deps.wallet.readWalletInfo();
  if (opts.mode === 'preflight') {
    const report = await deps.payment.readWalletPreflight({ walletAddress: info.address, rpc: deps.rpc });
    return { mode: 'preflight', address: info.address, encrypted: true, keyUnlocked: false,
      report, paymentReady: false, sendAvailable: false,
      note: 'Only public wallet and native USDC mint data were read. Supplier settlement is not verified; no signing or sending is available.' };
  }
  const quoteFile = privateQuoteFile(opts.quoteFile, deps.privatePath);
  const quote = deps.readQuoteFile(quoteFile);
  const plan = await deps.payment.prepareTransferPlan({ walletAddress: info.address, quote, rpc: deps.rpc });
  // The full quote can be an order-access credential. Print a fingerprint and public review data.
  return { mode: 'plan', address: info.address, keyUnlocked: false,
    orderFingerprint: crypto.createHash('sha256').update(quote.orderId).digest('hex').slice(0, 12),
    amountBaseUnits: quote.amountBaseUnits, recipientOwner: quote.recipientOwner,
    recipientTokenAccount: quote.recipientTokenAccount, expiresAt: quote.expiresAt,
    blockers: plan.blockers, paymentReady: false, sendAvailable: false,
    note: 'This imported quote is unverified merchant evidence. No transaction was built, signed or sent. Keep the original supplier order and verify its live processor instructions and fulfilment path before enabling payment.' };
}

async function main(argv = process.argv.slice(2), deps) {
  const opts = parse(argv);
  if (opts.help) {
    console.log('Local Solana test wallet preparation (no sign/send mode)\n  --create       create a fresh encrypted, unfunded wallet on Windows\n  --preflight    read its SOL and native USDC balances without unlocking its key\n  --plan --quote-file <private JSON>    inspect an unverified supplier-bound quote\nUse only a dedicated test wallet. Never put a private key in chat, argv, environment variables or OneDrive.');
    return;
  }
  const result = await run(opts, deps || dependencies());
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (require.main === module) main().catch(() => {
  console.error('Solana preparation could not complete. Check local private setup, the official RPC connection and quote requirements. No signing or sending is available.');
  process.exitCode = 1;
});
module.exports = { parse, run, main, privateQuoteFile };
