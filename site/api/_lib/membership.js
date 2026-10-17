'use strict';
/**
 * membership — the rules of OT+T membership, in one place for the weekly indexer
 * (scripts/allowances.js) and the API (site/api/redeem.js). docs/membership.md explains them.
 *
 *   - A wallet joins by burning at least `burnTokens` OTT: a Transfer from it to the burn address,
 *     or to the zero address for a token whose burn() emits one. Burns from one wallet add up.
 *   - Each member can claim one welcome eSIM from the plans welcomeEligible() accepts.
 *   - Each week's member budget is split by holdings among the members at the snapshot, with no
 *     member above `capMultiple` times the average (cappedShares()).
 *
 * Everything here is pure: logs, receipts and numbers in, decisions out.
 */
const { keccak256Hex } = require('./keccak');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = keccak256Hex('Transfer(address,address,uint256)');

const lower = (value) => String(value || '').toLowerCase();
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
const unpad = (word) => '0x' + String(word || '').slice(-40).toLowerCase();
// Dollar shares are rounded DOWN to a hundredth of a cent, so the shares can never add up to more
// than the budget and no rounded share can creep above the cap.
const floor4 = (n) => Math.floor(n * 1e4 + 1e-6) / 1e4;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * The validated membership settings from esim.json, or null when the config has none. A block
 * that is present but wrong throws, because guessing at a burn amount or a cap would quietly
 * change who gets what.
 */
function membershipConfig(config) {
  const m = config && config.membership;
  if (m === undefined || m === null) return null;
  const bad = (what) => { throw new Error('esim.json membership needs ' + what); };
  if (typeof m !== 'object' || Array.isArray(m)) bad('to be an object');
  // A string, never a JSON number: large token amounts lose precision as floats.
  const burnTokens = m.burnTokens;
  if (typeof burnTokens !== 'string' || !/^\d+(\.\d+)?$/.test(burnTokens) || !/[1-9]/.test(burnTokens)) bad('a positive burnTokens amount, written as a string');
  if (!isAddress(m.burnAddress) || /^0x0{40}$/.test(m.burnAddress)) bad('a non-zero burnAddress');
  const capMultiple = Number(m.capMultiple);
  if (!Number.isFinite(capMultiple) || capMultiple < 1) bad('a capMultiple of at least 1');
  const w = m.welcome || {};
  const welcome = { gb: Number(w.gb), days: Number(w.days), maxUsd: Number(w.maxUsd) };
  if (!(welcome.gb > 0) || !Number.isSafeInteger(welcome.days) || welcome.days <= 0 || !(welcome.maxUsd > 0)) {
    bad('a welcome plan with positive gb, whole days and maxUsd');
  }
  const burnAddress = lower(m.burnAddress);
  return { burnTokens, burnAddress, destinations: [burnAddress, ZERO_ADDRESS], capMultiple, welcome };
}

/** A decimal token amount ("100000", "0.5") in the token's base units, exactly. */
function unitsOf(tokens, decimals) {
  const d = Number(decimals);
  if (!Number.isSafeInteger(d) || d < 0 || d > 36) throw new Error('token decimals must be a whole number from 0 to 36');
  const [whole, fraction = ''] = String(tokens).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error('not a token amount: ' + tokens);
  if (fraction.replace(/0+$/, '').length > d) throw new Error(tokens + ' has more decimal places than the token');
  return BigInt(whole) * 10n ** BigInt(d) + BigInt((fraction + '0'.repeat(d)).slice(0, d) || '0');
}

const blockOf = (log) => Number(BigInt(log.blockNumber));
const indexOf = (log) => (log.logIndex === undefined || log.logIndex === null ? 0 : Number(BigInt(log.logIndex)));

/**
 * Every wallet's running total of OTT sent to a burn destination, from the coin's Transfer logs.
 * When `threshold` is given, each entry also records the burn that first took the wallet to it:
 * that log's block and transaction. Logs are taken in chain order whatever order they arrive in.
 */
