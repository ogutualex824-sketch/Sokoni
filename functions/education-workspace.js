'use strict';
/* ══ EDUCATION E2 — the ONE capability answer for every Education actor (owner brief 2026-10-03) ══════════════════════
   E1 decided WHO an applicant is; this answers WHAT each actor may see and manage. The browser renders it and never
   sends a role, a provider type or "isEnterprise" — every field below is read from server-written records:

     learner     — every signed-in account. Its access is education-learner.learnerAccess (users.ageVerified or an
                   active guardian link → interactive; else free self-paced only).
     teacher /   — ONLY through the business workspace authority (business-workspace.workspaceFor): the approval gate,
     institution   the category and the server-stamped providers/{uid}.education.type. Never a second implementation.
     enterprise  — a company BUYING training: educationEnterprises/{uid} (application-lifecycle). It never receives
                   provider modules, a storefront or provider settlement.
     applications — the caller's own Education applications: status, and the type only once the server stamped it.

   Unknown is reported as null (the UI renders "—"), never guessed. Nothing here writes. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const EDU_CATEGORIES = Object.freeze(['tutor', 'school', 'online-course', 'education-enterprise']);
const ENTERPRISE_MODULES = Object.freeze(['employees', 'training', 'programmes', 'enrolments', 'liveClasses', 'providers',
  'bookings', 'payments', 'receipts', 'wallet', 'reports', 'messages', 'roles', 'companyProfile', 'settings']);
const LEARNER_MODULES = Object.freeze(['overview', 'myLearning', 'discover', 'courses', 'liveClasses', 'tutoring', 'bookings',
  'certificates', 'messages', 'receipts', 'profile', 'settings']);
/* What exists today for a learner. Everything else is an E2 build: NOT_IMPLEMENTED, never shown as working. */
const LEARNER_BUILT = Object.freeze(['overview', 'myLearning', 'discover', 'courses', 'certificates', 'profile']);   /* certificates: courseLessons myCertificates + verify (E2 lessons slice) */
/* Interactive learner modules additionally need learnerAccess().interactive (E1 owner rule). */
const LEARNER_INTERACTIVE = Object.freeze(['liveClasses', 'tutoring', 'messages']);
/* What exists today for a company (E2 enterprise slice: consent-based training assignments, education-enterprise.js). */
const ENTERPRISE_BUILT = Object.freeze(['employees', 'training', 'companyProfile']);
const ENTERPRISE_ROUTE = 'education-enterprise.html';

const _st = (state, reason) => ({ state, reason: reason || null });

function learnerModules(access) {
  const out = {};
  for (const k of LEARNER_MODULES) {
    if (!LEARNER_BUILT.includes(k)) { out[k] = _st('NOT_IMPLEMENTED', 'EDUCATION_E2_PENDING'); continue; }
    out[k] = _st('AVAILABLE');
  }
  for (const k of LEARNER_INTERACTIVE) {
    if (!(access && access.interactive === true)) out[k] = _st('LOCKED', access ? 'AGE_OR_GUARDIAN_REQUIRED' : 'ACCESS_UNKNOWN');
  }
  return out;
}

function enterpriseState(doc) {
  if (!doc) return null;
  if (doc.status === 'active' && doc.approved === true) return 'ACTIVE';
  if (doc.status === 'inactive') return 'SUSPENDED';
  return null;
}

async function educationWorkspaceFor(db, uid, opts) {
  const L = require('./education-learner')._internal;
  const BW = require('./business-workspace');
  const out = { uid: String(uid), learner: null, provider: null, enterprise: null, applications: [], dashboards: [] };

  /* learner — always (every account can learn) */
  try {
    const [p, access] = await Promise.all([db.collection('learnerProfiles').doc(String(uid)).get(), L.learnerAccess(db, uid)]);
    out.learner = { profile: p.exists, access, modules: learnerModules(access) };
  } catch (_) {
    out.learner = { profile: null, access: null, modules: learnerModules(null) };
  }
  out.dashboards.push({ actor: 'learner', route: 'education.html#learn', state: 'AVAILABLE' });

  /* teacher / institution — the business workspace authority, never re-derived here */
  try {
    const w = await BW.workspaceFor(db, uid, opts);
    if (w && w.category === 'education') {
      const eduMods = {};
      for (const [k, v] of Object.entries(w.modules || {})) if (/^edu[A-Z]/.test(k) && v.state !== 'NOT_APPLICABLE') eduMods[k] = v;
      out.provider = { educationType: w.educationType || null, state: w.state, reason: w.reason || null, route: w.route || null,
        modules: eduMods, approval: w.approval ? w.approval.state : null };
      if (w.route && w.state === 'AVAILABLE' && w.educationType) out.dashboards.push({ actor: w.educationType, route: w.route, state: 'AVAILABLE' });
    }
  } catch (_) {
    out.provider = { educationType: null, state: 'UNREADABLE', reason: 'WORKSPACE_UNREADABLE', route: null, modules: {}, approval: null };
  }

  /* enterprise buyer — its own record; never provider tools */
  try {
    const e = await db.collection('educationEnterprises').doc(String(uid)).get();
    const state = enterpriseState(e.exists ? e.data() : null);
    if (state) {
      const mods = {};
      for (const k of ENTERPRISE_MODULES) {
        mods[k] = state !== 'ACTIVE' ? _st('LOCKED', 'ENTERPRISE_SUSPENDED')
          : ENTERPRISE_BUILT.includes(k) ? _st('AVAILABLE') : _st('NOT_IMPLEMENTED', 'EDUCATION_E2_PENDING');
      }
      out.enterprise = { state, companyName: (e.data() || {}).companyName || null, modules: mods };
      /* The company's OWN shell — never provider-dashboard. A suspended company is not routed. */
      out.dashboards.push({ actor: 'enterprise', route: state === 'ACTIVE' ? ENTERPRISE_ROUTE : null, state: state === 'ACTIVE' ? 'AVAILABLE' : 'LOCKED' });
    }
  } catch (_) {
    out.enterprise = { state: 'UNREADABLE', companyName: null, modules: {} };
  }

  /* the caller's own Education applications (status; type only once the server stamped it) */
  try {
    const q = await db.collection('applications').where('uid', '==', String(uid)).limit(20).get();
    for (const d of q.docs) {
      const a = d.data() || {};
      if (!EDU_CATEGORIES.includes(String(a.category || ''))) continue;
      out.applications.push({ id: d.id, category: a.category, status: a.statusCanonical || a.status || null,
        educationType: a.educationType || null, missing: Array.isArray(a.missing) ? a.missing : [],
        projectionStatus: a.projectionStatus || null });
    }
  } catch (_) {
    out.applications = null;   /* unreadable ≠ none */
  }
  return out;
}

exports.educationWorkspace = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 20 }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  /* the caller only — there is no uid parameter */
  return educationWorkspaceFor(getFirestore(), uid, { claims: req.auth.token || {} });
});
exports._internal = { educationWorkspaceFor, learnerModules, enterpriseState, ENTERPRISE_MODULES, ENTERPRISE_BUILT, ENTERPRISE_ROUTE, LEARNER_MODULES, LEARNER_BUILT };
