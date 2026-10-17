#!/usr/bin/env node
'use strict';
/**
 * scripts/launch-config.js works out the four launch values from the coin itself and refuses a
 * coin the keepers can't serve. Checked against real pump.fun accounts saved from mainnet
 * (test/fixtures/solana/pump-accounts.json), with the incinerator's account derived independently
 * by @solana-program/token.
 */
const path = require('path');
const kit = require('@solana/kit');
const tok = require('@solana-program/token');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const L = require(path.join(__dirname, '..', 'scripts', 'launch-config.js'));
const { formatConfig } = require(path.join(__dirname, '..', 'scripts', 'catalogue.js'));
const fixtures = require(path.join(__dirname, 'fixtures', 'solana', 'pump-accounts.json'));

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const checkThat = (what, cond, detail) => { checks++; if (cond) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); } };

/** An RPC answering getAccountInfo / getMultipleAccounts from saved accounts. */
function fakeRpc(accounts) {
  return async (method, params) => {
    if (method === 'getAccountInfo') return { context: { slot: 1 }, value: accounts[params[0]] || null };
    if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: params[0].map((a) => accounts[a] || null) };
    throw new Error('unexpected ' + method);
  };
}
const curveCoin = fixtures.curveCoin, graduated = fixtures.graduatedCoin;
const curveAccounts = { [curveCoin.mint]: curveCoin.mintAccount, [curveCoin.curve]: curveCoin.curveAccount };
const graduatedAccounts = { [graduated.mint]: graduated.mintAccount, [graduated.curve]: graduated.curveAccount, [graduated.pool]: graduated.poolAccount,
  [graduated.baseVault]: graduated.baseVaultAccount, [graduated.quoteVault]: graduated.quoteVaultAccount };
// The same curve account with one flag byte set: offsets from scripts/solana-chain.js decodeBondingCurve.
function withCurveFlag(offset) {
  const b = Buffer.from(curveCoin.curveAccount.data[0], 'base64');
  b[81] = 0; // clear Mayhem mode, so each case tests one flag
  if (offset !== null) b[offset] = 1;
  return Object.assign({}, curveCoin.curveAccount, { data: [b.toString('base64'), 'base64'] });
}

