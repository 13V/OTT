#!/usr/bin/env node
'use strict';
// Operator-only capability probe: one isolated dummy key, no wallet or purchase API.
const crypto = require('node:crypto');
const { officialConfig } = require('./test-esim');

const PREFIX = 'ott:operator-test:storage-check:';
const FAILURE = 'Storage capability check did not pass. Review the private storage credentials and permissions. An isolated dummy key may remain; no wallet, invoice, order or purchase was used. No sensitive response was printed.';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireResult = condition => { if (!condition) throw new Error(FAILURE); };

function parse(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !['--help', '--local-credentials'].includes(argv[0])) throw new Error(FAILURE);
  return { help: argv[0] === '--help' };
}

async function checkStorage(storage, { randomUUID = crypto.randomUUID, now = Date.now } = {}) {
  try {
    requireResult(storage?.name === 'upstash' && ['get', 'set', 'compareSet', 'compareDel'].every(method => typeof storage[method] === 'function'));
    const id = randomUUID();
    requireResult(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
    const key = 'probe:' + id;
    const value = phase => ({ purpose: 'ott-operator-storage-check', probe: id, phase });
    const claimed = value('claimed'), rejectedNx = value('nx-rejected'), wrong = value('never-written');
    const refusedReplacement = value('refused-replacement'), missingReplacement = value('refused-missing');
    const contenders = [value('replacement-a'), value('replacement-b')], recreated = value('created-if-missing');
    const owned = [];
    let touched = false, passed = false, cleaned = false;
    const attempt = candidate => { touched = true; owned.push(candidate); };
    try {
      requireResult(await storage.get(key) === null);
      attempt(claimed);
      requireResult(await storage.set(key, claimed, { nx: true }) === true);
      requireResult(same(await storage.get(key), claimed));
      attempt(rejectedNx);
      requireResult(await storage.set(key, rejectedNx, { nx: true }) === false);
      requireResult(same(await storage.get(key), claimed));
      attempt(refusedReplacement);
      requireResult(await storage.compareSet(key, wrong, refusedReplacement) === false);
      requireResult(same(await storage.get(key), claimed));
      attempt(missingReplacement);
      requireResult(await storage.compareSet(key, null, missingReplacement) === false);
      requireResult(same(await storage.get(key), claimed));
      contenders.forEach(attempt);
      const replacementOutcomes = await Promise.allSettled(contenders.map(candidate => storage.compareSet(key, claimed, candidate)));
      requireResult(replacementOutcomes.every(result => result.status === 'fulfilled'));
      const replaced = replacementOutcomes.map(result => result.value);
      requireResult(replaced.every(result => typeof result === 'boolean') && replaced.filter(Boolean).length === 1);
      const winner = contenders[replaced.indexOf(true)];
      requireResult(same(await storage.get(key), winner));
      requireResult(await storage.compareDel(key, claimed) === false);
      requireResult(same(await storage.get(key), winner));
      const deletionOutcomes = await Promise.allSettled([storage.compareDel(key, winner), storage.compareDel(key, winner)]);
      requireResult(deletionOutcomes.every(result => result.status === 'fulfilled'));
      const deleted = deletionOutcomes.map(result => result.value);
      requireResult(deleted.every(result => typeof result === 'boolean') && deleted.filter(Boolean).length === 1);
      requireResult(await storage.get(key) === null);
      attempt(recreated);
      requireResult(await storage.compareSet(key, null, recreated) === true);
      requireResult(same(await storage.get(key), recreated));
      requireResult(await storage.compareDel(key, recreated) === true);
      requireResult(await storage.get(key) === null);
      passed = true;
    } catch {
      // Even a thrown response can follow a completed write. Cleanup is conditional
      // on our exact unique dummy values, never an unconditional delete or DB scan.
    } finally {
      if (touched) {
        let cleanupCallsValid = true;
        for (const candidate of [...owned].reverse()) {
          try {
            if (typeof await storage.compareDel(key, candidate) !== 'boolean') cleanupCallsValid = false;
          } catch { cleanupCallsValid = false; }
        }
        try { cleaned = cleanupCallsValid && await storage.get(key) === null; } catch { cleaned = false; }
      }
    }
    requireResult(passed && cleaned);
    const checkedAt = typeof now === 'function' ? now() : now;
    requireResult(Number.isSafeInteger(checkedAt) && checkedAt >= 0);
    return { schema: 1, mode: 'operator-storage-capability-check', prefix: PREFIX, passed: true,
      capabilities: ['get', 'set-nx', 'compare-set', 'compare-delete'], cleanup: 'verified',
      checkedAt: new Date(checkedAt).toISOString(), paymentReady: false,
      limitations: ['This isolated probe checks command behavior and permission; it does not establish payment readiness or crash durability.',
        'A process crash or unavailable storage can leave its isolated dummy key. No wallet, invoice, order or public redemption record is used.'] };
  } catch { throw new Error(FAILURE); }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env || process.env;
  const names = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'STORE_PREFIX', 'REDEMPTIONS_ENABLED'];
  const previous = names.map(name => [name, Object.hasOwn(env, name), env[name]]);
  try {
    const options = parse(argv);
    if (options.help) return 'Storage permission probe: node scripts/phone-test-storage-check.js --local-credentials\nUses encrypted local credentials and one temporary isolated dummy key. Checks GET, SET NX and atomic compare operations, then removes only matching owned values. No wallet, invoice, order or purchase is used. A crash may leave a dummy key; success does not establish payment readiness.';
    const credentials = await (deps.loadCredentials || (() => require('./operator-test-credentials').loadLocalCredentials()))();
    requireResult(credentials && ['KV_REST_API_URL', 'KV_REST_API_TOKEN'].every(name => typeof credentials[name] === 'string' && credentials[name].trim()));
    env.KV_REST_API_URL = credentials.KV_REST_API_URL;
    env.KV_REST_API_TOKEN = credentials.KV_REST_API_TOKEN;
    officialConfig(env, false, true);
    env.NODE_ENV = 'production';
    env.STORE_PREFIX = PREFIX;
    env.REDEMPTIONS_ENABLED = '0';
    const storage = (deps.makeStore || (() => require('../site/api/_lib/store').store()))();
    return await checkStorage(storage, deps.probeOptions);
  } catch { throw new Error(FAILURE); }
  finally {
    for (const [name, existed, value] of previous) { if (existed) env[name] = value; else delete env[name]; }
  }
}

if (require.main === module) main().then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))).catch(() => {
  console.error(FAILURE);
  process.exitCode = 1;
});
module.exports = { PREFIX, FAILURE, parse, checkStorage, main };
