#!/usr/bin/env node
/* approval-decision-manifest.js — plan / apply wrapper around the REAL admin approval-decision authority
 * (functions/business-approval-admin.js bizAdminApprovalDecide) for ONE identity with no valid approval evidence
 * (the DJ Bvmbxno / King Bruce class: providers/{uid} live by client-written status, no application).
 *
 *   node scripts/approval-decision-manifest.js --uid <uid> --decision approve|refuse --reason "<text>" --plan
 *   node scripts/approval-decision-manifest.js --uid <uid> --decision approve|refuse --reason "<text>" --apply <digest> --actor <adminUid>
 *
 * plan   READ-ONLY: snapshots the identity (provider, users, sellers, businesses, shops, applications by uid, activity
 *        counts, wallet, Auth claims), lists the handler's own refusals as it would raise them, prints the exact mutation
 *        (one provider patch + one adminAudit; approve also grants `provider` through the role authority) and what stays
 *        untouched, and a digest over the full snapshot. Never writes.
 * apply  re-snapshots; refuses on ANY difference from the reviewed digest; refuses unless --actor is an Auth account
 *        holding the admin claim (a REAL named admin, never a tool label); then calls the REAL handler once with
 *        { auth: { uid: actor, token: claims } }. Idempotent: a repeated apply reports `repeated` and writes nothing.
 *
 * The decision itself is the owner's; this script only makes it exact and auditable. It never classifies.
 */
'use strict';
const crypto = require('crypto');
const norm = (v) => (v == null ? null : JSON.parse(JSON.stringify(v, (k, x) => (x && x._seconds !== undefined ? new Date(x._seconds * 1000).toISOString() : (x && x.toDate ? x.toDate().toISOString() : x)))));
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const DECISIONS = ['approve', 'refuse'];

async function snapshot(db, uid, auth) {
  const docOf = async (p) => { const s = await db.doc(p).get(); return s.exists ? norm(s.data()) : null; };
  const count = async (col, field) => { try { return (await db.collection(col).where(field, '==', uid).limit(50).get()).size; } catch (e) { return 'unreadable'; } };
  const [provider, user, seller, business, shop, wallet] = await Promise.all(['providers', 'users', 'sellers', 'businesses', 'shops', 'wallets'].map((c) => docOf(c + '/' + uid)));
  const applications = (await db.collection('applications').where('uid', '==', uid).limit(10).get()).docs.map((d) => Object.assign({ __id: d.id }, norm(d.data())));
  const activity = { providerBookings: await count('providerBookings', 'providerId'), providerServices: await count('providerServices', 'providerId'), walletTransactions: await count('walletTransactions', 'uid'), products: await count('products', 'sellerUid'), orders: await count('orders', 'sellerUid') };
  let claims = null; if (auth) { try { claims = (await auth.getUser(uid)).customClaims || {}; } catch (e) { claims = { absent: true }; } }
  const s = { uid, provider, user, seller, business, shop, wallet, applications, activity, claims, at: new Date().toISOString() };
  s.digest = sha({ provider, user, seller, business, shop, wallet, applications, activity, claims });
  return s;
}

