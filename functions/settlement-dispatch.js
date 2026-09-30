'use strict';
/**
 * SOKONI Settlement Dispatcher — consolidates the settlement onCall CFs into a
 * SINGLE Cloud Run service (quota-optimized, mirrors loyaltyDispatch).
 *
 * Clients call settlementDispatch({ op: 'operationName', ...data }) instead of
 * individual CFs. Handler registry is populated at require() time by each
 * settlement module via the exports._h pattern; auth (admin / App Check) is
 * enforced INSIDE each handler exactly as before — no security is relaxed.
 *
 * Consolidates 12 handlers → 1 dispatcher:
 *   settlement-engine     : settlementGetContext, settlementPreview, settlementGetDashboard
 *   settlement-routing    : settlementGetRoutingConfig, settlementSetRoutingConfig
 *   payment-config        : getCheckoutPaymentConfig, adminGetPaymentConfig, adminSetPaymentConfig
 *   settlement-validation : settlementValidatePath
 *   settlement-providers  : settlementGetProviders, settlementSetProvider
 *   settlement-executor   : settlementPreviewMethod
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const SA = require('./settlement-account');

const REGION = 'us-central1';

/* Load every settlement module so each populates its exports._h registry. */
const _modules = [
  require('./settlement-engine'),
  require('./settlement-routing'),
  require('./payment-config'),
  require('./settlement-validation'),
  require('./settlement-providers'),
  require('./settlement-executor'),
];

/* Merge all handler registries. Op names are globally unique across modules
   (asserted below), so no collisions. */
const _H = {};
for (const m of _modules) {
  if (!m || !m._h) continue;
  for (const [op, fn] of Object.entries(m._h)) {
    if (_H[op]) throw new Error(`settlementDispatch: duplicate op "${op}" — op names must be unique`);
    _H[op] = fn;
  }
}

/* Dispatcher options: widest superset any settlement handler needs.
   SETTLEMENT_ACCOUNT_NUMBER is bound because settlementGetContext /
   settlementPreview / settlementGetDashboard / settlementPreviewMethod read the
   masked collection account. App Check enforced for every op. */
const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  secrets:         [SA.SETTLEMENT_ACCOUNT_NUMBER],
  timeoutSeconds:  120,
  memory:          '512MiB',
};

/**
 * settlementDispatch — single entry-point for all settlement operations.
 * req.data = { op: 'operationName', ...operationPayload }
 * Routes on `op`; the rest of req.data passes through unchanged so handlers
 * destructure their own params exactly as they did as standalone CFs.
 */
exports.settlementDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', '));
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown settlement operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`);
  }
  return handler(req);   // handler enforces its own admin/auth checks
});

/* Merged settlement handler registry — exported so it can be hosted inside an
   existing deployed dispatcher (financeSprintDispatch) when a dedicated
   settlementDispatch service can't be created under Cloud Run quota. */
module.exports.handlers = _H;
module.exports.SETTLEMENT_ACCOUNT_NUMBER = SA.SETTLEMENT_ACCOUNT_NUMBER;

/* Exposed for validation tooling. */
module.exports._ops = () => Object.keys(_H).sort();
