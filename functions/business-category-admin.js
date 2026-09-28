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

/* ── SELLER SHOPS (owner decision 2026-09-28, stage 2 of the shop discovery authority) ─────────────────────────────
   A seller shop's SOKONI category lives on the CANONICAL shops/{id}.business (business-category.shopEligibility reads
   it there, never from the owner-writable sellers / businesses rows). Approval stamps it (projectSeller); this is how
   an administrator classifies a shop approval could not, corrects one, or classifies a shop that predates categories.
   A shop may be given a category whose workspace is merchant-v2 — the categories that run on a shop. */
const WS = () => require('./business-workspace');
const shopCategories = () => BCAT.KEYS.filter((k) => WS().ROUTE_OF[k] === 'merchant-v2.html');
const _shopOwner = (s) => s.sellerUid || s.ownerId || s.ownerUid || null;
/* What approved this shop. 'application' = decided in AdminOS Applications (projectSeller); 'admin' = classified here
   before; 'none' = no approval record (legacy, or created by the shop wizard, which never approves anything). */
function _shopApproval(s) {
  if (s.source === 'application_approval' || s.applicationId) return 'application';
  if (s.business && s.business.source === 'admin') return 'admin';
  if (s.business && s.business.source === 'application') return 'application';
  return 'none';
}
function _shopRow(id, s) {
  const e = BCAT.shopEligibility(s);
  return { shopId: id, ownerUid: _shopOwner(s), name: s.name || s.storeName || s.businessName || '', status: s.status || null,
    category: e.category, categoryLabel: e.category ? BCAT.label(e.category) : null,
    source: (s.business && s.business.source) || null, approval: _shopApproval(s),
    ownerWording: typeof s.category === 'string' ? s.category.slice(0, 80) : null,
    eligible: e.eligible, reasons: e.reasons, city: s.city || null };
}

/** Seller shops with their SOKONI category and discovery answer; view = 'unclassified' | 'all' | <category>. */
_adminH.bizAdminShops = async (req) => {
  _requireAdmin(req);
  const view = _san(req.data && req.data.view, 40) || 'unclassified';
  const [live, stamped] = await Promise.all([
    _db().collection('shops').where('status', 'in', ['active', 'approved', 'suspended']).limit(500).get(),
    _db().collection('shops').where('business.source', 'in', ['application', 'admin']).limit(500).get(),
  ]);
  const seen = new Set();
  let rows = [...live.docs, ...stamped.docs].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .map((d) => _shopRow(d.id, d.data() || {}));
  if (view === 'unclassified') rows = rows.filter((r) => !r.category);
  else if (BCAT.isCategory(view)) rows = rows.filter((r) => r.category === view);
  return { view, shops: rows,
    categories: shopCategories().map((k) => ({ id: k, label: BCAT.CATEGORIES[k].label, group: BCAT.CATEGORIES[k].group })) };
};

/**
 * Classify or re-classify one seller shop. Audited. The category is stamped on shops/{id}.business (source 'admin')
 * and mirrored onto the owner's EXISTING sellers / businesses rows (as approval does), which re-runs the search gate.
 * It does not approve, activate, publish or un-suspend anything: a shop never approved through Applications is
 * refused unless the administrator attests they verified the business (recorded), and a pending shop is refused.
 */
_adminH.bizAdminClassifyShop = async (req) => {
  const actor = _requireAdmin(req);
  const d = req.data || {};
  const shopId = _san(d.shopId, 128);
  if (!shopId || /[/]/.test(shopId)) throw new HttpsError('invalid-argument', 'shopId is required.');
  const category = String(d.category || '');
  const allowed = shopCategories();
  if (!allowed.includes(category)) throw new HttpsError('invalid-argument', 'A shop category must be one of: ' + allowed.join(', ') + '.');
  const reason = _san(d.reason, 500);
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason is required (kept in the audit log).');
  const attest = d.attestApproval === true;
  const db = _db();
  const ref = db.collection('shops').doc(shopId);
  let out = null;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'No shop with this id.');
    const shop = s.data() || {};
    const owner = _shopOwner(shop);
    if (!owner) throw new HttpsError('failed-precondition', 'This shop names no owner — it cannot be classified.', { code: 'NO_OWNER' });
    if (!['active', 'approved', 'suspended'].includes(String(shop.status || ''))) {
      throw new HttpsError('failed-precondition', 'Only an approved shop can be classified — decide its application first.', { code: 'NOT_APPROVED' });
    }
    const approval = _shopApproval(shop);
    if (approval === 'none' && !attest) {
      throw new HttpsError('failed-precondition', 'This shop has no approval record (created before approvals, or by the shop wizard). Confirm you have verified this business, or decide its application in Applications.', { code: 'NO_APPROVAL_RECORD' });
    }
    /* reads before writes: the owner's account rows are mirrored only where they exist */
    const sellerRef = db.collection('sellers').doc(String(owner));
    const bizRef = db.collection('businesses').doc(String(owner));
    const [sellerSnap, bizSnap] = await Promise.all([t.get(sellerRef), t.get(bizRef)]);
    const previous = BCAT.shopEligibility(shop).category;
    const prior = shop.business || {};
    const business = Object.assign({}, prior, { category, source: 'admin', classifiedBy: actor, setAt: _ts(),
      applicationId: prior.applicationId || shop.applicationId || null }, approval === 'none' ? { approvalAttestedBy: actor } : {});
    t.set(ref, { business, updatedAt: _ts() }, { merge: true });
    if (sellerSnap.exists && String((sellerSnap.data() || {}).shopId || owner) === shopId) t.set(sellerRef, { business, updatedAt: _ts() }, { merge: true });
    if (bizSnap.exists && String((bizSnap.data() || {}).shopId || owner) === shopId) t.set(bizRef, { business, updatedAt: _ts() }, { merge: true });
    t.set(db.collection('adminAudit').doc(), {
      action: 'shop_classify', targetShopId: shopId, targetUid: String(owner), performedBy: actor,
      previous, next: category, approval, attested: approval === 'none', reason, createdAt: _ts(),
    });
    const after = BCAT.shopEligibility(Object.assign({}, shop, { business: { category, source: 'admin' } }));
    out = { shopId, ownerUid: String(owner), previous, category, label: BCAT.label(category), eligible: after.eligible, reasons: after.reasons };
  });
  return out;
};

module.exports = { _adminH };
