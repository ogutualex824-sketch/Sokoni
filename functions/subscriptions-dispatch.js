'use strict';
/**
 * SOKONI Subscriptions Dispatcher — canonical read-only subscription ops.
 *
 * One Cloud Run service exposing the subscription-core resolver to clients so a
 * user gets ONE authoritative view across all five subscription stores.
 * Enforcement itself is a backend library (subscription-core) that other modules
 * import directly; this dispatcher only surfaces read/checks to the UI.
 *
 * Client: firebase.functions().httpsCallable('subscriptionsDispatch')({ op, ...data })
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const _OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };

let _mod;
function _h() { return _mod || (_mod = require('./subscription-core')._h); }

const ROUTES = ['getUnifiedSubscription', 'listMySubscriptions', 'checkFeature', 'checkLimit'];
const VALID = ROUTES.join(', ');

exports.subscriptionsDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', `"op" is required. Valid: ${VALID}`);
  if (!ROUTES.includes(op)) throw new HttpsError('not-found', `Unknown op "${op}". Valid: ${VALID}`);
  const handler = _h()[op];
  if (!handler) throw new HttpsError('internal', `Handler "${op}" not found.`);
  return handler(req);
});