(async () => {
  console.log('the mint layout');
  const m = L.decodeMint(curveCoin.mintAccount.data[0]);
  check('decimals', m.decimals, 6);
  check('the mint and freeze authorities are revoked', [m.mintAuthority, m.freezeAuthority], [null, null]);
  check('initialised', m.initialized, true);

  console.log('a coin on its curve, with a plain creator wallet');
  const read = await L.read(fakeRpc(curveAccounts), curveCoin.mint);
  checkThat('reads the curve', read.state && read.state.source === 'bonding-curve');
  const creator = read.state.creator;
  checkThat('the creator is an ordinary wallet', S.isOnCurve(S.addressBytes(creator)));
  const ok = await L.launchFields({ mint: curveCoin.mint, mintInfo: read.mintInfo, state: read.state });
  check('no problems', ok.problems, []);
  const [ata] = await tok.findAssociatedTokenPda({ owner: kit.address(S.INCINERATOR), tokenProgram: kit.address(S.PROGRAMS.token2022), mint: kit.address(curveCoin.mint) });
  check('the four values', ok.fields, { coin: curveCoin.mint, tokenProgram: S.PROGRAMS.token2022, treasury: creator, burnAccount: String(ata) });
  checkThat('Mayhem mode and its doubled supply are warnings, not refusals', ok.warnings.some((w) => /Mayhem/.test(w)) && ok.warnings.some((w) => /supply is 2,000,000,000/.test(w)), JSON.stringify(ok.warnings));
  const named = await L.launchFields({ mint: curveCoin.mint, mintInfo: read.mintInfo, state: read.state, treasury: creator });
  check('naming the right treasury passes', named.problems, []);
  const wrong = await L.launchFields({ mint: curveCoin.mint, mintInfo: read.mintInfo, state: read.state, treasury: S.INCINERATOR });
  checkThat('naming another treasury is refused', wrong.fields === null && wrong.problems.some((p) => /not the treasury/.test(p)), JSON.stringify(wrong.problems));

  console.log('coins the keepers cannot serve');
  const grad = await L.read(fakeRpc(graduatedAccounts), graduated.mint);
  checkThat('reads the pool after graduation', grad.state && grad.state.source === 'pool');
  const shared = await L.launchFields({ mint: graduated.mint, mintInfo: grad.mintInfo, state: grad.state });
  checkThat('a fee-sharing creator (a program account) is refused', shared.fields === null && shared.problems.some((p) => /fee sharing/.test(p)), JSON.stringify(shared.problems));
  for (const [name, offset, pattern] of [['Holder Rewards', 124, /Holder Rewards/], ['Cashback', 82, /Cashback/]]) {
    const accounts = Object.assign({}, curveAccounts, { [curveCoin.curve]: withCurveFlag(offset) });
    const r = await L.read(fakeRpc(accounts), curveCoin.mint);
    const out = await L.launchFields({ mint: curveCoin.mint, mintInfo: r.mintInfo, state: r.state });
    checkThat(name + ' is refused', out.fields === null && out.problems.some((p) => pattern.test(p)), JSON.stringify(out.problems));
  }
  const plain = await L.read(fakeRpc(Object.assign({}, curveAccounts, { [curveCoin.curve]: withCurveFlag(null) })), curveCoin.mint);
  checkThat('without Mayhem mode there is no Mayhem warning', !(await L.launchFields({ mint: curveCoin.mint, mintInfo: plain.mintInfo, state: plain.state })).warnings.some((w) => /Mayhem/.test(w)));
  const minting = Buffer.from(curveCoin.mintAccount.data[0], 'base64');
  minting.writeUInt32LE(1, 0); S.addressBytes(S.INCINERATOR).forEach((x, i) => { minting[4 + i] = x; });
  const live = await L.launchFields({ mint: curveCoin.mint, mintInfo: Object.assign({}, curveCoin.mintAccount, { data: [minting.toString('base64'), 'base64'] }), state: read.state });
  checkThat('a mint that can still mint is refused', live.fields === null && live.problems.some((p) => /mint authority/.test(p)), JSON.stringify(live.problems));
  const notToken = await L.launchFields({ mint: curveCoin.mint, mintInfo: Object.assign({}, curveCoin.mintAccount, { owner: S.PROGRAMS.system }), state: read.state });
  checkThat('an account no token program owns is refused', notToken.fields === null && notToken.problems.some((p) => /not a token program/.test(p)));
  const missing = await L.read(fakeRpc({ [curveCoin.mint]: curveCoin.mintAccount }), curveCoin.mint);
  check('a token with no bonding curve reads as no curve', missing.state, null);
  checkThat('and is refused', (await L.launchFields({ mint: curveCoin.mint, mintInfo: missing.mintInfo, state: null })).problems.some((p) => /no pump\.fun bonding curve/.test(p)));
  checkThat('an account that does not exist is refused', (await L.launchFields({ mint: curveCoin.mint, mintInfo: null, state: null })).problems.some((p) => /no account/.test(p)));

  console.log('writing esim.json');
  const config = require(path.join(__dirname, '..', 'site', 'config', 'esim.json'));
  const empty = Object.assign({}, config, { coin: '', tokenProgram: '', treasury: '', membership: Object.assign({}, config.membership, { burnAccount: '' }) });
  const { next, changed } = L.applyFields(empty, ok.fields);
  check('fills the four values', [next.coin, next.tokenProgram, next.treasury, next.membership.burnAccount], [ok.fields.coin, ok.fields.tokenProgram, ok.fields.treasury, ok.fields.burnAccount]);
  check('and changes nothing else', Object.assign({}, next, { coin: '', tokenProgram: '', treasury: '', membership: Object.assign({}, next.membership, { burnAccount: '' }) }), empty);
  check('reports the change', changed, true);
  check('the same values again change nothing', L.applyFields(next, ok.fields).changed, false);
  let refused = '';
  try { L.applyFields(Object.assign({}, next, { coin: graduated.mint }), ok.fields); } catch (e) { refused = e.message; }
  checkThat('different values already there are not replaced', /already has different launch values \(coin\)/.test(refused), refused);
  checkThat('the written file keeps the repo formatting', formatConfig(next).split('\n').filter((l) => l.startsWith('  { "code"')).length === config.packages.length);

  console.log(`\n${checks - failures}/${checks} launch-config checks passed`);
  if (failures) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
