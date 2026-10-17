#!/usr/bin/env node
'use strict';
/**
 * claim.js — collect the coin's pump.fun creator fees into the treasury.
 *
 * pump.fun keeps the creator fee on the bonding curve (and, after graduation, in the PumpSwap pool)
 * until someone pays it out; scripts/pump-fees.js has the details. This sends the one transaction
 * that sweeps it and pays it to the treasury, on a schedule, so the fees never wait more than a day:
 *
 *   TREASURY_PRIVATE_KEY=… node scripts/claim.js            # collect whatever is waiting
 *   TREASURY_PRIVATE_KEY=… node scripts/claim.js --dry-run  # build, sign and simulate it; send nothing
 *   node scripts/claim.js --dry-run                         # no key: simulate it unsigned, as the treasury
 *   node scripts/claim.js --rehearse <mint>                 # any live pump.fun coin, as its creator, simulated
 *   node scripts/claim.js --min-sol 0.01                    # collect nothing below this (default 0.005 SOL)
 *
 * The key must be the treasury's — the creator wallet in site/config/esim.json, as a base58 secret
 * key (Phantom's export) or a JSON byte array — and anything else is refused before any call.
 * Collecting is permissionless and can only ever pay the creator, so the key buys exactly one thing:
 * paying the transaction fee. The transaction is simulated before it is sent. What a confirmed claim
 * paid is read back from the chain and appended to site/data/claims.json (the newest hundred), which
 * the status page reads to show when the treasury was last paid.
 *
 * --rehearse is the proof that the account lists are right before there is a coin to claim for: it
 * builds the same transaction for a real coin, with that coin's creator as the payer, and simulates
 * it unsigned (sigVerify false, the blockhash replaced). It has no path that sends anything.
 */
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));
const C = require(path.join(__dirname, 'solana-chain.js'));
const P = require(path.join(__dirname, 'pump-fees.js'));

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const CLAIMS_PATH = path.join(SITE, 'data', 'claims.json');
const KEEP = 100;
const DEFAULT_MIN_SOL = 0.005;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
const sol = (lamports) => Number(lamports) / 1e9;
const fmtSol = (lamports) => sol(lamports).toFixed(6) + ' SOL';
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

// ---------------------------------------------------------------------------
// The pure part.
// ---------------------------------------------------------------------------

/** What to collect: nothing under the floor, otherwise whichever of curve and pool has fees. */
function plan({ curveLamports, poolLamports, minLamports }) {
  const total = curveLamports + poolLamports;
  if (total < minLamports || total <= 0n) return { sources: [], lamports: total };
  const sources = [];
  if (curveLamports > 0n) sources.push('curve');
  if (poolLamports > 0n) sources.push('pool');
  return { sources, lamports: total };
}

/** Append to the log and keep the newest KEEP. Newest last, so the page reads the tail. */
function appendClaims(existing, entries) {
  return (Array.isArray(existing) ? existing : []).concat(entries).slice(-KEEP);
}

// ---------------------------------------------------------------------------
// The chain.
// ---------------------------------------------------------------------------

/**
 * Simulate `wire`. Signed, it is checked as it will be sent; `unsigned` skips the signature check
 * and replaces the blockhash, which is what a rehearsal or a key-free dry run needs. `watch` asks
 * for those accounts' state afterwards. Throws with the program's last log lines on failure.
 */
async function simulate(rpc, wire, { unsigned = false, watch = [] } = {}) {
  const opts = { encoding: 'base64', commitment: 'confirmed' };
  if (unsigned) { opts.sigVerify = false; opts.replaceRecentBlockhash = true; } else opts.sigVerify = true;
  if (watch.length) opts.accounts = { encoding: 'base64', addresses: watch };
  const r = await rpc('simulateTransaction', [S.encodeBase64(wire), opts]);
  const value = r && r.value;
  if (!value) throw new Error('the simulation returned nothing');
  if (value.err) {
    const logs = (value.logs || []).slice(-6).join(' | ');
    throw new Error('the claim would fail: ' + JSON.stringify(value.err) + (logs ? ' — ' + logs : ''));
  }
  return value;
}

/** The lamports a watched account holds after a simulation, or null. */
function simulatedLamports(value, i = 0) {
  const a = value && Array.isArray(value.accounts) ? value.accounts[i] : null;
  return a && a.lamports !== undefined && a.lamports !== null ? BigInt(a.lamports) : null;
}

