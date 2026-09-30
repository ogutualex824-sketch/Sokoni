/**
 * SOKONI — canonical audit schema (v1).
 * ONE shape for every business-critical action so reports and investigations are uniform.
 * Fire-and-forget: an audit write must never block or fail the operation it records.
 *
 * Fields:
 *   schema     'v1'
 *   action     dotted verb — 'pos.refund' | 'inventory.stock_adjust' | 'product.price_change' |
 *              'pos.receipt_reprint' | 'pos.dispatch.status' | …
 *   actorUid   who did it (auth.uid)
 *   actorRole  their role claim at the time
 *   branchId   branch/terminal scope, when known
 *   objectType 'order' | 'product' | 'receipt' | …
 *   objectId   the affected doc id
 *   before/after  prior + new value of the changed field(s)
 *   delta      numeric change where meaningful (e.g. stock ±)
 *   reason     free-text justification when the caller supplies one
 *   outcome    'success' | 'failure'
 *   metadata   action-specific extras (amount, printer, receiptType, count…)
 *   ts         server timestamp (authoritative)
 */
const admin = require('firebase-admin');

function writeAudit(db, e) {
  e = e || {};
  return db.collection('auditLogs').add({
    schema:     'v1',
    action:     e.action || 'unknown',
    actorUid:   e.actorUid || null,
    actorRole:  e.actorRole || null,
    branchId:   e.branchId || null,
    objectType: e.objectType || null,
    objectId:   e.objectId || null,
    before:     e.before === undefined ? null : e.before,
    after:      e.after === undefined ? null : e.after,
    delta:      e.delta === undefined ? null : e.delta,
    reason:     e.reason || null,
    outcome:    e.outcome || 'success',
    metadata:   e.metadata || {},
    ts:         admin.firestore.FieldValue.serverTimestamp(),
  }).catch((err) => console.error('[audit] ' + (e.action || '?') + ' failed (non-blocking):', err.message));
}

module.exports = { writeAudit };
