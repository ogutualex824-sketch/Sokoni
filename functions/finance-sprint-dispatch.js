'use strict';
/**
 * SOKONI Finance OS Sprint 4.3 Dispatcher — 37 onCall CFs → 1 Cloud Run service.
 * Covers: Budgeting, Expense Management, Bank Reconciliation,
 *         Tax Calendar, Financial Statements, Petty Cash, Invoices.
 *
 * Clients call financeSprintDispatch({op: 'functionName', ...data}).
 * Cloud Run reduction: 37 → 1.
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { defineSecret }        = require('firebase-functions/params');

const SENDGRID_KEY = defineSecret('SENDGRID_API_KEY');
const REGION       = 'us-central1';

const finSprint = require('./finance-os-sprint43');

const _OPTS = {
  region:          REGION,
  enforceAppCheck: true,
  secrets:         [SENDGRID_KEY],
  timeoutSeconds:  60,
  memory:          '256MiB',
};

exports.financeSprintDispatch = onCall(_OPTS, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument', '"op" field is required. Valid ops: ' + Object.keys(finSprint._h).sort().join(', '));
  }
  const handler = finSprint._h[op];
  if (!handler) {
    throw new HttpsError('not-found', `Unknown finance-sprint operation: "${op}". Valid ops: ${Object.keys(finSprint._h).sort().join(', ')}`);
  }
  return handler(req);
});
