'use strict';
/**
 * SOKONI — AdminOS › Business approval decision  (capability convergence, the missing authority)
 * ============================================================================================
 * ONE place an administrator records a DECISION, today, about whether an existing business registry record
 * (providers/{uid}) is approved to operate — for the case the application lifecycle cannot cover: a record that is
 * live by a client-writable status alone, with no approved application and therefore no approval evidence
 * (the six-identity census: DJ Bvmbxno, King Bruce), or one whose historical "approval" was written by an
 * automation and not a person (Kasindi's `decidedBy: "reindex"`).
 *
 *   bizAdminApprovalDecide   { uid, decision: 'approve' | 'refuse', reason }
 *
 * WHAT IT IS NOT
 *   · It is NOT a classification. The category is decided separately by bizAdminClassify. An approved record with
 *     no category stays PENDING_CLASSIFICATION (no route) until an admin classifies it.
 *   · It does NOT create an application, and it never edits one. The approval model is satisfied by a REAL decision
 *     record on the registry document, not by a manufactured application.
 *   · It does NOT reinterpret history. The historical status / approvedAt / decider are copied into `prior` on the
 *     decision and into the audit as `previous`; they are never rewritten to look like an admin decision.
 *   · It touches NO financial or activity record: bookings, wallet, products, services, orders stay as they are —
 *     they are historical evidence of trading, not inputs to or outputs of the decision.
 *
 * WHAT IT WRITES (one transaction)
 *   providers/{uid}.approvalDecision = { decision, decidedBy: <admin uid>, decidedAt: <server ts>, reason,
 *                                        prior: { status, approvedAt, approvedBy, decidedBy }, source: 'admin_decision' }
 *   approve → status 'active', approvedAt <server ts>, approvedBy <admin uid>, suspended false
 *   refuse  → status 'suspended', suspended true, searchable false, isPublic false   (fail closed: an unapproved record
 *             that was live by status alone stops being public)
 *   adminAudit/{auto} = { action: 'business_approval_decision', targetUid, performedBy, decision,
 *                         previous: { status, approvedAt }, next: { status, approvedAt }, reason, createdAt }
 *   approve additionally grants the `provider` role through the canonical role authority (grantAccountRole) — an
 *   approval whose account cannot act as a provider is not an approval. Never a bespoke claim write.
 *
 * IDEMPOTENT / IMMUTABLE
 *   The same decision repeated returns the existing decision and writes nothing (no duplicate audit). A DIFFERENT
 *   decision on a record that already carries one is REFUSED (DECISION_EXISTS) — history is not overwritten; a
 *   reversal is a new authority with its own audit, not this one.
 *
 * REFUSALS
 *   unauthenticated · no admin claim · uid missing · decision not approve|refuse · reason < 3 chars · no provider
 *   record · a healthcare provider (its own approval authority) · a conflicting prior decision.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const ADMIN = require('./admin-claim');

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const DECISIONS = Object.freeze(['approve', 'refuse']);

function _requireAdmin(req) {
  if (!req || !req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');
  return req.auth.uid;
}

const _adminH = {};

/**
 * Decide, today, whether this business is approved to operate. Audited; the business can never invoke it.
 * `deps.grantRole` is the canonical role grant (injected so the suite can observe it); default = role-authority.
 */
_adminH.bizAdminApprovalDecide = async (req, deps) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const uid = _san(d.uid, 128);
  if (!uid || /[/]/.test(uid)) throw new HttpsError('invalid-argument', 'uid is required.');
  /* SELF-APPROVAL IS NEVER APPROVAL (remediation rule 2): refused BEFORE the target is read. An administrator
     deciding their own business record would be `decidedBy === applicant`, which the validity test rejects anyway;
     refusing here keeps such a record from ever being written. */
  if (uid === actor) throw new HttpsError('permission-denied', 'An administrator cannot decide their own business record.', { code: 'SELF_DECISION' });
  const decision = String(d.decision || '');
  if (!DECISIONS.includes(decision)) throw new HttpsError('invalid-argument', 'decision must be approve or refuse.');
  const reason = _san(d.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required (kept in the audit log).');

  const db = _db();
  const ref = db.collection('providers').doc(uid);
  let outcome = null;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'No provider record for this account. An approval decision needs an existing registry record; it never creates one.', { code: 'NO_PROVIDER' });
    const p = s.data() || {};
    if (p.healthcare) throw new HttpsError('failed-precondition', 'A health provider is approved by the healthcare authority, not here.', { code: 'HEALTHCARE_BOUNDARY' });
    const existing = p.approvalDecision || null;
    if (existing && existing.source === 'admin_decision') {
      if (existing.decision === decision) { outcome = { uid, decision, repeated: true, decidedBy: existing.decidedBy, decidedAt: existing.decidedAt || null }; return; }
      throw new HttpsError('failed-precondition', `This business already carries an admin decision (${existing.decision}); history is not overwritten here.`, { code: 'DECISION_EXISTS', existing: existing.decision, decidedBy: existing.decidedBy });
    }
    const prior = { status: p.status || null, approvedAt: p.approvedAt || null, approvedBy: p.approvedBy || null, decidedBy: p.decidedBy || null };
    const approvalDecision = { decision, decidedBy: actor, decidedAt: _ts(), reason, prior, source: 'admin_decision' };
    const patch = { approvalDecision, updatedAt: _ts() };
    if (decision === 'approve') Object.assign(patch, { status: 'active', approvedAt: _ts(), approvedBy: actor, suspended: false });
    else Object.assign(patch, { status: 'suspended', suspended: true, searchable: false, isPublic: false });
    t.set(ref, patch, { merge: true });
    t.set(db.collection('adminAudit').doc(), {
      action: 'business_approval_decision', targetUid: uid, performedBy: actor, decision,
      previous: { status: prior.status, approvedAt: prior.approvedAt }, next: { status: patch.status, approvedAt: decision === 'approve' ? _ts() : prior.approvedAt },
      reason, createdAt: _ts(),
    });
    outcome = { uid, decision, repeated: false, decidedBy: actor, previous: { status: prior.status, approvedAt: prior.approvedAt }, next: { status: patch.status } };
  });
  /* the role, through the ONE role authority — only on a fresh approval */
  if (outcome && !outcome.repeated && decision === 'approve') {
    const grant = (deps && deps.grantRole) || ((db, uid, role, on, meta) => require('./role-authority').grantAccountRole(db, uid, role, on, meta));
    try { outcome.role = await grant(db, uid, 'provider', true, { source: 'bizAdminApprovalDecide', entityId: uid }); }
    catch (e) { outcome.role = { error: String(e && e.message || e) }; }
  }
  return outcome;
};

module.exports = { _adminH, DECISIONS };
