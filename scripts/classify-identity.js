#!/usr/bin/env node
/* ============================================================================
   ADMIN CLASSIFICATION OF ONE IDENTITY — through the existing AdminOS authority, nothing else
   scripts/classify-identity.js

   The category of an approved business is decided by a person through ONE authority:
   functions/business-category-admin.js `bizAdminClassify` (AdminOS › Business categories). This script does not
   re-implement it. It (1) snapshots the identity, (2) plans the exact mutation the authority will make and prints the
   manifest with a digest, and (3) on --apply <digest>, re-snapshots, refuses on ANY difference, and then CALLS THE
   AUTHORITY'S OWN HANDLER (the same transaction, the same refusals, the same adminAudit record) with an admin request
   whose actor names this owner-authorized session. It never writes a provider field itself.

   Why call the handler rather than the deployed callable: the authority lives on this lineage and is not deployed;
   the only way to exercise it against production today is the Admin SDK. The actor is recorded truthfully as
   `admin-sdk:classify-identity` — not a person's uid — and the reason text names the owner's authorization.

   Refusals (plan or apply): no provider · provider not approved by evidence (approvedAt) · sourceApplicationId not the
   approved application · already classified (idempotent skip) · target category not a C1 category, owned by another
   authority, or healthcare (the handler's own boundaries) · any drift from the reviewed snapshot digest.
   ========================================================================== */
'use strict';
const path = require('path'); const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const BCAT = require(path.join(ROOT, 'functions', 'business-category.js'));
const scope = require(path.join(ROOT, 'functions', 'shared', 'business-scope.js'));
const norm = (v) => (v == null ? null : JSON.parse(JSON.stringify(v, (k, x) => (x && x._seconds !== undefined ? new Date(x._seconds * 1000).toISOString() : (x && x.toDate ? x.toDate().toISOString() : x)))));
const ACTOR = 'admin-sdk:classify-identity';

async function snapshot(db, uid, applicationId) {
  const [p, a, s, b] = await Promise.all([db.doc('providers/' + uid).get(), db.doc('applications/' + applicationId).get(), db.doc('sellers/' + uid).get(), db.doc('businesses/' + uid).get()]);
  const audits = (await db.collection('adminAudit').where('targetUid', '==', uid).get()).size;
  return { uid, applicationId, provider: p.exists ? norm(p.data()) : null, application: a.exists ? norm(a.data()) : null, seller: s.exists ? norm(s.data()) : null, business: b.exists ? norm(b.data()) : null, audits };
}

