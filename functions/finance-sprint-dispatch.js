'use strict';
/**
 * SOKONI Finance OS Sprint 4.3 Dispatcher — finance CFs → 1 Cloud Run service.
 * Covers: Budgeting, Expense Management, Bank Reconciliation,
 *         Tax Calendar, Financial Statements, Petty Cash, Invoices.
 *
 * ALSO HOSTS the 12 Enterprise Settlement operations (Phase 1 engine + Phase 2
 * flags/config/validation + Phase 3 split/providers). A dedicated
 * settlementDispatch service could not be created under Cloud Run quota, so —
 * per the "reuse existing infrastructure / integrate into an existing
 * dispatcher" directive — the settlement handler registry is merged in here.
 * This is a pure UPDATE to an already-deployed service: zero new Cloud Run
 * services. Settlement handlers enforce their own admin/App Check checks
 * unchanged; the client wrapper (sokoni-settlement.js) targets this CF.
 *
 * Clients call financeSprintDispatch({op: 'functionName', ...data}).
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { defineSecret }        = require('firebase-functions/params');

const SENDGRID_KEY = defineSecret('SENDGRID_API_KEY');
const REGION       = 'us-central1';

const finSprint  = require('./finance-os-sprint43');
const settlement = require('./settlement-dispatch');   // merged settlement handlers + secret

/* Merge finance-sprint + settlement handler registries. Op namespaces are
   disjoint; guard against any accidental collision. */
const _H = Object.assign({}, finSprint._h);
for (const [op, fn] of Object.entries(settlement.handlers)) {
  if (_H[op]) throw new Error(`financeSprintDispatch: op collision "${op}" between finance-sprint and settlement`);
  _H[op] = fn;
}

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  secrets:         [SENDGRID_KEY, settlement.SETTLEMENT_ACCOUNT_NUMBER],
  timeoutSeconds:  120,
  memory:          '512MiB',
};

exports.financeSprintDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(_H).sort().join(', '));
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`);
  }
  return handler(req);   // handler enforces its own admin/auth checks
});
