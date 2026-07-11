'use strict';
/**
 * SOKONI Admin OS Dispatcher — consolidates 41 onCall CFs into 1 Cloud Run service.
 * Clients call adminOsDispatch({op: 'functionName', ...data}).
 *
 * Cloud Run reduction: 41 onCall → 1 dispatcher.
 * sokoni-aos.js routes admin-os ops through this dispatcher automatically
 * via its ADMIN_OS_OPS whitelist in the _call() helper.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION = 'us-central1';
const adminOs = require('./admin-os');

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  maxInstances:    10,
  timeoutSeconds:  60,
  memory:          '256MiB',
};

exports.adminOsDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(adminOs._h).sort().join(', '));
  }
  const handler = adminOs._h[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown admin-os operation: "${op}". Valid ops: ${Object.keys(adminOs._h).sort().join(', ')}`);
  }
  return handler(req);
});