function foldBurns(logs, destinations, threshold = null) {
  const to = new Set(destinations.map(lower));
  const ordered = logs.filter((log) => log && Array.isArray(log.topics) && log.topics.length >= 3 && !log.removed
    && lower(log.topics[0]) === TRANSFER_TOPIC && to.has(unpad(log.topics[2])))
    .slice().sort((a, b) => blockOf(a) - blockOf(b) || indexOf(a) - indexOf(b));
  const burns = new Map();
  for (const log of ordered) {
    const from = unpad(log.topics[1]);
    if (from === ZERO_ADDRESS || to.has(from)) continue;
    const entry = burns.get(from) || { burned: 0n, sinceBlock: null, tx: null };
    const before = entry.burned;
    entry.burned = before + BigInt(log.data);
    if (threshold !== null && before < threshold && entry.burned >= threshold) {
      entry.sinceBlock = blockOf(log);
      entry.tx = lower(log.transactionHash) || null;
    }
    burns.set(from, entry);
  }
  return burns;
}

/** The members among folded burns: every wallet whose total reached `threshold`. */
function membersFrom(burns, threshold) {
  const members = new Map();
  for (const [address, entry] of burns) if (entry.burned >= threshold) members.set(address, entry);
  return members;
}

/**
 * Split `budgetUsd` among `members` in proportion to `weights` (their OTT at the snapshot), with
 * nobody above capMultiple × budget / members. A member over the cap is held at it and the rest
 * is shared again among the others, until nobody is over. What cannot be placed — the excess
 * when every remaining member holds nothing — stays in the pool as `unallocatedUsd`.
 *
 * Returns { allocations: Map(address -> dollars), capUsd, allocatedUsd, unallocatedUsd }.
 */
function cappedShares({ members, weights, budgetUsd, capMultiple }) {
  const allocations = new Map(members.map((address) => [address, 0]));
  const budget = Number(budgetUsd);
  if (!members.length || !(budget > 0)) {
    return { allocations, capUsd: members.length ? floor4(capMultiple * Math.max(0, budget) / members.length) : 0,
      allocatedUsd: 0, unallocatedUsd: round4(Math.max(0, budget)) };
  }
  const cap = capMultiple * budget / members.length;
  const weight = (address) => { const w = weights.get(address); return typeof w === 'bigint' && w > 0n ? w : 0n; };
  let active = members.filter((address) => weight(address) > 0n);
  let remaining = budget;
  while (active.length && remaining > 0) {
    const total = active.reduce((sum, address) => sum + weight(address), 0n);
    const shareOf = (address) => remaining * (Number(weight(address)) / Number(total));
    const over = active.filter((address) => shareOf(address) > cap);
    if (!over.length) {
      for (const address of active) allocations.set(address, shareOf(address));
      remaining = 0;
      break;
    }
    for (const address of over) allocations.set(address, cap);
    remaining -= cap * over.length;
    active = active.filter((address) => !over.includes(address));
  }
  let allocated = 0;
  for (const [address, usd] of allocations) {
    const floored = floor4(Math.min(usd, cap));
    allocations.set(address, floored);
    allocated += floored;
  }
  const allocatedUsd = round4(allocated);
  return { allocations, capUsd: floor4(cap), allocatedUsd, unallocatedUsd: round4(Math.max(0, budget - allocatedUsd)) };
}

/** True when a catalogue package is one a member may take as their welcome eSIM. */
function welcomeEligible(pkg, welcome) {
  if (!pkg || !welcome) return false;
  const price = Number(pkg.priceUsd);
  return Number(pkg.gb) === Number(welcome.gb) && Number(pkg.days) === Number(welcome.days)
    && Number.isFinite(price) && price > 0 && price <= Number(welcome.maxUsd) + 1e-9;
}

/**
 * How much of `coin` one transaction receipt shows `address` burning: the sum of its Transfer
 * logs from that wallet to a burn destination. 0n for a failed, missing or unrelated receipt.
 */
function burnedInReceipt(receipt, { coin, address, destinations }) {
  if (!receipt || typeof receipt !== 'object' || lower(receipt.status) !== '0x1' || !Array.isArray(receipt.logs)) return 0n;
  const to = new Set(destinations.map(lower));
  let burned = 0n;
  for (const log of receipt.logs) {
    if (!log || log.removed || lower(log.address) !== lower(coin) || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (lower(log.topics[0]) !== TRANSFER_TOPIC || unpad(log.topics[1]) !== lower(address) || !to.has(unpad(log.topics[2]))) continue;
    try { burned += BigInt(log.data); } catch (e) { /* not an amount: not a burn */ }
  }
  return burned;
}

module.exports = {
  ZERO_ADDRESS, TRANSFER_TOPIC, membershipConfig, unitsOf, foldBurns, membersFrom, cappedShares,
  welcomeEligible, burnedInReceipt, floor4,
};
