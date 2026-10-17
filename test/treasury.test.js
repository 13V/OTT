#!/usr/bin/env node
'use strict';
/**
 * The treasury monitor (scripts/treasury.js), offline: the arithmetic the card and the alert rely
 * on, and the run against a fake Solana RPC — the treasury's SOL, the creator fees still waiting in
 * pump.fun's vaults for a coin on its curve and for a graduated one (real mainnet accounts from
 * test/fixtures/solana/pump-accounts.json), each read failing on its own, and the file before
 * launch. scripts/claim.js has its own suite, test/claim.test.js.
 *
 *   node test/treasury.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const T = require(path.join(__dirname, '..', 'scripts', 'treasury.js'));
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const C = require(path.join(__dirname, '..', 'scripts', 'solana-chain.js'));
const P = require(path.join(__dirname, '..', 'scripts', 'pump-fees.js'));
const PUMP = require(path.join(__dirname, 'fixtures', 'solana', 'pump-accounts.json'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const wallet = () => S.encodeBase58(new Uint8Array(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
const TREASURY = wallet();
const config = {
  coin: PUMP.curveCoin.mint,
  treasury: TREASURY,
  packages: [
    { code: 'EU-35_1_7', packageCode: 'P2CYMUS93', priceUsd: 0.62 },
    { code: 'GL-120_1_7', packageCode: 'PHS30M6EZ', priceUsd: 4.6 },
  ],
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-'));
const withData = (account, base64) => Object.assign({}, account, { data: [base64, 'base64'] });
function patch(base64, edits) {
  const b = Buffer.from(base64, 'base64');
  for (const [at, value] of edits) {
    if (typeof value === 'string') Buffer.from(S.addressBytes(value)).copy(b, at);
    else b.writeBigUInt64LE(BigInt(value), at);
  }
  return b.toString('base64');
}

/** A fake RPC over accounts; `down` names methods that fail. */
function fakeRpc({ accounts = {}, lamports = 0, down = [] }) {
  return async (method, params) => {
    if (down.includes(method)) throw new Error(method + ' unavailable');
    if (method === 'getBalance') return { value: lamports };
    if (method === 'getAccountInfo') return { value: accounts[params[0]] || null };
    if (method === 'getMultipleAccounts') return { value: params[0].map((a) => accounts[a] || null) };
    throw new Error('unexpected ' + method);
  };
}

