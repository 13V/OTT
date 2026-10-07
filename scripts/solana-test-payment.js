#!/usr/bin/env node
'use strict';
/** Read-only preparation for one native-USDC eSIM test. No signer or send path.
 * A locally supplied quote is evidence to review, never merchant authentication.
 * Official mint: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * RPC: https://solana.com/docs/references/clusters
 */
const MAINNET_RPC = 'https://api.mainnet.solana.com';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MIXPAY_USDC_ASSET = 'de6fa523-c596-398e-b12f-6d6980544b59';
const INVOICE_CAP_BASE_UNITS = 2500000n;
const WALLET_CAP_USD_MICROS = 4000000n;
const U64_MAX = (1n << 64n) - 1n;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const READ_METHODS = new Set(['getGenesisHash', 'getBalance', 'getTokenAccountsByOwner', 'getAccountInfo']);
const ROUTE_BLOCKERS = ['merchant-route-unverified', 'transaction-builder-unavailable', 'gas-unquoted'];

function address(value, label = 'Public address') {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new Error(label + ' must be a Solana public address.');
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error(label + ' must be a Solana public address.');
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  const zeros = /^1*/.exec(value)[0].length;
  if (bytes + zeros !== 32) throw new Error(label + ' must decode to exactly 32 bytes.');
  return value;
}
function units(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error(label + ' must be an exact base-unit string.');
  const result = BigInt(value);
  if (result > U64_MAX || (positive && result === 0n)) throw new Error(label + ' is outside its allowed range.');
  return result;
}
function decimalUnits(value, label = 'Amount') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/.test(value)) throw new Error(label + ' needs a decimal string with at most six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return units(BigInt(whole + fraction.padEnd(6, '0')).toString(), label);
}
function displayUnits(value, decimals) {
  const padded = value.toString().padStart(decimals + 1, '0');
  return padded.slice(0, -decimals) + '.' + padded.slice(-decimals);
}
function clock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Preparation time is invalid.');
  return value;
}
function instant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) throw new Error(label + ' needs an ISO UTC timestamp.');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || new Date(result).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new Error(label + ' is invalid.');
  return result;
}
function context(result, minimum = 0) {
  if (!result || !Number.isSafeInteger(result.context?.slot) || result.context.slot < minimum) throw new Error('RPC context is missing or stale.');
  return result.context.slot;
}
function createReadOnlyRpc({ fetchImpl = globalThis.fetch } = {}) {
  let requestId = 0;
  return async (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error('Only the reviewed read-only RPC methods are available.');
    const id = ++requestId;
    try {
      const response = await fetchImpl(MAINNET_RPC, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('RPC unavailable');
      const body = await response.json();
      if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) throw new Error('RPC response invalid');
      return body.result;
    } catch { throw new Error('Official Solana RPC read failed; no payment was attempted.'); }
  };
}
function tokenAccount(account, walletAddress) {
  const info = account?.data?.parsed?.info;
  if (!account || account.executable !== false || account.owner !== TOKEN_PROGRAM || account.data?.program !== 'spl-token' ||
      account.data?.parsed?.type !== 'account' || !info || info.mint !== USDC_MINT || info.owner !== walletAddress ||
      info.tokenAmount?.decimals !== 6 || info.isNative !== false || !['initialized', 'frozen'].includes(info.state)) {
    throw new Error('Token account does not match standard native USDC and its expected owner.');
  }
  const amount = units(info.tokenAmount.amount, 'USDC balance');
  const reasons = [];
  if (info.state !== 'initialized') reasons.push('frozen');
  if (info.delegate != null || info.delegatedAmount != null) reasons.push('delegate-present');
  if (info.closeAuthority != null && info.closeAuthority !== walletAddress) reasons.push('external-close-authority');
  return { amount, eligible: reasons.length === 0, reasons };
}
async function readWalletPreflight({ walletAddress, rpc = createReadOnlyRpc(), now = Date.now() }) {
  address(walletAddress, 'Wallet'); clock(now);
  if (await rpc('getGenesisHash', []) !== MAINNET_GENESIS) throw new Error('RPC is not Solana mainnet.');
  const mint = await rpc('getAccountInfo', [USDC_MINT, { commitment: 'confirmed', encoding: 'jsonParsed' }]);
  const mintSlot = context(mint);
  const mintInfo = mint.value?.data?.parsed?.info;
  if (mint.value?.owner !== TOKEN_PROGRAM || mint.value?.executable !== false || mint.value?.data?.program !== 'spl-token' ||
      mint.value?.data?.parsed?.type !== 'mint' || mintInfo?.decimals !== 6 || mintInfo?.isInitialized !== true) {
    throw new Error('Official USDC mint verification failed.');
  }
  const balance = await rpc('getBalance', [walletAddress, { commitment: 'confirmed', minContextSlot: mintSlot }]);
  const balanceSlot = context(balance, mintSlot);
  if (!Number.isSafeInteger(balance.value) || balance.value < 0) throw new Error('SOL balance is not an exact safe lamport integer.');
  const tokens = await rpc('getTokenAccountsByOwner', [walletAddress, { mint: USDC_MINT },
    { commitment: 'confirmed', minContextSlot: balanceSlot, encoding: 'jsonParsed' }]);
  const tokenSlot = context(tokens, balanceSlot);
  if (!Array.isArray(tokens.value) || tokens.value.length > 100) throw new Error('USDC account response is invalid.');
  let total = 0n, available = 0n;
  const seen = new Set();
  const accounts = tokens.value.map(entry => {
    const accountAddress = address(entry?.pubkey, 'Token account');
    if (seen.has(accountAddress)) throw new Error('RPC returned a duplicate token account.');
    seen.add(accountAddress);
    const checked = tokenAccount(entry.account, walletAddress);
    total += checked.amount;
    if (checked.eligible) available += checked.amount;
    return { address: accountAddress, amountBaseUnits: checked.amount.toString(), eligible: checked.eligible, reasons: checked.reasons };
  }).sort((a, b) => a.address.localeCompare(b.address));
  return { schema: 1, mode: 'read-only-preflight', checkedAt: new Date(now).toISOString(), network: 'solana-mainnet',
    walletAddress, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM, confirmedSlot: tokenSlot,
    sol: { lamports: String(balance.value), amount: displayUnits(BigInt(balance.value), 9) },
    usdc: { decimals: 6, totalBaseUnits: total.toString(), availableBaseUnits: available.toString(),
      amount: displayUnits(total, 6), accounts },
    paymentReady: false, sendAvailable: false, blockers: [...ROUTE_BLOCKERS,
      ...(total > WALLET_CAP_USD_MICROS ? ['wallet-usdc-over-cap'] : [])] };
}
function validateMerchantQuote(quote, { now = Date.now() } = {}) {
  clock(now);
  const required = ['schema', 'supplier', 'processor', 'network', 'mint', 'decimals', 'orderId', 'processorOrderId',
    'processorPayeeId', 'amountBaseUnits', 'recipientOwner', 'recipientTokenAccount', 'merchantCheckoutUrl', 'receivedAt', 'expiresAt', 'references'];
  const allowed = new Set([...required, 'processorAssetId']);
  if (!quote || Array.isArray(quote) || typeof quote !== 'object' || Object.keys(quote).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(quote, key))) throw new Error('Quote schema is incomplete or contains unreviewed fields.');
  if (quote.schema !== 1 || quote.supplier !== 'nadanada' || quote.processor !== 'mixpay' || quote.network !== 'solana-mainnet' ||
      quote.mint !== USDC_MINT || quote.decimals !== 6 || (quote.processorAssetId != null && quote.processorAssetId !== MIXPAY_USDC_ASSET)) throw new Error('Quote asset, network, supplier or processor does not match the native-USDC test.');
  for (const key of ['orderId', 'processorOrderId', 'processorPayeeId']) {
    if (typeof quote[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(quote[key])) throw new Error('Quote order and payee identifiers need review.');
  }
  const amount = units(quote.amountBaseUnits, 'Invoice', { positive: true });
  if (amount > INVOICE_CAP_BASE_UNITS) throw new Error('Invoice exceeds the $2.50 test cap.');
  address(quote.recipientOwner, 'Recipient owner');
  if (quote.recipientTokenAccount !== null) address(quote.recipientTokenAccount, 'Destination token account');
  let url;
  try { url = new URL(quote.merchantCheckoutUrl); } catch { throw new Error('Merchant checkout URL is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'nadanada.me' || url.port || url.username || url.password || url.hash) throw new Error('Merchant checkout URL must use the official HTTPS supplier domain.');
  const received = instant(quote.receivedAt, 'Quote received time'), expires = instant(quote.expiresAt, 'Quote expiry');
  if (received > now || now - received > 300000 || expires <= now || expires <= received || expires - received > 900000) throw new Error('Quote is expired, stale or has an invalid lifetime.');
  if (!Array.isArray(quote.references) || quote.references.length > 8 || new Set(quote.references).size !== quote.references.length) throw new Error('Quote references are invalid.');
  quote.references.forEach(reference => address(reference, 'Payment reference'));
  return { ...quote, references: [...quote.references], merchantCheckoutUrl: url.href,
    provenance: 'user-supplied-unverified', merchantAuthenticated: false };
}
function valueSol(lamports, priceQuote, now) {
  if (!priceQuote) return null;
  if (!priceQuote || typeof priceQuote !== 'object' || Object.keys(priceQuote).some(key => !['usdPerSol', 'receivedAt'].includes(key))) throw new Error('SOL price input has unreviewed fields.');
  const micros = decimalUnits(priceQuote.usdPerSol, 'SOL USD price');
  const received = instant(priceQuote.receivedAt, 'SOL price time');
  if (micros === 0n || received > now || now - received > 60000) throw new Error('SOL USD price is missing, stale or invalid.');
  return (lamports * micros + 999999999n) / 1000000000n;
}
async function prepareTransferPlan({ walletAddress, quote, rpc = createReadOnlyRpc(), now = Date.now(), solUsdQuote = null }) {
  const checkedQuote = validateMerchantQuote(quote, { now });
  const wallet = await readWalletPreflight({ walletAddress, rpc, now });
  if (walletAddress === checkedQuote.recipientOwner) throw new Error('The test cannot pay its own source wallet.');
  const total = BigInt(wallet.usdc.totalBaseUnits), amount = BigInt(checkedQuote.amountBaseUnits);
  if (total > WALLET_CAP_USD_MICROS) throw new Error('Use a dedicated wallet within the $4 USDC test cap.');
  const solUsdMicros = valueSol(BigInt(wallet.sol.lamports), solUsdQuote, now);
  if (solUsdMicros !== null && total + solUsdMicros > WALLET_CAP_USD_MICROS) throw new Error('USDC plus valued wallet SOL exceeds the $4 funding cap.');
  const candidates = wallet.usdc.accounts.filter(account => account.eligible && BigInt(account.amountBaseUnits) >= amount);
  candidates.sort((a, b) => BigInt(a.amountBaseUnits) === BigInt(b.amountBaseUnits) ? a.address.localeCompare(b.address) : BigInt(a.amountBaseUnits) > BigInt(b.amountBaseUnits) ? -1 : 1);
  const sourceAccount = candidates[0]?.address || null;
  let destinationVerified = false;
  const blockers = [...ROUTE_BLOCKERS];
  if (!sourceAccount) blockers.push(BigInt(wallet.usdc.availableBaseUnits) >= amount ? 'usdc-source-fragmented' : 'insufficient-available-usdc');
  if (wallet.sol.lamports === '0') blockers.push('wallet-needs-sol');
  if (solUsdMicros === null) blockers.push('wallet-sol-usd-unquoted');
  if (checkedQuote.recipientTokenAccount) {
    const destination = await rpc('getAccountInfo', [checkedQuote.recipientTokenAccount,
      { commitment: 'confirmed', encoding: 'jsonParsed', minContextSlot: wallet.confirmedSlot }]);
    context(destination, wallet.confirmedSlot);
    if (!destination.value) blockers.push('destination-token-account-missing');
    else {
      const checked = tokenAccount(destination.value, checkedQuote.recipientOwner);
      if (!checked.eligible) throw new Error('Destination token account is frozen, delegated or has an external close authority.');
      destinationVerified = true;
    }
  } else blockers.push('destination-token-account-unresolved');
  // No transaction SDK is installed here. Do not invent a fee, ATA/rent budget,
  // merchant authentication, payment instruction or successful settlement.
  return { schema: 1, mode: 'transfer-plan', network: wallet.network, walletAddress, mint: USDC_MINT, decimals: 6,
    quote: checkedQuote, sourceAccount, destinationVerified, amountBaseUnits: amount.toString(), amountUsdc: displayUnits(amount, 6),
    wallet, limits: { invoiceBaseUnits: INVOICE_CAP_BASE_UNITS.toString(), totalFundingUsdMicros: WALLET_CAP_USD_MICROS.toString() },
    walletSolUsdMicros: solUsdMicros?.toString() ?? null, gas: { status: 'unquoted', lamports: null, usdMicros: null },
    transactionBuilt: false, paymentReady: false, sendAvailable: false, blockers };
}

module.exports = { MAINNET_RPC, MAINNET_GENESIS, USDC_MINT, TOKEN_PROGRAM, MIXPAY_USDC_ASSET,
  INVOICE_CAP_BASE_UNITS, WALLET_CAP_USD_MICROS, address, decimalUnits, createReadOnlyRpc,
  readWalletPreflight, validateMerchantQuote, prepareTransferPlan };
if (require.main === module) {
  console.error('Use the Solana test workflow for public-address preflight or a reviewed quote plan. This module cannot sign or send payments.');
  process.exitCode = 1;
}
