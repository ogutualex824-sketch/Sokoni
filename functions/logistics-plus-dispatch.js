'use strict';
/**
 * SOKONI Logistics+ Dispatcher — 30 onCall CFs → 1 Cloud Run service.
 * Covers: Fleet Management, Route Planning, Warehouse, Delivery Zones, Cargo & Freight, Reports.
 * Cloud Run reduction: 30 → 1.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION    = 'us-central1';
const logPlus   = require('./logistics-plus');

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  60,
  memory:          '256MiB',
};

exports.logisticsPlusDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(logPlus._h).sort().join(', '));
  }
  const handler = logPlus._h[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown logistics-plus operation: "${op}". Valid ops: ${Object.keys(logPlus._h).sort().join(', ')}`);
  }
  return handler(req);
});
