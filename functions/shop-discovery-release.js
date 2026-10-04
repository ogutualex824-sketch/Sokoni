'use strict';
/**
 * SOKONI — shop discovery RELEASE evaluator (owner 2026-10-04: "the gate decides").
 *
 * The ONE discovery gate is business-category.shopEligibility. Approval holds a new shop (discovery:'HELD', _noIndex)
 * and this evaluator — a SERVER write, never the browser — lifts the hold the moment the shop passes EVERY check:
 *   1. the shop document checks of the gate (active, not suspended / deactivated / locked / hidden, C1 category stamped)
 *      → business-category.shopReleaseChecks;
 *   2. an AUTHORITATIVE approval: applicationDecisions/{applicationId} via shared/approval-authority (admin decider, not
 *      the applicant, not revoked, account not frozen) — the application the shop was projected from;
 *   3. a valid owner and business: the shop's sellerUid is the decision's applicant, sellers/{owner} is active with
 *      approval evidence, and businesses/{shopId} exists.
 * Products are NOT a condition (owner 2026-10-04): an approved, categorised shop with zero products is released.
 *
 * Any check failing on a RELEASED shop re-holds it (suspension, rejection, revocation, inactivation, lost category); the
 * business records are kept intact — only discovery changes. Shops that never entered the hold (no `discovery` field —
 * pre-hold legacy shops) are never touched: they keep exactly the visibility they had.
 *
 * Indexing follows automatically: release writes `_noIndex:false` + searchable/isPublic on sellers/{owner} and
 * businesses/{shopId} (the search rows), which fires their algolia-sync triggers, and discovery-eligibility.prepareForIndex
 * admits them only through this same gate. A re-hold writes `_noIndex:true`, which the sync turns into a DELETE.
 *
 * Never throws into a caller: an unreadable state returns { action:'error' } and leaves the shop as it was (held stays held).
 */
const BCAT = require('./business-category');
const { DISCOVERY } = BCAT;

const RELEASE = (FieldValue, at) => ({ discovery: DISCOVERY.ELIGIBLE, _noIndex: false, searchable: true, isPublic: true,
  discoveryReleasedAt: at, discoveryHeldReasons: FieldValue.delete(), updatedAt: at });
/* A search row that never carried the hold (a legacy, already-visible seller / business behind a NEW shop) is only TAGGED —
   the write fires its index trigger; the owner's own visibility fields are left exactly as they were. */
const TAG = (at) => ({ discovery: DISCOVERY.ELIGIBLE, discoveryReleasedAt: at, updatedAt: at });
const carriesHold = (d) => !!d && (d._noIndex === true || d.discovery === DISCOVERY.HELD);
const REHOLD = (FieldValue, at, reasons) => ({ discovery: DISCOVERY.HELD, _noIndex: true, searchable: false, isPublic: false,
  discoveryHeldAt: at, discoveryHeldReasons: reasons.slice(0, 10), updatedAt: at });

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} shopId
 * @param {{ FieldValue: any, getUser?: Function, isAdmin?: Function }} deps
 * @returns {Promise<{ action: 'released'|'reheld'|'unchanged'|'not_participating'|'error', reasons: string[] }>}
 */
async function evaluateShopDiscovery(db, shopId, deps) {
  const d = deps || {};
  const { FieldValue } = d;
  const id = typeof shopId === 'string' ? shopId.trim() : '';
  if (!id || /[/]/.test(id) || !FieldValue) return { action: 'error', reasons: ['BAD_INPUT'] };
  try {
    const shopSnap = await db.collection('shops').doc(id).get();
    if (!shopSnap.exists) return { action: 'not_participating', reasons: ['NO_SHOP'] };
    const shop = shopSnap.data() || {};
    if (shop.discovery !== DISCOVERY.HELD && shop.discovery !== DISCOVERY.ELIGIBLE) return { action: 'not_participating', reasons: ['LEGACY_VISIBILITY'] };

    /* searchable / isPublic on a held shop are the HOLD's own output (server-written; not on the owner's shop allow-list),
       never a reason to keep holding it — judge every other check. */
    const reasons = BCAT.shopReleaseChecks(Object.assign({}, shop, { searchable: undefined, isPublic: undefined })).reasons.slice();
    const owner = String(shop.sellerUid || shop.ownerId || '');
    if (!owner || /[/]/.test(owner)) reasons.push('NO_OWNER');
    const appId = String((shop.business && shop.business.applicationId) || shop.applicationId || '');

    /* 2 — the approval authority (the ONE predicate; no status / audit fallback) */
    if (!appId) reasons.push('NO_APPLICATION');
    else {
      const AUTH = require('./shared/approval-authority');
      const v = await AUTH.isAuthoritativelyApproved(db, appId, { isAdmin: d.isAdmin, getUser: d.getUser });
      if (!v.approved) reasons.push('NOT_APPROVED:' + v.reason);
      else if (owner && v.applicantUid && String(v.applicantUid) !== owner) reasons.push('OWNER_MISMATCH');
    }
    /* 3 — owner + business records */
    const [sellerSnap, bizSnap] = owner ? await Promise.all([
      db.collection('sellers').doc(owner).get(), db.collection('businesses').doc(id).get(),
    ]) : [null, null];
    const seller = sellerSnap && sellerSnap.exists ? (sellerSnap.data() || {}) : null;
    if (!seller) reasons.push('NO_SELLER');
    else if (seller.status !== 'active' || seller.active === false || !seller.approvedAt || seller.suspended === true) reasons.push('SELLER_NOT_ACTIVE');
    if (!(bizSnap && bizSnap.exists)) reasons.push('NO_BUSINESS');

    const pass = reasons.length === 0;
    const at = FieldValue.serverTimestamp();
    if (pass && shop.discovery === DISCOVERY.HELD) {
      const batch = db.batch();
      batch.set(db.collection('shops').doc(id), RELEASE(FieldValue, at), { merge: true });
      const biz = bizSnap.data() || {};
      batch.set(db.collection('sellers').doc(owner), carriesHold(seller) ? RELEASE(FieldValue, at) : TAG(at), { merge: true });
      batch.set(db.collection('businesses').doc(id), carriesHold(biz) ? RELEASE(FieldValue, at) : TAG(at), { merge: true });
      await batch.commit();
      return { action: 'released', reasons: [] };
    }
    if (!pass && shop.discovery === DISCOVERY.ELIGIBLE) {
      const batch = db.batch();
      batch.set(db.collection('shops').doc(id), REHOLD(FieldValue, at, reasons), { merge: true });
      if (seller) batch.set(db.collection('sellers').doc(owner), REHOLD(FieldValue, at, reasons), { merge: true });
      if (bizSnap && bizSnap.exists) batch.set(db.collection('businesses').doc(id), REHOLD(FieldValue, at, reasons), { merge: true });
      await batch.commit();
      return { action: 'reheld', reasons };
    }
    return { action: 'unchanged', reasons };
  } catch (e) {
    try { require('firebase-functions/logger').error('[shopDiscovery] evaluation failed — shop left as it was', { shopId: id, error: e && e.message }); } catch (_) { /* no logger */ }
    return { action: 'error', reasons: ['UNREADABLE'] };
  }
}

module.exports = { evaluateShopDiscovery, RELEASE, REHOLD };
