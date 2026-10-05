'use strict';

const { isProduction } = require('./request-origin');

// Funding and configuring the API must not start purchases by themselves. Production needs an
// exact, explicit opt-in; development fixtures remain usable when this setting is absent.
function redemptionsEnabled() {
  const setting = process.env.REDEMPTIONS_ENABLED;
  return setting === undefined ? !isProduction() : setting === '1';
}

function requireRedemptionsEnabled() {
  if (redemptionsEnabled()) return;
  const error = new Error('data redemption is not enabled yet');
  error.status = 503;
  throw error;
}

module.exports = { redemptionsEnabled, requireRedemptionsEnabled };
