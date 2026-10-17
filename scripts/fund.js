#!/usr/bin/env node
'use strict';
/**
 * fund.js — move creator fees from the treasury wallet into the Lightning wallet that pays for eSIMs.
 *
 * The fees arrive as SOL in the treasury (scripts/claim.js collects them from pump.fun). wholesale
 * wants sats over Lightning. Two services, each with an API, none needing a person:
 *
 *   1. Blink: an invoice on the pool's wallet for the sats to receive.
 *   2. FixedFloat: a fixed-rate order SOL → BTC (Lightning) paying that invoice. Its answer is the
 *      SOL to send and a one-off Solana address to send it to, and the treasury sends exactly that
 *      in one plain transfer.
 *
 * Then it waits for FixedFloat to say DONE and Blink to say PAID, and writes what happened to
 * site/data/funding.json. FixedFloat's quote is checked against the wallet's own BTC price and
 * SOL's market price before any money moves, its order is checked against the quote, the deposit
 * address must be a Solana address, the transfer is simulated before it is sent, and a dry run does
 * everything except create the invoice, the order and the transfer.
 *
 *   TREASURY_PRIVATE_KEY=… BLINK_API_KEY=… FIXEDFLOAT_API_KEY=… FIXEDFLOAT_API_SECRET=… node scripts/fund.js
 *   node scripts/fund.js --dry-run           # the plan, priced, nothing sent (Blink and FixedFloat keys still needed for quotes)
 *   node scripts/fund.js --target 150        # keep the Lightning wallet at $150 (default 100)
 *   node scripts/fund.js --min 20 --max 200  # never move less than $20 or more than $200 in one run
 *   node scripts/fund.js --keep-sol 0.05     # SOL the treasury always keeps for fees and rent
 *
 * The key must be the treasury's (the creator wallet in site/config/esim.json), as in claim.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const OUT_PATH = path.join(SITE, 'data', 'funding.json');
const TREASURY_PATH = path.join(SITE, 'data', 'treasury.json');
const { membershipConfig } = require(path.join(SITE, 'api', '_lib', 'membership.js'));
const HTTP_TIMEOUT_MS = 30000;
const KEEP = 100;

const FIXEDFLOAT_API = () => (process.env.FIXEDFLOAT_API || 'https://ff.io/api/v2').replace(/\/$/, '');
// FixedFloat's codes for native SOL and for BTC over Lightning. The order's answer is checked to
// carry the same code and a Solana deposit address, so a wrong guess here stops the run instead
// of sending SOL anywhere.
const FF_FROM = process.env.FIXEDFLOAT_FROM_CCY || 'SOL';
const FF_TO = 'BTCLN';

// targetUsd is the FLOOR the pool is kept at when nothing is owed; what it actually aims for is
// this week's outstanding allowances (see plan()). maxUsd caps one FixedFloat order, which is the
// real exposure in a single run — the money is with an intermediary between leaving the treasury
// and arriving as sats. maxPoolUsd caps the standing balance of what is, after all, a hot wallet
// at a third party: past this the pool stays behind on purpose and the treasury file says so.
// keepLamports never leaves the treasury, so it can always pay for the next claim and its rent.
const DEFAULTS = { targetUsd: 100, minUsd: 20, maxUsd: 500, maxPoolUsd: 1000, keepLamports: 50000000n, waitMs: 10 * 60 * 1000, pollMs: 15000 };
const QUOTE_TOLERANCE = 0.05;   // FixedFloat's rate vs Blink's BTC price and SOL's market price
const ASK_TOLERANCE = 0.03;     // SOL FixedFloat asks for vs the amount quoted
const PRIORITY_MICRO_LAMPORTS = 50000;

const round2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }
async function timedFetch(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// The pure part.
// ---------------------------------------------------------------------------

/**
 * How much to move, and what the pool is actually aiming at.
 *
 * `owedUsd` is what this week's members can still spend — the published budget less what they
 * have already redeemed, written by scripts/treasury.js. Aiming at a flat hundred dollars while
 * scripts/allowances.js published an unbounded budget would be the worst thing about this system:
 * a week that collected thousands of dollars of fees would promise them as data against a
 * hundred-dollar wallet, and everyone past the first few redeemers would get a 503 on the button
 * while their dashboard showed a real balance. So the target follows the promise.
 *
 * Three things still bound it. maxPoolUsd, because the pool is a hot wallet at a third party and
 * an unbounded balance there is its own risk; maxUsd, because one FixedFloat order is the real
 * exposure in a single run; and the treasury's own balance, because we cannot move what we do not
 * have. When a bound is what stops it, the reason says which — a pool deliberately behind reads
 * very differently from a pool nobody noticed was behind.
 *
 * `reserveUsd` is headroom for welcome eSIMs (docs/membership.md), which the same pool pays for.
 * Aiming at exactly what the week owes would leave nothing for them, and the API stops offering
 * the join once the pool less what is owed cannot cover one. It is 0 without membership.
 */
