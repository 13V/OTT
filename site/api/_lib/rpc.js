'use strict';
/**
 * rpc — the one chain read the API makes: the join transaction a welcome claim names, when it is
 * newer than the weekly ledger. Endpoints come from SOLANA_RPC_URL (comma-separated, tried first:
 * an operator's own RPC) and then config/addresses.json's `rpcs`, which site/vercel.json bundles
 * with the function. site/solana.js does the rotation: each endpoint is tried once, and a null
 * (a transaction one node has not seen yet) is only believed once every endpoint has said it.
 *
 * Timeouts are short because this runs inside a request a person is waiting on. When nothing
 * answers, the error is a 503 the caller can retry.
 */
const fs = require('fs');
const path = require('path');
const S = require('../../solana.js');

const ADDRESSES_PATH = path.join(__dirname, '..', '..', 'config', 'addresses.json');
const TIMEOUT_MS = 4000;
const TX_OPTIONS = Object.freeze({ encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' });

function endpoints() {
  const fromEnv = String(process.env.SOLANA_RPC_URL || '').split(',').map((url) => url.trim()).filter((url) => /^https?:\/\//i.test(url));
  let fromFile = [];
  try {
    const addresses = JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
    fromFile = (Array.isArray(addresses.rpcs) ? addresses.rpcs : []).filter((url) => typeof url === 'string' && /^https:\/\//i.test(url));
  } catch (e) { fromFile = []; }
  return [...new Set([...fromEnv, ...fromFile])];
}

function unavailable() {
  const error = new Error('the chain could not be read just now; try again in a moment');
  error.status = 503;
  return error;
}

async function call(method, params) {
  const urls = endpoints();
  if (!urls.length) throw unavailable();
  try {
    return await S.createRpc(urls, { timeoutMs: TIMEOUT_MS, rounds: 1, pauseMs: 0 })(method, params);
  } catch (e) { throw unavailable(); }
}

// A claim naming a transaction that doesn't exist costs a lookup on every endpoint. So a missing
// signature is remembered for a few seconds, and lookups are capped per instance per minute: a
// script naming random transactions can't turn the API into an amplifier against the RPCs. Past
// the cap the caller gets the same 503 as an outage, which the app treats as "try again".
const MISSING_TTL_MS = 10 * 1000;
const LOOKUPS_PER_MINUTE = 60;
const missing = new Map(); // signature -> when it was last found missing
let lookups = { minute: 0, count: 0 };

/** One transaction, jsonParsed, any version. null when no endpoint has it. */
async function getTransaction(signature) {
  const now = Date.now();
  const seen = missing.get(signature);
  if (seen !== undefined && now - seen < MISSING_TTL_MS) return null;
  const minute = Math.floor(now / 60000);
  if (lookups.minute !== minute) lookups = { minute, count: 0 };
  lookups.count += 1;
  if (lookups.count > LOOKUPS_PER_MINUTE) throw unavailable();
  const tx = await call('getTransaction', [signature, TX_OPTIONS]);
  if (tx === null) {
    missing.set(signature, now);
    if (missing.size > 5000) for (const k of [...missing.keys()].slice(0, 2500)) missing.delete(k);
  }
  return tx;
}

/** Tests only: forget remembered lookups. */
function _reset() { missing.clear(); lookups = { minute: 0, count: 0 }; }

module.exports = { call, getTransaction, endpoints, TX_OPTIONS, LOOKUPS_PER_MINUTE, _reset };
