#!/usr/bin/env node
'use strict';

/** Read-only launch checks. Never signs, redeems, funds a wallet or prints backend secrets. */
const fs = require('node:fs');
const path = require('node:path');
const { weekOf } = require('../site/api/_lib/week');
const { catalogueReady, catalogueFingerprint } = require('../site/api/_lib/catalogue');
const S = require('../site/solana.js');
const FRONTEND = 'https://13v.github.io';
// A launch address is a canonical base58 Solana address, never the all-zero key an unset one reads as.
const address = value => S.isAddress(value) && value !== S.PROGRAMS.system;
const row = (id, label, ok, detail) => ({ id, label, ok: !!ok, detail });
// The four addresses filled in on launch day (docs/membership.md). The incinerator's account sits
// in the membership block, in esim.json and in /api/status's config summary alike.
const launchFields = cfg => ({ coin: cfg?.coin, tokenProgram: cfg?.tokenProgram, treasury: cfg?.treasury, burnAccount: cfg?.membership?.burnAccount });
const unlaunched = cfg => Object.values(launchFields(cfg)).every(value => value === '');
const launchedConfig = cfg => cfg?.chain === 'solana' && address(cfg?.coin) && S.TOKEN_PROGRAMS.includes(cfg?.tokenProgram)
  && address(cfg?.treasury) && address(cfg?.membership?.burnAccount);
function catalogueMatches(body, esim) {
  const fingerprint = catalogueFingerprint(esim);
  return !!fingerprint && body?.ready?.config === true && body?.config?.packages === esim.packages.length
    && body?.config?.catalogueAt === esim.catalogueAt && body?.config?.catalogueFingerprint === fingerprint;
}
function freshStatus(body, now) {
  const asOf = Number(body?.asOf);
  return body?.ok === true && !body.error && Number.isFinite(asOf) && asOf <= now / 1000 + 30 && now / 1000 - asOf < 180;
}
function httpsRpc(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch (_) { return false; }
}
const httpsRpcs = list => Array.isArray(list) && list.length > 0 && list.every(httpsRpc);

function apiOrigin(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && /^https:\/\/[^/\\?#\s]+\/?$/i.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : '';
  } catch (_) { return ''; }
}

function publicChecks({ app, esim, chain }) {
  return [
    row('api', 'HTTPS backend origin', !!apiOrigin(app?.apiBaseUrl), 'Configure the real API origin, without a path or credentials.'),
    row('contracts', 'Token launch addresses', launchedConfig(esim), 'Publish the real coin, its token program, the treasury and the incinerator account after launch.'),
    row('chain', 'Wallet network', chain?.chain === 'solana' && chain.cluster === 'mainnet-beta' && httpsRpcs(chain.rpcs) && httpsRpcs(chain.browserRpcs),
      'Use Solana mainnet with HTTPS RPC endpoints for the keepers and for browsers.'),
    row('catalogue', 'Data catalogue', catalogueReady(esim), 'Publish valid, uniquely named provider packages with data, duration and price.'),
  ];
}

function prelaunchPublicChecks(config) {
  return publicChecks(config).map(check => check.id === 'contracts'
    ? row('prelaunch-contracts', 'Token launch remains pending', unlaunched(config.esim), 'All four token launch addresses must remain blank during prelaunch.') : check)
    .concat(row('provider-selection', 'Provider selection', config.esim?.provider === 'wholesale', 'Use the verified nadanada wholesale catalogue.'));
}

