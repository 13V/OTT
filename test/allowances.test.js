#!/usr/bin/env node
'use strict';
/**
 * scripts/allowances.js, against a small fake Solana chain.
 *
 * The ledger decides who gets free data, so it is run here week after week over one consistent
 * world: a pump.fun coin on its bonding curve, wallets that buy and then send OTT to the
 * incinerator, creator-fee collections into the treasury (and things that look like them but are
 * not), and members' token accounts whose history decides what they held at each Monday snapshot.
 * The fake chain indexes every transaction under every account it touches and answers
 * getSignaturesForAddress with the real until/before/limit semantics, so the cursors, the paging
 * and the balance-at-a-moment walk are exercised rather than assumed. Prices are injected.
 *
 *   node test/allowances.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require(path.join(__dirname, '..', 'scripts', 'allowances.js'));
const C = require(path.join(__dirname, '..', 'scripts', 'solana-chain.js'));
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));

let failures = 0, total = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
function check(what, got, want) {
  total++;
  if (norm(got) !== norm(want)) { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
  else console.log(`  ok   ${what}`);
}
function checkThat(what, cond, detail) {
  total++;
  if (!cond) { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
  else console.log(`  ok   ${what}`);
}
async function rejects(what, promise, pattern) {
  total++;
  try { await promise; failures++; console.error(`  FAIL ${what}\n       resolved instead of throwing`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}\n       threw "${e.message}"`); }
  }
}
function throws(what, fn, pattern) {
  total++;
  try { fn(); failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); }
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-allowances-'));
const outPath = (name) => path.join(TMP, name + '.json');
const readOut = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// Real wallets are points on the ed25519 curve; these are fresh keys.
const wallet = () => S.encodeBase58(new Uint8Array(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
const randomAddress = () => S.encodeBase58(new Uint8Array(crypto.randomBytes(32)));
const randomSignature = () => S.encodeBase58(new Uint8Array(crypto.randomBytes(64)));
const T22 = S.PROGRAMS.token2022;
const OTT = (n) => BigInt(Math.round(n * 1e6)); // whole OTT in base units (6 decimals)
const SOL = (n) => BigInt(Math.round(n * 1e9));

// ---------------------------------------------------------------------------------------------
// The fake chain
// ---------------------------------------------------------------------------------------------
function curveData({ vt = 1073000000000000n, vq = 30000000000n, complete = false, creator, quoteMint = null, holderReward = false, cashback = false }) {
  const b = Buffer.alloc(166);
  Buffer.from(C.DISC.bondingCurve).copy(b, 0);
  b.writeBigUInt64LE(vt, 8); b.writeBigUInt64LE(vq, 16); b.writeBigUInt64LE(793100000000000n, 24); b.writeBigUInt64LE(0n, 32);
  b.writeBigUInt64LE(1000000000000000n, 40);
  b[48] = complete ? 1 : 0;
  Buffer.from(S.decodeBase58(creator)).copy(b, 49);
  b[82] = cashback ? 1 : 0;
  if (quoteMint) Buffer.from(S.decodeBase58(quoteMint)).copy(b, 83);
  b[124] = holderReward ? 1 : 0;
  return [b.toString('base64'), 'base64'];
}
function poolData({ baseMint, quoteMint = S.MINTS.wsol, baseVault, quoteVault, coinCreator, creator, virtualQuote = 0n }) {
  const b = Buffer.alloc(301);
  Buffer.from(C.DISC.pool).copy(b, 0);
  b[8] = 255; b.writeUInt16LE(0, 9);
  for (const [at, key] of [[11, creator], [43, baseMint], [75, quoteMint], [107, randomAddress()], [139, baseVault], [171, quoteVault], [211, coinCreator]]) Buffer.from(S.decodeBase58(key)).copy(b, at);
  b.writeBigInt64LE(virtualQuote >> 64n, 253); b.writeBigUInt64LE(virtualQuote & ((1n << 64n) - 1n), 245);
  return [b.toString('base64'), 'base64'];
}
function mintData({ supply = 1000000000000000n, decimals = 6 } = {}) {
  const b = Buffer.alloc(82);
  b.writeBigUInt64LE(supply, 36); b[44] = decimals; b[45] = 1;
  return [b.toString('base64'), 'base64'];
}

function fakeChain() {
  const accounts = new Map();
  const history = new Map();
  const txs = new Map();
  const unreadable = new Set();
  const calls = [];
  let slot = 5000;
  let lastAt = 0;
  function add({ at, signer, keys = [], tokens = [], lamports = {}, fee = 5000, err = null }) {
    if (at < lastAt) throw new Error('fixture transactions must be added in time order');
    lastAt = at;
    slot += 10;
    const signature = randomSignature();
    const order = [signer];
    const push = (k) => { if (k && !order.includes(k)) order.push(k); };
    keys.forEach(push); tokens.forEach((t) => push(t.account)); Object.keys(lamports).forEach(push);
    const pre = [], post = [];
    for (const t of tokens) {
      const i = order.indexOf(t.account);
      const row = (amount) => ({ accountIndex: i, mint: t.mint, owner: t.owner, programId: T22, uiTokenAmount: { amount: String(amount), decimals: 6 } });
      if (t.pre !== null && t.pre !== undefined) pre.push(row(t.pre));
      if (t.post !== null && t.post !== undefined) post.push(row(t.post));
    }
    const tx = {
      slot, blockTime: at, version: 0,
      meta: { err, fee, preBalances: order.map((k) => Number((lamports[k] || [0, 0])[0])), postBalances: order.map((k) => Number((lamports[k] || [0, 0])[1])), preTokenBalances: pre, postTokenBalances: post },
      transaction: { signatures: [signature], message: { accountKeys: order.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true, source: 'transaction' })) } },
    };
    txs.set(signature, tx);
    for (const k of order) {
      if (!history.has(k)) history.set(k, []);
      history.get(k).unshift({ signature, slot, blockTime: at, err, confirmationStatus: 'finalized' });
    }
    return signature;
  }
  async function rpc(method, params = []) {
    calls.push([method, params[0]]);
    switch (method) {
      case 'getSlot': return slot;
      case 'getAccountInfo': { const a = accounts.get(params[0]); return { context: { slot }, value: a ? Object.assign({ lamports: 0, executable: false }, a) : null }; }
      case 'getMultipleAccounts': return { context: { slot }, value: params[0].map((k) => (accounts.has(k) ? Object.assign({ lamports: 0 }, accounts.get(k)) : null)) };
      case 'getSignaturesForAddress': {
        const [address, opts = {}] = params;
        let list = history.get(address) || [];
        if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); if (i >= 0) list = list.slice(0, i); }
        if (opts.before) { const i = list.findIndex((s) => s.signature === opts.before); list = i >= 0 ? list.slice(i + 1) : []; }
        return list.slice(0, opts.limit || 1000);
      }
      case 'getTransaction': return unreadable.has(params[0]) ? null : (txs.get(params[0]) || null);
      case 'getTokenAccountsByOwner': return { context: { slot }, value: [] };
      default: throw new Error('the fake chain does not answer ' + method);
    }
  }
  const count = (method, address) => calls.filter(([m, a]) => m === method && (address === undefined || a === address)).length;
  return { accounts, history, txs, unreadable, add, rpc, calls, count };
}

/** A launched coin on its bonding curve, with the config that matches it. */
async function world({ priceVq = 30000000000n, holderReward = false, cashback = false, quoteMint = null } = {}) {
  const chain = fakeChain();
  const coin = randomAddress();
  const treasury = wallet();
  const burnAccount = await S.associatedTokenAddress(S.INCINERATOR, coin, T22);
  const curve = await C.bondingCurveAddress(coin);
  chain.accounts.set(coin, { owner: T22, data: mintData() });
  chain.accounts.set(curve, { owner: S.PROGRAMS.pump, data: curveData({ vq: priceVq, creator: treasury, holderReward, cashback, quoteMint }) });
  const config = {
    chain: 'solana', coin, tokenProgram: T22, treasury, budgetBps: 8000,
    membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount, capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } },
  };
  const vault = await C.creatorVaultAddress(treasury);
  const ammVault = await C.ammCreatorVaultAccount(treasury);
  const ata = (owner) => S.associatedTokenAddress(owner, coin, T22);
  const balance = new Map(); // owner -> OTT units held in its associated account
  async function buy(owner, amount, at) {
    const account = await ata(owner);
    const before = balance.get(owner);
    balance.set(owner, (before || 0n) + amount);
    return chain.add({ at, signer: owner, keys: [curve], tokens: [{ account, mint: coin, owner, pre: before === undefined ? null : before, post: balance.get(owner) }] });
  }
  async function sell(owner, amount, at) {
    const account = await ata(owner);
    const before = balance.get(owner);
    balance.set(owner, before - amount);
    return chain.add({ at, signer: owner, keys: [curve], tokens: [{ account, mint: coin, owner, pre: before, post: balance.get(owner) }] });
  }
  let burned = null;
  async function join(owner, amount, at) {
    const account = await ata(owner);
    const before = balance.get(owner);
    balance.set(owner, before - amount);
    const pre = burned;
    burned = (burned || 0n) + amount;
    return chain.add({ at, signer: owner, keys: [S.PROGRAMS.associatedToken, coin], tokens: [
      { account, mint: coin, owner, pre: before, post: balance.get(owner) },
      { account: burnAccount, mint: coin, owner: S.INCINERATOR, pre, post: burned }] });
  }
  /** A collection from the bonding-curve creator vault, paid for by the treasury. */
  function collect(lamports, at, { fee = 5000 } = {}) {
    return chain.add({ at, signer: treasury, keys: [vault, curve, S.PROGRAMS.pump], fee, lamports: { [treasury]: [SOL(1), SOL(1) + lamports - BigInt(fee)], [vault]: [lamports + 890880n, 890880n] } });
  }
  return { chain, config, coin, treasury, burnAccount, curve, vault, ammVault, ata, buy, sell, join, collect, balance };
}

