'use strict';
/**
 * SOKONI SmartPOS Dispatcher — 154 onCall CFs → 1 Cloud Run service.
 *
 * Modules merged:
 *   pos-crm-pro.js       — 25 handlers  (wallet, CRM, customer history …)
 *   pos-completeness.js  — 25 handlers  (gift cards, layaway, KDS, cycle count …)
 *   pos-staff-ops.js     — 21 handlers  (shifts, payroll, permissions …)
 *   pos-inventory-pro.js — 21 handlers  (batches, FEFO, expiry, transfers …)
 *   pos-accounting.js    — 18 handlers  (chart of accounts, journal, P&L …)
 *   pos-retail-engine.js — 18 handlers  (customer engine, sale recording, analytics …)
 *   pos-integrations.js  — 15 handlers  (webhooks, API keys, bank reconciliation …)
 *   pos-hq.js            — 13 handlers  (central pricing, HQ dashboard, broadcasts …)
 *
 * Cloud Run reduction: 154 → 1.
 * Secret: SENDGRID_API_KEY required by pos-retail-engine emailReceipt.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');

const SENDGRID_KEY = defineSecret('SENDGRID_API_KEY');

const posCrmPro      = require('./pos-crm-pro');
const posCompleteness= require('./pos-completeness');
const posStaffOps    = require('./pos-staff-ops');
const posInventoryPro= require('./pos-inventory-pro');
const posAccounting  = require('./pos-accounting');
const posRetailEngine= require('./pos-retail-engine');
const posIntegrations= require('./pos-integrations');
const posHq          = require('./pos-hq');

const _H = Object.assign(
  {},
  posCrmPro._h,
  posCompleteness._h,
  posStaffOps._h,
  posInventoryPro._h,
  posAccounting._h,
  posRetailEngine._h,
  posIntegrations._h,
  posHq._h
);

const _OPTS = {
  region:          'us-central1',
  enforceAppCheck: true,
  secrets:         [SENDGRID_KEY],
  timeoutSeconds:  120,
  memory:          '512MiB',
  maxInstances:    20,
};

exports.smartPosDispatch = onCall(_OPTS, async (req) => {
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
      `Unknown SmartPOS operation: "${op}". Valid ops: ${Object.keys(_H).sort().join(', ')}`
    );
  }
  return handler(req);
});