function prelaunchStatusChecks(body, esim, now = Date.now()) {
  return [
    row('status', 'Backend status response', freshStatus(body, now), 'A fresh, valid status response is required; HTTP 200 alone is insufficient.'),
    row('prelaunch-contracts-match', 'Backend remains prelaunch', unlaunched(body?.config) && body?.config?.launched === false, 'The backend must also keep all four token launch addresses blank.'),
    row('redemption-paused', 'Redemption remains disabled', body?.redemption?.enabled === false && body?.redemption?.ready === false, 'Disable redemption while preparing the service.'),
    row('backend-config', 'Backend catalogue', catalogueMatches(body, esim), 'Deploy the same reviewed catalogue, including provider SKU, coverage, data, duration and price, as the frontend.'),
    row('backend-provider', 'Provider catalogue access', body?.ready?.provider === true && body?.wiring?.provider === 'wholesale', 'The real provider catalogue must answer without placing an order.'),
    row('backend-store', 'Durable order storage', body?.ready?.store === true && body?.wiring?.store === 'upstash', 'Connect the durable Redis REST store before live use.'),
    row('payer-selection', 'Lightning payer selection', body?.wiring?.payer === 'blink', 'Select Blink; funding and payment validation are deferred.'),
  ];
}

function statusChecks(body, esim, now = Date.now()) {
  // Base58 is case-sensitive, so the backend's addresses must match the app's exactly.
  const backend = launchFields(body?.config), app = launchFields(esim);
  const sameContracts = launchedConfig(body?.config) && Object.keys(app).every(key => backend[key] === app[key]);
  const currentWeek = weekOf(Math.floor(now / 1000));
  const allocation = body?.allowances;
  const rows = [
    row('status', 'Backend status response', freshStatus(body, now), 'A fresh, valid status response is required; HTTP 200 alone is insufficient.'),
    row('contracts-match', 'Backend token addresses', sameContracts && body?.config?.launched === true, 'The backend must use the same launched token addresses as the app.'),
    row('redemption-enabled', 'Redemption enabled', body?.redemption?.enabled === true && body?.redemption?.ready === true, 'Enable redemption only after validating the launched, funded service.'),
  ];
  for (const key of ['config', 'provider', 'payer', 'store', 'allowances']) {
    rows.push(row('backend-' + key, 'Backend ' + key, key === 'config' ? catalogueMatches(body, esim) : body?.ready?.[key] === true,
      key === 'config' ? 'Deploy the same reviewed catalogue, including provider SKU, coverage, data, duration and price, as the frontend.' : 'Check this dependency in the hosting environment.'));
  }
  rows.push(row('real-provider', 'Verified provider and durable store', body?.wiring?.provider === esim?.provider && body?.wiring?.provider === 'wholesale'
    && body?.wiring?.payer === 'blink' && body?.wiring?.store === 'upstash', 'Use the probed wholesale provider, Blink and durable storage. Alternative providers need a real liveness probe before passing.'));
  rows.push(row('current-week', 'Current weekly allocation', allocation?.stale === false && allocation.week === currentWeek, 'The ledger must belong to the current week.'));
  rows.push(row('funded-payer', 'Funded Lightning wallet', Number.isFinite(body?.pool?.usd) && body.pool.usd > 0 && Number.isFinite(body?.pool?.sats) && body.pool.sats > 0, 'The payer must report a positive balance. This does not certify budget coverage.'));
  return rows;
}

async function probeBackend(origin, esim, fetcher = fetch, prelaunch = false) {
  const requests = await Promise.allSettled([
    fetcher(origin + '/api/status', { method: 'GET', headers: { Origin: FRONTEND }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) }),
    fetcher(origin + '/api/redeem', { method: 'OPTIONS', headers: { Origin: FRONTEND, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12000) }),
  ]);
  const rows = [];
  const status = requests[0];
  if (status.status === 'fulfilled') {
    const response = status.value;
    rows.push(row('status-cors', 'GitHub Pages status access', response.headers.get('access-control-allow-origin') === FRONTEND, 'Allow exactly the GitHub Pages frontend origin.'));
    try {
      const body = response.ok && /^application\/json\b/i.test(response.headers.get('content-type') || '') ? await response.json() : null;
      rows.push(...(prelaunch ? prelaunchStatusChecks(body, esim) : statusChecks(body, esim)));
    } catch (_) { rows.push(row('status', 'Backend status response', false, 'The backend did not return valid JSON.')); }
  } else rows.push(row('status', 'Backend status response', false, 'The HTTPS backend could not be reached without redirects.'));
  const preflight = requests[1];
  const response = preflight.status === 'fulfilled' ? preflight.value : null;
  const allowedMethods = (response?.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim().toUpperCase());
  const allowedHeaders = (response?.headers.get('access-control-allow-headers') || '').split(',').map(value => value.trim().toLowerCase());
  rows.push(row('redeem-cors', 'GitHub Pages redemption preflight', response?.status === 204 && response.headers.get('access-control-allow-origin') === FRONTEND && allowedMethods.includes('POST') && allowedHeaders.includes('content-type'), 'Permit the frontend’s JSON POST preflight. This check does not place an order.'));
  return rows;
}

