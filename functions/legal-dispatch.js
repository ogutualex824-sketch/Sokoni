'use strict';
/**
 * SOKONI Legal Dispatcher — legal agreement + digital-acceptance ops → 1 Cloud Run service.
 * Client: firebase.functions().httpsCallable('legalDispatch')({ op, ...data })
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const _OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };

let _mod;
function _h() { return _mod || (_mod = require('./legal-agreements')._h); }

const ROUTES = [
  'legalGetAgreements', 'legalGetMyAcceptances', 'legalCheckCompliance', 'legalAccept',
  'legalPublishAgreement', 'legalArchiveAgreement', 'legalVersionHistory',
  'legalSearchAcceptances', 'legalGetStats',
  'legalSetEnforcement', 'legalComplianceReport',
];
const VALID = ROUTES.join(', ');

exports.legalDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', `"op" is required. Valid: ${VALID}`);
  if (!ROUTES.includes(op)) throw new HttpsError('not-found', `Unknown op "${op}". Valid: ${VALID}`);
  const handler = _h()[op];
  if (!handler) throw new HttpsError('internal', `Handler "${op}" not found.`);
  return handler(req);
});
