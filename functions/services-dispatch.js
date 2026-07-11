'use strict';
/**
 * SOKONI Services Dispatcher — 77 onCall CFs → 1 Cloud Run service.
 *
 * Modules merged:
 *   healthcare-hub.js    — 15 handlers  (provider registration, appointments, records, prescriptions …)
 *   security-identity.js — 14 handlers  (TOTP MFA, WebAuthn passkeys, device trust registry …)
 *   jobs.js              — 12 handlers  (job posts, applications, seeker profiles …)
 *   hr-payroll.js        — 12 handlers  (staff, attendance, payroll, leave, training …)
 *   b2b-wholesale.js     — 12 handlers  (wholesale accounts, orders, payments, catalog …)
 *   property-hub.js      — 12 handlers  (listings, enquiries, viewings, agent management …)
 *
 * Cloud Run reduction: 77 → 1.
 *
 * Secrets bundled:
 *   PAYROLL_ENCRYPTION_KEY — hr-payroll.js AES-256-GCM encryption for bank account details
 *
 * Op-name note: the legacy index.js alias "secRegisterDevice" maps to op "registerDevice"
 * in this dispatcher (the _h key is always the original function name).
 *
 * No scheduled/trigger CFs in any of these modules — all 77 are dispatchable.
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

const _H = Object.assign(
  {},
  healthcareHub._h,
  securityIdentity._h,
  jobs._h,
  hrPayroll._h,
  b2bWholesale._h,
  propertyHub._h
);

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
  return handler(req);
});
