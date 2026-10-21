#!/usr/bin/env node
'use strict';
/**
 * The browser's copies of the membership rules, held to the server's.
 *
 * site/esim.js cannot require site/api/_lib (the functions directory is not served), so it
 * carries its own welcome-plan filter and join rule, builds the join transaction itself and writes
 * the messages the API checks. If any of those drift, the failure is quiet and costly: the app
 * offers a plan the API refuses, signs a message the API rejects, or asks a wallet to send the
 * wrong transaction. So the copy that ships is loaded under Node, as test/week.test.js does, and
 * compared with the server's code and with @solana/kit's own decoders.
 *
 *   node test/membership-client.test.js
 */
const path = require('path');
const crypto = require('crypto');
const kit = require('@solana/kit');
const tok = require('@solana-program/token');

const ROOT = path.join(__dirname, '..');
const rules = require(path.join(ROOT, 'site', 'api', '_lib', 'membership.js'));
const S = require(path.join(ROOT, 'site', 'solana.js'));
const config = require(path.join(ROOT, 'site', 'config', 'esim.json'));
const fixture = (name) => require(path.join(__dirname, 'fixtures', 'solana', name));

process.env.SIGNIN_HOST = 'ott.test';
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;
const redeem = require(path.join(ROOT, 'site', 'api', 'redeem.js'));

global.window = { OTTSolana: S };
global.location = { host: 'ott.test' };
require(path.join(ROOT, 'site', 'esim.js'));
const page = global.window.WhateverData;

