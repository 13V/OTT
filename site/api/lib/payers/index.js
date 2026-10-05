'use strict';
/**
 * One Lightning payer, chosen by LN_PAYER. "blink" is the default because it is the one that pays
 * real invoices; "mock" pays nothing and remembers what it was asked, for development tests.
 * Production refuses it. An unknown name is an error at the
 * first request, like the provider chooser.
 */
const PAYERS = {
  blink: () => require('./blink'),
  mock: () => require('./mock'),
};
const { isProduction } = require('../request-origin');

function payer() {
  const name = (process.env.LN_PAYER || 'blink').toLowerCase();
  if (isProduction() && name === 'mock') {
    const error = new Error('production requires a real Lightning payer');
    error.status = 503;
    throw error;
  }
  const load = PAYERS[name];
  if (!load) throw new Error('unknown LN_PAYER "' + name + '"');
  return load();
}

module.exports = { payer, names: Object.keys(PAYERS) };
