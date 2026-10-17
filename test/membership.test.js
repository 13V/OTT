#!/usr/bin/env node
'use strict';
/**
 * The membership rules (site/api/_lib/membership.js), on their own: config validation, token
 * amounts in base units, burns folded from Transfer logs, the capped split by holdings, welcome
 * plan eligibility and the burn-receipt check. docs/membership.md states the rules being held.
 *
 *   node test/membership.test.js
 */
const path = require('path');
const M = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'membership.js'));
const chain = require(path.join(__dirname, '..', 'scripts', 'chain.js'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x instanceof Map ? [...x] : x));
  if (norm(got) === norm(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const throws = (what, fn, pattern) => {
  checks++;
  try { fn(); failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); }
  }
};

const DEAD = '0x000000000000000000000000000000000000dEaD';
const dead = DEAD.toLowerCase();
const COIN = '0x1fefc04bcb777c615b887297168c57e67a2c8192';
const ALICE = '0xe9f89a769f234f6cc75e1c1c6b1fd9963d72c652';
const BOB = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const CAROL = '0xe33e9e479df8802cb0866d5d05258bec4cf62948';
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const amount = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let logIndex = 0;
const xfer = (from, to, value, block, tx = '0x' + String(block).padStart(64, '0')) => ({
  topics: [M.TRANSFER_TOPIC, pad(from), pad(to)], data: amount(value),
  blockNumber: '0x' + block.toString(16), logIndex: '0x' + (logIndex++).toString(16), transactionHash: tx,
});
const CONFIG = { membership: { burnTokens: '100000', burnAddress: DEAD, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } } };

console.log('the Transfer topic is the real event hash');
check('it matches the indexer\'s own computation', M.TRANSFER_TOPIC, chain.topic('Transfer(address,address,uint256)'));

console.log('\nmembershipConfig() reads esim.json\'s block and refuses a broken one');
check('no block means membership is off', M.membershipConfig({}), null);
const m = M.membershipConfig(CONFIG);
check('a valid block is normalised', m, {
  burnTokens: '100000', burnAddress: dead, destinations: [dead, M.ZERO_ADDRESS], capMultiple: 3,
  welcome: { gb: 1, days: 7, maxUsd: 4 },
});
const broken = (change) => ({ membership: Object.assign({}, CONFIG.membership, change) });
throws('a numeric burnTokens is refused, so a float can never round it', () => M.membershipConfig(broken({ burnTokens: 100000 })), /burnTokens/);
throws('a zero burn amount is refused', () => M.membershipConfig(broken({ burnTokens: '0' })), /burnTokens/);
throws('the zero address cannot be the burn address', () => M.membershipConfig(broken({ burnAddress: M.ZERO_ADDRESS })), /burnAddress/);
throws('a malformed burn address is refused', () => M.membershipConfig(broken({ burnAddress: '0xdead' })), /burnAddress/);
throws('a cap below the average makes no sense', () => M.membershipConfig(broken({ capMultiple: 0.5 })), /capMultiple/);
throws('a welcome plan needs whole days', () => M.membershipConfig(broken({ welcome: { gb: 1, days: 7.5, maxUsd: 4 } })), /welcome/);
throws('a welcome plan needs a price limit', () => M.membershipConfig(broken({ welcome: { gb: 1, days: 7 } })), /welcome/);

console.log('\nunitsOf() converts a token amount to base units exactly');
check('100,000 tokens at 18 decimals', M.unitsOf('100000', 18), 100000n * 10n ** 18n);
check('100,000 tokens at 9 decimals', M.unitsOf('100000', 9), 100000n * 10n ** 9n);
check('a fraction that fits', M.unitsOf('0.25', 6), 250000n);
check('trailing zeros beyond the decimals are fine', M.unitsOf('1.500', 1), 15n);
throws('more decimal places than the token has is refused', () => M.unitsOf('0.0000001', 6), /decimal places/);
throws('impossible decimals are refused', () => M.unitsOf('1', 99), /decimals/);

console.log('\nfoldBurns() adds up each wallet\'s burns and records the one that crossed the threshold');
const T = 100n;
const logs = [
  xfer(CAROL, dead, 60, 20, '0xc2'),
  xfer(ALICE, dead, 100, 10, '0xa1'),
  xfer(CAROL, dead, 50, 15, '0xc1'),        // out of order on purpose: chain order is what counts
  xfer(BOB, dead, 99, 30, '0xb1'),
  xfer(BOB, ALICE, 500, 31),                // an ordinary transfer is not a burn
  xfer(M.ZERO_ADDRESS, dead, 1000, 32),     // a mint straight to the burn address is nobody's burn
  xfer(ALICE, M.ZERO_ADDRESS, 5, 40, '0xa2'), // the token's own burn() counts too
];
const burns = M.foldBurns(logs, m.destinations, T);
check('Alice crossed with her first burn', burns.get(ALICE), { burned: 105n, sinceBlock: 10, tx: '0xa1' });
check('Carol crossed with her second, in chain order', burns.get(CAROL), { burned: 110n, sinceBlock: 20, tx: '0xc2' });
check('Bob is one short and has no crossing', burns.get(BOB), { burned: 99n, sinceBlock: null, tx: null });
check('nobody else burned', [...burns.keys()].sort(), [ALICE, BOB, CAROL].sort());
check('membersFrom() keeps only those at the threshold', [...M.membersFrom(burns, T).keys()].sort(), [ALICE, CAROL].sort());
check('a removed log is ignored', M.foldBurns([Object.assign(xfer(BOB, dead, 500, 50), { removed: true })], m.destinations, T).size, 0);