/**
 * Wait for `signature` to confirm. A wait that runs out is not proof it failed: if the
 * transaction is on chain and succeeded, that is a confirmation too. Anything else rethrows.
 */
async function confirmed(rpc, signature, options, log = () => {}) {
  try {
    return await C.confirmTransaction(rpc, signature, options);
  } catch (e) {
    let tx = null;
    try { tx = await C.getTransaction(rpc, signature); } catch (err) { tx = null; }
    if (!tx || !tx.meta || tx.meta.err !== null) throw e;
    log(`  ${e.message}, but it is on chain and succeeded`);
    return 'confirmed';
  }
}

/** What a confirmed claim paid `treasury`: its balance change plus the fee it paid, or null if unreadable. */
async function collectedBy(rpc, signature, treasury, { attempts = 5, pauseMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let tx = null;
    try { tx = await C.getTransaction(rpc, signature); } catch (e) { tx = null; }
    if (tx && tx.meta) {
      const delta = S.lamportsChange(tx, treasury);
      if (delta !== null) return delta + (S.feePayer(tx) === treasury ? BigInt(tx.meta.fee || 0) : 0n);
    }
    if (i + 1 < attempts) await sleep(pauseMs);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function run({ rpc, config, key = null, minSol = DEFAULT_MIN_SOL, dryRun = false, microLamports, out = CLAIMS_PATH,
  now = () => Date.now(), log = () => {}, solUsd = () => C.solUsdNow(), confirmOptions = {}, measureOptions = {} }) {
  const treasury = config.treasury;
  if (!S.isAddress(treasury)) throw new Error('site/config/esim.json has no treasury yet; nothing to claim for');
  if (!S.isAddress(config.coin)) throw new Error('site/config/esim.json has no coin yet; nothing to claim');
  if (key && key.address !== treasury) {
    throw new Error(`wrong wallet: the key is for ${key.address}, but the treasury is ${treasury}; refusing to claim from the wrong wallet`);
  }
  if (!key && !dryRun) throw new Error('TREASURY_PRIVATE_KEY is required to claim; use --dry-run to simulate without it');

  const waiting = await P.claimable(rpc, { mint: config.coin, creator: treasury });
  log(`waiting: ${fmtSol(waiting.curveLamports)} from the curve, ${fmtSol(waiting.poolLamports)} from the pool`
    + (waiting.accounts.pool ? '' : ' (not graduated)'));
  const p = plan({ curveLamports: waiting.curveLamports, poolLamports: waiting.poolLamports, minLamports: BigInt(Math.round(minSol * 1e9)) });
  if (!p.sources.length) {
    return { claimed: [], waitingLamports: p.lamports, summary: `claim: ${fmtSol(p.lamports)} waiting, under the ${minSol} SOL floor; no transaction sent` };
  }

  const instructions = P.claimInstructions({ payer: treasury, accounts: waiting.accounts, sources: p.sources, microLamports });
  const { blockhash, lastValidBlockHeight } = await C.latestBlockhash(rpc);
  let wire, signature = null;
  if (key) ({ wire, signature } = C.signedTransaction({ payer: treasury, blockhash, instructions, signers: [key] }));
  else wire = S.wireTransaction(S.compileMessage({ payer: treasury, blockhash, instructions }));
  const sim = await simulate(rpc, wire, { unsigned: !key, watch: [treasury] });
  log(`  simulated: ${sim.unitsConsumed || '?'} compute units, ok`);
  if (dryRun) {
    return { claimed: [], dryRun: true, plannedLamports: p.lamports, sources: p.sources,
      summary: `claim: would collect ${fmtSol(p.lamports)} from the ${p.sources.join(' and ')} (dry run, nothing sent)` };
  }

  const sent = await C.sendTransaction(rpc, wire);
  if (sent !== signature) log(`  the node answered ${sent} for ${signature}`);
  log(`  sent ${signature}`);
  await confirmed(rpc, signature, Object.assign({ wire, lastValidBlockHeight }, confirmOptions), log);
  // What the chain says it paid, not what was waiting a moment before: a trade can add to the fee
  // between the reading and the claim, and the ledger values exactly this figure.
  const measured = await collectedBy(rpc, signature, treasury, measureOptions);
  const lamports = measured !== null && measured > 0n ? measured : p.lamports;
  let price = null;
  try { price = await solUsd(); } catch (e) { log(`  no SOL price for the log: ${e.message}`); }
  const entry = {
    at: Math.floor(now() / 1000), lamports: lamports.toString(), sol: sol(lamports), solUsd: price,
    usd: price === null ? null : round2(sol(lamports) * price), tx: signature, sources: p.sources, dryRun: false,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(appendClaims(readJson(out, []), [entry]), null, 1) + '\n');
  return { claimed: [entry], summary: `claim: collected ${fmtSol(lamports)} from the ${p.sources.join(' and ')} in ${signature} -> ${path.relative(process.cwd(), out)}` };
}

/**
 * The same claim for any live pump.fun coin, as its creator, simulated unsigned. Never sends.
 * Returns what was waiting, the simulated change in the creator's balance and the compute used.
 */
async function rehearse({ rpc, mint, microLamports, log = () => {} }) {
  if (!S.isAddress(mint)) throw new Error('--rehearse needs a coin mint address');
  let state = await C.coinState(rpc, mint);
  const creator = state.curveState.creator;
  if (state.poolState && state.poolState.coinCreator !== creator) {
    log(`  the pool's coin creator (${state.poolState.coinCreator}) is not the curve's (${creator}); rehearsing the curve part only`);
    state = Object.assign({}, state, { pool: null, poolState: null });
  }
  const waiting = await P.claimable(rpc, { mint, creator, state });
  // Both parts, whatever is waiting: the point is to prove every account list, empty or not.
  const sources = waiting.accounts.pool ? ['curve', 'pool'] : ['curve'];
  const instructions = P.claimInstructions({ payer: creator, accounts: waiting.accounts, sources, microLamports });
  const { blockhash } = await C.latestBlockhash(rpc);
  const wire = S.wireTransaction(S.compileMessage({ payer: creator, blockhash, instructions }));
  const before = await rpc('getBalance', [creator, { commitment: 'confirmed' }]);
  const sim = await simulate(rpc, wire, { unsigned: true, watch: [creator] });
  const after = simulatedLamports(sim);
  const pre = before && before.value !== undefined ? BigInt(before.value) : null;
  return {
    mint, creator, graduated: !!waiting.accounts.pool, source: state.source, sources,
    waitingCurve: waiting.curveLamports, waitingPool: waiting.poolLamports,
    unitsConsumed: sim.unitsConsumed || null,
    balanceChange: pre !== null && after !== null ? after - pre : null,
    logs: (sim.logs || []).filter((l) => /invoke|success|failed|Error/i.test(l)).slice(0, 40),
  };
}

module.exports = { plan, appendClaims, simulate, simulatedLamports, confirmed, collectedBy, run, rehearse, CLAIMS_PATH, DEFAULT_MIN_SOL };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  const has = (name) => argv.includes('--' + name);
  const log = (m) => process.stderr.write(m + '\n');
  const rpc = C.makeRpc({ log });
  const priority = arg('priority') === undefined ? undefined : Number(arg('priority'));
  if (has('rehearse')) {
    rehearse({ rpc, mint: arg('rehearse'), microLamports: priority, log })
      .then((r) => console.log(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)))
      .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
  } else {
    const secret = process.env.TREASURY_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
    let key = null;
    try { key = secret ? C.keypairFromSecret(secret) : null; } catch (e) { console.error('TREASURY_PRIVATE_KEY: ' + e.message); process.exit(1); }
    const dryRun = has('dry-run');
    const config = readJson(ESIM_PATH, {});
    // Before launch there is nothing to collect, and an unattended keeper should say so and stop
    // cleanly rather than fail every day and open an issue about it.
    if (!S.isAddress(config.coin) || !S.isAddress(config.treasury)) { console.log('claim: the coin is not launched yet (no coin or treasury in site/config/esim.json); nothing to claim'); process.exit(0); }
    if (!key && !dryRun) { console.error('TREASURY_PRIVATE_KEY is required — the treasury\'s Solana secret key, in the environment, never in a file'); process.exit(1); }
    run({
      rpc, config, key, dryRun, microLamports: priority,
      minSol: arg('min-sol') === undefined ? DEFAULT_MIN_SOL : Number(arg('min-sol')),
      out: arg('out') ? path.resolve(process.cwd(), arg('out')) : CLAIMS_PATH,
      log,
    })
      .then(({ summary }) => console.log(summary))
      .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
  }
}