function plan({ walletUsd, poolUsd, owedUsd = null, reserveUsd = 0, targetUsd = DEFAULTS.targetUsd, minUsd = DEFAULTS.minUsd, maxUsd = DEFAULTS.maxUsd, maxPoolUsd = DEFAULTS.maxPoolUsd }) {
  const owed = Number.isFinite(Number(owedUsd)) && owedUsd !== null ? Number(owedUsd) : null;
  const reserve = Number.isFinite(Number(reserveUsd)) && Number(reserveUsd) > 0 ? Number(reserveUsd) : 0;
  const promised = owed === null ? null : owed + reserve;
  const wanted = promised !== null && promised > targetUsd ? Math.min(promised, maxPoolUsd) : targetUsd;
  const capped = promised !== null && promised > maxPoolUsd;
  const aim = `pool $${poolUsd.toFixed(2)}, aiming at $${wanted.toFixed(2)}`
    + (owed === null ? '' : ` of $${owed.toFixed(2)} promised this week`
      + (reserve ? ` plus a $${reserve.toFixed(2)} welcome reserve` : ''))
    + (capped ? ` (held at the $${maxPoolUsd.toFixed(2)} ceiling)` : '');
  const need = round2(wanted - poolUsd);
  if (need < minUsd) return { amountUsd: 0, targetUsd: wanted, owedUsd: owed, reserveUsd: reserve, reason: `${aim}; the shortfall is under the $${minUsd.toFixed(2)} floor` };
  const amountUsd = round2(Math.min(need, walletUsd, maxUsd));
  if (amountUsd < minUsd) return { amountUsd: 0, targetUsd: wanted, owedUsd: owed, reserveUsd: reserve, reason: `${aim}; the treasury holds $${walletUsd.toFixed(2)} of spendable SOL, under the $${minUsd.toFixed(2)} floor` };
  const short = round2(need - amountUsd);
  return {
    amountUsd, targetUsd: wanted, owedUsd: owed, reserveUsd: reserve,
    reason: `${aim}, treasury $${walletUsd.toFixed(2)} of spendable SOL`
      + (short > 0 ? ` — $${short.toFixed(2)} short of the aim this run, ${amountUsd === maxUsd ? 'capped per run' : 'all the treasury has'}` : ''),
  };
}

/** Welcome eSIMs the pool keeps room for beyond what the week owes: five at the dearest welcome price. */
const WELCOME_RESERVE_COUNT = 5;
function welcomeReserveFor(config) {
  const membership = membershipConfig(config);
  return membership ? round2(WELCOME_RESERVE_COUNT * membership.welcome.maxUsd) : 0;
}

/** This week's outstanding allowances, from the treasury file, or null when it cannot say. */
function owedFrom(treasuryFile) {
  // Not `treasuryFile && treasuryFile.owedUsd`: that yields null for a missing file, and
  // Number(null) is 0 — a confident "nothing is owed" where the truth is "we cannot tell".
  const raw = treasuryFile ? treasuryFile.owedUsd : undefined;
  const owed = raw === null ? NaN : Number(raw);
  return Number.isFinite(owed) ? owed : null;
}