(async () => {
  console.log('treasury: the arithmetic');
  const now = Date.parse('2026-09-14T12:00:00Z');
  const day = 86400 * 1000;
  const orders = [
    { packageCode: 'EU-35_1_7', createdAt: new Date(now - 2 * day).toISOString() },
    { packageCode: 'GL-120_1_7', createdAt: new Date(now - 10 * day).toISOString() },
    { packageCode: 'P2CYMUS93', createdAt: new Date(now - 29 * day).toISOString() },   // by packageCode, not slug
    { packageCode: 'EU-35_1_7', createdAt: new Date(now - 31 * day).toISOString() },   // outside the window
    { packageCode: 'GONE_1_7', createdAt: new Date(now - 1 * day).toISOString() },     // no longer in the catalogue
  ];
  check('thirty days of spend, at catalogue prices, dearest for the unknown', T.summarise({ orders, config, now }), { spendUsd: 10.44, count: 4, perDayUsd: 0.35, days: 30 });
  const paid = orders.map((o) => Object.assign({ paidUsd: 1.89 }, o));
  check('a record that says what was actually paid is counted at that', T.summarise({ orders: paid, config, now }), { spendUsd: 7.56, count: 4, perDayUsd: 0.25, days: 30 });
  check('runway is balance over the daily rate, in whole days', T.runway({ balanceUsd: 412, perDayUsd: 0.35 }), 1177);
  check('no spend means no rate and no runway, not infinity', T.runway({ balanceUsd: 412, perDayUsd: 0 }), null);
  check('status: no reading', T.statusOf({ balanceUsd: NaN, runwayDays: null }), 'unknown');
  check('status: nothing there', T.statusOf({ balanceUsd: 0, runwayDays: null }), 'empty');
  check('status: under the floor', T.statusOf({ balanceUsd: 20, runwayDays: 400 }), 'low');
  check('status: under two weeks', T.statusOf({ balanceUsd: 200, runwayDays: 9 }), 'low');
  check('status: fine', T.statusOf({ balanceUsd: 200, runwayDays: 90 }), 'funded');
  check('status: fine with no spend yet', T.statusOf({ balanceUsd: 200, runwayDays: null }), 'funded');
  // A pool can be comfortably full by every backward-looking measure and still be unable to pay
  // what this week has already promised — which is the shape a good week takes, not a bad one.
  check('status: full by the old measure, short of what this week promised', T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 4000 }), 'behind');
  check('status: enough of the promise covered to be getting on with', T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 300 }), 'funded');
  check('status: nothing promised yet is not behind', T.statusOf({ balanceUsd: 200, runwayDays: 400, owedUsd: 0 }), 'funded');
  check('status: empty still beats behind', T.statusOf({ balanceUsd: 0, runwayDays: null, owedUsd: 4000 }), 'empty');
  check('owed: this week\'s budget less what this week redeemed', T.owing({ orders, config, budgetUsd: 25, weekStartMs: now - 3 * day }), { budgetUsd: 25, redeemedUsd: 5.22, owedUsd: 19.78 });
  check('owed: no budget, no figure', T.owing({ orders, config, budgetUsd: undefined, weekStartMs: 0 }), { budgetUsd: null, redeemedUsd: null, owedUsd: null });
  {
    // A welcome eSIM is paid from the reserve: it is spend, but it doesn't use up anyone's weekly
    // credit, so what the week still owes stays the same.
    const { welcomeIdFor, transactionIdFor } = require(path.join(__dirname, '..', 'site', 'api', '_lib', 'order-ids.js'));
    const wallet = 'Bb8RRCgXw3vXEdYFxF4h8Pv4mxXHy3mDZhGJ2pFzKJcQ'.toLowerCase();
    const at = new Date(now - day).toISOString();
    const welcome = { transactionId: welcomeIdFor(wallet), address: wallet, packageCode: orders[0].packageCode, createdAt: at };
    const weekly = { transactionId: transactionIdFor(wallet, 2962, 0), address: wallet, packageCode: orders[0].packageCode, createdAt: at };
    const base = T.owing({ orders, config, budgetUsd: 25, weekStartMs: now - 3 * day });
    check('owed: a welcome order is not counted against the week', T.owing({ orders: [...orders, welcome], config, budgetUsd: 25, weekStartMs: now - 3 * day }), base);
    check('owed: a weekly order from the same wallet still is', T.owing({ orders: [...orders, weekly], config, budgetUsd: 25, weekStartMs: now - 3 * day }).owedUsd < base.owedUsd, true);
    check('spend: the welcome order is still money the pool paid', T.summarise({ orders: [welcome], config, now }).count, 1);
  }
  check('the last claim as the card shows it', T.lastClaimOf([{ at: 1, sol: 0.1 }, { at: 1789300000, lamports: '120000000', sol: 0.12, solUsd: 104, usd: 12.48, tx: 'sig', sources: ['curve'] }]),
    { at: 1789300000, sol: 0.12, usd: 12.48, tx: 'sig' });
  check('no claims yet', T.lastClaimOf([]), null);

  console.log('\ntreasury: the run');
  const curveCoin = PUMP.curveCoin, gradCoin = PUMP.graduatedCoin;
  const vault = await C.creatorVaultAddress(TREASURY);
  const curveAccounts = {
    // Our treasury as the curve's creator, with 0.002 SOL waiting on the curve.
    [curveCoin.curve]: withData(curveCoin.curveAccount, patch(curveCoin.curveAccount.data[0], [[49, TREASURY], [125, 2000000]])),
    [vault]: { lamports: Number(P.RENT_EXEMPT_EMPTY) + 30000000, owner: S.PROGRAMS.system, data: ['', 'base64'] },
  };
  const provider = { name: 'fake', async balanceUsd() { return 412; }, async listOrders() { return orders; } };
  const lightning = { name: 'wholesale', async balanceUsd() { return 412; }, async balance() { return { sats: 515000, usd: 412, usdPerSat: 0.0008 }; }, async listOrders() { return orders; } };
  const claims = [{ at: 1789300000, lamports: '41700000', sol: 0.0417, solUsd: 100, usd: 4.17, tx: 'sigA', sources: ['curve'], dryRun: false }];
  const allowancesPath = path.join(tmp, 'allowances.json');
  fs.writeFileSync(allowancesPath, JSON.stringify({ week: 2963, budgetUsd: 0 }));
  const run = (over) => T.run(Object.assign({ rpc: fakeRpc({ accounts: curveAccounts, lamports: 1500000000 }), config, provider, claims, now: () => now,
    out: path.join(tmp, 't.json'), allowancesPath, solUsd: async () => 100 }, over));

  let r = await run({});
  check('the file has every number the card needs', r.data, {
    asOf: Math.floor(now / 1000), treasury: TREASURY, solUsd: 100,
    walletSol: 1.5, walletUsd: 150, claimableSol: 0.032, claimableUsd: 3.2,
    reseller: { name: 'fake', balanceUsd: 412, asOf: Math.floor(now / 1000) },
    spend30dUsd: 10.44, redemptions30d: 4, perDayUsd: 0.35, runwayDays: 1177,
    weekBudgetUsd: 0, weekRedeemedUsd: 0, owedUsd: 0,
    lastClaim: { at: 1789300000, sol: 0.0417, usd: 4.17, tx: 'sigA' }, status: 'funded',
  });
  process.env.LN_PAYER = 'blink';
  r = await run({ provider: lightning, out: path.join(tmp, 't1b.json') });
  check('a Lightning-paid provider also writes the sats and the wallet', r.data.reseller, { name: 'wholesale', balanceUsd: 412, asOf: Math.floor(now / 1000), sats: 515000, wallet: 'blink' });

  {
    const ammVault = await C.ammCreatorVaultAccount(TREASURY);
    const gradAccounts = {
      [gradCoin.curve]: withData(gradCoin.curveAccount, patch(gradCoin.curveAccount.data[0], [[49, TREASURY], [125, 0]])),
      [gradCoin.pool]: withData(gradCoin.poolAccount, patch(gradCoin.poolAccount.data[0], [[211, TREASURY], [279, 250000000]])),
      [gradCoin.baseVault]: gradCoin.baseVaultAccount, [gradCoin.quoteVault]: gradCoin.quoteVaultAccount,
      [vault]: { lamports: Number(P.RENT_EXEMPT_EMPTY), owner: S.PROGRAMS.system, data: ['', 'base64'] },
      [ammVault]: { data: { parsed: { info: { tokenAmount: { amount: '750000000' } } } } },
    };
    r = await run({ rpc: fakeRpc({ accounts: gradAccounts, lamports: 2000000000 }), config: Object.assign({}, config, { coin: gradCoin.mint }), out: path.join(tmp, 't-grad.json') });
    check('a graduated coin: the pool\'s waiting fee and the PumpSwap vault, not the vault\'s rent', [r.data.claimableSol, r.data.claimableUsd, r.data.walletSol], [1, 100, 2]);
  }

  r = await run({ provider: null, claims: [], out: path.join(tmp, 't2.json') });
  check('without a provider the reseller side is null and the status unknown', [r.data.reseller, r.data.status, r.data.claimableSol], [null, 'unknown', 0.032]);
  const broken = { name: 'fake', async balanceUsd() { throw new Error('HTTP 503'); } };
  r = await run({ provider: broken, claims: [], out: path.join(tmp, 't3.json') });
  check('a reseller that cannot answer is recorded as such, not thrown', [r.data.reseller.balanceUsd, r.data.reseller.error, r.data.status], [null, 'HTTP 503', 'unknown']);
  r = await run({ rpc: async () => { throw new Error('no route'); }, out: path.join(tmp, 't4.json') });
  check('a chain that cannot answer leaves nulls and keeps the reseller reading', [r.data.walletSol, r.data.claimableSol, r.data.walletUsd, r.data.reseller.balanceUsd], [null, null, null, 412]);
  r = await run({ rpc: fakeRpc({ accounts: curveAccounts, lamports: 1500000000, down: ['getAccountInfo'] }), out: path.join(tmp, 't5.json') });
  check('one failed read costs one figure', [r.data.walletSol, r.data.claimableSol], [1.5, null]);
  r = await run({ solUsd: async () => { throw new Error('no price'); }, out: path.join(tmp, 't6.json') });
  check('no SOL price: the SOL figures stay, the dollar ones are null', [r.data.walletSol, r.data.walletUsd, r.data.claimableUsd, r.data.solUsd], [1.5, null, null, null]);
  r = await run({ rpc: fakeRpc({ accounts: { [curveCoin.curve]: withData(curveCoin.curveAccount, patch(curveCoin.curveAccount.data[0], [[49, wallet()]])) }, lamports: 1 }), out: path.join(tmp, 't7.json') });
  check('a coin created by another wallet is not counted as ours', r.data.claimableSol, null);

  let calls = 0;
  r = await run({ config: Object.assign({}, config, { coin: '', treasury: '' }), rpc: async () => { calls++; throw new Error('no'); }, solUsd: async () => { calls++; return 1; }, out: path.join(tmp, 't8.json') });
  check('before launch the chain side is skipped and the file still written', [calls, r.data.treasury, r.data.walletSol, r.data.claimableSol, r.data.solUsd, fs.existsSync(path.join(tmp, 't8.json'))], [0, '', null, null, null, true]);
  r = await run({ config: Object.assign({}, config, { coin: '' }), out: path.join(tmp, 't9.json') });
  check('a treasury before the coin: its SOL is read, no fees yet', [r.data.walletSol, r.data.claimableSol], [1.5, null]);

  // The workflows commit only when a data file changed; the clock and the price alone must not.
  const out = path.join(tmp, 't10.json');
  await run({ out, now: () => now });
  const first = fs.readFileSync(out, 'utf8');
  await run({ out, now: () => now + 60000, solUsd: async () => 100.001 });
  check('a later run with nothing else changed leaves the file alone', fs.readFileSync(out, 'utf8'), first);
  await run({ out, now: () => now + 120000, rpc: fakeRpc({ accounts: curveAccounts, lamports: 1600000000 }) });
  check('a changed balance rewrites it', JSON.parse(fs.readFileSync(out, 'utf8')).walletSol, 1.6);

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
