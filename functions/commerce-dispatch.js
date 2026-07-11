'use strict';
/**
 * SOKONI Commerce Dispatcher — 75 onCall CFs → 1 Cloud Run service.
 *
 * Modules merged:
 *   marketplace-extensions.js — 30 handlers  (auctions, rentals, digital products, Q&A, SEO …)
 *   merchant-success.js       — 17 handlers  (dashboard, AI coach, CRM, financials, campaigns …)
 *   foundation.js             — 17 handlers  (charitable giving, donations, campaigns, admin …)
 *   marketing-engine.js       — 11 handlers  (bundles, flash sales, cross-sell, coupons, A/B …)
 *
 * Cloud Run reduction: 75 → 1.
 *
 * Secrets bundled:
 *   INTASEND_PRIVATE_KEY — foundation.js donation STK push
 *   SENDGRID_API_KEY     — foundation.js email receipts
 *   ANTHROPIC_API_KEY    — merchant-success.js AI coach + marketing-engine.js recommendations
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

const _H = Object.assign(
  {},
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
  return handler(req);
});
