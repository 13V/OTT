#!/usr/bin/env node
'use strict';
/**
 * The browser's copies of the membership rules, held to the server's.
 *
 * site/esim.js cannot require site/api/_lib (the functions directory is not served), so it
 * carries its own welcome-plan filter, builds the burn transaction itself and writes the welcome
 * message the API checks. If any of those drift, the failure is quiet and costly: the app offers
 * a plan the API refuses, signs a message the API rejects, or asks a wallet to send the wrong
 * transaction. So the copy that ships is loaded under Node, as test/week.test.js does, and
 * compared with the server's code and an independent ABI encoder.
 *
 *   node test/membership-client.test.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rules = require(path.join(ROOT, 'site', 'api', '_lib', 'membership.js'));
const chain = require(path.join(ROOT, 'scripts', 'chain.js'));
const config = require(path.join(ROOT, 'site', 'config', 'esim.json'));

process.env.SIGNIN_HOST = 'ott.test';
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;
const redeem = require(path.join(ROOT, 'site', 'api', 'redeem.js'));

global.window = {};
global.location = { host: 'ott.test' };
require(path.join(ROOT, 'site', 'esim.js'));
const page = global.window.WhateverData;

let failures = 0, checks = 0;
const check = (what, got, want) => {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

console.log('the page exposes the helpers this test compares');
check('signInMessage, burnCalldata and welcomeEligible are on the page global',
  [typeof page.signInMessage, typeof page.burnCalldata, typeof page.welcomeEligible], ['function', 'function', 'function']);

const ADDRESS = '0xe9f89a769f234f6cc75e1c1c6b1fd9963d72c652';
const now = () => Math.floor(Date.now() / 1000);

console.log('\nthe messages the page writes are the ones the API accepts');
const welcomeMessage = page.signInMessage(ADDRESS, { action: 'welcome', packageCode: 'fixed_1GB_7D_AU' });
check('a welcome message passes the API\'s check for that plan', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'welcome', packageCode: 'fixed_1GB_7D_AU' }), null);
check('its first line is the welcome head', welcomeMessage.split('\n')[0], redeem.HEADS.welcome);
check('it names no slot', welcomeMessage.split('\n').some((line) => line.startsWith('Slot: ')), false);
check('it cannot pass as a weekly redemption', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '0' }), 'this signature does not authorise a redemption');
check('or as a read', redeem.checkMessage(welcomeMessage, ADDRESS, now(), { action: 'read' }), 'this signature does not authorise a read');
const redeemMessage = page.signInMessage(ADDRESS, { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: 2 });
check('weekly redemption messages still pass', redeem.checkMessage(redeemMessage, ADDRESS, now(), { action: 'redeem', packageCode: 'fixed_1GB_7D_AU', n: '2' }), null);
check('and read messages still pass', redeem.checkMessage(page.signInMessage(ADDRESS, { action: 'read' }), ADDRESS, now(), { action: 'read' }), null);

console.log('\nthe page offers exactly the welcome plans the API accepts');
const welcome = rules.membershipConfig(config).welcome;
const pageList = config.packages.filter((pkg) => page.welcomeEligible(pkg, welcome)).map((pkg) => pkg.code);
const serverList = config.packages.filter((pkg) => rules.welcomeEligible(pkg, welcome)).map((pkg) => pkg.code);
check('the same plans, across the whole live catalogue', pageList, serverList);
check('which is 27 places\' 1 GB / 7 day plan, everything but Global', [serverList.length, serverList.includes('fixed_1GB_7D_GLOBAL')], [27, false]);

console.log('\nthe burn transaction is a plain ERC-20 transfer to the burn address');
const units = rules.unitsOf(config.membership.burnTokens, 18);
check('its calldata matches an independent ABI encoding of transfer(burnAddress, amount)',
  page.burnCalldata(config.membership.burnAddress, units.toString()),
  chain.encodeCall('transfer(address,uint256)', [config.membership.burnAddress, units]));

console.log('\nthe page refuses burn details from the API that the published config does not back');
const COIN = '0x1111111111111111111111111111111111111111';
const published = Object.assign({}, config, { coin: COIN });
const fromApi = (extra) => Object.assign({ coin: COIN, burnAddress: config.membership.burnAddress, burnTokens: config.membership.burnTokens, burnUnits: units.toString() }, extra);
const ledger = { coin: COIN, decimals: 18 };
check('matching details pass', page.publishedBurnMismatch(published, fromApi(), ledger), '');
check('the burn address compares without regard to case', page.publishedBurnMismatch(published, fromApi({ burnAddress: config.membership.burnAddress.toLowerCase() }), ledger), '');
const refused = (what, api, ledgerFile = ledger, cfg = published) => check(what, /nothing was sent/.test(page.publishedBurnMismatch(cfg, api, ledgerFile)), true);
refused('another burn address is refused', fromApi({ burnAddress: '0x' + '6'.repeat(40) }));
refused('another coin is refused', fromApi({ coin: '0x' + '7'.repeat(40) }));
refused('another burn amount is refused', fromApi({ burnTokens: '1000000' }));
refused('units that do not match the ledger\'s decimals are refused', fromApi({ burnUnits: (units * 10n).toString() }));
check('units are not judged against a ledger for another coin', page.publishedBurnMismatch(published, fromApi({ burnUnits: (units * 10n).toString() }), { coin: '0x' + '8'.repeat(40), decimals: 18 }), '');
refused('a site with no published membership refuses every burn', fromApi(), ledger, Object.assign({}, published, { membership: undefined }));

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