/** Pure. The manifest the authority will produce, or refusals. */
function plan(s, category, reason) {
  const refusals = [];
  const p = s.provider || {}, a = s.application || {};
  if (!s.provider) refusals.push('provider_absent');
  if (s.provider && !scope.resolveBusinessScope({ provider: p }).providesServices) refusals.push('provider_not_live_by_evidence');
  if (!s.application) refusals.push('application_absent');
  else {
    if (String(a.statusCanonical || a.status) !== 'approved') refusals.push('application_not_approved');
    if (a.uid !== s.uid) refusals.push('application_uid_mismatch');
    if (!a.decidedBy || !a.decidedAt) refusals.push('application_without_decision_evidence');
  }
  if (p.sourceApplicationId && p.sourceApplicationId !== s.applicationId) refusals.push('provider_source_application_mismatch');
  if (!BCAT.isCategory(category)) refusals.push('not_a_c1_category');
  else {
    if (BCAT.CATEGORIES[category].authority) refusals.push('category_owned_by_authority:' + BCAT.CATEGORIES[category].authority);
    if (BCAT.CATEGORIES[category].healthcare || p.healthcare) refusals.push('healthcare_boundary');
  }
  if (!reason || String(reason).trim().length < 3) refusals.push('reason_required');
  const current = BCAT.categoryOf(p);
  let noop = false;
  if (p.business && p.business.category === category && p.business.source === 'admin') noop = true;
  else if (p.business) refusals.push('already_stamped_differently:' + (p.business.category || 'null') + '/' + (p.business.source || '?'));
  const laneKept = (p.business && p.business.lane && p.business.lane.hub) || null;
  const mutation = refusals.length ? null : {
    write: { path: 'providers/' + s.uid, op: 'set-merge (the authority\'s transaction)', fields: { business: Object.assign({}, p.business || {}, { category, source: 'admin', classifiedBy: ACTOR, setAt: '<serverTimestamp>' }), updatedAt: '<serverTimestamp>' } },
    audit: { path: 'adminAudit/(auto)', fields: { action: 'business_classify', targetUid: s.uid, performedBy: ACTOR, previous: current, next: category, laneUnchanged: laneKept, reason, createdAt: '<serverTimestamp>' } },
    untouched: ['providers/' + s.uid + ' — every field except business and updatedAt (status, approvedAt, name, description, categories, searchable, isPublic, acceptsBookings, rating…)', 'applications/' + s.applicationId, 'users/' + s.uid, 'wallets/' + s.uid, 'sellers/' + s.uid, 'businesses/' + s.uid, 'products/*', 'providerBookings/*', 'orders/*', 'Auth claims'],
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify({ uid: s.uid, applicationId: s.applicationId, category, provider: s.provider, application: s.application, seller: s.seller, business: s.business, refusals, noop })).digest('hex');
  return { ok: refusals.length === 0, noop, refusals, category, currentCategory: current, laneKept, mutation, digest, actor: ACTOR };
}

/** The apply: re-snapshot, compare digests, then call the AUTHORITY's handler. */
async function apply(db, uid, applicationId, category, reason, expectDigest, handler) {
  const s = await snapshot(db, uid, applicationId);
  const p = plan(s, category, reason);
  if (p.noop) return { applied: false, reason: 'already_classified', digest: p.digest };
  if (!p.ok) return { applied: false, reason: 'plan_refused', refusals: p.refusals };
  if (p.digest !== expectDigest) return { applied: false, reason: 'digest_mismatch', expected: expectDigest, actual: p.digest };
  const req = { auth: { uid: ACTOR, token: { admin: true } }, data: { uid, category, reason } };
  const res = await handler(req);   /* business-category-admin._adminH.bizAdminClassify — its own transaction + audit */
  return { applied: true, result: res, digest: p.digest };
}

module.exports = { snapshot, plan, apply, ACTOR };

if (require.main === module) {
  const args = process.argv.slice(2); const arg = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : null; };
  const uid = arg('--uid'), applicationId = arg('--application'), category = arg('--category'), reason = arg('--reason'), expect = arg('--apply');
  if (!uid || !applicationId || !category || !reason) { console.error('usage: --uid U --application A --category C --reason "…" [--apply <digest>]'); process.exit(2); }
  const _r = require('module').createRequire(path.join(ROOT, 'functions', 'package.json'));
  const admin = _r('firebase-admin'); const { getFirestore } = _r('firebase-admin/firestore');
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' });
  const db = getFirestore(app);
  (async () => {
    if (!expect) {
      const s = await snapshot(db, uid, applicationId); const p = plan(s, category, reason);
      console.log(JSON.stringify({ mode: 'plan', uid, applicationId, snapshotAudits: s.audits, plan: p }, null, 2));
      process.exit(p.ok ? 0 : 1);
    }
    if (!/^[a-f0-9]{64}$/.test(expect)) { console.error('REFUSED: --apply needs the reviewed plan digest'); process.exit(2); }
    const handler = require(path.join(ROOT, 'functions', 'business-category-admin.js'))._adminH.bizAdminClassify;
    const r = await apply(db, uid, applicationId, category, reason, expect, handler);
    console.log(JSON.stringify(r, null, 2)); process.exit(r.applied ? 0 : 1);
  })().catch((e) => { console.error('FAILED — ' + (e.stack || e)); process.exit(2); });
}