function appendLog(existing, entry) {
  return (Array.isArray(existing) ? existing : []).concat([entry]).slice(-KEEP);
}

/** SOL to quote for `amountUsd` at `solUsd`, to the microSOL. */
const solFor = (amountUsd, solUsd) => Math.floor((amountUsd / solUsd) * 1e6) / 1e6;

/**
 * FixedFloat's order, checked before anything is sent: the code we asked for, no memo, a Solana
 * deposit address that is not our own, and an ask within tolerance of what was quoted. Returns
 * { to, lamports, ask } or throws.
 */
function checkOrder(order, { quotedSol, treasury }) {
  const from = (order && order.from) || {};
  if (from.code !== undefined && from.code !== FF_FROM) throw new Error(`FixedFloat's order is for ${from.code}, not ${FF_FROM}; order ${order.id} left to expire`);
  if (from.network !== undefined && from.network !== null && from.network !== '' && !/^sol(ana)?$/i.test(String(from.network))) {
    throw new Error(`FixedFloat's order deposits on ${from.network}, not Solana; order ${order.id} left to expire`);
  }
  if (from.tag !== undefined && from.tag !== null && String(from.tag) !== '') throw new Error(`FixedFloat's order needs a memo (${from.tag}), which a plain transfer cannot carry; order ${order.id} left to expire`);
  const to = String(from.address || '');
  if (!S.isAddress(to)) throw new Error('FixedFloat order came back without a Solana deposit address');
  if (to === treasury) throw new Error('FixedFloat\'s deposit address is the treasury itself; refusing');
  let lamports;
  try { lamports = S.unitsOf(String(from.amount), 9); } catch (e) { throw new Error('FixedFloat order came back without an amount it can be paid in'); }
  const ask = Number(from.amount);
  if (!(lamports > 0n) || !(ask > 0)) throw new Error('FixedFloat order came back without an amount');
  if (ask > quotedSol * (1 + ASK_TOLERANCE)) throw new Error(`FixedFloat asks ${ask} SOL for what was quoted at ${quotedSol} SOL; order ${order.id} left to expire`);
  return { to, lamports, ask };
}

