'use strict';
/**
 * One provider, chosen by ESIM_PROVIDER. "mock" is the default on purpose: a fresh deploy with no
 * secrets hands out placeholder profiles rather than failing, and a real provider is opted into
 * by name once its keys are in the environment. An unknown name is an error at the first request,
 * not at load, so a typo in the env produces a 500 with a sentence rather than a function that
 * refuses to boot.
 */
const PROVIDERS = {
  mock: () => require('./mock'),
  esimaccess: () => require('./esimaccess'),
  wholesale: () => require('./wholesale'),
};

function provider() {
  const name = (process.env.ESIM_PROVIDER || 'mock').toLowerCase();
  const load = PROVIDERS[name];
  if (!load) throw new Error('unknown ESIM_PROVIDER "' + name + '"');
  return load();
}

module.exports = { provider, names: Object.keys(PROVIDERS) };
