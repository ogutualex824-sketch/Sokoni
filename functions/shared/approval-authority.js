'use strict';
/**
 * THE approval authority — isAuthoritativelyApproved(applicationId, category).  P0-C, owner 2026-10-03.
 *
 * Application `status` is WORKFLOW, never authorisation. An application is approved for a capability only when
 * applicationDecisions/{applicationId} — written ONLY by applicationDecide (K13-A), no client rule — says so:
 *   1. the record exists, names THIS application and says 'approved';
 *   2. its decider is a legitimate administrator (Auth custom claim admin / superAdmin);
 *   3. the decider is not the applicant (separation of duties);
 *   4. when a category is asked for, the record's approvedCategories contains it (absent list → refused);
 *   5. the application was not revoked;
 *   6. the applicant's provider record is not suspended / deactivated / banned / revoked, and no active account freeze.
 * There is NO fallback: never application.status, adminApproved, approvedBy, providers.approvalDecision or adminAudit.
 * (adminAudit is migration evidence only — P0-H reconciles it into records ONCE.) Unreadable → not approved.
 *
 * READ-ONLY. Every hub (Education, Marketing, Construction, Legal, Food, Sports, Tech, Car, seller, driver, role grants)
 * consumes this one function; none interprets approval locally.
 */

const INACTIVE = new Set(['suspended', 'deactivated', 'banned', 'revoked', 'rejected']);

function adminResolver(getUser) {
  const cache = {};
  return async (uid) => {
    if (!uid || /[:/ ]/.test(String(uid))) return false;
    if (Object.prototype.hasOwnProperty.call(cache, uid)) return cache[uid];
    let ok = false;
    try { const u = await getUser(String(uid)); const c = (u && u.customClaims) || {}; ok = c.admin === true || c.superAdmin === true; } catch (_) { ok = false; }
    cache[uid] = ok; return ok;
  };
}

const no = (reason, extra) => Object.assign({ approved: false, reason }, extra || {});

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} applicationId
 * @param {{ category?: string|null, isAdmin?: (uid:string)=>Promise<boolean>, getUser?: Function, application?: object }} [opts]
 * @returns {Promise<{approved:boolean, reason:string, applicationId:string, applicantUid?:string, decidedBy?:string,
 *                    decidedAt?:any, approvedCategories?:string[]|null}>}
 */
async function isAuthoritativelyApproved(db, applicationId, opts) {
  const o = opts || {};
  const id = typeof applicationId === 'string' ? applicationId.trim() : '';
  if (!id || /[/]/.test(id)) return no('NO_APPLICATION_ID', { applicationId: id });
  const isAdmin = o.isAdmin || (o.getUser ? adminResolver(o.getUser) : async () => false);
  try {
    const recSnap = await db.collection('applicationDecisions').doc(id).get();
    if (!recSnap.exists) return no('NO_DECISION_RECORD', { applicationId: id });
    const rec = recSnap.data() || {};
    if (String(rec.applicationId || id) !== id) return no('RECORD_MISMATCH', { applicationId: id });
    const base = { applicationId: id, decidedBy: rec.decidedBy || null, decidedAt: rec.decidedAt || null,
      approvedCategories: Array.isArray(rec.approvedCategories) ? rec.approvedCategories.slice() : null };
    if (String(rec.status || '') !== 'approved') return no('NOT_APPROVED', Object.assign(base, { status: rec.status || null }));

    let app = o.application || null;
    if (!app) { const a = await db.collection('applications').doc(id).get(); app = a.exists ? (a.data() || {}) : null; }
    if (!app) return no('NO_APPLICATION', base);
    const applicantUid = String(rec.applicantUid || app.uid || '');
    if (!applicantUid || (app.uid && String(app.uid) !== applicantUid)) return no('APPLICANT_MISMATCH', base);
    base.applicantUid = applicantUid;

    const by = typeof rec.decidedBy === 'string' ? rec.decidedBy.trim() : '';
    if (!by || !(await isAdmin(by))) return no('DECIDER_NOT_ADMIN', base);
    if (by === applicantUid) return no('SELF_DECIDED', base);
    if (app.reviewStage === 'revoked') return no('REVOKED', base);

    if (o.category != null) {
      const cat = String(o.category);
      if (!base.approvedCategories || base.approvedCategories.indexOf(cat) < 0) return no('CATEGORY_NOT_APPROVED', base);
    }

    const [prov, frz] = await Promise.all([
      db.collection('providers').doc(applicantUid).get(),
      db.collection('accountFreezes').doc(applicantUid).get(),
    ]);
    if (prov.exists) {
      const p = prov.data() || {};
      if (INACTIVE.has(String(p.status || '')) || p.suspended === true || p.banned === true || p.deactivated === true) return no('PROVIDER_INACTIVE', base);
    }
    if (frz.exists && (frz.data() || {}).active === true) return no('ACCOUNT_FROZEN', base);

    return Object.assign({ approved: true, reason: 'APPROVED' }, base);
  } catch (_) {
    return no('UNREADABLE', { applicationId: id });
  }
}

module.exports = { isAuthoritativelyApproved, adminResolver, INACTIVE };