// ---------------------------------------------------------------------------
// FixedFloat: signed JSON over POST. code 0 is success; anything else carries their message.
// ---------------------------------------------------------------------------
function fixedFloat({ key = process.env.FIXEDFLOAT_API_KEY || '', secret = process.env.FIXEDFLOAT_API_SECRET || '', api = FIXEDFLOAT_API() } = {}) {
  async function call(method, body) {
    if (!key || !secret) throw new Error('FIXEDFLOAT_API_KEY and FIXEDFLOAT_API_SECRET are not set');
    const json = JSON.stringify(body);
    const res = await timedFetch(api + '/' + method, {
      method: 'POST',
      headers: {
        accept: 'application/json', 'content-type': 'application/json; charset=UTF-8',
        'X-API-KEY': key, 'X-API-SIGN': crypto.createHmac('sha256', secret).update(json).digest('hex'),
      },
      body: json,
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok && !j) throw new Error('FixedFloat answered HTTP ' + res.status + ' on ' + method);
    if (!j || Number(j.code) !== 0) throw new Error('FixedFloat: ' + ((j && j.msg) || 'HTTP ' + res.status) + ' (' + method + ')');
    return j.data;
  }
  return {
    name: 'fixedfloat',
    ccies: () => call('ccies', {}),
    price: (body) => call('price', body),
    create: (body) => call('create', body),
    order: (body) => call('order', body),
  };
}

/**
 * Whether FixedFloat lists the two currencies a top-up uses: SOL it will take in (`recv`), native
 * on Solana (no token contract), and BTC over Lightning it will pay out (`send`). Read-only: nothing
 * is quoted or ordered. Run before launch, it catches a wrong currency code while there is still
 * time to set FIXEDFLOAT_FROM_CCY.
 */
async function checkCurrencies(ff, { from = FF_FROM, to = FF_TO } = {}) {
  const list = await ff.ccies();
  if (!Array.isArray(list)) throw new Error('FixedFloat returned no currency list');
  const find = (code) => list.find((c) => c && c.code === code) || null;
  const yes = (v) => v === true || v === 1 || v === '1';
  const source = find(from), target = find(to);
  const problems = [];
  if (!source) problems.push(`FixedFloat lists no currency ${from}; set FIXEDFLOAT_FROM_CCY to its code for SOL on Solana`);
  else {
    if (!/^sol(ana)?$/i.test(String(source.network || ''))) problems.push(`FixedFloat's ${from} is on ${source.network || 'an unnamed network'}, not Solana`);
    if (source.contract) problems.push(`FixedFloat's ${from} is a token (${source.contract}), not native SOL`);
    if (!yes(source.recv)) problems.push(`FixedFloat is not taking ${from} in just now`);
  }
  if (!target) problems.push(`FixedFloat lists no currency ${to}`);
  else if (!yes(target.send)) problems.push(`FixedFloat is not paying ${to} out just now`);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function run({ rpc, chain, config, key, payer, ff, solUsd, targetUsd, minUsd, maxUsd, maxPoolUsd, reserveUsd, keepLamports = DEFAULTS.keepLamports,
  dryRun = false, waitMs = DEFAULTS.waitMs, pollMs = DEFAULTS.pollMs, out = OUT_PATH, treasuryPath = TREASURY_PATH,
  confirmOptions = {}, now = () => Date.now(), log = () => {} }) {
  const C = chain || require(path.join(__dirname, 'solana-chain.js'));
  const treasury = config.treasury;
  if (!S.isAddress(treasury)) throw new Error('no treasury in site/config/esim.json');
  if (!key || key.address !== treasury) throw new Error(`wrong wallet: the key is for ${key && key.address}, the treasury is ${treasury}`);

  // 1. Where things stand.
  const pool = await payer.balance();
  const balance = await rpc('getBalance', [treasury, { commitment: 'confirmed' }]);
  const lamports = BigInt(balance && balance.value !== undefined ? balance.value : 0);
  const keep = BigInt(keepLamports);
  const spendable = lamports > keep ? lamports - keep : 0n;
  const price = Number(await (solUsd || C.solUsdNow)());
  if (!(price > 0)) throw new Error('no SOL price to value the treasury');
  const walletUsd = round2((Number(spendable) / 1e9) * price);
  // What this week still owes its members, as scripts/treasury.js last measured it. A day old at
  // worst — the keepers run in the order claim, fund, treasury — which is close enough to aim by.
  const owedUsd = owedFrom(readJson(treasuryPath, null));
  const reserve = reserveUsd === undefined ? welcomeReserveFor(config) : reserveUsd;
  const p = plan({ walletUsd, poolUsd: Number(pool.usd), owedUsd, reserveUsd: reserve, targetUsd, minUsd, maxUsd, maxPoolUsd });
  log(`  pool $${Number(pool.usd).toFixed(2)} (${pool.sats} sats), treasury ${(Number(lamports) / 1e9).toFixed(4)} SOL at $${price.toFixed(2)}, $${walletUsd.toFixed(2)} spendable`);
  if (!p.amountUsd) { log(`  nothing to move: ${p.reason}`); return { action: 'none', reason: p.reason }; }
  const amountUsd = p.amountUsd;
  const quotedSol = solFor(amountUsd, price);

  // 2. FixedFloat's rate for that, checked against the wallet's own BTC price: the SOL quoted
  // should buy about amountUsd of sats.
  const quote = await ff.price({ type: 'fixed', fromCcy: FF_FROM, toCcy: FF_TO, direction: 'from', amount: quotedSol });
  const btc = Number(quote && quote.to && quote.to.amount);
  if (!(btc > 0)) throw new Error('FixedFloat quoted no amount');
  const sats = Math.round(btc * 1e8);
  const implied = sats * Number(pool.usdPerSat);
  if (Math.abs(implied - amountUsd) > amountUsd * QUOTE_TOLERANCE) {
    throw new Error(`FixedFloat's rate is off: ${quotedSol} SOL ($${amountUsd.toFixed(2)}) would buy ${sats} sats, worth $${implied.toFixed(2)} at the wallet's price`);
  }
  log(`  moving $${amountUsd.toFixed(2)}: ${quotedSol} SOL for ${sats} sats via FixedFloat (${p.reason})`);
  if (dryRun) return { action: 'plan', amountUsd, sats, sol: quotedSol, reason: p.reason };

  // 3. The invoice, the order, the transfer — in that order, each checked before the next.
  const invoice = await payer.invoice({ sats, memo: 'OT+T data pool top-up', expiresInMinutes: 120 });
  const order = await ff.create({ type: 'fixed', fromCcy: FF_FROM, toCcy: FF_TO, direction: 'to', amount: (sats / 1e8).toFixed(8), toAddress: invoice.paymentRequest });
  const { to, lamports: sendLamports, ask } = checkOrder(order, { quotedSol, treasury });
  if (sendLamports > spendable) throw new Error(`FixedFloat asks ${ask} SOL and the treasury can spare ${(Number(spendable) / 1e9).toFixed(6)}; order ${order.id} left to expire`);

  const { blockhash, lastValidBlockHeight } = await C.latestBlockhash(rpc);
  const { wire, signature } = C.signedTransaction({
    payer: treasury, blockhash, signers: [key],
    instructions: [S.computeUnitPrice(PRIORITY_MICRO_LAMPORTS), S.systemTransfer({ from: treasury, to, lamports: sendLamports })],
  });
  await C.simulateTransaction(rpc, wire);

  // The journal opens HERE — one line before the only call in this file that moves money, and not
  // after it. Everything above can be retried for nothing; the transfer cannot. A process killed
  // between the broadcast and the write would leave real SOL with FixedFloat and no record of it
  // anywhere but one run's console. A Solana signature is known before it is sent, so 'sending'
  // already names the transfer and the FixedFloat order, which is what a person needs to find the
  // money again.
  const journal = appendLog(readJson(out, []), {
    at: Math.floor(now() / 1000), amountUsd, solSent: ask, lamports: sendLamports.toString(), sats,
    fixedFloatOrder: order.id, invoiceHash: invoice.paymentHash, depositTx: signature,
    status: 'sending', dryRun: false,
  });
  const entry = journal[journal.length - 1];
  const write = () => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(journal, null, 1) + '\n'); };
  write();

  const sent = await C.sendTransaction(rpc, wire);
  if (sent !== signature) log(`  the node answered ${sent} for ${signature}`);
  try {
    await C.confirmTransaction(rpc, signature, Object.assign({ wire, lastValidBlockHeight }, confirmOptions));
  } catch (e) {
    // A wait that ran out is not proof the transfer failed; one that is on chain and succeeded
    // is a confirmation, and the run carries on to wait for the sats.
    let landed = null;
    try { landed = await C.getTransaction(rpc, signature); } catch (err) { landed = null; }
    if (landed && landed.meta && landed.meta.err === null) {
      log(`  ${e.message}, but the transfer is on chain and succeeded`);
    } else {
      entry.status = 'unconfirmed';
      entry.error = String(e.message || e).slice(0, 200);
      write();
      throw new Error(`the transfer ${signature} to FixedFloat was not confirmed (${entry.error}); check it on chain and order ${order.id} at ff.io before running again`);
    }
  }
  log(`  sent ${ask} SOL: ${signature}`);
  entry.status = 'sent';
  write();

  // 4. Wait for the sats. FixedFloat: NEW → PENDING → EXCHANGE → WITHDRAW → DONE; EXPIRED and
  // EMERGENCY are the two that need a person, and the log says so.
  const deadline = now() + waitMs;
  for (;;) {
    let status = 'unknown';
    try { status = String((await ff.order({ id: order.id, token: order.token }) || {}).status || 'unknown'); } catch (e) { log(`  order check failed: ${e.message}`); }
    if (status === 'DONE') {
      let paid = 'UNKNOWN';
      try { paid = (await payer.received(invoice.paymentHash)).status; } catch (e) { /* the order says done; the wallet will show it */ }
      entry.status = paid === 'PAID' ? 'done' : 'done-unconfirmed';
      entry.finishedAt = Math.floor(now() / 1000);
      write();
      log(`  done: ${sats} sats landed (Blink says ${paid})`);
      return { action: 'funded', amountUsd, sats, status: entry.status, entry };
    }
    if (status === 'EXPIRED' || status === 'EMERGENCY') {
      entry.status = status.toLowerCase();
      write();
      throw new Error(`FixedFloat order ${order.id} is ${status} after the transfer ${signature}; it needs a hand at ff.io`);
    }
    if (now() >= deadline) {
      entry.status = 'sent'; entry.lastSeen = status;
      write();
      log(`  still ${status} after ${Math.round(waitMs / 60000)} minutes; recorded as sent`);
      return { action: 'funded', amountUsd, sats, status: 'sent', entry };
    }
    await sleep(pollMs);
  }
}

