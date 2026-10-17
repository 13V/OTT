#!/usr/bin/env node
'use strict';
/**
 * launch-config.js — the four launch values for site/config/esim.json, read from the coin itself.
 *
 * On launch day the coin is created on pump.fun from the treasury wallet. This reads the new coin
 * from Solana and works out what the site needs, so nothing is typed by hand:
 *
 *   coin                    the mint
 *   tokenProgram            the program that owns the mint (Token-2022 for current pump.fun coins)
 *   treasury                the coin's creator, which pump.fun pays the creator fee to
 *   membership.burnAccount  the incinerator's token account for the coin, where joins are sent
 *
 *   node scripts/launch-config.js <mint>                       # read and check; change nothing
 *   node scripts/launch-config.js <mint> --treasury <wallet>   # also require this creator
 *   node scripts/launch-config.js <mint> --write               # write the four values into esim.json
 *
 * It refuses a coin the keepers can't serve: one that isn't a pump.fun coin, isn't paired with SOL,
 * pays its creator fee to holders (Holder Rewards) or traders (Cashback), or has a program account
 * as its creator (fee sharing). Any of those would publish a programme the treasury is never paid
 * for. It reads public chain data only; it needs no key and sends nothing.
 */
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const C = require(path.join(__dirname, 'solana-chain.js'));
const { formatConfig } = require(path.join(__dirname, 'catalogue.js'));

const ESIM_PATH = path.join(__dirname, '..', 'site', 'config', 'esim.json');
const EXPECTED_DECIMALS = 6;
const EXPECTED_SUPPLY = 1000000000n * 10n ** 6n;
const whole = (units, decimals) => (units / 10n ** BigInt(decimals)).toLocaleString('en-US');

/** The base layout every SPL mint (Token and Token-2022) starts with. */
function decodeMint(base64) {
  const b = Buffer.from(base64, 'base64');
  if (b.length < 82) throw new Error('the mint account is too short to be a token mint');
  const option = (at) => b.readUInt32LE(at) === 1;
  return {
    mintAuthority: option(0) ? S.encodeBase58(b.subarray(4, 36)) : null,
    supply: b.readBigUInt64LE(36),
    decimals: b[44],
    initialized: b[45] === 1,
    freezeAuthority: option(46) ? S.encodeBase58(b.subarray(50, 82)) : null,
  };
}

/**
 * Checks a coin and works out its launch values. Pure: `mintInfo` is getAccountInfo's value for the
 * mint (base64), `state` is solana-chain's coinState(). Returns { fields, problems, warnings, facts };
 * `fields` is null when anything is a problem.
 */
async function launchFields({ mint, mintInfo, state, treasury }) {
  const problems = [], warnings = [];
  if (!S.isAddress(mint)) return { fields: null, problems: [`${mint} is not a Solana address`], warnings, facts: {} };
  if (!mintInfo) return { fields: null, problems: [`${mint} has no account on Solana mainnet`], warnings, facts: {} };
  const tokenProgram = mintInfo.owner;
  if (!S.TOKEN_PROGRAMS.includes(tokenProgram)) problems.push(`${mint} is owned by ${tokenProgram}, not a token program`);
  let m = null;
  try { m = decodeMint(Array.isArray(mintInfo.data) ? mintInfo.data[0] : mintInfo.data); } catch (e) { problems.push(e.message); }
  const facts = { tokenProgram: tokenProgram === S.PROGRAMS.token2022 ? 'Token-2022' : tokenProgram === S.PROGRAMS.token ? 'Token' : tokenProgram };
  if (m) {
    Object.assign(facts, { decimals: m.decimals, supply: whole(m.supply, m.decimals), mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority });
    if (!m.initialized) problems.push('the mint is not initialised');
    if (m.decimals !== EXPECTED_DECIMALS) warnings.push(`the coin has ${m.decimals} decimals; pump.fun coins have ${EXPECTED_DECIMALS}`);
    if (m.supply !== EXPECTED_SUPPLY) warnings.push(`the supply is ${whole(m.supply, m.decimals)}; a standard pump.fun coin has 1,000,000,000`);
    if (m.mintAuthority) problems.push(`the mint authority is still ${m.mintAuthority}, so more OTT can be minted; pump.fun coins revoke it`);
    if (m.freezeAuthority) problems.push(`the freeze authority is ${m.freezeAuthority}, so holders' OTT can be frozen; pump.fun coins have none`);
  }
  if (!state) problems.push('the coin has no pump.fun bonding curve');
  else {
    const creator = state.creator;
    const curve = state.curveState || {};
    const pool = state.poolState || {};
    Object.assign(facts, { creator, graduated: !!state.complete, priceSol: state.priceSol, source: state.source });
    if (curve.isHolderReward || pool.isHolderReward) problems.push('Holder Rewards is on: the creator fee goes to holders, not to the treasury');
    if (curve.isCashbackCoin || pool.isCashbackCoin) problems.push('Cashback is on: part of the creator fee goes to traders instead of the treasury');
    if (curve.isMayhemMode || pool.isMayhemMode) warnings.push('Mayhem mode is on; check what it does to the creator fee before going live');
    const bytes = S.addressBytes(creator);
    if (!bytes) problems.push(`the creator ${creator} is not an address`);
    else if (!S.isOnCurve(bytes)) problems.push(`the creator ${creator} is a program account, so fee sharing is set up; claim.js collects only for a plain creator wallet`);
    if (treasury && treasury !== creator) problems.push(`the creator is ${creator}, not the treasury ${treasury} you named`);
  }
  if (problems.length) return { fields: null, problems, warnings, facts };
  const burnAccount = await S.associatedTokenAddress(S.INCINERATOR, mint, tokenProgram);
  return { fields: { coin: mint, tokenProgram, treasury: state.creator, burnAccount }, problems, warnings, facts };
}

