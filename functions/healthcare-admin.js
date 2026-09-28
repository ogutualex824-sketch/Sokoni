'use strict';
/**
 * SOKONI — AdminOS › Healthcare operations  (CHANGELOG 227)
 * ============================================================================================
 * Merged into the ONE admin dispatcher (admin-os-dispatch.js, like legal-verification._adminH);
 * AdminOS is the only administrative workspace. Every op re-checks the canonical admin claim
 * (admin-claim.js) — never a numeric role — and every change writes the existing immutable
 * `adminAudit` trail (the one applicationDecide writes).
 *
 * Operational administration only. These ops read the provider IDENTITY and its category — never
 * a patient's clinical record (healthRecords / healthPrescriptions stay patient-only; an audited,
 * purpose-bound administrative clinical read is an open policy decision, CHANGELOG 223).
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const ADMIN = require('./admin-claim');
const HCAT = require('./healthcare-category');

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);

function _requireAdmin(req) {
  if (!req || !req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');
  return req.auth.uid;
}

const _adminH = {};

/** Healthcare providers (those the server classified, plus health providers still unclassified). */
_adminH.healthAdminProviders = async (req) => {
  _requireAdmin(req);
  const db = _db();
  const view = _san(req.data && req.data.view, 20) || 'all';
  /* Every provider the server ever stamped with a healthcare record (category may be null =
     UNCLASSIFIED). A provider approved before CHANGELOG 227 has no stamp until re-approved or
     classified here — they are found through the application queue (Applications › Health). */
  const snap = await db.collection('providers').where('healthcare.source', 'in', ['application', 'admin']).limit(500).get();
  let rows = snap.docs.map((d) => {
    const p = d.data() || {};
    const h = p.healthcare || {};
    return { uid: d.id, name: p.name || '', status: p.status || null, acceptsBookings: p.acceptsBookings !== false,
      category: HCAT.isCategory(h.category) ? h.category : null, categoryLabel: HCAT.LABELS[h.category] || 'Unclassified',
      source: h.source || null, city: p.city || null };
  });
  if (view === 'unclassified') rows = rows.filter((r) => !r.category);
  else if (HCAT.isCategory(view)) rows = rows.filter((r) => r.category === view);
  return { view, providers: rows, categories: HCAT.CATEGORIES.map((c) => ({ id: c, label: HCAT.LABELS[c] })) };
};

/** Classify (or re-classify) a healthcare provider. Audited; the provider can never do this. */
_adminH.healthAdminClassify = async (req) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const uid = _san(d.uid, 128);
  if (!uid || /[/]/.test(uid)) throw new HttpsError('invalid-argument', 'uid is required.');
  const category = String(d.category || '');
  if (!HCAT.isCategory(category)) throw new HttpsError('invalid-argument', 'category must be one of: ' + HCAT.CATEGORIES.join(', ') + '.');
  const reason = _san(d.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required (kept in the audit log).');
  const db = _db();
  const ref = db.collection('providers').doc(uid);
  let previous = null;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'No provider record for this account.');
    const p = s.data() || {};
    /* only an account the server already knows as a healthcare provider — this op never turns a
       plumber into a clinic */
    if (!p.healthcare) throw new HttpsError('failed-precondition', 'This provider was not approved as a healthcare provider.');
    previous = HCAT.isCategory(p.healthcare.category) ? p.healthcare.category : null;
    /* one decision, two fields (CHANGELOG 236): the canonical business category moves with the healthcare one */
    t.set(ref, { healthcare: Object.assign({}, p.healthcare, { category, source: 'admin', classifiedBy: actor, setAt: _ts() }),
      business: Object.assign({}, p.business || {}, { category, source: 'admin', classifiedBy: actor, setAt: _ts() }), updatedAt: _ts() }, { merge: true });
    t.set(db.collection('adminAudit').doc(), {
      action: 'healthcare_classify', targetUid: uid, performedBy: actor,
      previous, next: category, reason, createdAt: _ts(),
    });
  });
  return { uid, previous, category, label: HCAT.LABELS[category] };
};

module.exports = { _adminH };