const W = 2965;
const at = (week, seconds) => A.weekStart(week) + seconds;
const clock = (week, seconds) => () => at(week, seconds) * 1000;
/** Prices: SOL now, and SOL at a given hour (by default $100, with overrides per hour). */
function prices(now = 100, hours = {}) {
  return { now: async () => { if (now instanceof Error) throw now; return now; }, at: async (t) => { const h = Math.floor(t / 3600) * 3600; const v = hours[h]; if (v instanceof Error) throw v; return v === undefined ? 100 : v; } };
}

(async () => {
  console.log('before launch: an empty ledger, whatever the RPC does');
  {
    const out = outPath('empty');
    const dead = async () => { throw new Error('every endpoint is down'); };
    const r = await A.run({ config: { chain: 'solana', coin: '', tokenProgram: '', treasury: '', membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: '' } }, rpc: dead, out, now: clock(W, 100) });
    const f = readOut(out);
    check('the empty ledger names the week and nothing else', [f.chain, f.week, f.weekStart, f.weekEnd, f.coin, f.decimals, f.budgetUsd, f.budgetSource],
      ['solana', W, A.weekStart(W), A.weekEnd(W), '', null, 0, 'the coin is not launched yet']);
    check('with no members, joins, wallets or membership block', [f.membership, f.members, f.joins, f.wallets, f.holders, f.memberTokens, f.fees], [null, {}, {}, {}, 0, '0', null]);
    check('the slot falls back to 0 when the chain cannot be reached', f.slot, 0);
    checkThat('and it says why', /not launched/.test(r.summary), r.summary);
    const partial = await A.run({ config: { chain: 'solana', coin: randomAddress(), tokenProgram: '', treasury: '', membership: {} }, rpc: dead, out: outPath('partial'), now: clock(W, 100) });
    check('a half-filled launch config is still not launched', partial.data.membership, null);
  }

  console.log('\nthe first weeks of a launched coin');
  const w1 = await world();
  const ALICE = wallet(), BOB = wallet(), CAROL = wallet(), DAVE = wallet(), ERIN = wallet();
  // A collection in week W-2, before anyone joined: it is week W-1's budget.
  await w1.collect(SOL(1), at(W - 2, 3600 * 30));
  await w1.buy(ALICE, OTT(5000000), at(W - 1, 1000));
  await w1.join(ALICE, OTT(1800000), at(W - 1, 2000));
  await w1.buy(BOB, OTT(10000000), at(W - 1, 3000));
  await w1.join(BOB, OTT(1000000), at(W - 1, 3500));   // short of 1.8M…
  await w1.join(BOB, OTT(800000), at(W - 1, 4000));    // …then over it with his second send
  const ledger = outPath('ledger');
  {
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W - 1, 5000), prices: prices(100) });
    const f = readOut(ledger);
    check('week W-1 is priced at its first run: $5 at $0.0000028 is 1,800,000 OTT', [f.membership.requirement.week, f.membership.requirement.burnTokens, f.membership.requirement.burnUnits, f.membership.requirement.source],
      [W - 1, '1800000', '1800000000000', 'bonding-curve']);
    checkThat('the price recorded is the curve price times SOL', Math.abs(f.membership.requirement.priceUsd - (30e9 / 1.073e15 / 1000) * 100) < 1e-15, f.membership.requirement.priceUsd);
    check('and the amount goes into the history of amounts', f.membership.requirements, { [W - 1]: '1800000000000' });
    check('Alice joined with one send', f.members[ALICE].burned, '1800000000000');
    check('Bob joined with his second send, and both are recorded', [f.members[BOB].burned, f.members[BOB].since.at], ['1800000000000', at(W - 1, 4000)]);
    check('nobody joined before this week\'s snapshot, so nobody shares yet', [f.holders, f.wallets, f.membership.members], [0, {}, 0]);
    check('week W-1\'s budget is 80% of the $100 collected in week W-2', [f.budgetUsd, f.budgetSource], [80, `creator fees collected in week ${W - 2}`]);
    check('the collection is recorded with its price', f.fees.collections.map((c) => [c.lamports, c.solUsd, c.usd]), [['1000000000', 100, 100]]);
    check('the cursor sits on the last send read', f.membership.cursor.signature, w1.chain.history.get(w1.burnAccount)[0].signature);
    check('decimals and the token program come from the mint', [f.decimals, f.tokenProgram, f.treasury], [6, T22, w1.treasury]);
    checkThat('the run reports it wrote the file', r.written);
  }
  {
    const before = fs.readFileSync(ledger, 'utf8');
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W - 1, 9000), prices: prices(50) });
    check('a second run in the same week never reprices: still 1,800,000 at half the SOL price', readOut(ledger).membership.requirement.burnTokens, '1800000');
    check('with nothing new on chain, the file is not rewritten', [r.written, fs.readFileSync(ledger, 'utf8') === before], [false, true]);
  }
  {
    // Spam lands on the treasury: the cursor would move, but nothing in the ledger changes.
    w1.chain.add({ at: at(W - 1, 9500), signer: wallet(), keys: [], lamports: { [w1.treasury]: [SOL(1), SOL(1) + 1000n] } });
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W - 1, 9600), prices: prices(100) });
    check('a cursor moving over spam alone does not rewrite the file', r.written, false);
  }
  // Week W-1's fees: two collections at different hours and prices, a sale of OTT by the treasury
  // that touches the vault (not a fee), and a donation that never touched a vault (not a fee).
  const h1 = Math.floor(at(W - 1, 20000) / 3600) * 3600, h2 = Math.floor(at(W - 1, 90000) / 3600) * 3600;
  await w1.collect(SOL(0.5), at(W - 1, 20000));
  w1.balance.set(w1.treasury, OTT(1000));
  w1.chain.add({ at: at(W - 1, 30000), signer: w1.treasury, keys: [w1.vault, w1.curve], tokens: [{ account: await w1.ata(w1.treasury), mint: w1.coin, owner: w1.treasury, pre: OTT(1000), post: 0n }], lamports: { [w1.treasury]: [SOL(1), SOL(3)] } });
  w1.chain.add({ at: at(W - 1, 40000), signer: wallet(), keys: [], lamports: { [w1.treasury]: [SOL(1), SOL(1.5)] } });
  await w1.collect(SOL(0.25), at(W - 1, 90000));
  {
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W - 1, 100000), prices: prices(100, { [h1]: 100, [h2]: 120 }) });
    const f = readOut(ledger);
    check('each collection is valued at its own hour\'s SOL price', f.fees.collections.slice(1).map((c) => [c.lamports, c.solUsd, c.usd]), [['500000000', 100, 50], ['250000000', 120, 30]]);
    check('a sale of OTT by the treasury and a plain transfer in are not fees', f.fees.collections.length, 3);
    check('weekly totals', f.fees.weekUsd, { [W - 2]: 100, [W - 1]: 80 });
    check('this week\'s budget is still last week\'s fees', f.budgetUsd, 80);
    checkThat('new collections rewrite the file', r.written);
  }

  console.log('\nthe next week: the snapshot and the split');
  // Carol joins after Monday's snapshot; she is a member but does not share until next week.
  await w1.buy(CAROL, OTT(3000000), at(W, 2000));
  await w1.join(CAROL, OTT(900000), at(W, 2500));
  {
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W, 3600), prices: prices(200) });
    const f = readOut(ledger);
    check('week W is priced afresh: $5 at twice the SOL price is 900,000 OTT', [f.membership.requirement.week, f.membership.requirement.burnTokens], [W, '900000']);
    check('and week W-1\'s amount is kept as it was', f.membership.requirements, { [W - 1]: '1800000000000', [W]: '900000000000' });
    check('Carol joined against this week\'s amount', f.members[CAROL].burned, '900000000000');
    check('Alice and Bob share; Carol joined after the snapshot', Object.keys(f.wallets).sort(), [ALICE, BOB].sort());
    check('holdings are what each held at the snapshot, after their sends', [f.wallets[ALICE].tokens, f.wallets[BOB].tokens], ['3200000000000', '8200000000000']);
    check('the budget is 80% of week W-1\'s $80 of fees', [f.budgetUsd, f.budgetSource], [64, `creator fees collected in week ${W - 1}`]);
    check('shared by holdings, under the 3x cap', [f.wallets[ALICE].allowanceUsd, f.wallets[BOB].allowanceUsd, f.membership.capUsd], [17.9649, 46.035, 96]);
    check('shares are fractions of the members\' OTT', [f.memberTokens, f.wallets[BOB].share], ['11400000000000', 8200 / 11400]);
    check('holders and the sharing count agree', [f.holders, f.membership.members], [2, 2]);
    checkThat('the budget is fully placed', Math.abs(f.membership.allocatedUsd + f.membership.unallocatedUsd - 64) < 1e-9 && r.written);
  }
  {
    // Later the same week: holdings are reused, not read again. Alice's history now cannot be read,
    // which would fail the run if it were.
    const aliceAta = await w1.ata(ALICE);
    for (const s of w1.chain.history.get(aliceAta)) w1.chain.unreadable.add(s.signature);
    const reads = w1.chain.count('getSignaturesForAddress', aliceAta);
    let r = null, error = null;
    try { r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W, 50000), prices: prices(300) }); } catch (e) { error = e.message; }
    check('holdings read once a week are reused within it', [error, w1.chain.count('getSignaturesForAddress', aliceAta) - reads, r && r.written], [null, 0, false]);
    check('and the week\'s amount is still 900,000', readOut(ledger).membership.requirement.burnTokens, '900000');
    for (const s of w1.chain.history.get(aliceAta)) w1.chain.unreadable.delete(s.signature);
  }

  console.log('\na send that cannot be read holds the cursor');
  await w1.buy(DAVE, OTT(2000000), at(W, 60000));
  const daveJoin = await w1.join(DAVE, OTT(900000), at(W, 61000));
  await w1.buy(ERIN, OTT(2000000), at(W, 62000));
  await w1.join(ERIN, OTT(900000), at(W, 63000));
  {
    w1.chain.unreadable.add(daveJoin);
    const r = await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W, 70000), prices: prices(100) });
    const f = readOut(ledger);
    check('neither Dave nor Erin, whose send comes after his, is a member yet', [!!f.members[DAVE], !!f.members[ERIN]], [false, false]);
    check('the cursor stays on the send before Dave\'s', f.membership.cursor.signature, w1.chain.history.get(w1.burnAccount)[2].signature);
    checkThat('and the run says why', r.warnings.some((w) => w.includes(daveJoin)), r.warnings.join('; '));
    w1.chain.unreadable.delete(daveJoin);
    await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W, 80000), prices: prices(100) });
    const g = readOut(ledger);
    check('the next run resumes from it and finds both', [g.members[DAVE].burned, g.members[ERIN].burned], ['900000000000', '900000000000']);
    check('and the cursor reaches the newest send', g.membership.cursor.signature, w1.chain.history.get(w1.burnAccount)[0].signature);
  }

  console.log('\na new week recomputes holdings, and a holding that cannot be read stops the run');
  await w1.sell(ALICE, OTT(1200000), at(W, 90000));
  {
    const aliceAta = await w1.ata(ALICE);
    const newest = w1.chain.history.get(aliceAta)[0].signature;
    w1.chain.unreadable.add(newest);
    const before = fs.readFileSync(ledger, 'utf8');
    await rejects('a member whose holding cannot be read fails the run', A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W + 1, 3600), prices: prices(100) }), new RegExp('what ' + ALICE + ' held'));
    check('and nothing is written', fs.readFileSync(ledger, 'utf8') === before, true);
    w1.chain.unreadable.delete(newest);
    await A.run({ config: w1.config, rpc: w1.chain.rpc, out: ledger, now: clock(W + 1, 3600), prices: prices(100) });
    const f = readOut(ledger);
    check('week W+1\'s snapshot: Alice sold 1.2M, and the later joiners share now', [f.wallets[ALICE].tokens, Object.keys(f.wallets).length], ['2000000000000', 5]);
    check('the budget follows week W\'s fees, of which there were none', f.budgetUsd, 0);
    check('every week\'s amount is kept', Object.keys(f.membership.requirements), [String(W - 1), String(W), String(W + 1)]);
  }

  console.log('\ncollections are kept for three weeks, weekly totals for longer');
  {
    const r = A.mergeFees({ collections: [{ tx: 'a', at: at(W - 3, 10), slot: 1, usd: 5 }, { tx: 'b', at: at(W - 2, 10), slot: 2, usd: 7 }], weekUsd: { [W - 9]: 1, [W - 3]: 5 }, found: [{ tx: 'c', at: at(W, 10), slot: 3, usd: 2 }], week: W });
    check('collections older than three weeks are dropped', r.collections.map((c) => c.tx), ['b', 'c']);
    check('totals keep eight weeks and include the dropped collection\'s week', r.weekUsd, { [W - 3]: 5, [W - 2]: 7, [W]: 2 });
  }

  console.log('\nsends in a week the keeper never priced');
  {
    // The coin launched and people joined in week W-1, but the keeper's first run is in week W.
    const w2 = await world();
    const FRANK = wallet();
    await w2.buy(FRANK, OTT(5000000), at(W - 1, 1000));
    await w2.join(FRANK, OTT(1800000), at(W - 1, 2000));
    const out = outPath('late-start');
    await A.run({ config: w2.config, rpc: w2.chain.rpc, out, now: clock(W, 1000), prices: prices(100) });
    const f = readOut(out);
    check('a send before the first priced week is judged against the first amount', [f.members[FRANK] && f.members[FRANK].burned, f.membership.requirements], ['1800000000000', { [W - 1]: '1800000000000', [W]: '1800000000000' }]);
    check('fillPastWeeks uses the most recent earlier amount when there is one', A.fillPastWeeks({ 10: '5', 12: '7' }, [11, 13, 14], 14), { 10: '5', 11: '5', 12: '7', 13: '7' });
    check('and never fills the current week', A.fillPastWeeks({ 10: '5' }, [12], 12), { 10: '5' });
  }

  console.log('\na join amount that cannot be priced');
  {
    const w3 = await world();
    const GINA = wallet();
    await w3.buy(GINA, OTT(5000000), at(W, 1000));
    await w3.join(GINA, OTT(1800000), at(W, 2000));
    const out = outPath('no-price');
    const r = await A.run({ config: w3.config, rpc: w3.chain.rpc, out, now: clock(W, 3000), prices: prices(new Error('Coinbase and Kraken are down')) });
    const f = readOut(out);
    check('leaves this week\'s amount unset', [f.membership.requirement, f.membership.requirements], [null, {}]);
    check('and this week\'s sends wait, the cursor before them', [Object.keys(f.members).length, f.membership.cursor], [0, null]);
    checkThat('with a warning, not a failure', r.warnings.some((w) => /could not be priced/.test(w)), r.warnings.join('; '));
    await A.run({ config: w3.config, rpc: w3.chain.rpc, out, now: clock(W, 4000), prices: prices(100) });
    check('once priced, they are judged', readOut(out).members[GINA].burned, '1800000000000');
  }

  console.log('\nthe join amount is held to 2% of the supply');
  {
    const w4 = await world({ priceVq: 1000000000n }); // 1 SOL of virtual reserves: a very cheap coin
    const out = outPath('capped');
    await A.run({ config: w4.config, rpc: w4.chain.rpc, out, now: clock(W, 100), prices: prices(100) });
    const req = readOut(out).membership.requirement;
    check('$5 would buy 50M OTT; the amount is held at 20M', [req.burnTokens, req.burnUnits, req.capped], ['20000000', '20000000000000', true]);
  }

  console.log('\nthe split caps a whale');
  {
    const w5 = await world();
    const whale = wallet(), small = [wallet(), wallet(), wallet()];
    await w5.collect(SOL(1), at(W - 1, 100));
    await w5.buy(whale, OTT(101800000), at(W - 1, 1000));
    await w5.join(whale, OTT(1800000), at(W - 1, 1100));
    for (const [i, s] of small.entries()) { await w5.buy(s, OTT(2800000), at(W - 1, 2000 + i * 10)); await w5.join(s, OTT(1800000), at(W - 1, 2005 + i * 10)); }
    const out = outPath('whale');
    await A.run({ config: w5.config, rpc: w5.chain.rpc, out, now: clock(W - 1, 5000), prices: prices(100) });
    await A.run({ config: w5.config, rpc: w5.chain.rpc, out, now: clock(W, 100), prices: prices(100) });
    const f = readOut(out);
    check('the budget is $80 among four members; the cap is 3x the $20 average', [f.budgetUsd, f.membership.capUsd], [80, 60]);
    check('the whale, with 97% of the OTT, is held at $60', f.wallets[whale].allowanceUsd, 60);
    check('the three small members share the rest equally', small.map((s) => f.wallets[s].allowanceUsd), [6.6666, 6.6666, 6.6666]);
  }

  console.log('\nthe coin must be the configured one');
  {
    const w6 = await world();
    await rejects('a pump.fun creator other than the treasury is refused', A.run({ config: Object.assign({}, w6.config, { treasury: wallet() }), rpc: w6.chain.rpc, out: outPath('r1'), now: clock(W, 1) }), /pump\.fun creator is .* but esim\.json says the treasury is/);
    await rejects('a mint owned by another program is refused', A.run({ config: Object.assign({}, w6.config, { tokenProgram: S.PROGRAMS.token }), rpc: w6.chain.rpc, out: outPath('r2'), now: clock(W, 1) }), /belongs to .* but esim\.json says tokenProgram/);
    await rejects('a burn account that is not the incinerator\'s is refused', A.run({ config: Object.assign({}, w6.config, { membership: Object.assign({}, w6.config.membership, { burnAccount: wallet() }) }), rpc: w6.chain.rpc, out: outPath('r3'), now: clock(W, 1) }), /must be the incinerator's account for the coin/);
    const w7 = await world({ holderReward: true });
    await rejects('a holder rewards coin is refused: its creator fee never reaches the treasury', A.run({ config: w7.config, rpc: w7.chain.rpc, out: outPath('r4'), now: clock(W, 1) }), /holder rewards coin/);
    const w8 = await world({ quoteMint: S.MINTS.usdc });
    await rejects('a coin not paired with SOL is refused', A.run({ config: w8.config, rpc: w8.chain.rpc, out: outPath('r5'), now: clock(W, 1) }), /SOL-paired coins only/);
    const w9 = await world({ cashback: true });
    const r = await A.run({ config: w9.config, rpc: w9.chain.rpc, out: outPath('r6'), now: clock(W, 1), prices: prices(100) });
    checkThat('a cashback coin is indexed, with a warning', r.warnings.some((w) => /cashback/.test(w)), r.warnings.join('; '));
    checkThat('none of the refusals wrote a file', ['r1', 'r2', 'r3', 'r4', 'r5'].every((n) => !fs.existsSync(outPath(n))));
  }

  console.log('\na graduated coin is priced from its pool');
  {
    const w10 = await world();
    w10.chain.accounts.set(w10.curve, { owner: S.PROGRAMS.pump, data: curveData({ complete: true, creator: w10.treasury }) });
    const pool = await C.poolAddress(w10.coin);
    const baseVault = randomAddress(), quoteVault = randomAddress();
    w10.chain.accounts.set(pool, { owner: S.PROGRAMS.pumpAmm, data: poolData({ baseMint: w10.coin, baseVault, quoteVault, coinCreator: w10.treasury, creator: await C.poolAuthorityAddress(w10.coin), virtualQuote: SOL(10) }) });
    w10.chain.accounts.set(baseVault, { owner: S.PROGRAMS.token2022, data: { parsed: { info: { tokenAmount: { amount: String(OTT(200000000)) } } } } });
    w10.chain.accounts.set(quoteVault, { owner: S.PROGRAMS.token, data: { parsed: { info: { tokenAmount: { amount: String(SOL(90)) } } } } });
    const out = outPath('graduated');
    await A.run({ config: w10.config, rpc: w10.chain.rpc, out, now: clock(W, 1), prices: prices(100) });
    const req = readOut(out).membership.requirement;
    // (90 + 10) SOL over 200M OTT is 5e-7 SOL a token, $0.00005 at $100: $5 is 100,000 OTT.
    check('from effective pool reserves', [req.source, req.burnTokens], ['pool', '100000']);
    w10.chain.accounts.set(pool, { owner: S.PROGRAMS.pumpAmm, data: poolData({ baseMint: w10.coin, baseVault, quoteVault, coinCreator: wallet(), creator: await C.poolAuthorityAddress(w10.coin) }) });
    await rejects('after graduation the pool\'s coin creator must be the treasury', A.run({ config: w10.config, rpc: w10.chain.rpc, out: outPath('r7'), now: clock(W, 1) }), /pump\.fun creator is/);
  }

  console.log('\nhistory goes only to nodes that keep it');
  {
    const HEAD = 458000000;
    const fakeUrl = (first) => async (method) => { if (first instanceof Error) throw first; return method === 'getSlot' ? HEAD : first; };
    const answers = { 'https://archive.test': fakeUrl(0), 'https://shallow.test': fakeUrl(HEAD - 412000), 'https://down.test': fakeUrl(new Error('HTTP 429')), 'https://old.test': fakeUrl(HEAD - A.DEEP_HISTORY_SLOTS) };
    check('a node with all of history and one remembering 400 days qualify; two days, or no answer, do not',
      await A.deepHistoryEndpoints(Object.keys(answers), { makeCall: (url) => answers[url] }), ['https://archive.test', 'https://old.test']);
    // A public node with two days of ledger answers an older account's history with an empty list.
    const w12 = await world();
    const HANK = wallet();
    await w12.buy(HANK, OTT(5000000), at(W - 1, 1000));
    await w12.join(HANK, OTT(1800000), at(W - 1, 2000));
    const shallow = async (method, params) => (method === 'getSignaturesForAddress' ? [] : w12.chain.rpc(method, params));
    const blind = await A.run({ config: w12.config, rpc: shallow, historyRpc: shallow, out: outPath('shallow'), now: clock(W, 1000), prices: prices(100) });
    check('read through such a node, the join is simply not there', Object.keys(blind.data.members).length, 0);
    const seen = await A.run({ config: w12.config, rpc: shallow, historyRpc: w12.chain.rpc, out: outPath('deep'), now: clock(W, 1000), prices: prices(100) });
    check('so history calls go to the history node, whatever the other one says', [Object.keys(seen.data.members), seen.data.wallets[HANK] && seen.data.wallets[HANK].tokens], [[HANK], '3200000000000']);
  }
  {
    const waits = [];
    let n = 0;
    const busy = A.patient(async () => { n++; if (n < 3) throw new Error('getTransaction failed on every Solana endpoint: HTTP 429'); return 7; }, { sleep: async (ms) => { waits.push(ms); } });
    check('a rate limit is waited out, with growing pauses', [await busy('getTransaction', []), waits], [7, [2000, 4000]]);
    let m = 0;
    const wrong = A.patient(async () => { m++; throw new Error('Invalid param: could not find account'); }, { sleep: async () => {} });
    await rejects('anything else fails at once', wrong('getAccountInfo', []), /Invalid param/);
    check('without a retry', m, 1);
    const down = A.patient(async () => { throw new Error('HTTP 503'); }, { tries: 3, sleep: async () => {} });
    await rejects('and a rate limit that never lifts fails in the end', down('getSlot', []), /HTTP 503/);
  }

  console.log('\nwrites, comparisons and the rehearsal guard');
  {
    const base = { asOf: 1, slot: 2, week: 3, fees: { cursor: { signature: 'x', slot: 1 }, weekUsd: {} }, membership: { cursor: { signature: 'y', slot: 1 }, members: 0 } };
    check('the clock and the cursors are not changes', A.sameButForTheClock(base, Object.assign({}, base, { asOf: 9, slot: 9, fees: { cursor: { signature: 'z', slot: 2 }, weekUsd: {} }, membership: { cursor: null, members: 0 } })), true);
    check('anything else is', A.sameButForTheClock(base, Object.assign({}, base, { membership: { cursor: null, members: 1 } })), false);
    throws('a rehearsal without --out is refused', () => A.rehearsalOut(undefined), /needs --out/);
    throws('a rehearsal never writes into site/data/', () => A.rehearsalOut(path.join(__dirname, '..', 'site', 'data', 'allowances.json')), /never writes into site\/data/);
    check('anywhere else is fine', A.rehearsalOut(outPath('rehearsal')), outPath('rehearsal'));
    check('the CLI flags', A.parseArgs(['--rehearse', 'Mint1', '--out', '/tmp/x.json', '--history-limit', '50']), { out: '/tmp/x.json', rehearse: 'Mint1', historyLimit: 50 });
    const w11 = await world();
    const cfg = await A.rehearsalConfig(w11.chain.rpc, { chain: 'solana', coin: '', tokenProgram: '', treasury: '', budgetBps: 8000, membership: { burnUsd: 5, burnOwner: S.INCINERATOR, burnAccount: '', capMultiple: 3, welcome: { gb: 1, days: 7, maxUsd: 4 } } }, w11.coin);
    check('a rehearsal takes the program, the creator and the burn account from chain', [cfg.coin, cfg.tokenProgram, cfg.treasury, cfg.membership.burnAccount], [w11.coin, T22, w11.treasury, w11.burnAccount]);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${total} checks FAILED` : `\nall ${total} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
