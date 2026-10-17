'use strict';
/**
 * membership — the rules of OT+T membership on Solana, in one place for the weekly ledger
 * (scripts/allowances.js) and the API (site/api/redeem.js). docs/membership.md explains them.
 *
 *   - A wallet joins by sending OTT to the incinerator's token account (`burnAccount`). The amount
 *     is about `burnUsd` dollars of OTT, set once a week from the coin's price (burnTokensFor()).
 *     Sends from one wallet add up; a send is judged against the amount of the week it landed in
 *     (requirementFor()).
 *   - Each member can claim one welcome eSIM from the plans welcomeEligible() accepts.
 *   - Each week's member budget is split by holdings among the members at the snapshot, with no
 *     member above `capMultiple` times the average (cappedShares()).
 *
 * Everything here is pure: transactions and numbers in, decisions out.
 */
const S = require('../../solana.js');
const { weekOf, weekStart } = require('./week');

// A send in the first ten minutes of a week may use the previous week's amount if it is lower:
// a holder who signed just before Monday must not be caught out by the new figure.
const GRACE_S = 10 * 60;
// The app refuses a join amount above this share of the supply, whatever the API says.
const MAX_BURN_SHARE_BPS = 200;

// Dollar shares are rounded DOWN to a hundredth of a cent, so the shares can never add up to more
// than the budget and no rounded share can creep above the cap.
const floor4 = (n) => Math.floor(n * 1e4 + 1e-6) / 1e4;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * The validated membership settings from esim.json, or null when the config has none. A block
 * that is present but wrong throws, because guessing at an amount, a destination or a cap would
 * quietly change who gets what. `burnAccount` may be empty before launch.
 */
function membershipConfig(config) {
  const m = config && config.membership;
  if (m === undefined || m === null) return null;
  const bad = (what) => { throw new Error('esim.json membership needs ' + what); };
  if (typeof m !== 'object' || Array.isArray(m)) bad('to be an object');
  const burnUsd = Number(m.burnUsd);
  if (typeof m.burnUsd !== 'number' || !(burnUsd > 0) || burnUsd > 1000) bad('a burnUsd above 0 and at most 1000 dollars');
  if (m.burnOwner !== S.INCINERATOR) bad('burnOwner to be the incinerator, ' + S.INCINERATOR);
  const burnAccount = m.burnAccount === undefined || m.burnAccount === null ? '' : m.burnAccount;
  if (burnAccount !== '' && !S.isAddress(burnAccount)) bad('a burnAccount that is a Solana address, or empty before launch');
  const capMultiple = Number(m.capMultiple);
  if (!Number.isFinite(capMultiple) || capMultiple < 1) bad('a capMultiple of at least 1');
  const w = m.welcome || {};
  const welcome = { gb: Number(w.gb), days: Number(w.days), maxUsd: Number(w.maxUsd) };
  if (!(welcome.gb > 0) || !Number.isSafeInteger(welcome.days) || welcome.days <= 0 || !(welcome.maxUsd > 0)) {
    bad('a welcome plan with positive gb, whole days and maxUsd');
  }
  return { burnUsd, burnOwner: S.INCINERATOR, burnAccount, capMultiple, welcome };
}

/**
 * Whole tokens worth `burnUsd` at `priceUsd` a token, rounded UP to two significant figures:
 * $5 at $0.0000029 is 1,724,138 tokens, published as 1,800,000. Rounding up keeps the amount at
 * or above the dollar figure, and two figures keep it readable.
 */
function burnTokensFor(burnUsd, priceUsd) {
  const raw = Number(burnUsd) / Number(priceUsd);
  if (!Number.isFinite(raw) || !(raw > 0)) throw new Error('the join amount needs a positive price');
  const whole = Math.ceil(raw - 1e-9);
  if (whole <= 99) return String(Math.max(1, whole));
  const scale = 10 ** (String(whole).length - 2);
  return String(Math.ceil(raw / scale - 1e-9) * scale);
}

/** A week's amount in base units from a `requirements` map, or null. */
function weekAmount(requirements, week) {
  const raw = requirements && requirements[String(week)];
  if (typeof raw !== 'string' || !/^\d{1,40}$/.test(raw)) return null;
  const units = BigInt(raw);
  return units > 0n ? units : null;
}