module.exports = { plan, appendLog, owedFrom, welcomeReserveFor, checkOrder, checkCurrencies, solFor, run, fixedFloat, DEFAULTS, OUT_PATH, TREASURY_PATH, FF_FROM, FF_TO };

if (require.main === module) {
  const C = require(path.join(__dirname, 'solana-chain.js'));
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt; };
  const config = readJson(ESIM_PATH, {});
  // FixedFloat's currency codes, checked read-only: on request (--check), and before launch whenever
  // the keys are there, so a wrong code is caught while nothing depends on it yet.
  const currencies = async () => {
    const r = await checkCurrencies(fixedFloat());
    if (r.ok) console.log(`fund: FixedFloat lists ${FF_FROM} (in, on Solana) and ${FF_TO} (out)`);
    else { r.problems.forEach((p) => console.error('fund: ' + p)); process.exit(1); }
  };
  const fixedFloatKeys = !!(process.env.FIXEDFLOAT_API_KEY && process.env.FIXEDFLOAT_API_SECRET);
  if (argv.includes('--check')) { currencies().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); }); return; }
  // Before launch there is no treasury to move anything from; say so and stop cleanly.
  if (!S.isAddress(config.treasury)) {
    console.log('fund: the coin is not launched yet (no treasury in site/config/esim.json); nothing to move');
    if (fixedFloatKeys) currencies().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
    return;
  }
  const secret = process.env.TREASURY_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
  if (!secret) { console.error('TREASURY_PRIVATE_KEY is required — the treasury\'s Solana secret key, in the environment, never in a file'); process.exit(1); }
  let key;
  try { key = C.keypairFromSecret(secret); } catch (e) { console.error('TREASURY_PRIVATE_KEY: ' + e.message); process.exit(1); }
  process.env.LN_PAYER = process.env.LN_PAYER || 'blink';
  const payer = require(path.join(SITE, 'api', '_lib', 'payers')).payer();
  const log = (m) => process.stderr.write(m + '\n');
  const keepSol = flag('keep-sol', undefined);
  run({
    rpc: C.makeRpc({ log }),
    chain: C,
    config,
    key,
    payer,
    ff: fixedFloat(),
    solUsd: () => C.solUsdNow(),
    targetUsd: flag('target', DEFAULTS.targetUsd),
    minUsd: flag('min', DEFAULTS.minUsd),
    maxUsd: flag('max', DEFAULTS.maxUsd),
    maxPoolUsd: flag('max-pool', DEFAULTS.maxPoolUsd),
    reserveUsd: flag('reserve', undefined),
    keepLamports: keepSol === undefined ? DEFAULTS.keepLamports : BigInt(Math.round(keepSol * 1e9)),
    dryRun: argv.includes('--dry-run'),
    log,
  })
    .then((r) => console.log(r.action === 'none' ? `fund: nothing to move (${r.reason})` : r.action === 'plan' ? `fund: would move $${r.amountUsd.toFixed(2)} (${r.sol} SOL for ${r.sats} sats) — dry run` : `fund: $${r.amountUsd.toFixed(2)} → ${r.sats} sats, ${r.status}`))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
