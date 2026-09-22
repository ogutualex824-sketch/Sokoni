'use strict';
/**
 * SOKONI Connect Dispatcher — 12 onCall CFs consolidated into 1 Cloud Run service.
 *
 * Same shape as messages-dispatch.js: clients call
 * connectDispatch({ op: 'connectRequestSession', ...payload }).
 *
 * Consolidation is a cost decision (one service, not twelve) and it is also why the handler
 * registry in connect-calls.js exists. `module.exports` must never be REBOUND in that file —
 * a rebind drops `_h` and every op here resolves to "unknown", which presents as a dispatcher
 * that accepts nothing rather than as a load error.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION = 'us-central1';

const connect = require('./connect-calls');

const _OPTS = {
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 60,
};

exports.connectDispatch = onCall(_OPTS, async (req) => {
  const op = req.data && req.data.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument',
      '"op" field is required. Valid ops: ' + Object.keys(connect._h).sort().join(', '));
  }
  const handler = connect._h[op];
  if (!handler) {
    throw new HttpsError('not-found',
      `Unknown connect operation: "${op}". Valid ops: ${Object.keys(connect._h).sort().join(', ')}`);
  }
  return handler(req);
});
