#!/usr/bin/env node
'use strict';

// Real HTTP requests exercise the portable listener and the existing handlers. All provider
// and ledger fetches are intercepted; no test orders an eSIM or reaches a live upstream.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('../scripts/serve-api');
const redeem = require('../site/api/redeem');
const { weekOf, weekEnd } = require('../site/api/_lib/week');

let checks = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log('  ok   ' + name);
}

function request(port, url, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const result = [];
      res.on('data', chunk => result.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(result).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('test request timed out')));
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

async function cli(extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'serve-api.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      HOST: '', PORT: '0', NODE_ENV: 'development', VERCEL_ENV: '',
      ESIM_PROVIDER: 'mock', LN_PAYER: 'mock', STORE: 'memory',
      ESIM_CONFIG_URL: '', ALLOWANCES_URL: '', TREASURY_URL: '',
      VERCEL_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '',
    }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not start')); }, 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on http:\/\/([^:]+):(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve({ host: match[1], port: Number(match[2]) }); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('CLI exited before listening: ' + code)); });
  });
  return { child, ready };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function main() {
  const fixtureEnv = {
    NODE_ENV: 'development', VERCEL_ENV: '', ESIM_PROVIDER: 'mock', LN_PAYER: 'mock', STORE: 'memory',
    ESIM_CONFIG_URL: 'https://ledger.ott.test/config.json', ALLOWANCES_URL: 'https://ledger.ott.test/allowances.json',
    FRONTEND_ORIGINS: 'https://13v.github.io', SIGNIN_HOST: '13v.github.io',
  };
  const previousEnv = Object.fromEntries(Object.keys(fixtureEnv).map(name => [name, process.env[name]]));
  Object.assign(process.env, fixtureEnv);
  const originalFetch = global.fetch;
  const currentWeek = weekOf(Math.floor(Date.now() / 1000));
  const config = { coin: '', curve: '', treasury: '', provider: 'mock', packages: [] };
  const allowances = { week: currentWeek, weekEnd: weekEnd(currentWeek), budgetUsd: 0, holders: 0, wallets: {} };
  let upstreamCalls = 0;
  global.fetch = async url => {
    upstreamCalls++;
    const data = String(url) === fixtureEnv.ESIM_CONFIG_URL ? config : String(url) === fixtureEnv.ALLOWANCES_URL ? allowances : null;
    if (!data) throw new Error('outbound network blocked by the offline test');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  redeem._resetCaches();
  const server = createServer();
  const children = [];
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    console.log('the portable server exposes only the API');
    for (const url of ['/', '/index.html', '/config/esim.json', '/.env', '/site/api/redeem.js', '/health', '/api/redeem/']) {
      const result = await request(port, url);
      check(url + ' does not expose a file or another route', [result.status, result.body.error], [404, 'API route not found']);
    }
    let result = await request(port, '/api/status');
    check('the actual status handler reports the unlaunched programme', [result.status, result.body.ok, result.body.config.launched], [200, true, false]);
    check('API responses are JSON and never cached', [result.headers['content-type'], result.headers['cache-control'], result.headers['x-content-type-options']], ['application/json; charset=utf-8', 'no-store', 'nosniff']);
    result = await request(port, '/api/redeem?address=0x' + 'a'.repeat(40));
    check('an account read cannot invent credit before launch', [result.status, result.body.error], [409, 'coin not launched yet']);
    result = await request(port, '/api/status', { method: 'POST' });
    check('the status handler keeps its GET-only method policy', [result.status, result.headers.allow], [405, 'GET']);

    console.log('\nJSON bodies remain bounded before the handler runs');
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('non-JSON requests are refused', [result.status, result.headers.connection], [415, 'close']);
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://13v.github.io' }, body: '{bad' });
    check('a trusted frontend can read an invalid-body error across origins', [result.status, result.headers['access-control-allow-origin']], [400, 'https://13v.github.io']);
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-16' }, body: '{}' });
    check('a non-UTF-8 JSON encoding is refused', result.status, 415);
    for (const body of ['{bad', 'null', '[]', '42', '']) {
      result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      check('invalid JSON object ' + JSON.stringify(body) + ' is refused safely', [result.status, result.headers.connection], [400, 'close']);
    }
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
    check('valid JSON reaches the real prelaunch handler', [result.status, result.body.error], [409, 'coin not launched yet']);
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 17000 }, body: 'x'.repeat(17000) });
    check('an oversized declared body is refused and its connection closes', [result.status, result.headers.connection], [413, 'close']);
    result = await request(port, '/api/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, chunks: ['x'.repeat(10000), 'x'.repeat(10000)] });
    check('chunked requests cannot bypass the 16 KiB limit', [result.status, result.headers.connection], [413, 'close']);
    result = await request(port, '/api/status');
    check('a rejected body leaves the listener usable for the next request', result.status, 200);
    await new Promise(resolve => {
      const interrupted = http.request({ hostname: '127.0.0.1', port, path: '/api/redeem', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 100 } });
      interrupted.on('error', resolve);
      interrupted.write('{');
      setTimeout(() => interrupted.destroy(new Error('offline test interrupted its own request')), 20);
    });
    result = await request(port, '/api/status');
    check('an interrupted request cannot crash the API process', result.status, 200);

    console.log('\nCORS is applied by the actual API handlers');
    result = await request(port, '/api/redeem', { method: 'OPTIONS', headers: { origin: 'https://13v.github.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    check('a trusted browser can preflight its JSON POST', [result.status, result.body, result.headers['access-control-allow-origin']], [204, null, 'https://13v.github.io']);
    const callsBefore = upstreamCalls;
    result = await request(port, '/api/status?fresh=1', { headers: { origin: 'https://unrelated.example' } });
    check('another browser origin cannot drive an upstream health check', [result.status, upstreamCalls], [403, callsBefore]);
    check('an unrelated origin receives no CORS read permission', result.headers['access-control-allow-origin'], undefined);

    console.log('\nthe CLI chooses safe local and public defaults');
    const local = await cli({}); children.push(local.child);
    const localAddress = await local.ready;
    check('the default CLI host is loopback', localAddress.host, '127.0.0.1');
    result = await request(localAddress.port, '/api/status');
    check('a local development fixture remains possible without a live provider', result.body.ready.provider, true);
    await stop(local.child);
    const publicApi = await cli({ HOST: '0.0.0.0', NODE_ENV: 'development', WHOLESALE_ALLOW_MEMORY_STORE: '1' }); children.push(publicApi.child);
    const publicAddress = await publicApi.ready;
    result = await request(publicAddress.port, '/api/status');
    check('a public listener overrides development mode and rejects the mock provider', [result.body.ready.provider, /real eSIM provider/.test(result.body.checks.provider.detail)], [false, true]);
    check('the same public listener rejects a mock payer', [result.body.ready.payer, /real Lightning payer/.test(result.body.checks.payer.detail)], [false, true]);
    check('no real account is opened by a public prelaunch server', result.body.config.launched, false);
    await stop(publicApi.child);
  } finally {
    for (const child of children) await stop(child);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    global.fetch = originalFetch;
    redeem._resetCaches();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  console.log('\nall ' + checks + ' portable API checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
