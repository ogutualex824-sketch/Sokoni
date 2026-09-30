'use strict';
/**
 * SOKONI Legal Dispatcher — legal agreement + digital-acceptance ops → 1 Cloud Run service.
 * Client: firebase.functions().httpsCallable('legalDispatch')({ op, ...data })
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const _OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };

let _mod;
function _h() { return _mod || (_mod = require('./legal-agreements')._h); }

/* The route list is DERIVED from the handler map, never hand-maintained.
 *
 * It used to be a literal array, and it drifted: legal-agreements.js grew to 21 handlers
 * while the array still listed 13. The 8 that were missing — including legalMyCertificates
 * and legalGetCertificate, which legal-centre.html calls on every load — were rejected with
 * "not-found", so the Legal Centre certificate view and three admin panels were dead in
 * production while the code for them existed and was deployed.
 *
 * Deriving the list makes that class of bug impossible: adding a handler routes it.
 * This is only safe because EVERY handler authenticates itself as its first statement —
 * _assertAdmin(req) for the 15 admin ops, _uid(req) for the caller-scoped ones. The
 * dispatcher is a router, not an authorization boundary, and must not be mistaken for one.
 * A handler added without its own guard is exposed to any authenticated caller. */
function _routes() { return Object.keys(_h()); }

exports.legalDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  const valid = _routes().join(', ');
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', `"op" is required. Valid: ${valid}`);
  const handler = _h()[op];
  if (typeof handler !== 'function') throw new HttpsError('not-found', `Unknown op "${op}". Valid: ${valid}`);
  return handler(req);
});
