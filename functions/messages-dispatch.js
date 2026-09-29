'use strict';
/**
 * SOKONI Messages Dispatcher — consolidates 12 onCall CFs into 1 Cloud Run service.
 * Clients call messagesDispatch({op: 'functionName', ...data}) instead of individual CFs.
 *
 * Cloud Run reduction: 12 onCall → 1 dispatcher (2 onSchedule + 3 onDocumentUpdated +
 * 2 onDocumentCreated = 7 event-triggered CFs remain individual).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION = 'us-central1';

// Load module to populate its handler registry
const messages = require('./messages');
/* Product enquiries & public Q&A (product-enquiries.js, 2026-09-29) — served by this same dispatcher: no new Cloud Function. */
const productEnquiries = require('./product-enquiries');
/* buyer price offers (T2b, 2026-09-29) — negotiated in the same product conversation */
const productOffers = require('./product-offers');
const HANDLERS = Object.assign({}, messages._h, productEnquiries._h, productOffers._h);

// Dispatcher options: widest superset (sendMessage uses enforceAppCheck: true)
const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  timeoutSeconds:  60,
};

/**
 * messagesDispatch — single entry-point for all message operations.
 * req.data = { op: 'operationName', ...operationPayload }
 */
exports.messagesDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(HANDLERS).sort().join(', '));
  }
  const handler = HANDLERS[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown messages operation: "${op}". Valid ops: ${Object.keys(HANDLERS).sort().join(', ')}`);
  }
  return handler(req);
});
