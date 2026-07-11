'use strict';
/**
 * SOKONI Loyalty Dispatcher — consolidates 40 onCall CFs into 1 Cloud Run service.
 * Clients call loyaltyDispatch({op: 'functionName', ...data}) instead of individual CFs.
 *
 * Handler registry is populated at require() time by loyalty.js and loyalty-enterprise.js
 * via the exports._h pattern: each module stores its handler functions in exports._h.
 *
 * Cloud Run reduction: 40 onCall → 1 dispatcher (2 scheduled stay individual).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const LOYALTY_HMAC = defineSecret('LOYALTY_HMAC_SECRET');
const REGION       = 'us-central1';

// Load both modules to populate their handler registries
const loyalty    = require('./loyalty');
const enterprise = require('./loyalty-enterprise');

// Merge all onCall handlers — enterprise handlers override loyalty if names collide (shouldn't happen)
const _H = Object.assign({}, loyalty._h, enterprise._h);

// Dispatcher options: widest superset needed by any loyalty handler
const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  secrets:         [LOYALTY_HMAC],
  timeoutSeconds:  120,
  memory:          '512MiB',
};

/**
 * loyaltyDispatch — single entry-point for all loyalty operations.
 * req.data = { op: 'operationName', ...operationPayload }
 * The 'op' field routes to the registered handler; the rest of req.data is
 * passed through as-is so handlers can destructure their own parameters normally.
 */
exports.loyaltyDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', '));
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown loyalty operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`);
  }
  return handler(req);
});
