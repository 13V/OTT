'use strict';
/**
 * One Lightning payer, chosen by LN_PAYER. "blink" is the default because it is the one that pays
 * real invoices; "mock" pays nothing and remembers what it was asked, for tests and for a deploy
 * that has the wholesale provider wired up but no wallet yet. An unknown name is an error at the
 * first request, like the provider chooser.
 */
const PAYERS = {
  blink: () => require('./blink'),
  mock: () => require('./mock'),
};

function payer() {
  const name = (process.env.LN_PAYER || 'blink').toLowerCase();
  const load = PAYERS[name];
  if (!load) throw new Error('unknown LN_PAYER "' + name + '"');
  return load();
}

module.exports = { payer, names: Object.keys(PAYERS) };
