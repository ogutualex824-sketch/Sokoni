'use strict';
/**
 * SOKONI Commerce Dispatcher â€” 75 onCall CFs â†’ 1 Cloud Run service.
 *
 * Modules merged:
 *   marketplace-extensions.js â€” 30 handlers  (auctions, rentals, digital products, Q&A, SEO â€¦)
 *   merchant-success.js       â€” 17 handlers  (dashboard, AI coach, CRM, financials, campaigns â€¦)
 *   marketing-engine.js       â€” 11 handlers  (bundles, flash sales, cross-sell, coupons, A/B â€¦)
 *
 * Cloud Run reduction: 75 â†’ 1.
 *
 * Secrets bundled:
 *   ANTHROPIC_API_KEY    â€” merchant-success.js AI coach + marketing-engine.js recommendations
 *
 * Scheduled CFs remain individual in index.js:
 *   auctionCloseSweep, seoGetSitemap (onRequest)
 *   concludeExpiredFlashSales
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const SENDGRID_API_KEY     = defineSecret('SENDGRID_API_KEY');
const ANTHROPIC_API_KEY    = defineSecret('ANTHROPIC_API_KEY');

const mktExt        = require('./marketplace-extensions');
const merchantSuccess = require('./merchant-success');
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
  marketingEng._h
);

// SECURITY HOTFIX DE-2 (2026-10-03). OWNER DECISION 2026-10-03: the digital-downloads store is
// RETIRED (pages paused, data kept, server code dormant). DE-0 proved these two ops are live
// through this dispatcher and grant a paid good with NO payment: digitalProductPurchase mints a
// purchase + licence for any signed-in caller; digitalProductDownload signs a Storage URL for it.
// They are removed from the served map so they fall through to the normal "not-found"
// unknown-op error below. The handlers stay defined (dormant) in marketplace-extensions.js.
// Do NOT re-add them without a payment-backed purchase (pending_payment + verified IntaSend webhook).
const _RETIRED_OPS = ['digitalProductPurchase', 'digitalProductDownload'];
for (const op of _RETIRED_OPS) delete _H[op];

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
