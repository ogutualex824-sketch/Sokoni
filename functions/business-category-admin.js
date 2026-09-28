'use strict';
/**
 * SOKONI — AdminOS › Business categories  (CHANGELOG 236, convergence C1)
 * ============================================================================================
 * The ONE place a business's category is decided by a person. Merged into the one admin dispatcher
 * (admin-os-dispatch.js), like healthcare-admin._adminH. Every op re-checks the canonical admin claim
 * (admin-claim.js) and every change writes the immutable `adminAudit` trail.
 *
 *   bizAdminProviders  list approved businesses by category, or the UNCLASSIFIED queue
 *   bizAdminClassify   set (or correct) a business's category — a reason is required
 *
 * BOUNDARIES
 *   · Healthcare is one decision in two fields (providers.healthcare + providers.business). A Healthcare
 *     category can be given only to an account approved as a health provider, and a health provider only a
 *     Healthcare category — this op never turns a plumber into a clinic, nor a clinic into a plumber. Both
 *     fields are written in the same transaction.
 *   · Categories owned by a specialised authority (lawyer → legal-verification, event_organizer, delivery) are
 *     REFUSED here: those are decided by their own authority, and a label here would be a second one.
 *   · The COMMERCIAL LANE (business.lane, stamped at approval) is NOT changed. Re-pricing on reclassification is
 *     a commercial decision (convergence C6); the audit records the lane that stayed.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const ADMIN = require('./admin-claim');
const BCAT = require('./business-category');

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);

function _requireAdmin(req) {
  if (!req || !req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!ADMIN.isAdmin(req)) throw new HttpsError('permission-denied', 'Administrators only.');
  return req.auth.uid;
}

const _adminH = {};

/** Approved businesses with their canonical category; view = 'unclassified' | 'all' | <category>. */
_adminH.bizAdminProviders = async (req) => {
  _requireAdmin(req);
  const view = _san(req.data && req.data.view, 40) || 'unclassified';
  /* Stamped businesses (C1) PLUS the LEGACY ones — approved before C1, carrying no `business` stamp. Legacy providers
     are grandfathered in their workspace (owner decision 2026-09-28, C2) and belong in this queue until classified. */
  const [stamped, active] = await Promise.all([
    _db().collection('providers').where('business.source', 'in', ['application', 'admin']).limit(500).get(),
    _db().collection('providers').where('status', 'in', ['active', 'approved']).limit(500).get(),
  ]);
  const seen = new Set();
  let rows = [...stamped.docs, ...active.docs].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))).map((d) => {
    const p = d.data() || {};
    const cat = BCAT.categoryOf(p);
    const legacy = !p.business && !p.healthcare;
    return { uid: d.id, name: p.name || '', status: p.status || null, category: cat, categoryLabel: BCAT.label(cat),
      source: legacy ? 'legacy' : ((p.business && p.business.source) || null), lane: (p.business && p.business.lane && p.business.lane.hub) || null,
      healthcare: !!p.healthcare, legacy, city: p.city || null };
  });
  if (view === 'unclassified') rows = rows.filter((r) => !r.category);
  else if (BCAT.isCategory(view)) rows = rows.filter((r) => r.category === view);
  return { view, providers: rows,
    categories: BCAT.KEYS.map((k) => ({ id: k, label: BCAT.CATEGORIES[k].label, group: BCAT.CATEGORIES[k].group, authority: BCAT.CATEGORIES[k].authority || null })) };
};

/** Classify or re-classify one business. Audited; the provider can never do this. */
_adminH.bizAdminClassify = async (req) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const uid = _san(d.uid, 128);
  if (!uid || /[/]/.test(uid)) throw new HttpsError('invalid-argument', 'uid is required.');
  const category = String(d.category || '');
  if (!BCAT.isCategory(category)) throw new HttpsError('invalid-argument', 'category must be one of: ' + BCAT.KEYS.join(', ') + '.');
  if (BCAT.CATEGORIES[category].authority) {
    throw new HttpsError('failed-precondition', `${BCAT.label(category)} is decided by its own authority (${BCAT.CATEGORIES[category].authority}), not here.`, { code: 'OWNED_BY_AUTHORITY' });
  }
  const reason = _san(d.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required (kept in the audit log).');
  const db = _db();
  const ref = db.collection('providers').doc(uid);
  let previous = null; let laneKept = null;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'No provider record for this account.');
    const p = s.data() || {};
    if (!['active', 'approved', 'suspended'].includes(String(p.status || ''))) {
      throw new HttpsError('failed-precondition', 'Only an approved business can be classified — decide the application first.', { code: 'NOT_APPROVED' });
    }
    const isHealth = !!p.healthcare;
    const toHealth = !!BCAT.CATEGORIES[category].healthcare;
    if (isHealth !== toHealth) {
      throw new HttpsError('failed-precondition', isHealth
        ? 'A health provider can only be given a Healthcare category.'
        : 'A Healthcare category needs a health-provider approval, not a reclassification.', { code: 'HEALTHCARE_BOUNDARY' });
    }
    previous = BCAT.categoryOf(p);
    const b = p.business || {};
    laneKept = (b.lane && b.lane.hub) || null;
    const patch = { business: Object.assign({}, b, { category, source: 'admin', classifiedBy: actor, setAt: _ts() }), updatedAt: _ts() };
    if (isHealth) patch.healthcare = Object.assign({}, p.healthcare, { category, source: 'admin', classifiedBy: actor, setAt: _ts() });
    t.set(ref, patch, { merge: true });
    t.set(db.collection('adminAudit').doc(), {
      action: 'business_classify', targetUid: uid, performedBy: actor,
      previous, next: category, laneUnchanged: laneKept, reason, createdAt: _ts(),
    });
  });
  return { uid, previous, category, label: BCAT.label(category), laneUnchanged: laneKept };
};

module.exports = { _adminH };
