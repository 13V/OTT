#!/usr/bin/env node
'use strict';
/** Unsigned native-USDC transaction review. Public keys and read-only RPC only.
 * No key loader, signing, simulation, broadcast or merchant authentication.
 * https://solana.com/docs/tokens/basics/transfer-tokens
 * https://solana.com/docs/rpc/http/getfeeformessage
 */
const crypto = require('node:crypto');
const kit = require('@solana/kit');
const token = require('@solana-program/token');
const { MAINNET_RPC, USDC_MINT, TOKEN_PROGRAM, INVOICE_CAP_BASE_UNITS, WALLET_CAP_USD_MICROS,
  address, decimalUnits, readWalletPreflight, validateMerchantQuote } = require('./solana-test-payment');
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const U64_MAX = (1n << 64n) - 1n;
const READ_METHODS = new Set(['getGenesisHash', 'getBalance', 'getTokenAccountsByOwner', 'getAccountInfo',
  'getLatestBlockhash', 'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getBlockHeight']);
const INTENT_FIELDS = ['purpose', 'walletAddress', 'sourceTokenAccount', 'recipientOwner', 'destinationTokenAccount',
  'amountBaseUnits', 'createSourceAta', 'createDestinationAta', 'references', 'blockhash', 'lastValidBlockHeight', 'orderBinding'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function integer(value, label, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX || (positive && value === '0')) throw new Error(label + ' must be an exact base-unit integer string.');
  return BigInt(value);
}
function rpcInteger(value, label, positive = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) throw new Error(label + ' must be an exact safe RPC integer.');
  return BigInt(value);
}
function context(result, minimum = 0) {
  if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < minimum) throw new Error('RPC context is missing or stale.');
  return result.context.slot;
}
function currentTime(value) {
  const result = typeof value === 'function' ? value() : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Review time is invalid.');
  return result;
}
function exactFields(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new Error(label + ' has incomplete or unreviewed fields.');
}
function canonicalOrderBinding(value, purpose) {
  if (purpose === 'recovery') {
    if (value !== null) throw new Error('Recovery has no merchant order binding.');
    return null;
  }
  const fields = ['supplier', 'processor', 'orderId', 'processorOrderId', 'processorPayeeId', 'merchantCheckoutUrl', 'expiresAt'];
  exactFields(value, fields, 'Order binding');
  if (value.supplier !== 'nadanada' || value.processor !== 'mixpay') throw new Error('Order binding supplier or processor does not match.');
  for (const field of ['orderId', 'processorOrderId', 'processorPayeeId']) {
    if (typeof value[field] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value[field])) throw new Error('Order binding identifier is invalid.');
  }
  let url;
  try { url = new URL(value.merchantCheckoutUrl); } catch { throw new Error('Order binding URL is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'nadanada.me' || url.port || url.username || url.password || url.hash) throw new Error('Order binding URL must use the supplier HTTPS domain.');
  const expires = Date.parse(value.expiresAt);
  if (!Number.isSafeInteger(expires) || new Date(expires).toISOString() !== value.expiresAt) throw new Error('Order binding expiry is invalid.');
  return Object.freeze({ supplier: 'nadanada', processor: 'mixpay', orderId: value.orderId, processorOrderId: value.processorOrderId,
    processorPayeeId: value.processorPayeeId, merchantCheckoutUrl: url.href, expiresAt: value.expiresAt });
}
function createTransferReadOnlyRpc({ fetchImpl = globalThis.fetch } = {}) {
  let requestId = 0;
  return async (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error('Only reviewed read-only transfer RPC methods are available.');
    const id = ++requestId;
    try {
      const response = await fetchImpl(MAINNET_RPC, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if (!response.ok) throw new Error('RPC unavailable');
      const body = await response.json();
      if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) throw new Error('RPC response invalid');
      return body.result;
    } catch { throw new Error('Official Solana transfer RPC read failed; no payment was attempted.'); }
  };
}
async function deriveUsdcAta(owner) {
  const [ata] = await token.findAssociatedTokenPda({ owner: kit.address(address(owner, 'Token owner')),
    mint: kit.address(USDC_MINT), tokenProgram: kit.address(TOKEN_PROGRAM) });
  return ata;
}
async function buildUnsignedUsdcTransferMessage(input) {
  exactFields(input, INTENT_FIELDS, 'Unsigned transfer intent');
  if (!['merchant-test', 'recovery'].includes(input.purpose)) throw new Error('Transfer purpose must be explicit.');
  for (const field of ['walletAddress', 'sourceTokenAccount', 'recipientOwner', 'destinationTokenAccount']) address(input[field], field);
  const walletAddress = kit.address(input.walletAddress);
  if (kit.isOffCurveAddress(walletAddress) || input.walletAddress === SYSTEM_PROGRAM) throw new Error('Fee payer must be a dedicated signing wallet public key.');
  if (input.walletAddress === input.recipientOwner || input.sourceTokenAccount === input.destinationTokenAccount) throw new Error('Source and recipient must be different.');
  const amount = integer(input.amountBaseUnits, 'Transfer amount', true);
  if (amount > (input.purpose === 'merchant-test' ? INVOICE_CAP_BASE_UNITS : WALLET_CAP_USD_MICROS)) throw new Error('Transfer amount exceeds its test limit.');
  if (typeof input.createSourceAta !== 'boolean' || typeof input.createDestinationAta !== 'boolean') throw new Error('ATA creation choices must be explicit booleans.');
  if (input.createSourceAta && input.sourceTokenAccount !== await deriveUsdcAta(input.walletAddress)) throw new Error('Missing source must be the wallet native-USDC ATA.');
  if (input.createDestinationAta && input.destinationTokenAccount !== await deriveUsdcAta(input.recipientOwner)) throw new Error('ATA creation must target the recipient native-USDC ATA.');
  if (!Array.isArray(input.references) || input.references.length > 8 || new Set(input.references).size !== input.references.length) throw new Error('Payment references are invalid.');
  const reserved = new Set([input.walletAddress, input.sourceTokenAccount, input.recipientOwner, input.destinationTokenAccount,
    USDC_MINT, TOKEN_PROGRAM, SYSTEM_PROGRAM, token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS]);
  input.references.forEach(reference => {
    address(reference, 'Payment reference');
    if (reserved.has(reference)) throw new Error('Payment reference collides with a transaction account.');
  });
  if (input.purpose === 'recovery' && input.references.length) throw new Error('Recovery must not include merchant payment references.');
  address(input.blockhash, 'Recent blockhash');
  if (input.blockhash === SYSTEM_PROGRAM) throw new Error('A fresh nonzero RPC blockhash is required.');
  const lastValidBlockHeight = integer(input.lastValidBlockHeight, 'Last valid block height', true);
  const orderBinding = canonicalOrderBinding(input.orderBinding, input.purpose);
  const intent = Object.freeze({ schema: 1, purpose: input.purpose, network: 'solana-mainnet', mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM, decimals: 6, walletAddress: input.walletAddress, sourceTokenAccount: input.sourceTokenAccount,
    recipientOwner: input.recipientOwner, destinationTokenAccount: input.destinationTokenAccount, amountBaseUnits: amount.toString(),
    createSourceAta: input.createSourceAta, createDestinationAta: input.createDestinationAta,
    references: Object.freeze([...input.references]), blockhash: input.blockhash, lastValidBlockHeight: lastValidBlockHeight.toString(), orderBinding });
  const withAuthority = instruction => ({ ...instruction, accounts: instruction.accounts.map(meta =>
    meta.address === walletAddress ? { address: meta.address, role: kit.upgradeRoleToSigner(meta.role) } : { ...meta }) });
  const instructions = [];
  for (const [create, owner, ata] of [[intent.createSourceAta, walletAddress, intent.sourceTokenAccount],
    [intent.createDestinationAta, kit.address(intent.recipientOwner), intent.destinationTokenAccount]]) {
    if (create) {
      // Generated JS accepts public-address metadata. Set the signer role explicitly;
      // no signer object, signature callback or secret material is ever supplied.
      instructions.push(withAuthority(token.getCreateAssociatedTokenIdempotentInstruction({ payer: walletAddress,
        ata: kit.address(ata), owner, mint: kit.address(USDC_MINT), systemProgram: kit.address(SYSTEM_PROGRAM), tokenProgram: kit.address(TOKEN_PROGRAM) })));
    }
  }
  const transfer = withAuthority(token.getTransferCheckedInstruction({ source: kit.address(intent.sourceTokenAccount),
    mint: kit.address(USDC_MINT), destination: kit.address(intent.destinationTokenAccount), authority: walletAddress,
    amount, decimals: 6 }));
  instructions.push({ ...transfer, accounts: [...transfer.accounts,
    ...intent.references.map(reference => ({ address: kit.address(reference), role: kit.AccountRole.READONLY }))] });
  let message = kit.createTransactionMessage({ version: 0 });
  message = kit.setTransactionMessageFeePayer(walletAddress, message);
  message = kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash(intent.blockhash), lastValidBlockHeight }, message);
  message = kit.appendTransactionMessageInstructions(instructions, message);
  const transaction = kit.compileTransaction(message);
  const requiredSigners = Object.keys(transaction.signatures);
  if (requiredSigners.length !== 1 || requiredSigners[0] !== walletAddress || Object.values(transaction.signatures).some(signature => signature !== null)) throw new Error('Unsigned message unexpectedly requires another signer.');
  const wire = kit.getTransactionEncoder().encode(transaction);
  if (wire.length > 1232) throw new Error('Unsigned transaction exceeds the reviewed packet size.');
  return Object.freeze({ schema: 1, mode: 'unsigned-transfer-review', intent,
    intentHash: sha256(JSON.stringify(intent)), messageHash: sha256(transaction.messageBytes),
    messageBase64: Buffer.from(transaction.messageBytes).toString('base64'), unsignedTransactionBase64: Buffer.from(wire).toString('base64'),
    requiredSigners: Object.freeze(requiredSigners), transactionVersion: 0, signed: false, merchantAuthenticated: false,
    paymentReady: false, sendAvailable: false });
}
async function serializeUnsignedUsdcIntent(intent) {
  exactFields(intent, ['schema', 'network', 'mint', 'tokenProgram', 'decimals', ...INTENT_FIELDS], 'Canonical transfer intent');
  if (intent.schema !== 1 || intent.network !== 'solana-mainnet' || intent.mint !== USDC_MINT ||
      intent.tokenProgram !== TOKEN_PROGRAM || intent.decimals !== 6) throw new Error('Canonical intent is not a native-USDC Solana mainnet transfer.');
  return buildUnsignedUsdcTransferMessage(Object.fromEntries(INTENT_FIELDS.map(field => [field, intent[field]])));
}
function checkedOwnedTokenAccount(account, owner) {
  const info = account?.data?.parsed?.info;
  if (account?.owner !== TOKEN_PROGRAM || account.executable !== false || account.data?.program !== 'spl-token' || account.data?.parsed?.type !== 'account' ||
      info?.owner !== owner || info.mint !== USDC_MINT || info.isNative !== false || !['initialized', 'frozen'].includes(info.state) || info.tokenAmount?.decimals !== 6) throw new Error('Transfer token account ownership, native mint or state check failed.');
  const reasons = [];
  if (info.state !== 'initialized') reasons.push('frozen');
  if (info.delegate != null || info.delegatedAmount != null) reasons.push('delegate-present');
  if (info.closeAuthority != null && info.closeAuthority !== owner) reasons.push('external-close-authority');
  return { amount: integer(info.tokenAmount.amount, 'Token balance'), eligible: reasons.length === 0, reasons };
}
function checkedTokenAccount(account, owner) {
  const checked = checkedOwnedTokenAccount(account, owner);
  if (!checked.eligible) throw new Error('Transfer token account state or delegation check failed.');
  return checked.amount;
}
function checkedWalletInventory(entries, owner) {
  if (!Array.isArray(entries) || entries.length > 100) throw new Error('Final wallet token inventory is invalid.');
  let total = 0n, available = 0n;
  const seen = new Set();
  const accounts = entries.map(entry => {
    const accountAddress = address(entry?.pubkey, 'Wallet token account');
    if (seen.has(accountAddress)) throw new Error('Final wallet inventory contains duplicate accounts.');
    seen.add(accountAddress);
    const checked = checkedOwnedTokenAccount(entry.account, owner);
    total += checked.amount;
    if (checked.eligible) available += checked.amount;
    return { address: accountAddress, amountBaseUnits: checked.amount.toString(), eligible: checked.eligible, reasons: checked.reasons };
  }).sort((a, b) => a.address.localeCompare(b.address));
  const digits = total.toString().padStart(7, '0');
  return { decimals: 6, totalBaseUnits: total.toString(), availableBaseUnits: available.toString(),
    amount: digits.slice(0, -6) + '.' + digits.slice(-6), accounts };
}
function checkedFeePayer(account) {
  if (account === null) return 0n;
  if (account.owner !== SYSTEM_PROGRAM || account.executable !== false || account.space !== 0 ||
      !Array.isArray(account.data) || account.data[0] !== '' || account.data[1] !== 'base64') throw new Error('Fee payer must be a plain system wallet account.');
  return rpcInteger(account.lamports, 'Fee payer SOL');
}
function solValue(lamports, priceQuote, now) {
  if (!priceQuote) return null;
  exactFields(priceQuote, ['usdPerSol', 'receivedAt'], 'SOL price quote');
  const price = decimalUnits(priceQuote.usdPerSol, 'SOL USD price');
  const received = Date.parse(priceQuote.receivedAt);
  if (price === 0n || !Number.isSafeInteger(received) || new Date(received).toISOString() !== priceQuote.receivedAt || received > now || now - received > 60000) throw new Error('SOL USD price is invalid or stale.');
  return (lamports * price + 999999999n) / 1000000000n;
}
async function prepareUnsignedUsdcTransfer({ walletAddress, quote, sourceTokenAccount = null,
  rpc = createTransferReadOnlyRpc(), solUsdQuote = null, now = Date.now }) {
  let checkedAt = currentTime(now);
  const checkedQuote = validateMerchantQuote(quote, { now: checkedAt });
  const wallet = await readWalletPreflight({ walletAddress, rpc, now: checkedAt });
  if (walletAddress === checkedQuote.recipientOwner) throw new Error('Source and recipient must be different.');
  const amount = integer(checkedQuote.amountBaseUnits, 'Invoice', true);
  const initialUsdc = integer(wallet.usdc.totalBaseUnits, 'Total USDC');
  let capUsdc = initialUsdc;
  if (capUsdc > WALLET_CAP_USD_MICROS) throw new Error('Dedicated test wallet exceeds the $4 USDC cap.');
  const sourceAta = await deriveUsdcAta(walletAddress), destinationAta = await deriveUsdcAta(checkedQuote.recipientOwner);
  let slot = wallet.confirmedSlot;
  const readAccount = async accountAddress => {
    const result = await rpc('getAccountInfo', [accountAddress, { commitment: 'confirmed', encoding: 'jsonParsed', minContextSlot: slot }]);
    slot = context(result, slot);
    if (!Object.hasOwn(result, 'value') || (result.value !== null && (typeof result.value !== 'object' || Array.isArray(result.value)))) throw new Error('RPC account response is missing or malformed.');
    return result.value;
  };
  const feePayer = await readAccount(walletAddress);
  const initialSol = integer(wallet.sol.lamports, 'Wallet SOL');
  const currentSol = checkedFeePayer(feePayer);
  let availableSol = currentSol < initialSol ? currentSol : initialSol;
  let capSol = currentSol > initialSol ? currentSol : initialSol;
  const candidates = wallet.usdc.accounts.filter(account => account.eligible && integer(account.amountBaseUnits, 'Account balance') >= amount);
  candidates.sort((a, b) => a.address === sourceAta ? -1 : b.address === sourceAta ? 1 : a.address.localeCompare(b.address));
  let source = sourceTokenAccount ? address(sourceTokenAccount, 'Reviewed source account') : candidates[0]?.address || sourceAta;
  if (sourceTokenAccount && source !== sourceAta && !wallet.usdc.accounts.some(account => account.address === source && account.eligible)) throw new Error('Reviewed source is not an eligible wallet USDC account.');
  const sourceInfo = await readAccount(source);
  if (!sourceInfo && source !== sourceAta) throw new Error('A missing auxiliary source account cannot be created without a different key.');
  const observedSourceAmount = sourceInfo ? checkedTokenAccount(sourceInfo, walletAddress) : 0n;
  const cachedSourceAmount = integer(wallet.usdc.accounts.find(account => account.address === source)?.amountBaseUnits || '0', 'Cached source USDC');
  const sourceAdjustedTotal = initialUsdc - cachedSourceAmount + observedSourceAmount;
  if (sourceAdjustedTotal > capUsdc) capUsdc = sourceAdjustedTotal;
  if (capUsdc > WALLET_CAP_USD_MICROS) throw new Error('Fresh source balance exceeds the $4 wallet USDC cap.');
  const destination = checkedQuote.recipientTokenAccount || destinationAta;
  if (destination === source) throw new Error('Source and destination token accounts must differ.');
  const destinationInfo = await readAccount(destination);
  if (destinationInfo) checkedTokenAccount(destinationInfo, checkedQuote.recipientOwner);
  else if (destination !== destinationAta) throw new Error('A missing auxiliary destination account cannot be fabricated.');
  // Idempotent destination ATA creation protects against an empty ATA being closed
  // after review. Budget the full possible deposit even when it exists at review.
  const createSourceAta = sourceInfo === null, createDestinationAta = destination === destinationAta;
  const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: slot }]);
  slot = context(latest, slot);
  const blockhash = address(latest.value?.blockhash, 'RPC blockhash');
  const lastValidBlockHeight = rpcInteger(latest.value?.lastValidBlockHeight, 'Blockhash expiry height', true);
  const artifact = await buildUnsignedUsdcTransferMessage({ purpose: 'merchant-test', walletAddress, sourceTokenAccount: source,
    recipientOwner: checkedQuote.recipientOwner, destinationTokenAccount: destination, amountBaseUnits: checkedQuote.amountBaseUnits,
    createSourceAta, createDestinationAta, references: checkedQuote.references, blockhash, lastValidBlockHeight: lastValidBlockHeight.toString(),
    orderBinding: { supplier: 'nadanada', processor: 'mixpay', orderId: checkedQuote.orderId, processorOrderId: checkedQuote.processorOrderId,
      processorPayeeId: checkedQuote.processorPayeeId, merchantCheckoutUrl: checkedQuote.merchantCheckoutUrl, expiresAt: new Date(Date.parse(checkedQuote.expiresAt)).toISOString() } });
  const fee = await rpc('getFeeForMessage', [artifact.messageBase64, { commitment: 'confirmed', minContextSlot: slot }]);
  const feeSlot = context(fee, slot);
  slot = feeSlot;
  const feeLamports = rpcInteger(fee.value, 'Current message fee', true);
  const ataRentEach = rpcInteger(await rpc('getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]), 'Token account rent', true);
  const reserve = rpcInteger(await rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }]), 'Fee payer rent reserve', true);
  const finalTokens = await rpc('getTokenAccountsByOwner', [walletAddress, { mint: USDC_MINT },
    { commitment: 'confirmed', encoding: 'jsonParsed', minContextSlot: slot }]);
  slot = context(finalTokens, slot);
  const finalInventory = checkedWalletInventory(finalTokens.value, walletAddress);
  const finalTotalUsdc = integer(finalInventory.totalBaseUnits, 'Final wallet USDC');
  if (finalTotalUsdc > capUsdc) capUsdc = finalTotalUsdc;
  if (capUsdc > WALLET_CAP_USD_MICROS) throw new Error('Final wallet inventory exceeds the $4 USDC cap.');
  const finalSource = finalInventory.accounts.find(account => account.address === source);
  const finalSourceAmount = finalSource?.eligible ? integer(finalSource.amountBaseUnits, 'Final source USDC') : 0n;
  const sourceAmount = observedSourceAmount < finalSourceAmount ? observedSourceAmount : finalSourceAmount;
  const finalTokenSlot = slot;
  const finalFeePayer = await readAccount(walletAddress);
  const finalSol = checkedFeePayer(finalFeePayer);
  if (finalSol < availableSol) availableSol = finalSol;
  if (finalSol > capSol) capSol = finalSol;
  const solDigits = finalSol.toString().padStart(10, '0');
  const reviewedWallet = { ...wallet, confirmedSlot: slot,
    usdc: { ...finalInventory, confirmedSlot: finalTokenSlot, capObservedBaseUnits: capUsdc.toString() },
    sol: { lamports: finalSol.toString(), amount: solDigits.slice(0, -9) + '.' + solDigits.slice(-9),
      confirmedSlot: slot, capObservedLamports: capSol.toString() } };
  const currentHeight = rpcInteger(await rpc('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: slot }]), 'Current block height');
  if (currentHeight >= lastValidBlockHeight) throw new Error('Unsigned transaction blockhash expired during review.');
  checkedAt = currentTime(now);
  validateMerchantQuote(quote, { now: checkedAt });
  const createdCount = Number(createSourceAta) + Number(createDestinationAta);
  const ataRent = BigInt(createdCount) * ataRentEach;
  const expectedRent = BigInt(Number(!sourceInfo) + Number(!destinationInfo)) * ataRentEach;
  const cost = feeLamports + ataRent, requiredSol = cost + reserve;
  const walletSolUsd = solValue(capSol, solUsdQuote, checkedAt), costUsd = solValue(cost, solUsdQuote, checkedAt);
  const minimumSolUsd = solValue(requiredSol, solUsdQuote, checkedAt);
  if (walletSolUsd !== null && capUsdc + walletSolUsd > WALLET_CAP_USD_MICROS) throw new Error('USDC plus valued SOL exceeds the $4 wallet funding cap.');
  if (minimumSolUsd !== null && amount + minimumSolUsd > WALLET_CAP_USD_MICROS) throw new Error('Invoice plus minimum SOL funding exceeds the $4 test budget.');
  const fundingBlockers = [];
  if (!feePayer || !finalFeePayer) fundingBlockers.push('fee-payer-missing');
  if (sourceAmount < amount) fundingBlockers.push(integer(finalInventory.availableBaseUnits, 'Available USDC') >= amount ? 'usdc-source-fragmented' : 'insufficient-available-usdc');
  if (availableSol < requiredSol) fundingBlockers.push('insufficient-sol-for-fee-rent-and-reserve');
  if (walletSolUsd === null) fundingBlockers.push('sol-usd-unquoted');
  return Object.freeze({ ...artifact, checkedAt: new Date(checkedAt).toISOString(), quote: Object.freeze(checkedQuote), wallet: reviewedWallet,
    sourceAta, destinationAta, destinationAccountExists: !!destinationInfo, fundingReady: fundingBlockers.length === 0,
    funding: { additionalUsdcBaseUnits: (sourceAmount >= amount ? 0n : amount - sourceAmount).toString(),
      additionalSolLamports: (availableSol >= requiredSol ? 0n : requiredSol - availableSol).toString(),
      minimumWalletUsdMicros: minimumSolUsd === null ? null : (amount + minimumSolUsd).toString(),
      externalFundingFees: 'unquoted' },
    gas: { status: 'rpc-quoted', feeLamports: feeLamports.toString(), ataRentEachLamports: ataRentEach.toString(),
      ataRentLamports: ataRent.toString(), ataRentExpectedLamports: expectedRent.toString(), feePayerReserveLamports: reserve.toString(),
      requiredSolLamports: requiredSol.toString(), availableSolLamports: availableSol.toString(), usdMicros: costUsd?.toString() ?? null,
      priorityFeeLamports: '0', confirmedSlot: feeSlot, checkedAt: new Date(checkedAt).toISOString() },
    merchantAuthenticated: false, paymentReady: false, sendAvailable: false,
    blockers: Object.freeze(['merchant-route-unverified', 'unsigned-review-only', ...fundingBlockers]) });
}
module.exports = { createTransferReadOnlyRpc, deriveUsdcAta, buildUnsignedUsdcTransferMessage, serializeUnsignedUsdcIntent, prepareUnsignedUsdcTransfer };
if (require.main === module) {
  console.error('Unsigned transfer review module: no signing or payment command is available.');
  process.exitCode = 1;
}
