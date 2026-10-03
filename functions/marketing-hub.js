'use strict';
/**
 * SOKONI Marketing Hub — ONE callable, `marketingDispatch({ op, ... })` (Marketing Hub MK2, owner brief 2026-10-03).
 *
 * What it owns: the Marketing application (three SEPARATE types — individual marketer / agency / specialist — never the
 * generic business application), the applicant's own status, the public directory read, and the AdminOS overview.
 * What it does NOT own (reused, never forked):
 *   review + decision   applications/{marketing_uid} → applicationDecide (approvedCategories subset) → applyDecision →
 *                       projectMarketing (application-lifecycle.js) → providers/{uid} marketing block
 *   booking / payment   bookingCreateService → providerBookings → IntaSend webhook → hold → completion PIN →
 *                       settlement (one commission from the catalogue) → wallets/{providerId} (business wallet)
 *   quotes              service-leads (the ONE lead/quote authority)
 *   plans / commission  2f's commercial catalogue — nothing here prices anything
 *
 * Every handler authenticates itself as its first statement; the dispatcher is a router, not an authorization boundary
 * (same contract as legal-dispatch.js).
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const MKT = require('./shared/marketing-taxonomy');

const _OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };
const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;
const _ts = () => FV().serverTimestamp();

const APP_ID = (uid) => 'marketing_' + uid;
/* Statuses an applicant may (re)submit from. Anything else is a live application or a decision only an admin changes. */
const RESUBMITTABLE = ['info_requested', 'rejected', 'withdrawn'];
const LIVE = ['pending', 'submitted', 'under_review'];

