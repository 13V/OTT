'use strict';
/**
 * week.js — the week arithmetic every file that reasons about an allowance needs, kept in one
 * place so redeem.js and status.js can never disagree with each other about what week it is.
 *
 * A week is Monday 00:00 UTC through the following Monday 00:00 UTC. ANCHOR is that Monday
 * nearest the epoch (5 Jan 1970 00:00 UTC), so week 0 starts there and every boundary since then
 * falls a whole multiple of WEEK_S seconds after it. This is the same formula the indexer
 * (scripts/allowances.js) uses to decide which week's allowance a wallet is entitled to and to
 * stamp allowances.json's own `week` field — it is fixed forever, because changing it would make
 * every allowances.json ever written name the wrong week for the balances it holds, and every
 * past redemption id (which is derived from the week it was made in) unreachable.
 */
const WEEK_S = 604800;   // 7 * 24 * 60 * 60
const ANCHOR = 345600;   // Mon 5 Jan 1970 00:00 UTC

const weekOf = (unixSeconds) => Math.floor((Number(unixSeconds) - ANCHOR) / WEEK_S);
const weekStart = (w) => ANCHOR + w * WEEK_S; // inclusive
const weekEnd = (w) => weekStart(w) + WEEK_S; // exclusive

module.exports = { WEEK_S, ANCHOR, weekOf, weekStart, weekEnd };
