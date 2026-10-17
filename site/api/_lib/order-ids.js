'use strict';
/**
 * The ids every order is found by. There is no wallet database: the provider is the ledger, and a
 * wallet's orders are looked up under ids worked out from its address (site/api/redeem.js).
 *
 * Fixed forever: change either formula and every past order goes missing.
 *
 * The formulas lowercase their input, as they did for 0x addresses. A base58 address lowercased is
 * still unique in practice: two wallets would have to differ only in letter case, and keys cannot
 * be ground to collide like that (docs/membership.md).
 */
const { keccak256Hex } = require('./keccak');

/**
 * The wallet's Nth redemption id, in week `week`. Scoped by week so that each week's sequence
 * starts fresh at n=0 — the mechanism that makes an allowance which expires at the end of the
 * week actually expire: last week's ids are simply not the ids this week's redemptions are looked
 * up or placed under.
 */
function transactionIdFor(address, week, n) {
  return 'ott-' + keccak256Hex(address.toLowerCase() + ':' + week + ':' + n).slice(2, 34);
}

/**
 * A member's one welcome order. "welcome" can never be a week number, so this id can never be one
 * a weekly redemption looks under. The reserve pays for it, not the member's weekly credit.
 */
function welcomeIdFor(address) {
  return 'ott-' + keccak256Hex(address.toLowerCase() + ':welcome:0').slice(2, 34);
}

/** Whether a provider's order record is a welcome order (records that name their wallet only). */
function isWelcomeOrder(order) {
  return !!order && typeof order.address === 'string' && order.address !== '' && order.transactionId === welcomeIdFor(order.address);
}

module.exports = { transactionIdFor, welcomeIdFor, isWelcomeOrder };