console.log('\ncappedShares() splits by holdings with nobody above the cap');
const shares = (members, weights, budgetUsd, capMultiple) => M.cappedShares({ members, weights: new Map(weights), budgetUsd, capMultiple });
{
  const r = shares(['a', 'b', 'c'], [['a', 1n], ['b', 1n], ['c', 2n]], 100, 3);
  check('under the cap it is plain proportional', [...r.allocations], [['a', 25], ['b', 25], ['c', 50]]);
  check('the cap is the multiple of the average', r.capUsd, 100);
  check('and the whole budget is placed', [r.allocatedUsd, r.unallocatedUsd], [100, 0]);
}
{
  // One whale and nine small holders: proportionally the whale would take 91.7%.
  const members = ['w', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  const weights = [['w', 1000n], ...members.slice(1).map((s) => [s, 10n])];
  const r = shares(members, weights, 1000, 3);
  check('the whale is held at 3x the $100 average', r.allocations.get('w'), 300);
  check('each small holder gets an equal part of the rest', r.allocations.get('s0'), 77.7777);
  checkThat('nobody is above the cap', [...r.allocations.values()].every((usd) => usd <= r.capUsd));
  checkThat('the shares never add up to more than the budget', r.allocatedUsd <= 1000 && r.unallocatedUsd >= 0, JSON.stringify(r));
}
{
  // Capping one member can push the next over: the split has to settle in more than one round.
  const r = shares(['a', 'b', 'c', 'd'], [['a', 100n], ['b', 60n], ['c', 1n], ['d', 1n]], 400, 1.2);
  check('both large members end at the $120 cap', [r.allocations.get('a'), r.allocations.get('b')], [120, 120]);
  check('the two small members share what is left equally', [r.allocations.get('c'), r.allocations.get('d')], [80, 80]);
}
{
  const r = shares(['a', 'b'], [['a', 0n], ['b', 5n]], 90, 1.5);
  check('a member holding nothing gets nothing', r.allocations.get('a'), 0);
  check('the other is held at the cap', r.allocations.get('b'), 67.5);
  check('and what nobody could take stays in the pool', r.unallocatedUsd, 22.5);
}
{
  const r = shares([], [], 500, 3);
  check('no members: nothing is placed and the budget stays', [r.allocations.size, r.capUsd, r.allocatedUsd, r.unallocatedUsd], [0, 0, 0, 500]);
  const zero = shares(['a'], [['a', 10n]], 0, 3);
  check('a zero budget gives everyone zero', [zero.allocations.get('a'), zero.allocatedUsd], [0, 0]);
}
{
  const r = shares(['a', 'b', 'c'], [['a', 1n], ['b', 1n], ['c', 1n]], 100, 3);
  check('shares are rounded down to a hundredth of a cent', [...r.allocations.values()], [33.3333, 33.3333, 33.3333]);
  check('so the rounding dust stays in the pool', r.unallocatedUsd, 0.0001);
}

console.log('\nwelcomeEligible() accepts only the configured welcome plan');
const welcome = m.welcome;
check('Australia 1 GB / 7 days at $1.99', M.welcomeEligible({ gb: 1, days: 7, priceUsd: 1.99 }, welcome), true);
check('exactly $4 is included', M.welcomeEligible({ gb: 1, days: 7, priceUsd: 4 }, welcome), true);
check('Global at $8.99 is not', M.welcomeEligible({ gb: 1, days: 7, priceUsd: 8.99 }, welcome), false);
check('a bigger plan is not', M.welcomeEligible({ gb: 5, days: 30, priceUsd: 3 }, welcome), false);
check('an unpriced plan is not', M.welcomeEligible({ gb: 1, days: 7 }, welcome), false);

console.log('\nburnedInReceipt() reads a burn out of one transaction receipt');
const receipt = (status, entries) => ({ status, logs: entries });
const coinLog = (from, to, value) => Object.assign(xfer(from, to, value, 7), { address: COIN });
const opts = { coin: COIN, address: ALICE, destinations: m.destinations };
check('a successful burn to the burn address', M.burnedInReceipt(receipt('0x1', [coinLog(ALICE, dead, 100)]), opts), 100n);
check('two burn logs in one transaction add up', M.burnedInReceipt(receipt('0x1', [coinLog(ALICE, dead, 60), coinLog(ALICE, M.ZERO_ADDRESS, 40)]), opts), 100n);
check('a reverted transaction burned nothing', M.burnedInReceipt(receipt('0x0', [coinLog(ALICE, dead, 100)]), opts), 0n);
check('someone else\'s burn is not this wallet\'s', M.burnedInReceipt(receipt('0x1', [coinLog(BOB, dead, 100)]), opts), 0n);
check('a burn of a different token does not count', M.burnedInReceipt(receipt('0x1', [Object.assign(coinLog(ALICE, dead, 100), { address: BOB })]), opts), 0n);
check('an ordinary transfer does not count', M.burnedInReceipt(receipt('0x1', [coinLog(ALICE, BOB, 100)]), opts), 0n);
check('a missing receipt is nothing', M.burnedInReceipt(null, opts), 0n);

function checkThat(what, cond, detail) {
  checks++;
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
