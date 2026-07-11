'use strict';
/**
 * SOKONI Commerce Dispatcher â€” 75 onCall CFs â†’ 1 Cloud Run service.
 *
 * Modules merged:
 *   marketplace-extensions.js â€” 30 handlers  (auctions, rentals, digital products, Q&A, SEO â€¦)
 *   merchant-success.js       â€” 17 handlers  (dashboard, AI coach, CRM, financials, campaigns â€¦)
 *   foundation.js             â€” 17 handlers  (charitable giving, donations, campaigns, admin â€¦)
 *   marketing-engine.js       â€” 11 handlers  (bundles, flash sales, cross-sell, coupons, A/B â€¦)
 *
 * Cloud Run reduction: 75 â†’ 1.
 *
 * Secrets bundled:
 *   INTASEND_PRIVATE_KEY â€” foundation.js donation STK push
 *   SENDGRID_API_KEY     â€” foundation.js email receipts
 *   ANTHROPIC_API_KEY    â€” merchant-success.js AI coach + marketing-engine.js recommendations
 *
 * Scheduled CFs remain individual in index.js:
 *   auctionCloseSweep, seoGetSitemap (onRequest), foundationScheduledRecurring,
 *   concludeExpiredFlashSales
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const SENDGRID_API_KEY     = defineSecret('SENDGRID_API_KEY');
const ANTHROPIC_API_KEY    = defineSecret('ANTHROPIC_API_KEY');

const mktExt        = require('./marketplace-extensions');
const merchantSuccess = require('./merchant-success');
const foundation    = require('./foundation');
const marketingEng  = require('./marketing-engine');

function _merge() {
  const seen = {}, result = {};
  for (const m of arguments) {
    for (const k of Object.keys(m || {})) {
      if (k in seen) console.error('[dispatch] op collision: "' + k + '" defined in multiple modules — first wins');
      else { result[k] = m[k]; seen[k] = 1; }
    }
  }
  return result;
}
const _H = _merge(
  mktExt._h,
  merchantSuccess._h,
  foundation._h,
  marketingEng._h
);

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  secrets:         [INTASEND_PRIVATE_KEY, SENDGRID_API_KEY, ANTHROPIC_API_KEY],
  timeoutSeconds:  120,
  memory:          '512MiB',
  maxInstances:    20,
};

exports.commerceDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', ')
    );
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError(
      'not-found',
      `Unknown commerce operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`
    );
  }
  try {
    return await handler(req);
  } catch (err) {
    if (err && err.httpErrorCode) throw err; // re-throw HttpsError
    console.error('[dispatch] op="' + op + '" unhandled error:', err && err.message, err && err.stack);
    throw new HttpsError('internal', 'Operation failed unexpectedly.');
  }
});