/** The config with the four launch values in. Refuses to replace different values already there. */
function applyFields(config, fields) {
  const current = { coin: config.coin || '', tokenProgram: config.tokenProgram || '', treasury: config.treasury || '', burnAccount: (config.membership && config.membership.burnAccount) || '' };
  const clash = Object.keys(fields).filter((k) => current[k] && current[k] !== fields[k]);
  if (clash.length) throw new Error('site/config/esim.json already has different launch values (' + clash.join(', ') + '); clear them by hand first if the launch really changed');
  if (!config.membership || typeof config.membership !== 'object') throw new Error('site/config/esim.json has no membership block');
  const next = Object.assign({}, config, { coin: fields.coin, tokenProgram: fields.tokenProgram, treasury: fields.treasury });
  next.membership = Object.assign({}, config.membership, { burnAccount: fields.burnAccount });
  return { next, changed: Object.keys(fields).some((k) => current[k] !== fields[k]) };
}

async function read(rpc, mint) {
  const info = await rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
  let state = null;
  try { state = await C.coinState(rpc, mint); } catch (e) {
    if (!/has no pump\.fun bonding curve/.test(e.message)) throw e;
  }
  return { mintInfo: info && info.value, state };
}

module.exports = { decodeMint, launchFields, applyFields, read };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  const mint = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--treasury');
  if (!mint) { console.error('usage: node scripts/launch-config.js <mint> [--treasury <wallet>] [--write]'); process.exit(2); }
  const log = (m) => process.stderr.write(m + '\n');
  (async () => {
    const rpc = C.makeRpc({ log });
    const { mintInfo, state } = await read(rpc, mint);
    const out = await launchFields({ mint, mintInfo, state, treasury: value('treasury') });
    for (const [k, v] of Object.entries(out.facts)) console.log(`  ${k}: ${v === null ? 'none' : v}`);
    for (const w of out.warnings) console.log('  WARN ' + w);
    for (const p of out.problems) console.log('  FAIL ' + p);
    if (!out.fields) { console.error('Not launch-ready: nothing written.'); process.exit(1); }
    console.log(JSON.stringify({ coin: out.fields.coin, tokenProgram: out.fields.tokenProgram, treasury: out.fields.treasury, membership: { burnAccount: out.fields.burnAccount } }, null, 2));
    if (!argv.includes('--write')) { console.log('Check the creator is the wallet you launched from, then run again with --write.'); return; }
    const config = JSON.parse(fs.readFileSync(ESIM_PATH, 'utf8'));
    const { next, changed } = applyFields(config, out.fields);
    if (!changed) { console.log('site/config/esim.json already has these values.'); return; }
    fs.writeFileSync(ESIM_PATH, formatConfig(next));
    console.log('Wrote the launch values to site/config/esim.json. Next: npm run lint, commit and push (deploys the API), then npm run deploy:pages.');
  })().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
