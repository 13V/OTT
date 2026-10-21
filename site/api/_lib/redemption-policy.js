'use strict';

const { isProduction } = require('./request-origin');

// Funding and configuring the API must not start purchases by themselves. Production needs an
// exact, explicit opt-in; development fixtures remain usable when this setting is absent.
//
// On Vercel only the Production deployment may ever place orders. Orders are recorded per
// deployment (STORE_PREFIX), so a preview that could buy from the same Lightning wallet would let
// every member spend the same week's credit, and claim the welcome eSIM, a second time there.
function redemptionsEnabled() {
  // Vercel's own environments: production, preview, development.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === 'preview' || vercelEnv === 'development') return false;
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