function _uid(req) { if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.'); return req.auth.uid; }
function _admin(req) { const t = (req.auth && req.auth.token) || {}; if (!t.admin && !t.superAdmin) throw new HttpsError('permission-denied', 'Administrator access required.'); return req.auth.uid; }
function _s(v, max) { return v == null ? '' : String(v).replace(/[<>]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function _int(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null; }
function _urls(v) {
  return (Array.isArray(v) ? v : []).map((u) => _s(u, 400)).filter((u) => /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(u)).slice(0, 8);
}
function _phone(v) { const d = String(v || '').replace(/\D/g, ''); if (/^0[17]\d{8}$/.test(d)) return '+254' + d.slice(1); if (/^254[17]\d{8}$/.test(d)) return '+' + d; return ''; }

/** The public projection of a marketer — no phone, no email, no internal ids beyond the provider uid. */
function _card(id, p) {
  return {
    uid: id, name: _s(p.name, 160), marketingType: p.marketingType || 'individual',
    categories: Array.isArray(p.marketingCategories) ? p.marketingCategories : [],
    groups: Array.isArray(p.marketingGroups) ? p.marketingGroups : [],
    city: _s(p.city, 100), description: _s(p.description, 280), photoURL: _s(p.photoURL || p.logoUrl || '', 400),
    /* Real counters only (seeded 0 at creation, moved by reviews/bookings). reviewCount 0 → the UI shows "No reviews yet". */
    rating: typeof p.rating === 'number' ? p.rating : null, reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : 0,
    jobsCompleted: typeof p.jobsCompleted === 'number' ? p.jobsCompleted : 0,
  };
}
const _listed = (p) => p && p.marketingListed === true && p.marketingStatus === 'active' && p.status === 'active' && p.isPublic !== false;

const _h = {
  /* ── public ── */
  async marketingTaxonomy() {
    return { ok: true, groups: MKT.GROUPS, types: MKT.APPLICATION_TYPES };
  },

  /** Directory — a FILTERED VIEW of approved marketers (providers marketing block). Single-field queries only. */
  async marketingDirectory(req) {
    const d = req.data || {};
    const cat = MKT.isArea(d.category) ? d.category : null;
    const group = MKT.GROUPS.some((g) => g.id === d.group) ? d.group : null;
    const type = MKT.APPLICATION_TYPES[d.type] ? d.type : null;
    const lim = _int(d.limit, 1, 48) || 24;
    let q = db().collection('providers');
    q = cat ? q.where('marketingCategories', 'array-contains', cat)
      : group ? q.where('marketingGroups', 'array-contains', group)
        : q.where('marketingListed', '==', true);
    const snap = await q.limit(200).get();
    const term = _s(d.q, 60).toLowerCase();
    let items = snap.docs.filter((x) => _listed(x.data())).map((x) => _card(x.id, x.data()));
    if (type) items = items.filter((i) => i.marketingType === type);
    if (term) items = items.filter((i) => (i.name + ' ' + i.description + ' ' + i.categories.map((c) => MKT.AREA[c].label).join(' ')).toLowerCase().indexOf(term) >= 0);
    items.sort((a, b) => (b.jobsCompleted - a.jobsCompleted) || ((b.rating || 0) - (a.rating || 0)) || a.name.localeCompare(b.name));
    return { ok: true, items: items.slice(0, lim), total: items.length };
  },

  async marketingProfile(req) {
    const id = _s((req.data || {}).uid, 128);
    if (!id) throw new HttpsError('invalid-argument', 'uid is required.');
    const s = await db().collection('providers').doc(id).get();
    if (!s.exists || !_listed(s.data())) throw new HttpsError('not-found', 'This marketer is not listed.');
    const p = s.data();
    return { ok: true, profile: Object.assign(_card(s.id, p), { description: _s(p.description, 2000), portfolio: _urls(p.marketingPortfolio) }) };
  },

  /* ── applicant ── */
  /** Submit (or resubmit after NEEDS-INFO / rejection / withdrawal) a Marketing application. */
  async marketingApply(req) {
    const uid = _uid(req);
    const d = req.data || {};
    const type = String(d.marketingType || '');
    const T = MKT.APPLICATION_TYPES[type];
    if (!T) throw new HttpsError('invalid-argument', 'Choose individual marketer, agency or specialist.', { code: 'MKT_TYPE' });
    const cats = MKT.normalizeCategories(d.categories, T.maxCategories + 1);
    if (cats.length < T.minCategories) throw new HttpsError('invalid-argument', 'Choose at least one marketing service.', { code: 'MKT_NO_CATEGORY' });
    if (cats.length > T.maxCategories) throw new HttpsError('invalid-argument', T.label + ' may apply for at most ' + T.maxCategories + ' service(s).', { code: 'MKT_TOO_MANY' });
    const name = _s(d.name, 120);
    const description = _s(d.description, 2000);
    const county = _s(d.county, 80);
    if (name.length < 2) throw new HttpsError('invalid-argument', 'Your name or business name is required.', { code: 'MKT_NAME' });
    if (description.length < 30) throw new HttpsError('invalid-argument', 'Describe your work in at least 30 characters.', { code: 'MKT_DESCRIPTION' });
    if (!county) throw new HttpsError('invalid-argument', 'County is required.', { code: 'MKT_COUNTY' });
    const phone = _phone(d.phone);
    if (!phone) throw new HttpsError('invalid-argument', 'A valid Kenyan mobile number is required.', { code: 'MKT_PHONE' });
    const agency = type === 'agency'
      ? { teamSize: _int(d.teamSize, 2, 5000), registrationNumber: _s(d.registrationNumber, 60), kraPin: _s(d.kraPin, 20).toUpperCase() }
      : null;
    if (agency && !agency.teamSize) throw new HttpsError('invalid-argument', 'An agency must state its team size (2 or more).', { code: 'MKT_TEAM' });
    if (agency && !agency.registrationNumber) throw new HttpsError('invalid-argument', 'An agency must give its business registration number.', { code: 'MKT_REG' });

    const ref = db().collection('applications').doc(APP_ID(uid));
    const out = await db().runTransaction(async (t) => {
      const cur = await t.get(ref);
      const c = cur.exists ? cur.data() : null;
      const st = c ? String(c.status || 'pending') : null;
      if (c && LIVE.indexOf(st) >= 0) throw new HttpsError('already-exists', 'Your Marketing application is already under review.', { code: 'MKT_LIVE' });
      if (c && st === 'approved') throw new HttpsError('already-exists', 'You are already an approved marketer. Request more services from your dashboard.', { code: 'MKT_APPROVED' });
      if (c && RESUBMITTABLE.indexOf(st) < 0) throw new HttpsError('failed-precondition', 'This application cannot be resubmitted (' + st + '). Contact support.', { code: 'MKT_LOCKED' });
      const doc = {
        uid, applicationId: APP_ID(uid), applicationType: 'marketing', hub: 'marketing', requestedRole: 'provider',
        marketingIntake: 'server', marketingType: type, marketingTypeLabel: T.label,
        requestedCategories: cats, requestedGroups: MKT.groupsOf(cats),
        name, businessName: name, description, categoryLabel: 'Marketing — ' + T.label, category: 'marketing',
        location: county, city: county, phone, phoneNumber: phone, email: _s(req.auth.token && req.auth.token.email, 200),
        portfolio: _urls(d.portfolio), yearsExperience: _int(d.yearsExperience, 0, 60),
        ...(agency ? { agency } : {}),
        status: 'pending', marketingStage: 'submitted',
        marketingApprovedCategories: FV().delete(), marketingDeclinedCategories: FV().delete(),
        decisionAppliedFor: FV().delete(), reviewReason: c && st === 'info_requested' ? (c.reviewReason || null) : null,
        submittedAt: _ts(), receivedAt: _ts(), updatedAt: _ts(),
        ...(c ? { resubmissions: FV().increment(1) } : { createdAt: _ts() }),
      };
      t.set(ref, doc, { merge: true });
      return { resubmitted: !!c };
    });
    return { ok: true, applicationId: APP_ID(uid), status: 'pending', resubmitted: out.resubmitted };
  },

  async marketingWithdraw(req) {
    const uid = _uid(req);
    const ref = db().collection('applications').doc(APP_ID(uid));
    await db().runTransaction(async (t) => {
      const cur = await t.get(ref);
      if (!cur.exists) throw new HttpsError('not-found', 'No Marketing application.');
      const st = String(cur.data().status || 'pending');
      if (LIVE.indexOf(st) < 0 && st !== 'info_requested') throw new HttpsError('failed-precondition', 'Only an application under review can be withdrawn.', { code: 'MKT_NOT_LIVE' });
      t.set(ref, { status: 'withdrawn', marketingStage: 'withdrawn', withdrawnAt: _ts(), updatedAt: _ts() }, { merge: true });
    });
    return { ok: true, status: 'withdrawn' };
  },

  /** The applicant's own state: application (if any) + the live marketing block (if approved). */
  async marketingMyStatus(req) {
    const uid = _uid(req);
    const [a, p] = await Promise.all([db().collection('applications').doc(APP_ID(uid)).get(), db().collection('providers').doc(uid).get()]);
    const app = a.exists ? a.data() : null;
    const pr = p.exists ? p.data() : null;
    return {
      ok: true,
      application: app ? {
        status: app.status || 'pending', marketingType: app.marketingType || null, requestedCategories: app.requestedCategories || [],
        approvedCategories: app.marketingApprovedCategories || [], declinedCategories: app.marketingDeclinedCategories || [],
        reviewReason: app.status === 'info_requested' || app.status === 'rejected' ? (app.reviewReason || null) : null,
        name: app.name || '', description: app.description || '', county: app.city || '', phone: app.phone || '', portfolio: app.portfolio || [],
        yearsExperience: app.yearsExperience == null ? null : app.yearsExperience, agency: app.agency || null,
      } : null,
      marketer: pr && pr.marketingStatus ? {
        status: pr.marketingStatus, listed: _listed(pr), marketingType: pr.marketingType || null,
        categories: pr.marketingCategories || [], providerId: pr.providerId || null,
      } : null,
    };
  },

  /* ── AdminOS / Super Admin ── */
  /** Marketing overview: every marketing application with type + categories, and the live marketer counts. */
  async marketingAdminOverview(req) {
    _admin(req);
    const [apps, live] = await Promise.all([
      db().collection('applications').where('hub', '==', 'marketing').limit(500).get(),
      db().collection('providers').where('marketingListed', '==', true).limit(1000).get(),
    ]);
    const items = apps.docs.map((x) => { const a = x.data(); return {
      id: x.id, uid: a.uid || null, name: a.name || '', status: a.status || 'pending', marketingType: a.marketingType || null,
      requestedCategories: a.requestedCategories || [], approvedCategories: a.marketingApprovedCategories || [],
      county: a.city || '', phone: a.phone || '', email: a.email || '', portfolio: a.portfolio || [], description: a.description || '',
      agency: a.agency || null, yearsExperience: a.yearsExperience == null ? null : a.yearsExperience,
      projectionStatus: a.projectionStatus || null, projectionError: a.projectionError || null, reviewReason: a.reviewReason || null,
      receivedAtMs: a.receivedAt && a.receivedAt.toMillis ? a.receivedAt.toMillis() : null,
    }; }).sort((a, b) => (b.receivedAtMs || 0) - (a.receivedAtMs || 0));
    const byStatus = {}, byType = {}, byCategory = {};
    items.forEach((i) => { byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.marketingType || 'unknown'] = (byType[i.marketingType || 'unknown'] || 0) + 1; });
    live.docs.forEach((x) => { const p = x.data(); if (!_listed(p)) return; (p.marketingCategories || []).forEach((c) => { byCategory[c] = (byCategory[c] || 0) + 1; }); });
    return { ok: true, items, counts: { byStatus, byType, byCategory, listed: live.docs.filter((x) => _listed(x.data())).length } };
  },
};

exports._h = _h;
exports._internal = { APP_ID, RESUBMITTABLE, LIVE, _card, _listed, _phone };
exports.marketingDispatch = onCall(_OPTS, async (req) => {
  const op = req.data && req.data.op;
  const valid = Object.keys(_h).join(', ');
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', '"op" is required. Valid: ' + valid);
  const handler = Object.prototype.hasOwnProperty.call(_h, op) ? _h[op] : null;
  if (typeof handler !== 'function') throw new HttpsError('not-found', 'Unknown op "' + op + '". Valid: ' + valid);
  return handler(req);
});
