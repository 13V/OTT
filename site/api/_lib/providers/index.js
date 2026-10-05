'use strict';
/**
 * One provider, chosen by ESIM_PROVIDER. Development defaults to mock for offline fixtures;
 * production requires an explicitly configured real provider and fails closed otherwise.
 * An unknown name is an error at the first request,
 * not at load, so a typo in the env produces a 500 with a sentence rather than a function that
 * refuses to boot.
 */
const PROVIDERS = {
  mock: () => require('./mock'),
  esimaccess: () => require('./esimaccess'),
  wholesale: () => require('./wholesale'),
};
const { isProduction } = require('../request-origin');

function provider() {
  const name = (process.env.ESIM_PROVIDER || 'mock').toLowerCase();
  if (isProduction() && name === 'mock') {
    const error = new Error('production requires an explicitly configured real eSIM provider');
    error.status = 503;
    throw error;
  }
  const load = PROVIDERS[name];
  if (!load) throw new Error('unknown ESIM_PROVIDER "' + name + '"');
  return load();
}

module.exports = { provider, names: Object.keys(PROVIDERS) };
