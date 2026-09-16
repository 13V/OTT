#!/usr/bin/env node
'use strict';
/**
 * The week, agreed on by both ends of the wire.
 *
 * A wallet's allowance is written by the indexer for a given week and spent through the API in that
 * same week, and the page counts down to the end of it. The server side shares one module
 * (site/api/lib/week.js, which scripts/allowances.js imports), but the browser cannot require it —
 * site/api is the serverless functions directory, not a static one — so site/esim.js carries its
 * own copy of the arithmetic.
 *
 * That duplicate is the whole reason this file exists. If the two ever disagree, the failure is
 * silent and expensive: the page shows a countdown to one Monday while the API grants and expires
 * allowances on another, and nobody notices until a wallet is refused data it can see on screen.
 * So both implementations are run over the same timestamps and required to agree exactly.
 *
 *   node test/week.test.js
 */
const path = require('path');

const server = require(path.join(__dirname, '..', 'site', 'api', 'lib', 'week.js'));
const indexer = require(path.join(__dirname, '..', 'scripts', 'allowances.js'));

// site/esim.js is a browser IIFE that hangs its helpers off window. Give it the one global it
// needs and it loads under Node unchanged, which is the only way to test the copy that ships.
global.window = {};
require(path.join(__dirname, '..', 'site', 'esim.js'));
const page = global.window.WhateverData;

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${what}`); else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

console.log('all three implementations are reachable');
check('the API exports the week arithmetic', typeof server.weekOf, 'function');
check('the indexer imports it rather than restating it', indexer.weekOf === server.weekOf, true);
check('the page carries its own copy, on its global', typeof (page && page.weekOf), 'function');

console.log('\nthe anchor is a Monday at midnight UTC');
const anchorDate = new Date(server.ANCHOR * 1000);
check('ANCHOR is a Monday', anchorDate.getUTCDay(), 1);
check('at 00:00:00 UTC', [anchorDate.getUTCHours(), anchorDate.getUTCMinutes(), anchorDate.getUTCSeconds()], [0, 0, 0]);
check('a week is seven days', server.WEEK_S, 7 * 24 * 60 * 60);

console.log('\nthe page and the server agree, second for second');
// Every boundary that has ever caused an off-by-one: the anchor itself, the first and last second
// of a week, a leap day, a DST changeover in a timezone this code deliberately ignores, and today.
const moments = [
  server.ANCHOR, server.ANCHOR + 1, server.ANCHOR - 1,
  1789344000, 1789344000 - 1, 1789344000 + 604799, 1789344000 + 604800,
  Date.parse('2028-02-29T12:00:00Z') / 1000,
  Date.parse('2026-03-29T01:30:00Z') / 1000,
  Date.parse('2026-10-25T01:30:00Z') / 1000,
  Math.floor(Date.now() / 1000),
];
for (const t of moments) {
  const label = new Date(t * 1000).toISOString();
  check(`weekOf agrees at ${label}`, page.weekOf(t), server.weekOf(t));
  check(`weekStart agrees at ${label}`, page.weekStartOf(server.weekOf(t)), server.weekStart(server.weekOf(t)));
  check(`weekEnd agrees at ${label}`, page.weekEndOf(server.weekOf(t)), server.weekEnd(server.weekOf(t)));
}

console.log('\nand the arithmetic itself holds');
const w = server.weekOf(Math.floor(Date.now() / 1000));
check('a week starts where the previous one ends', server.weekStart(w), server.weekEnd(w - 1));
check('the first second of a week belongs to it', server.weekOf(server.weekStart(w)), w);
check('so does the last', server.weekOf(server.weekEnd(w) - 1), w);
check('and the next second does not', server.weekOf(server.weekEnd(w)), w + 1);
check('every week starts on a Monday', new Date(server.weekStart(w) * 1000).getUTCDay(), 1);

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
