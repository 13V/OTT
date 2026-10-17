#!/usr/bin/env node
'use strict';
/**
 * The membership rules (site/api/_lib/membership.js), on their own: config validation, the weekly
 * join amount and its rounding, which week's amount a send is judged against, which transactions
 * count as a join (two of them real mainnet transfers to the incinerator, in test/fixtures/solana),
 * folding joins into members, the capped split by holdings and welcome-plan eligibility.
 * docs/membership.md states the rules being held.
 *
 *   node test/membership.test.js
 */
const path = require('path');
const crypto = require('crypto');
const M = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'membership.js'));
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const { weekStart } = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'week.js'));
const fixture = (name) => require(path.join(__dirname, 'fixtures', 'solana', name));

let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x instanceof Map ? [...x] : x));
const check = (what, got, want) => {
  checks++;
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
function checkThat(what, cond, detail) {
  checks++;
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
}
// Real wallets are points on the curve; these come from fresh ed25519 keys.
const wallet = () => S.encodeBase58(new Uint8Array(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
const ALICE = wallet(), BOB = wallet(), CAROL = wallet(), TREASURY = wallet();

const CONFIG = { membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: '', capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } } };

(async () => {
  console.log('membershipConfig() validates the block');
  check('no block means membership is off', M.membershipConfig({}), null);
  const m = M.membershipConfig(CONFIG);
  check('a valid block before launch is normalised', m, { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: '', capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } });
  const broken = (change) => ({ membership: Object.assign({}, CONFIG.membership, change) });
  check('a filled-in burn account is kept', M.membershipConfig(broken({ burnAccount: 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF' })).burnAccount, 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF');
  throws('a string burnUsd is refused', () => M.membershipConfig(broken({ burnUsd: '5' })), /burnUsd/);
  throws('a zero burnUsd is refused', () => M.membershipConfig(broken({ burnUsd: 0 })), /burnUsd/);
  throws('an absurd burnUsd is refused', () => M.membershipConfig(broken({ burnUsd: 5000 })), /burnUsd/);
  throws('any owner but the incinerator is refused', () => M.membershipConfig(broken({ burnOwner: ALICE })), /incinerator/);
  throws('an EVM burn address is refused', () => M.membershipConfig(broken({ burnAccount: '0x000000000000000000000000000000000000dEaD' })), /burnAccount/);
  throws('a cap below the average makes no sense', () => M.membershipConfig(broken({ capMultiple: 0.5 })), /capMultiple/);
  throws('a welcome plan needs whole days', () => M.membershipConfig(broken({ welcome: { gb: 1, days: 7.5, maxUsd: 4 } })), /welcome/);
  throws('a welcome plan needs a price limit', () => M.membershipConfig(broken({ welcome: { gb: 1, days: 7 } })), /welcome/);

  console.log('\nburnTokensFor() rounds $5 of OTT up to two significant figures');
  check('$5 at $0.0000029 is 1,724,138 tokens, published as 1,800,000', M.burnTokensFor(5, 0.0000029), '1800000');
  check('an exact figure is not rounded further', M.burnTokensFor(5, 0.0000025), '2000000');
  check('$5 at launch price (~$0.0000029)', M.burnTokensFor(5, 2.8e-8 * 103.76), '1800000');
  check('$5 at graduation price (~$0.0000427)', M.burnTokensFor(5, 4.11e-7 * 103.76), '120000');
  check('$5 at a $1M market cap ($0.001)', M.burnTokensFor(5, 0.001), '5000');
  check('$5 at a $100M market cap ($0.1)', M.burnTokensFor(5, 0.1), '50');
  check('a dear token still needs a whole one', M.burnTokensFor(5, 40), '1');
  check('rounding up crosses a power of ten cleanly', M.burnTokensFor(5, 5 / 995), '1000');
  throws('no price, no amount', () => M.burnTokensFor(5, 0), /positive price/);
  throws('a missing price is refused too', () => M.burnTokensFor(5, NaN), /positive price/);

  console.log('\nrequirementFor() judges a send against its own week');
  const W = 2962;
  const req = { [W - 1]: '1500000000000', [W]: '1800000000000' };
  check('a send mid-week uses its week\'s amount', M.requirementFor(req, weekStart(W) + 86400), 1800000000000n);
  check('a send in the first ten minutes uses the lower of the two weeks', M.requirementFor(req, weekStart(W) + 60), 1500000000000n);
  check('but never the higher one', M.requirementFor({ [W - 1]: '2000000000000', [W]: '1800000000000' }, weekStart(W) + 60), 1800000000000n);
  check('the grace ends after ten minutes', M.requirementFor(req, weekStart(W) + M.GRACE_S), 1800000000000n);
  check('a week with no amount yet cannot be judged', M.requirementFor(req, weekStart(W + 1) + 3600), null);
  check('not even in its grace period', M.requirementFor(req, weekStart(W + 1) + 60), null);
  check('a malformed amount is no amount', M.requirementFor({ [W]: '1.5e12' }, weekStart(W) + 3600), null);

  console.log('\njoinFromTransaction() finds the sender of a real transfer to the incinerator');
  {
    // A pump.fun coin (Token-2022) sent to the incinerator, creating its account in the same
    // transaction: the shape of OT+T's own join transaction.
    const tx = fixture('join-creates-account.json');
    const coin = 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump';
    const burnAccount = 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF';
    check('the incinerator\'s account derives from the coin', await S.associatedTokenAddress(S.INCINERATOR, coin, S.PROGRAMS.token2022), burnAccount);
    const join = M.joinFromTransaction(tx, { coin, burnAccount });
    check('the sender and the amount the incinerator gained', [join.wallet, join.amount, join.slot, join.at, join.tx],
      ['GWUESs5wHvAqLR9gNLS6G4BKPqnCZ2iCe91o311EqMpR', 64194000000n, tx.slot, tx.blockTime, tx.transaction.signatures[0]]);
    check('another coin\'s transfer is not a join', M.joinFromTransaction(tx, { coin: S.MINTS.usdc, burnAccount }), null);
    check('a transfer into some other account is not a join', M.joinFromTransaction(tx, { coin, burnAccount: ALICE }), null);
    check('the treasury is never a member', M.joinFromTransaction(tx, { coin, burnAccount, exclude: ['GWUESs5wHvAqLR9gNLS6G4BKPqnCZ2iCe91o311EqMpR'] }).skip, 'the sender is a project wallet');
    const failed = JSON.parse(JSON.stringify(tx));
    failed.meta.err = { InstructionError: [1, { Custom: 1 }] };
    check('a failed transaction is not a join', M.joinFromTransaction(failed, { coin, burnAccount }), null);
  }
  {
    // Token-2022, into an incinerator account that already existed, with compute-budget instructions.
    const tx = fixture('join-existing-account.json');
    const join = M.joinFromTransaction(tx, { coin: 'AyYNfPtftg2zDP4ZbgcoQMggQtwLh4zpfVVmUJs2thto', burnAccount: 'HzfSrAF1hu9CfqF83X3RSW7Jtr9t3ETgk459cVaTahbH' });
    check('a send into an existing incinerator account', [join.wallet, join.amount], ['5aCpdJ56aKVtpwc8gxas3dDazusbwzGupAfM2WKqUHpR', 1000000n]);
  }
  {
    const COIN = wallet(), BURN = wallet(), PDA = (await S.programAddress(['bonding-curve', S.decodeBase58(COIN)], S.PROGRAMS.pump)).address;
    const keys = [ALICE, BOB, BURN, PDA, CAROL];
    const bal = (i, owner, amount) => ({ accountIndex: i, mint: COIN, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
    const tx = (pre, post) => ({ slot: 1, blockTime: 2, meta: { err: null, preTokenBalances: pre, postTokenBalances: post }, transaction: { signatures: ['sig'], message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } } });
    check('two senders in one transaction are skipped', M.joinFromTransaction(tx([bal(0, ALICE, 10), bal(1, BOB, 10)], [bal(0, ALICE, 5), bal(1, BOB, 5), bal(2, S.INCINERATOR, 10)]), { coin: COIN, burnAccount: BURN }).skip, 'several senders');
    check('tokens arriving from nowhere are skipped', M.joinFromTransaction(tx([], [bal(2, S.INCINERATOR, 10)]), { coin: COIN, burnAccount: BURN }).skip, 'no sender');
    check('a program account (the bonding curve) is never a member', M.joinFromTransaction(tx([bal(3, PDA, 10)], [bal(3, PDA, 0), bal(2, S.INCINERATOR, 10)]), { coin: COIN, burnAccount: BURN }).skip, 'the sender is not an ordinary wallet');
    check('one sender, two of its accounts', M.joinFromTransaction(tx([bal(0, ALICE, 10), bal(4, ALICE, 10)], [bal(0, ALICE, 0), bal(4, ALICE, 5), bal(2, S.INCINERATOR, 15)]), { coin: COIN, burnAccount: BURN }).amount, 15n);
    check('the incinerator losing tokens is not a join', M.joinFromTransaction(tx([bal(2, S.INCINERATOR, 10)], [bal(2, S.INCINERATOR, 5)]), { coin: COIN, burnAccount: BURN }), null);
    check('isWallet: a key on the curve', M.isWallet(ALICE), true);
    check('isWallet: a program address is not', M.isWallet(PDA), false);
    check('isWallet: an EVM address is not', M.isWallet('0x000000000000000000000000000000000000dEaD'), false);
  }

  console.log('\nfoldJoins() turns sends into members, in chain order');
  {
    const t = weekStart(W) + 3600;
    const req1 = { [W]: '100' };
    const events = [
      { wallet: ALICE, amount: 60n, at: t, slot: 10, tx: 'a1' },
      { wallet: BOB, amount: 100n, at: t + 1, slot: 11, tx: 'b1' },
      { wallet: ALICE, amount: 50n, at: t + 2, slot: 12, tx: 'a2' },
      { wallet: BOB, amount: 5n, at: t + 3, slot: 13, tx: 'b2' },
      { wallet: CAROL, amount: 99n, at: t + 4, slot: 14, tx: 'c1' },
    ];
    const r = M.foldJoins({}, events, req1);
    check('Alice crossed with her second send', r.members[ALICE], { burned: '110', since: { at: t + 2, slot: 12, tx: 'a2' } });
    check('Bob crossed with his first, and his later send only adds', r.members[BOB], { burned: '105', since: { at: t + 1, slot: 11, tx: 'b1' } });
    check('Carol is one short and waits in joins', [r.members[CAROL], r.joins[CAROL]], [undefined, { burned: '99', last: { at: t + 4, slot: 14, tx: 'c1' } }]);
    check('every send was folded', r.stoppedAt, 5);
    const later = M.foldJoins({ members: r.members, joins: r.joins }, [{ wallet: CAROL, amount: 1n, at: t + 100, slot: 20, tx: 'c2' }], req1);
    check('a later run finishes Carol from her running total', later.members[CAROL], { burned: '100', since: { at: t + 100, slot: 20, tx: 'c2' } });
    check('and she leaves joins', later.joins[CAROL], undefined);
    check('the inputs are not changed', r.joins[CAROL].burned, '99');
    const nextWeek = weekStart(W + 1) + 3600;
    const stopped = M.foldJoins({}, [{ wallet: ALICE, amount: 500n, at: t, slot: 1, tx: 'x' }, { wallet: BOB, amount: 500n, at: nextWeek, slot: 2, tx: 'y' }], req1);
    check('folding stops at a send whose week has no amount yet', [stopped.stoppedAt, Object.keys(stopped.members)], [1, [ALICE]]);
    const dearer = M.foldJoins({}, [{ wallet: ALICE, amount: 150n, at: nextWeek, slot: 2, tx: 'y' }], { [W]: '100', [W + 1]: '200' });
    check('a send is held to its own week\'s amount', [dearer.members[ALICE], dearer.joins[ALICE].burned], [undefined, '150']);
  }

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

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