/* Mirrors the handler's refusals (it is still the handler that decides at apply time). */
function plan(s, decision, reason) {
  const refusals = [];
  if (!DECISIONS.includes(decision)) refusals.push('decision_invalid');
  if (!reason || String(reason).trim().length < 3) refusals.push('reason_required');
  if (!s.provider) refusals.push('NO_PROVIDER');
  else {
    if (s.provider.healthcare) refusals.push('HEALTHCARE_BOUNDARY');
    const ex = s.provider.approvalDecision;
    if (ex && ex.source === 'admin_decision') refusals.push(ex.decision === decision ? 'already_decided_same (apply = no-op)' : 'DECISION_EXISTS:' + ex.decision);
  }
  const p = s.provider || {};
  const prior = { status: p.status || null, approvedAt: p.approvedAt || null, approvedBy: p.approvedBy || null, decidedBy: p.decidedBy || null };
  const patch = decision === 'approve'
    ? { status: 'active', approvedAt: '<serverTimestamp>', approvedBy: '<actor>', suspended: false }
    : { status: 'suspended', suspended: true, searchable: false, isPublic: false };
  const mutation = {
    write: { path: 'providers/' + s.uid, fields: Object.assign({ approvalDecision: { decision, decidedBy: '<actor>', decidedAt: '<serverTimestamp>', reason, prior, source: 'admin_decision' }, updatedAt: '<serverTimestamp>' }, patch) },
    audit: { path: 'adminAudit/<auto>', fields: { action: 'business_approval_decision', targetUid: s.uid, performedBy: '<actor>', decision, previous: { status: prior.status, approvedAt: prior.approvedAt }, next: { status: patch.status }, reason } },
    role: decision === 'approve' ? { via: 'role-authority.grantAccountRole', uid: s.uid, role: 'provider', approved: true } : null,
    untouched: ['applications/* (none created — the identity has ' + s.applications.length + ')', 'providerBookings (' + s.activity.providerBookings + ')', 'providerServices (' + s.activity.providerServices + ')', 'walletTransactions (' + s.activity.walletTransactions + ') + wallets/' + s.uid, 'products (' + s.activity.products + ')', 'orders (' + s.activity.orders + ')', 'sellers/ businesses/ shops/ (' + [s.seller, s.business, s.shop].map((x) => (x ? 'present' : 'absent')).join('/') + ')', 'users/' + s.uid + ' beyond the role authority', 'providers.business (category) — approval never classifies'],
  };
  const evidenceNow = { status: prior.status, approvedAt: prior.approvedAt, approvalDecision: p.approvalDecision || null, publiclyListed: !!(p.searchable || p.isPublic), lastActivity: s.activity };
  return { ok: refusals.length === 0, noop: refusals.some((r) => r.startsWith('already_decided_same')), refusals, decision, reason, evidenceNow, mutation, digest: s.digest, at: s.at };
}

async function apply(db, auth, uid, decision, reason, expectDigest, actor, handler) {
  if (!actor || /[:/ ]/.test(actor)) return { applied: false, reason: 'actor_required: a real admin Auth uid' };
  let claims; try { claims = (await auth.getUser(actor)).customClaims || {}; } catch (e) { return { applied: false, reason: 'actor_not_an_account' }; }
  if (claims.admin !== true && claims.superAdmin !== true) return { applied: false, reason: 'actor_holds_no_admin_claim' };
  const s = await snapshot(db, uid, auth);
  const p = plan(s, decision, reason);
  if (p.noop) return { applied: false, reason: 'already_decided_same', digest: s.digest };
  if (!p.ok) return { applied: false, reason: 'refused', refusals: p.refusals, digest: s.digest };
  if (s.digest !== expectDigest) return { applied: false, reason: 'digest_mismatch', expected: expectDigest, live: s.digest };
  const result = await handler({ auth: { uid: actor, token: claims }, data: { uid, decision, reason } });
  return { applied: !result.repeated, result, digest: s.digest, actor };
}

module.exports = { snapshot, plan, apply, DECISIONS };

if (require.main === module) {
  const args = process.argv.slice(2); const arg = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
  const uid = arg('--uid'), decision = arg('--decision'), reason = arg('--reason'), digest = arg('--apply'), actor = arg('--actor');
  if (!uid || !decision || !reason || (!args.includes('--plan') && !digest)) { console.error('usage: --uid <uid> --decision approve|refuse --reason "<text>" (--plan | --apply <digest> --actor <adminUid>)'); process.exit(64); }
  const REPO = 'C:/Users/USER1/OneDrive/Desktop/SOKONI';
  const _r = require('module').createRequire(REPO + '/functions/package.json');
  const admin = _r('firebase-admin'); const { getFirestore } = _r('firebase-admin/firestore');
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' });
  const db = getFirestore(app); const auth = admin.auth();
  (async () => {
    if (args.includes('--plan')) { const s = await snapshot(db, uid, auth); const p = plan(s, decision, reason); console.log(JSON.stringify(Object.assign({ mode: 'plan (read-only)', uid }, p), null, 2)); process.exit(0); }
    const FN = require('path').join(__dirname, '..', 'functions');
    const handler = require(require('path').join(FN, 'business-approval-admin.js'))._adminH.bizAdminApprovalDecide;
    const r = await apply(db, auth, uid, decision, reason, digest, actor, handler);
    console.log(JSON.stringify(r, null, 2)); process.exit(r.applied || r.reason === 'already_decided_same' ? 0 : 1);
  })().catch((e) => { console.error('FAILED', e.message); process.exit(2); });
}
