#!/usr/bin/env node
'use strict';
/**
 * fund.js — move the creator tax from the treasury wallet into the Lightning wallet that pays for eSIMs.
 *
 * The tax arrives as USDG on Robinhood Chain (scripts/claim.js sweeps it there). wholesale wants
 * sats over Lightning. Three hops, each with an API, none needing a person:
 *
 *   1. Blink: an invoice on the pool's wallet for the sats to receive.
 *   2. FixedFloat: a fixed-rate order USDC (Base) → BTC (Lightning), paying that invoice. Its
 *      answer is the USDC amount to send and a one-off Base address to send it to.
 *   3. Across: a deposit of USDG on Robinhood Chain that is filled as exactly that USDC on Base,
 *      delivered straight to FixedFloat's address (Across takes a recipient), in seconds. No wallet
 *      on Base, no gas there, nothing to sweep back.
 *
 * Then it waits for FixedFloat to say DONE and Blink to say PAID, and writes what happened to
 * site/data/funding.json. Every quote is checked against the wallet's own BTC price before any
 * money moves, the swap is simulated before it is sent, and a dry run does everything except
 * create the invoice, the order and the deposit.
 *
 *   PRIVATE_KEY=… BLINK_API_KEY=… FIXEDFLOAT_API_KEY=… FIXEDFLOAT_API_SECRET=… node scripts/fund.js
 *   node scripts/fund.js --dry-run           # the plan, priced, nothing sent (Blink and FixedFloat keys still needed for quotes)
 *   node scripts/fund.js --target 150        # keep the Lightning wallet at $150 (default 100)
 *   node scripts/fund.js --min 20 --max 200  # never move less than $20 or more than $200 in one run
 *
 * The key must be the treasury's (the fee recipient in site/config/esim.json), as in claim.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const ADDRESSES_PATH = path.join(SITE, 'config', 'addresses.json');
const OUT_PATH = path.join(SITE, 'data', 'funding.json');
const KEEP = 100;

const ACROSS_API = () => (process.env.ACROSS_API || 'https://app.across.to/api').replace(/\/$/, '');
const FIXEDFLOAT_API = () => (process.env.FIXEDFLOAT_API || 'https://ff.io/api/v2').replace(/\/$/, '');
const BASE_CHAIN_ID = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FF_FROM = 'USDCBASE', FF_TO = 'BTCLN';

const DEFAULTS = { targetUsd: 100, minUsd: 20, maxUsd: 200, waitMs: 10 * 60 * 1000, pollMs: 15000 };
const QUOTE_TOLERANCE = 0.05;   // FixedFloat's rate vs Blink's price
const ASK_TOLERANCE = 0.03;     // USDC FixedFloat asks for vs the amount quoted
const BRIDGE_TOLERANCE = 0.02;  // USDG in vs USDC out across the bridge
const APPROVE_SEL = '0x095ea7b3';  // approve(address,uint256)

/**
 * The one approval this run is willing to sign, built here rather than taken from Across.
 *
 * Every other number in fund() is bounded — what FixedFloat may ask, what the bridge may charge,
 * what the treasury holds. An approval is not a number, it is a standing permission, and the one
 * Across hands back asks for all of it, for ever. Signing that on trust would make a bad answer
 * from their API — compromised, hijacked, or merely wrong — worth the entire treasury including
 * every fee it has not earned yet, which is not a risk any amount in this file justifies.
 *
 * So their calldata is read, never sent. It has to be an approve() of our own USDG for the very
 * contract the deposit is about to call; anything else means the flow has changed and this run
 * stops rather than guesses. What is then signed is ours: the same spender, for what this run
 * needs and not a unit more. scripts/claim.js has never signed anyone else's bytes; this is the
 * same discipline reaching the one leg that had escaped it.
 */
function approvalFor(chain, t, { usdg, spender, units }) {
  const to = String((t && t.to) || '').toLowerCase();
  const data = String((t && t.data) || '').toLowerCase();
  if (to !== String(usdg).toLowerCase()) {
    throw new Error(`Across wants an approval sent to ${to || '(nothing)'}, which is not USDG (${usdg}); refusing to sign it`);
  }
  if (!data.startsWith(APPROVE_SEL) || data.length !== 2 + 8 + 64 + 64) {
    throw new Error('Across wants to send calldata that is not a plain approve(address,uint256); refusing to sign it');
  }
  const asked = '0x' + data.slice(10, 74).slice(24);
  if (asked !== String(spender).toLowerCase()) {
    throw new Error(`Across wants USDG approved for ${asked}, but the deposit goes to ${spender}; refusing to sign it`);
  }
  // Same token, same spender, our amount: enough for this deposit and worthless afterwards.
  return { to: usdg, data: chain.encodeCall('approve(address,uint256)', [spender, units]) };
}

const lower = (a) => String(a || '').toLowerCase();
const round2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

// ---------------------------------------------------------------------------
// The pure part.
// ---------------------------------------------------------------------------