/**
 * The incinerator account must be the one derived from the coin and its token program; a typo
 * there sends members' OTT somewhere else. Re-derived here so the launch check says so too.
 */
async function burnAccountCheck(esim) {
  let ok = false;
  try {
    ok = launchedConfig(esim) && await S.associatedTokenAddress(S.INCINERATOR, esim.coin, esim.tokenProgram) === esim.membership.burnAccount;
  } catch (_) { ok = false; }
  return row('burn-account', 'Incinerator account', ok, 'membership.burnAccount must be the incinerator’s token account for the coin.');
}

async function main(args = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
  if (args.some(arg => !['--remote', '--json', '--prelaunch', '--help'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Use check:launch with --remote, --json, --prelaunch or --help only.');
  if (args.includes('--help')) {
    console.log('npm run check:launch -- [--remote] [--json] [--prelaunch]\nChecks public settings; --remote also reads backend status and CORS preflight.\n--prelaunch checks preparation with redemption disabled. Funding, token launch and live allocations are deferred.\nNo signatures, orders or payments.');
    return 0;
  }
  let config;
  try {
    const read = name => JSON.parse(fs.readFileSync(path.join(root, 'site/config', name), 'utf8'));
    config = { app: read('app.json'), esim: read('esim.json'), chain: read('addresses.json') };
  } catch (_) { throw new Error('The public app configuration is missing or invalid JSON.'); }
  const prelaunch = args.includes('--prelaunch');
  const checks = prelaunch ? prelaunchPublicChecks(config) : publicChecks(config);
  if (!prelaunch) checks.push(await burnAccountCheck(config.esim));
  const configured = checks.every(check => check.ok);
  const remote = args.includes('--remote');
  const origin = apiOrigin(config.app?.apiBaseUrl);
  if (remote && origin) checks.push(...await probeBackend(origin, config.esim, fetch, prelaunch));
  const passed = checks.every(check => check.ok);
  const deferred = prelaunch ? ['Token launch addresses', 'Funded Lightning wallet and real payment', 'Funded holder allocations', 'Installation on a real phone'] : [];
  const report = { stage: prelaunch ? 'prelaunch' : 'launch', configured, remoteChecked: remote && !!origin, checksPassed: remote && !!origin && passed, liveRedemptionReady: !prelaunch && remote && !!origin && passed, checks, deferred };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of checks) console.log((check.ok ? 'PASS ' : 'WAIT ') + check.label + (check.ok ? '' : ': ' + check.detail));
    if (prelaunch) console.log('Prelaunch setup only. Still deferred: ' + deferred.join('; ') + '.');
    console.log(remote && origin ? 'These checks do not validate allocation economics, actual coverage or a real phone installation.' : 'Remote dependencies have not been checked. Run with --remote after configuring the API origin.');
  }
  return passed ? 0 : 1;
}

module.exports = { apiOrigin, catalogueReady, publicChecks, prelaunchPublicChecks, statusChecks, prelaunchStatusChecks, probeBackend, burnAccountCheck, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Launch check failed. Check the public configuration and supported flags.'); process.exitCode = 1; });
