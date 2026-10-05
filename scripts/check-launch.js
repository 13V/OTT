#!/usr/bin/env node
'use strict';

/** Read-only launch checks. Never signs, redeems, funds a wallet or prints backend secrets. */
const fs = require('node:fs');
const path = require('node:path');
const { weekOf } = require('../site/api/lib/week');
const FRONTEND = 'https://13v.github.io';
const address = value => /^0x[\da-f]{40}$/i.test(value || '') && !/^0x0{40}$/i.test(value);
const row = (id, label, ok, detail) => ({ id, label, ok: !!ok, detail });
function httpsRpc(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch (_) { return false; }
}

function apiOrigin(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && /^https:\/\/[^/\\?#\s]+\/?$/i.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : '';
  } catch (_) { return ''; }
}

function publicChecks({ app, esim, chain }) {
  const projectId = app?.walletConnect?.projectId;
  const launched = ['coin', 'curve', 'treasury'].every(key => address(esim?.[key]));
  return [
    row('wallet', 'Mobile wallet project', typeof projectId === 'string' && /^[\da-f]{32}$/i.test(projectId), 'Configure the public Reown project ID.'),
    row('api', 'HTTPS backend origin', !!apiOrigin(app?.apiBaseUrl), 'Configure the real API origin, without a path or credentials.'),
    row('contracts', 'Token launch addresses', launched, 'Publish the real coin, curve and treasury addresses after launch.'),
    row('chain', 'Wallet network', Number.isSafeInteger(chain?.chainId) && chain.chainId > 0 && httpsRpc(chain.rpc), 'Use the configured chain ID and HTTPS RPC.'),
    row('catalogue', 'Data catalogue', Array.isArray(esim?.packages) && esim.packages.length > 0, 'Publish the provider catalogue before redemption.'),
  ];
}

function statusChecks(body, esim, now = Date.now()) {
  const sameContracts = ['coin', 'curve', 'treasury'].every(key => address(body?.config?.[key])
    && String(body.config[key]).toLowerCase() === String(esim?.[key] || '').toLowerCase());
  const asOf = Number(body?.asOf);
  const timely = Number.isFinite(asOf) && asOf <= now / 1000 + 30 && now / 1000 - asOf < 180;
  const currentWeek = weekOf(Math.floor(now / 1000));
  const allocation = body?.allowances;
  const rows = [
    row('status', 'Backend status response', body?.ok === true && timely, 'A fresh, valid status response is required; HTTP 200 alone is insufficient.'),
    row('contracts-match', 'Backend token addresses', sameContracts && body?.config?.launched === true, 'The backend must use the same launched token addresses as the app.'),
  ];
  for (const key of ['config', 'provider', 'payer', 'store', 'allowances']) {
    rows.push(row('backend-' + key, 'Backend ' + key, body?.ready?.[key] === true, 'Check this dependency in the hosting environment.'));
  }
  rows.push(row('real-provider', 'Verified provider and durable store', body?.wiring?.provider === esim?.provider && body?.wiring?.provider === 'wholesale'
    && body?.wiring?.payer === 'blink' && body?.wiring?.store === 'upstash', 'Use the probed wholesale provider, Blink and durable storage. Alternative providers need a real liveness probe before passing.'));
  rows.push(row('current-week', 'Current weekly allocation', allocation?.stale === false && allocation.week === currentWeek, 'The ledger must belong to the current week.'));
  rows.push(row('funded-payer', 'Funded Lightning wallet', Number.isFinite(body?.pool?.usd) && body.pool.usd > 0 && Number.isFinite(body?.pool?.sats) && body.pool.sats > 0, 'The payer must report a positive balance. This does not certify budget coverage.'));
  return rows;
}

async function probeBackend(origin, esim, fetcher = fetch) {
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
      rows.push(...statusChecks(body, esim));
    } catch (_) { rows.push(row('status', 'Backend status response', false, 'The backend did not return valid JSON.')); }
  } else rows.push(row('status', 'Backend status response', false, 'The HTTPS backend could not be reached without redirects.'));
  const preflight = requests[1];
  const response = preflight.status === 'fulfilled' ? preflight.value : null;
  const allowedMethods = (response?.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim().toUpperCase());
  const allowedHeaders = (response?.headers.get('access-control-allow-headers') || '').split(',').map(value => value.trim().toLowerCase());
  rows.push(row('redeem-cors', 'GitHub Pages redemption preflight', response?.status === 204 && response.headers.get('access-control-allow-origin') === FRONTEND && allowedMethods.includes('POST') && allowedHeaders.includes('content-type'), 'Permit the frontend’s JSON POST preflight. This check does not place an order.'));
  return rows;
}

async function main(args = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
  if (args.some(arg => !['--remote', '--json', '--help'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Use check:launch with --remote, --json or --help only.');
  if (args.includes('--help')) {
    console.log('npm run check:launch [-- --remote] [--json]\nChecks public settings; --remote also reads backend status and CORS preflight. No wallet or redemption requests.');
    return 0;
  }
  let config;
  try {
    const read = name => JSON.parse(fs.readFileSync(path.join(root, 'site/config', name), 'utf8'));
    config = { app: read('app.json'), esim: read('esim.json'), chain: read('addresses.json') };
  } catch (_) { throw new Error('The public app configuration is missing or invalid JSON.'); }
  const checks = publicChecks(config);
  const configured = checks.every(check => check.ok);
  const remote = args.includes('--remote');
  const origin = apiOrigin(config.app?.apiBaseUrl);
  if (remote && origin) checks.push(...await probeBackend(origin, config.esim));
  const passed = checks.every(check => check.ok);
  const report = { configured, remoteChecked: remote && !!origin, checksPassed: remote && !!origin && passed, checks };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of checks) console.log((check.ok ? 'PASS ' : 'WAIT ') + check.label + (check.ok ? '' : ': ' + check.detail));
    console.log(remote && origin ? 'These checks do not validate allocation economics, actual coverage or a real phone installation.' : 'Remote dependencies have not been checked. Run with --remote after configuring the API origin.');
  }
  return passed ? 0 : 1;
}

module.exports = { apiOrigin, publicChecks, statusChecks, probeBackend, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Launch check failed. Check the public configuration and supported flags.'); process.exitCode = 1; });