/** How much to move: fill the wallet to the target from what the treasury holds, within the floors. */
function plan({ walletUsd, poolUsd, targetUsd = DEFAULTS.targetUsd, minUsd = DEFAULTS.minUsd, maxUsd = DEFAULTS.maxUsd }) {
  const need = round2(targetUsd - poolUsd);
  if (need < minUsd) return { amountUsd: 0, reason: `the pool holds $${poolUsd.toFixed(2)} of a $${targetUsd.toFixed(2)} target; under the $${minUsd.toFixed(2)} floor` };
  const amountUsd = round2(Math.min(need, walletUsd, maxUsd));
  if (amountUsd < minUsd) return { amountUsd: 0, reason: `the treasury holds $${walletUsd.toFixed(2)} USDG; under the $${minUsd.toFixed(2)} floor` };
  return { amountUsd, reason: `pool $${poolUsd.toFixed(2)}, target $${targetUsd.toFixed(2)}, treasury $${walletUsd.toFixed(2)}` };
}

function appendLog(existing, entry) {
  return (Array.isArray(existing) ? existing : []).concat([entry]).slice(-KEEP);
}

// ---------------------------------------------------------------------------
// The three services. Each is a thin client; the tests hand in fakes with the same shape.
// ---------------------------------------------------------------------------

/** FixedFloat: signed JSON over POST. code 0 is success; anything else carries their message. */
function fixedFloat({ key = process.env.FIXEDFLOAT_API_KEY || '', secret = process.env.FIXEDFLOAT_API_SECRET || '', api = FIXEDFLOAT_API() } = {}) {
  async function call(method, body) {
    if (!key || !secret) throw new Error('FIXEDFLOAT_API_KEY and FIXEDFLOAT_API_SECRET are not set');
    const json = JSON.stringify(body);
    const res = await fetch(api + '/' + method, {
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
    price: (body) => call('price', body),
    create: (body) => call('create', body),
    order: (body) => call('order', body),
  };
}

/** Across: one GET that answers the approval and the deposit transaction, ready to sign. */
function across({ api = ACROSS_API() } = {}) {
  return {
    name: 'across',
    async quote(params) {
      const url = api + '/swap/approval?' + new URLSearchParams(params).toString();
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok) throw new Error('Across answered HTTP ' + res.status + ((j && j.message) ? ': ' + j.message : ''));
      if (!j || !j.swapTx) throw new Error('Across gave no transaction');
      return j;
    },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function run({ chain, config, addresses, treasury, payer, ff, bridge, targetUsd, minUsd, maxUsd, dryRun = false, waitMs = DEFAULTS.waitMs, pollMs = DEFAULTS.pollMs, out = OUT_PATH, now = () => Date.now(), log = () => {} }) {
  const want = lower(config.treasury);
  if (!want) throw new Error('no treasury in site/config/esim.json');
  if (lower(treasury) !== want) throw new Error(`wrong wallet: the key is for ${treasury}, the treasury is ${config.treasury}`);
  const usdg = addresses.usdg;
  const decimals = Number(addresses.usdgDecimals || 6);
  const units = (usd) => BigInt(Math.round(usd * 10 ** decimals));

  // 1. Where things stand.
  const pool = await payer.balance();
  const [walletUnits] = await chain.call(usdg, 'balanceOf(address)', [treasury], ['uint256']);
  const walletUsd = Number(walletUnits) / 10 ** decimals;
  const p = plan({ walletUsd, poolUsd: Number(pool.usd), targetUsd, minUsd, maxUsd });
  log(`  pool $${Number(pool.usd).toFixed(2)} (${pool.sats} sats), treasury $${walletUsd.toFixed(2)} USDG`);
  if (!p.amountUsd) { log(`  nothing to move: ${p.reason}`); return { action: 'none', reason: p.reason }; }
  const amountUsd = p.amountUsd;

  // 2. FixedFloat's rate for that, checked against the wallet's own BTC price.
  const quote = await ff.price({ type: 'fixed', fromCcy: FF_FROM, toCcy: FF_TO, direction: 'from', amount: amountUsd });
  const btc = Number(quote && quote.to && quote.to.amount);
  if (!(btc > 0)) throw new Error('FixedFloat quoted no amount');
  const sats = Math.round(btc * 1e8);
  const implied = sats * Number(pool.usdPerSat);
  if (Math.abs(implied - amountUsd) > amountUsd * QUOTE_TOLERANCE) {
    throw new Error(`FixedFloat's rate is off: $${amountUsd.toFixed(2)} would buy ${sats} sats, worth $${implied.toFixed(2)} at the wallet's price`);
  }
  log(`  moving $${amountUsd.toFixed(2)}: ${sats} sats via FixedFloat (${p.reason})`);
  if (dryRun) return { action: 'plan', amountUsd, sats, reason: p.reason };

  // 3. The invoice, the order, the deposit — in that order, each checked before the next.
  const invoice = await payer.invoice({ sats, memo: 'OT+T data pool top-up', expiresInMinutes: 120 });
  const order = await ff.create({ type: 'fixed', fromCcy: FF_FROM, toCcy: FF_TO, direction: 'to', amount: (sats / 1e8).toFixed(8), toAddress: invoice.paymentRequest });
  const ask = Number(order && order.from && order.from.amount);
  const to = order && order.from && order.from.address;
  if (!(ask > 0) || !/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw new Error('FixedFloat order came back without an amount or an address');
  if (ask > amountUsd * (1 + ASK_TOLERANCE)) throw new Error(`FixedFloat asks $${ask.toFixed(2)} USDC for the ${sats} sats quoted at $${amountUsd.toFixed(2)}; order ${order.id} left to expire`);
  const usdcUnits = units(ask);

  const q = await bridge.quote({
    originChainId: String(addresses.chainId || 4663), destinationChainId: String(BASE_CHAIN_ID),
    inputToken: usdg, outputToken: USDC_BASE, amount: usdcUnits.toString(), tradeType: 'exactOutput',
    depositor: treasury, recipient: to,
  });
  const inUnits = BigInt(q.inputAmount || q.maxInputAmount || 0);
  const minOut = BigInt(q.minOutputAmount || 0);
  if (minOut < usdcUnits) throw new Error(`Across would deliver ${minOut} of the ${usdcUnits} USDC units FixedFloat asks for`);
  if (inUnits > usdcUnits + (usdcUnits * BigInt(Math.round(BRIDGE_TOLERANCE * 1000))) / 1000n) throw new Error(`Across wants ${inUnits} USDG units for ${usdcUnits} USDC; more than ${BRIDGE_TOLERANCE * 100}% over`);
  if (inUnits > walletUnits) throw new Error(`the bridge needs ${inUnits} USDG units and the treasury holds ${walletUnits}`);

  const tx = q.swapTx || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tx.to || ''))) throw new Error('Across returned no deposit address');
  const value = tx.value ? BigInt(tx.value) : 0n;

  // Approve if Across says so — for this deposit's spender and this deposit's amount, in calldata
  // built here. See approvalFor() for why none of theirs is signed.
  const hashes = [];
  for (const t of q.approvalTxns || []) {
    const safe = approvalFor(chain, t, { usdg, spender: tx.to, units: inUnits });
    const r = await chain.send(safe);
    hashes.push(r.transactionHash);
    log(`  approved ${inUnits} USDG units for the bridge at ${tx.to}: ${r.transactionHash}`);
  }
  await chain.rpc('eth_call', [{ from: treasury, to: tx.to, data: tx.data, value: '0x' + value.toString(16) }, 'latest']);
  const receipt = await chain.send({ to: tx.to, data: tx.data, value });
  log(`  deposited: ${receipt.transactionHash}`);

  const entry = {
    at: Math.floor(now() / 1000), amountUsd, usdcSent: ask, usdgIn: Number(inUnits) / 10 ** decimals, sats,
    fixedFloatOrder: order.id, invoiceHash: invoice.paymentHash, depositTx: receipt.transactionHash, approvals: hashes,
    status: 'sent', dryRun: false,
  };
  // One entry per run, appended once and rewritten in place as its status moves on.
  const journal = appendLog(readJson(out, []), entry);
  const write = () => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(journal, null, 1) + '\n'); };
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
      throw new Error(`FixedFloat order ${order.id} is ${status} after the deposit ${receipt.transactionHash}; it needs a hand at ff.io`);
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

