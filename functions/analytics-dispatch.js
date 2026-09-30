'use strict';
/**
 * SOKONI Analytics Dispatcher — 33 onCall CFs → 1 Cloud Run service.
 * Covers: Sales, Cohort, Product, Realtime, Platform, Report, Export analytics.
 * Cloud Run reduction: 33 → 1 (analyticsSnapshotDaily scheduled remains individual).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION    = 'us-central1';
const analytics = require('./analytics-engine');

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  60,
  memory:          '256MiB',
};

exports.analyticsDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(analytics._h).sort().join(', '));
  }
  const handler = analytics._h[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown analytics operation: "${op}". Valid ops: ${Object.keys(analytics._h).sort().join(', ')}`);
  }
  return handler(req);
});
