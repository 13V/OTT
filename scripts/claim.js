#!/usr/bin/env node
'use strict';
/**
 * claim.js — sweep the creator tax out of Pons's fee escrow into the treasury.
 *
 * Every trade against the coin pays its creator tax into Pons's fee escrow, credited to the
 * recipient named at launch. Nothing moves until that recipient calls claim. This is the call, made
 * on a schedule so the tax is never sitting in somebody else's contract for longer than a day:
 *
 *   PRIVATE_KEY=… node scripts/claim.js              # claim whatever is there
 *   PRIVATE_KEY=… node scripts/claim.js --dry-run    # say what it would do, send nothing
 *   node scripts/claim.js --min-usd 5 --min-eth 0.01 # floors below which a claim is not worth gas
 *
 * The key must be the treasury's — the recipient in site/config/esim.json — and the script refuses
 * to run with any other, because a claim from the wrong wallet is not an error, it is a successful
 * transaction that sweeps nothing. What it claims is written to site/data/claims.json (the last
 * hundred, tx hash and amount), which the Data page reads to show when the treasury was last paid.
 *
 * Both of the escrow's claim shapes are handled: `claimToken(token)` for the whole balance, and
 * `claimToken(token, amount)` if the first is refused, because the escrow's selectors were read off
 * its bytecode rather than its source and the one-argument form is an inference. The call is
 * simulated before it is sent, so a wrong inference costs nothing.
 */
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');
const ESIM_PATH = path.join(SITE, 'config', 'esim.json');
const ADDRESSES_PATH = path.join(SITE, 'config', 'addresses.json');
const CLAIMS_PATH = path.join(SITE, 'data', 'claims.json');
const KEEP = 100;

const lower = (a) => String(a || '').toLowerCase();

// ---------------------------------------------------------------------------
// The pure part.
// ---------------------------------------------------------------------------

/** Which claims are worth making. Floors keep a Sunday with three cents of tax from burning gas. */
function plan({ claimableUsd, claimableEth, minUsd = 1, minEth = 0.001 }) {
  const out = [];
  if (claimableUsd >= minUsd) out.push({ kind: 'usdg', amount: claimableUsd });
  if (claimableEth >= minEth) out.push({ kind: 'eth', amount: claimableEth });
  return out;
}

/** Append to the log and keep the newest KEEP. Newest last, so the page reads the tail. */
function appendClaims(existing, entries) {
  const list = (Array.isArray(existing) ? existing : []).concat(entries);
  return list.slice(-KEEP);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

// ---------------------------------------------------------------------------
// The run. `chain` is scripts/chain.js or a test double with the same four methods.
// ---------------------------------------------------------------------------
async function run({ chain, config, addresses, treasury, minUsd, minEth, dryRun = false, out = CLAIMS_PATH, now = () => Date.now(), log = () => {} }) {
  const want = lower(config.treasury);
  if (!want) throw new Error('site/config/esim.json has no treasury yet; nothing to claim for');
  if (lower(treasury) !== want) {
    throw new Error(`the key is for ${treasury}, but the treasury is ${config.treasury}; refusing to claim from the wrong wallet`);
  }
  const escrow = addresses.pons.feeEscrow;
  const usdg = addresses.usdg;
  const decimals = Number(addresses.usdgDecimals || 6);

  const [usdgUnits] = await chain.call(escrow, 'balanceOfToken(address,address)', [treasury, usdg], ['uint256']);
  const [wei] = await chain.call(escrow, 'balanceOf(address)', [treasury], ['uint256']);
  const claimableUsd = Number(usdgUnits) / 10 ** decimals;
  const claimableEth = Number(wei) / 1e18;
  log(`claimable: $${claimableUsd.toFixed(2)} USDG, ${claimableEth.toFixed(6)} ETH`);

  const todo = plan({ claimableUsd, claimableEth, minUsd, minEth });
  if (!todo.length) return { claimed: [], claimableUsd, claimableEth, summary: 'claim: nothing above the floor; no transaction sent' };

  const claimed = [];
  // Written after each item rather than after the loop. `todo` can hold both a USDG and an ether
  // claim, and the loop throws when every call shape for one of them reverts — which the escrow's
  // selectors being read off its bytecode rather than its source makes a real possibility. With
  // one write at the end, a USDG claim that had already been sent, mined and confirmed was
  // discarded from the log by the ether claim failing after it: a real transaction, on chain, with
  // no record anywhere but that one run's console.
  // Read once, up front: writing after every item means re-reading what this run just wrote, and
  // appending `claimed` to that would record each claim again on every subsequent write.
  const before = readJson(out, []);
  const record = () => {
    if (dryRun || !claimed.length) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(appendClaims(before, claimed), null, 1) + '\n');
  };
  for (const item of todo) {
    // One-argument first, two-argument if the escrow wants the amount spelled out.
    const candidates = item.kind === 'usdg'
      ? [['claimToken(address)', [usdg]], ['claimToken(address,uint256)', [usdg, usdgUnits]]]
      : [['claim()', []], ['claim(uint256)', [wei]]];
    let sent = null, lastErr = null;
    for (const [sig, args] of candidates) {
      const data = chain.encodeCall(sig, args);
      try {
        await chain.rpc('eth_call', [{ from: treasury, to: escrow, data }, 'latest']);
      } catch (e) { lastErr = e; log(`  ${sig} would revert (${e.message.slice(0, 80)}); trying the next shape`); continue; }
      if (dryRun) { log(`  [dry-run] would send ${sig}`); sent = { sig, transactionHash: null }; break; }
      const receipt = await chain.send({ to: escrow, data });
      sent = { sig, transactionHash: receipt.transactionHash };
      break;
    }
    if (!sent) {
      // Whatever was claimed before this one is on chain and has to stay in the log, even though
      // this run is about to fail.
      record();
      throw new Error(`could not claim ${item.kind}: every claim shape reverts (${lastErr && lastErr.message})`);
    }
    claimed.push({ at: Math.floor(now() / 1000), kind: item.kind, amount: item.amount, call: sent.sig, txHash: sent.transactionHash, dryRun });
    log(`  claimed ${item.kind} ${item.amount}${sent.transactionHash ? ' in ' + sent.transactionHash : ''}`);
    record();
  }

  const summary = `claim: ${claimed.map((c) => `${c.kind} ${c.amount}`).join(', ')}${dryRun ? ' (dry run, nothing sent)' : ' -> ' + path.relative(process.cwd(), out)}`;
  return { claimed, claimableUsd, claimableEth, summary };
}

module.exports = { plan, appendClaims, run, CLAIMS_PATH };

if (require.main === module) {
  const chain = require(path.join(__dirname, 'chain.js'));
  const flag = (name, dflt) => { const v = chain.flagValue(name); return v === undefined ? dflt : Number(v); };
  const key = process.env.PRIVATE_KEY || '';
  if (!key) { console.error('PRIVATE_KEY is required — the treasury\'s key, in the environment, never in a file'); process.exit(1); }
  run({
    chain,
    config: readJson(ESIM_PATH, {}),
    addresses: readJson(ADDRESSES_PATH, {}),
    treasury: chain.secp.addressOf(key),
    minUsd: flag('--min-usd', 1),
    minEth: flag('--min-eth', 0.001),
    dryRun: chain.dryRun,
    log: (m) => process.stderr.write(m + '\n'),
  })
    .then(({ summary }) => console.log(summary))
    .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