module.exports = { plan, appendLog, run, fixedFloat, across, DEFAULTS, OUT_PATH, USDC_BASE, BASE_CHAIN_ID };

if (require.main === module) {
  const chain = require(path.join(__dirname, 'chain.js'));
  const flag = (name, dflt) => { const v = chain.flagValue(name); return v === undefined ? dflt : Number(v); };
  const key = process.env.PRIVATE_KEY || '';
  if (!key) { console.error('PRIVATE_KEY is required — the treasury\'s key, in the environment, never in a file'); process.exit(1); }
  process.env.LN_PAYER = process.env.LN_PAYER || 'blink';
  const payer = require(path.join(SITE, 'api', 'lib', 'payers')).payer();
  run({
    chain,
    config: readJson(ESIM_PATH, {}),
    addresses: readJson(ADDRESSES_PATH, {}),
    treasury: chain.secp.addressOf(key),
    payer,
    ff: fixedFloat(),
    bridge: across(),
    targetUsd: flag('target', DEFAULTS.targetUsd),
    minUsd: flag('min', DEFAULTS.minUsd),
    maxUsd: flag('max', DEFAULTS.maxUsd),
    dryRun: chain.dryRun,
    log: (m) => process.stderr.write(m + '\n'),
  })
    .then((r) => console.log(r.action === 'none' ? `fund: nothing to move (${r.reason})` : r.action === 'plan' ? `fund: would move $${r.amountUsd.toFixed(2)} (${r.sats} sats) — dry run` : `fund: $${r.amountUsd.toFixed(2)} → ${r.sats} sats, ${r.status}`))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