let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x instanceof Uint8Array ? Array.from(x) : x));
const check = (what, got, want) => {
  checks++;
  if (norm(got) === norm(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const wallet = () => S.encodeBase58(new Uint8Array(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));

(async () => {
  console.log('the page exposes the helpers this test compares');
  check('signInMessage, joinTransaction, joinFromTransaction, welcomeEligible and publishedJoinMismatch are on the page global',
    ['signInMessage', 'joinTransaction', 'joinFromTransaction', 'welcomeEligible', 'publishedJoinMismatch'].map((n) => typeof page[n]), Array(5).fill('function'));
  check('the page\'s ceiling on a join amount is the server\'s', page.MAX_JOIN_SHARE_BPS, rules.MAX_BURN_SHARE_BPS);

  const ADDRESS = wallet();
  const now = () => Math.floor(Date.now() / 1000);

  console.log('\nthe messages the page writes are the ones the API accepts');
  const welcomeMessage = page.signInMessage(ADDRESS, { action: 'welcome', packageCode: 'fixed_1GB_7D_AU' });
  check('a welcome message passes the API\'s check for that plan', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'welcome', packageCode: 'fixed_1GB_7D_AU' }), null);
  check('it carries the address exactly, case and all', welcomeMessage.split('\n').find((l) => l.startsWith('Wallet: ')), 'Wallet: ' + ADDRESS);
  check('its first line is the welcome head', welcomeMessage.split('\n')[0], redeem.HEADS.welcome);
  check('it names no slot', welcomeMessage.split('\n').some((line) => line.startsWith('Slot: ')), false);
  check('it cannot pass as a weekly redemption', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '0' }), 'this signature does not authorise a redemption');
  check('or as a read', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'read' }), 'this signature does not authorise a read');
  const redeemMessage = page.signInMessage(ADDRESS, { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: 2 });
  check('weekly redemption messages pass', redeem.checkMessage(redeemMessage, ADDRESS, now(), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '2' }), null);
  check('and read messages pass', redeem.checkMessage(page.signInMessage(ADDRESS, { action: 'read' }), ADDRESS, now(), { action: 'read' }), null);
  // Only the exact form the page writes passes: nothing added, repeated or reordered, so a real
  // signature can't be hidden inside other text a phishing page asks a wallet to sign.
  const OTHER = wallet();
  const readLines = page.signInMessage(ADDRESS, { action: 'read' }).split('\n');
  const altered = {
    'an extra line': [...readLines.slice(0, 3), 'Note: harmless', ...readLines.slice(3)],
    'a second Wallet line': [...readLines.slice(0, 3), 'Wallet: ' + OTHER, ...readLines.slice(3)],
    'text after the timestamp': [...readLines, 'P.S. sign this to win'],
    'lines in another order': [readLines[0], readLines[2], readLines[1], readLines[3]],
    'Windows line endings': readLines.map((l, i) => (i < readLines.length - 1 ? l + '\r' : l)),
  };
  for (const [what, lines] of Object.entries(altered)) {
    check('a read message with ' + what + ' is refused', redeem.checkMessage(lines.join('\n'), ADDRESS, now(), { action: 'read' }) !== null, true);
  }
  const redeemLines = redeemMessage.split('\n');
  check('a redemption with its slot moved after the timestamp is refused', redeem.checkMessage([...redeemLines.slice(0, 4), redeemLines[5], redeemLines[4]].join('\n'), ADDRESS, now(), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '2' }) !== null, true);

  console.log('\nthe page offers exactly the welcome plans the API accepts');
  const welcome = rules.membershipConfig(config).welcome;
  const pageList = config.packages.filter((pkg) => page.welcomeEligible(pkg, welcome)).map((pkg) => pkg.code);
  const serverList = config.packages.filter((pkg) => rules.welcomeEligible(pkg, welcome)).map((pkg) => pkg.code);
  check('the same plans, in the same order', pageList, serverList);
  check('27 of the 28 places', new Set(config.packages.filter((pkg) => page.welcomeEligible(pkg, welcome)).map((pkg) => pkg.slug)).size, 27);

  console.log('\nthe join transaction is exactly the transfer the API counts');
  {
    const coin = 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump';
    const tokenProgram = S.PROGRAMS.token2022;
    const burnAccount = await S.associatedTokenAddress(S.INCINERATOR, coin, tokenProgram);
    const blockhash = S.encodeBase58(new Uint8Array(32).fill(3));
    const { wire, message, source } = await page.joinTransaction({ owner: ADDRESS, coin, tokenProgram, decimals: 6, burnOwner: S.INCINERATOR, burnAccount, units: '1800000000000', blockhash });
    check('it spends from the wallet\'s own associated account', source, await S.associatedTokenAddress(ADDRESS, coin, tokenProgram));
    const tx = kit.getTransactionDecoder().decode(wire);
    check('one signature slot, for the wallet, still empty', Object.keys(tx.signatures), [ADDRESS]);
    check('the wire carries the message the wallet is shown', Array.from(tx.messageBytes), Array.from(message));
    const decoded = kit.decompileTransactionMessage(kit.getCompiledTransactionMessageDecoder().decode(message));
    check('the wallet pays the fee', decoded.feePayer.address, ADDRESS);
    check('four instructions: compute limit, priority fee, create the incinerator account, transfer',
      decoded.instructions.map((ix) => ix.programAddress), [S.PROGRAMS.computeBudget, S.PROGRAMS.computeBudget, S.PROGRAMS.associatedToken, tokenProgram]);
    const signer = { address: kit.address(ADDRESS), signTransactions: async () => [] };
    const wantCreate = tok.getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: kit.address(burnAccount), owner: kit.address(S.INCINERATOR), mint: kit.address(coin), tokenProgram: kit.address(tokenProgram) });
    const wantTransfer = tok.getTransferCheckedInstruction({ source: kit.address(source), mint: kit.address(coin), destination: kit.address(burnAccount), authority: signer, amount: 1800000000000n, decimals: 6 }, { programAddress: kit.address(tokenProgram) });
    // Roles in a compiled message are merged across instructions (the wallet signs and pays, so it
    // is a writable signer everywhere), so accounts and data are compared, and signing separately.
    const same = (got, want) => norm({ a: (got.accounts || []).map((x) => x.address), d: Array.from(got.data || []) }) === norm({ a: want.accounts.map((x) => x.address), d: Array.from(want.data) });
    check('the create matches @solana-program/token, accounts and data', same(decoded.instructions[2], wantCreate), true);
    check('the transfer matches too: this amount, these decimals, into the incinerator\'s account', same(decoded.instructions[3], wantTransfer), true);
    check('the wallet signs the transfer, and only the wallet', decoded.instructions[3].accounts.map((a) => a.role >= kit.AccountRole.READONLY_SIGNER), [false, false, false, true]);
    check('the incinerator\'s account and the wallet\'s are the writable ones', decoded.instructions[3].accounts.map((a) => a.role === kit.AccountRole.WRITABLE || a.role === kit.AccountRole.WRITABLE_SIGNER), [true, false, true, true]);
    let refused = null;
    try { await page.joinTransaction({ owner: ADDRESS, coin, tokenProgram, decimals: 6, burnOwner: ADDRESS, burnAccount, units: '1', blockhash }); } catch (e) { refused = e.message; }
    check('a destination owned by anyone but the incinerator is refused', refused, 'The join details are not valid.');
    refused = null;
    try { await page.joinTransaction({ owner: ADDRESS, coin, tokenProgram, decimals: 6, burnOwner: S.INCINERATOR, burnAccount, units: '0', blockhash }); } catch (e) { refused = e.message; }
    check('a zero amount is refused', refused, 'The join amount is not valid.');
  }

  console.log('\nthe page reads a join the way the API does');
  for (const [name, coin, burnAccount] of [
    ['join-creates-account.json', 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump', 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF'],
    ['join-existing-account.json', 'AyYNfPtftg2zDP4ZbgcoQMggQtwLh4zpfVVmUJs2thto', 'HzfSrAF1hu9CfqF83X3RSW7Jtr9t3ETgk459cVaTahbH']]) {
    const tx = fixture(name);
    const a = page.joinFromTransaction(tx, { coin, burnAccount });
    const b = rules.joinFromTransaction(tx, { coin, burnAccount });
    check(name + ': the same sender and amount', [a.wallet, a.amount, a.tx], [b.wallet, b.amount, b.tx]);
  }
  {
    const tx = fixture('join-creates-account.json');
    const coin = 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump';
    const failed = JSON.parse(JSON.stringify(tx));
    failed.meta.err = { InstructionError: [1, { Custom: 1 }] };
    check('a failed transaction is no join to either', [page.joinFromTransaction(failed, { coin, burnAccount: 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF' }), rules.joinFromTransaction(failed, { coin, burnAccount: 'HzCqVi2hcNUgDhrPGc8VMY9EEaEVRTgArrEHgSk6VocF' })], [null, null]);
    check('nor is a transfer into another account', page.joinFromTransaction(tx, { coin, burnAccount: ADDRESS }), null);
  }

  console.log('\nthe join must match the site\'s published settings');
  {
    const coin = 'FNk5o1McVyZT8nEw5uBkEvVtRPvsnqrP7jQC9K7Qpump';
    const tokenProgram = S.PROGRAMS.token2022;
    const burnAccount = await S.associatedTokenAddress(S.INCINERATOR, coin, tokenProgram);
    const cfg = { coin, tokenProgram, membership: { burnOwner: S.INCINERATOR, burnAccount } };
    const m = { coin, tokenProgram, decimals: 6, burnOwner: S.INCINERATOR, burnAccount, requirement: { burnTokens: '1800000', burnUnits: '1800000000000' } };
    const supply = { amount: '1000000000000000', decimals: 6 };
    const refuse = 'The join details from the server don’t match this site’s published settings, so nothing was sent. Reload and try again.';
    const variant = (mChange, cfgChange = {}, sup = supply) => page.publishedJoinMismatch(Object.assign({}, cfg, cfgChange), Object.assign({}, m, mChange), sup);
    check('matching details pass', await variant({}), '');
    check('another coin is refused', await variant({ coin: S.MINTS.usdc }), refuse);
    check('another token program is refused', await variant({ tokenProgram: S.PROGRAMS.token }), refuse);
    const attacker = await S.associatedTokenAddress(ADDRESS, coin, tokenProgram);
    check('a destination that is not the published one is refused', await variant({ burnAccount: attacker }), refuse);
    check('even when the published config was tampered to match it', await variant({ burnAccount: attacker }, { membership: { burnOwner: S.INCINERATOR, burnAccount: attacker } }), refuse);
    check('an owner other than the incinerator is refused', await variant({ burnOwner: ADDRESS }), refuse);
    check('a zero amount is refused', await variant({ requirement: { burnTokens: '0', burnUnits: '0' } }), refuse);
    check('2% of the supply passes', await variant({ requirement: { burnTokens: '20000000', burnUnits: '20000000000000' } }), '');
    check('more than 2% of the supply is refused', await variant({ requirement: { burnTokens: '20000001', burnUnits: '20000001000000' } }), refuse);
    check('decimals that disagree with the coin are refused', await variant({ decimals: 9 }), refuse);
    check('no supply reading, no join', await variant({}, {}, null), refuse);
    check('no amount this week, no join', await variant({ requirement: null }), refuse);
  }

  console.log('\nthe page refuses a burn that could never count, before the wallet is asked');
  {
    const week = require(path.join(ROOT, 'site', 'api', '_lib', 'week.js'));
    const W = 2970;
    const start = week.weekStart(W);
    const me = wallet();
    const cfg = { treasury: wallet() };
    const req = (w) => ({ week: w, burnTokens: '1800000', burnUnits: '1800000000000' });
    check('this week\'s amount, mid-week, from an ordinary wallet, is fine', page.joinRefusal(cfg, req(W), me, start + 3 * 86400), '');
    check('the page sends with a few minutes\' margin inside the API\'s grace for last week\'s amount', page.JOIN_GRACE_SAFE_S > 0 && page.JOIN_GRACE_SAFE_S <= rules.GRACE_S - 60, true);
    check('last week\'s amount just after Monday 00:00 is still fine: inside the grace it is always enough', page.joinRefusal(cfg, req(W - 1), me, start + 60), '');
    check('rule check: in the grace, last week\'s lower amount is what a send must reach', rules.requirementFor({ [W - 1]: '1000', [W]: '2000' }, start + 60), 1000n);
    check('and when last week\'s was higher, it is more than enough', rules.requirementFor({ [W - 1]: '3000', [W]: '2000' }, start + 60) <= 3000n, true);
    check('past the margin, a page still showing last week\'s amount asks for a reload', /week that has ended\. Reload/.test(page.joinRefusal(cfg, req(W - 1), me, start + page.JOIN_GRACE_SAFE_S + 1)), true);
    check('as it does for an amount from any other week', /Reload/.test(page.joinRefusal(cfg, req(W - 2), me, start + 3600)) && /Reload/.test(page.joinRefusal(cfg, req(W + 1), me, start + 3600)), true);
    // A program-derived address: off the curve, as a multisig vault or smart wallet is.
    const vault = (await S.programAddress([Buffer.from('vault'), S.decodeBase58(me)], S.PROGRAMS.token)).address;
    check('the address used here is off the curve, like a multisig vault', rules.isWallet(vault), false);
    check('a program account is refused: the ledger never counts it', /program account/.test(page.joinRefusal(cfg, req(W), vault, start + 3600)), true);
    check('so is the treasury, which is never a member', /treasury can’t join/.test(page.joinRefusal(cfg, req(W), cfg.treasury, start + 3600)), true);
  }

  console.log('\nthe page knows which welcome answers ordered nothing and keep the burn');
  {
    // site/esim.js lists these as refused before dispatch (and the two "not yet" answers as keeping
    // the remembered burn) by their exact text, so a reworded API answer must fail here, not
    // turn a safe retry into "the claim result is unconfirmed" or a forgotten burn.
    const source = require('fs').readFileSync(path.join(ROOT, 'site', 'esim.js'), 'utf8');
    for (const name of ['WELCOME_POOL_SHORT', 'WELCOME_POOL_UNKNOWN', 'JOIN_UNSEEN', 'JOIN_UNPRICED']) {
      check('esim.js carries the API\'s ' + name + ' word for word', typeof redeem[name] === 'string' && source.includes("'" + redeem[name] + "'"), true);
    }
    check('and forgets a burn only on the API\'s refusal, which none of the "not yet" answers resemble',
      /did not make this wallet a member/.test(redeem.JOIN_REFUSED) && ![redeem.JOIN_UNSEEN, redeem.JOIN_UNPRICED].some((t) => /did not make this wallet a member|join OT\+T first/i.test(t)), true);
  }

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