/**
 * The amount a send that landed at `at` (unix seconds) must reach: its week's amount, or in the
 * first GRACE_S of a week the lower of that and the previous week's. null when its week has no
 * amount yet, which means the send cannot be judged until the keeper prices that week.
 */
function requirementFor(requirements, at) {
  const t = Number(at);
  if (!Number.isFinite(t)) return null;
  const week = weekOf(t);
  const own = weekAmount(requirements, week);
  if (own === null) return null;
  if (t - weekStart(week) < GRACE_S) {
    const previous = weekAmount(requirements, week - 1);
    if (previous !== null && previous < own) return previous;
  }
  return own;
}

/** An ordinary wallet: a canonical address that is a point on the ed25519 curve, so not a program account. */
function isWallet(address) {
  const bytes = S.addressBytes(address);
  return !!bytes && S.isOnCurve(bytes);
}

/**
 * What one transaction did for membership: null when it moved no OTT into `burnAccount`;
 * { skip: reason } when it did but no single wallet can be credited; otherwise
 * { wallet, amount, tx, slot, at } with `amount` the OTT (base units) the incinerator's account
 * gained. `exclude` lists wallets that are never members (the treasury).
 */
function joinFromTransaction(tx, { coin, burnAccount, exclude = [] }) {
  if (!tx || !S.succeeded(tx) || !coin || !burnAccount) return null;
  const changes = S.tokenChanges(tx, coin);
  const dest = changes.find((c) => c.account === burnAccount);
  if (!dest || dest.post <= dest.pre) return null;
  const amount = dest.post - dest.pre;
  const meta = {
    tx: (tx.transaction && Array.isArray(tx.transaction.signatures) && tx.transaction.signatures[0]) || null,
    slot: Number(tx.slot), at: Number(tx.blockTime),
  };
  const owners = [...new Set(changes.filter((c) => c.account !== burnAccount && c.post < c.pre).map((c) => c.owner))];
  if (owners.length !== 1 || !owners[0]) return Object.assign({ skip: owners.length ? 'several senders' : 'no sender', amount }, meta);
  const wallet = owners[0];
  if (!isWallet(wallet)) return Object.assign({ skip: 'the sender is not an ordinary wallet', wallet, amount }, meta);
  if (exclude.includes(wallet)) return Object.assign({ skip: 'the sender is a project wallet', wallet, amount }, meta);
  return Object.assign({ wallet, amount }, meta);
}

/**
 * Fold joins, in chain order, into the ledger's `members` and `joins` maps (copies are returned;
 * the inputs are not changed). A wallet becomes a member at the first send that takes its running
 * total to the amount for that send's week. Folding stops at the first send whose week has no
 * amount yet; `stoppedAt` is its index (or the length of `events` when every send was folded),
 * so the caller's cursor never moves past a send that was not judged.
 */
function foldJoins({ members = {}, joins = {} }, events, requirements) {
  const outMembers = {};
  for (const [wallet, row] of Object.entries(members)) outMembers[wallet] = Object.assign({}, row);
  const outJoins = {};
  for (const [wallet, row] of Object.entries(joins)) outJoins[wallet] = Object.assign({}, row);
  let stoppedAt = events.length;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const amount = BigInt(e.amount);
    const member = outMembers[e.wallet];
    if (member) { member.burned = (BigInt(member.burned) + amount).toString(); continue; }
    const need = requirementFor(requirements, e.at);
    if (need === null) { stoppedAt = i; break; }
    const total = BigInt((outJoins[e.wallet] && outJoins[e.wallet].burned) || '0') + amount;
    const at = { at: e.at, slot: e.slot, tx: e.tx };
    if (total >= need) {
      outMembers[e.wallet] = { burned: total.toString(), since: at };
      delete outJoins[e.wallet];
    } else {
      outJoins[e.wallet] = { burned: total.toString(), last: at };
    }
  }
  return { members: outMembers, joins: outJoins, stoppedAt };
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

module.exports = {
  GRACE_S, MAX_BURN_SHARE_BPS, membershipConfig, burnTokensFor, weekAmount, requirementFor, isWallet,
  joinFromTransaction, foldJoins, cappedShares, welcomeEligible, unitsOf: S.unitsOf, floor4, round4,
};
