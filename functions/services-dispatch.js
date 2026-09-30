'use strict';
/**
 * SOKONI Services Dispatcher â€” 77 onCall CFs â†’ 1 Cloud Run service.
 *
 * Modules merged:
 *   healthcare-hub.js    â€” 15 handlers  (provider registration, appointments, records, prescriptions â€¦)
 *   security-identity.js â€” 14 handlers  (TOTP MFA, WebAuthn passkeys, device trust registry â€¦)
 *   jobs.js              â€” 12 handlers  (job posts, applications, seeker profiles â€¦)
 *   hr-payroll.js        â€” 12 handlers  (staff, attendance, payroll, leave, training â€¦)
 *   b2b-wholesale.js     â€” 12 handlers  (wholesale accounts, orders, payments, catalog â€¦)
 *   property-hub.js      â€” 12 handlers  (listings, enquiries, viewings, agent management â€¦)
 *
 * Cloud Run reduction: 77 â†’ 1.
 *
 * Secrets bundled:
 *   PAYROLL_ENCRYPTION_KEY â€” hr-payroll.js AES-256-GCM encryption for bank account details
 *
 * Op-name note: the legacy index.js alias "secRegisterDevice" maps to op "registerDevice"
 * in this dispatcher (the _h key is always the original function name).
 *
 * No scheduled/trigger CFs in any of these modules â€” all 77 are dispatchable.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const PAYROLL_ENCRYPTION_KEY = defineSecret('PAYROLL_ENCRYPTION_KEY');

const healthcareHub    = require('./healthcare-hub');
const securityIdentity = require('./security-identity');
const jobs             = require('./jobs');
const hrPayroll        = require('./hr-payroll');
const b2bWholesale     = require('./b2b-wholesale');
const propertyHub      = require('./property-hub');

function _merge() {
  const seen = {}, result = {};
  for (const m of arguments) {
    for (const k of Object.keys(m || {})) {
      if (k in seen) console.error('[dispatch] op collision: "' + k + '" defined in multiple modules — first wins');
      else { result[k] = m[k]; seen[k] = 1; }
    }
  }
  return result;
}
const _H = _merge(
  healthcareHub._h,
  securityIdentity._h,
  jobs._h,
  hrPayroll._h,
  b2bWholesale._h,
  propertyHub._h
);
// Backward-compat: legacy index.js exported registerDevice as secRegisterDevice
if (_H.registerDevice) _H.secRegisterDevice = _H.registerDevice;

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  secrets:         [PAYROLL_ENCRYPTION_KEY],
  timeoutSeconds:  120,
  memory:          '512MiB',
  maxInstances:    20,
};

exports.servicesDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', ')
    );
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError(
      'not-found',
      `Unknown services operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`
    );
  }
  try {
    return await handler(req);
  } catch (err) {
    if (err && err.httpErrorCode) throw err; // re-throw HttpsError
    console.error('[dispatch] op="' + op + '" unhandled error:', err && err.message, err && err.stack);
    throw new HttpsError('internal', 'Operation failed unexpectedly.');
  }
});
