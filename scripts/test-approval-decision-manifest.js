#!/usr/bin/env node
/* test-approval-decision-manifest.js — the plan/apply contract around the REAL bizAdminApprovalDecide, on the
 * transactional fake store. No network.
 *
 * PROVES  plan is read-only and names exactly one provider patch + one audit (+ role grant on approve) and the
 *         untouched set; refusals mirror the handler (no provider, healthcare, existing decision); apply refuses a tool
 *         label / non-account / non-admin actor BEFORE any write; drift → digest_mismatch, nothing written; a valid
 *         apply calls the real handler ONCE (decidedBy = the named admin uid); a second apply = already_decided_same
 *         with nothing written; bookings / services / wallet byte-identical; no category stamp.
 *
 *   node scripts/test-approval-decision-manifest.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-adm';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const grants = []; stub('./role-authority', { grantAccountRole: async (dbx, uid, role, on) => { grants.push({ uid, role, on }); return { ok: true }; } });
const M = require(Path.join(ROOT, 'scripts', 'approval-decision-manifest.js'));
const handler = require(Path.join(FN, 'business-approval-admin.js'))._adminH.bizAdminApprovalDecide;
const accounts = { admin_D5: { admin: true, superAdmin: true }, plain_user: { provider: true } };
const auth = { getUser: async (uid) => { if (!accounts[uid]) throw new Error('no user'); return { uid, customClaims: accounts[uid] }; } };
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const J = (x) => JSON.stringify(x); const dump = (p) => J(db._dump(p));
const DJ = 'dj', REASON = 'Owner decision 2026-09-30: identity 3 of 6 approved to operate';
(async () => {
  await db.doc('providers/' + DJ).set({ name: 'DJ Bvmbxno', status: 'active', category: 'Entertainment Performer', searchable: true, isPublic: true });
  await db.doc('users/' + DJ).set({ roles: ['buyer'] }); await db.doc('wallets/' + DJ).set({ balance: 1500 });
  for (let i = 1; i <= 3; i++) await db.doc('walletTransactions/w' + i).set({ uid: DJ, amount: 500 });
  for (let i = 1; i <= 4; i++) await db.doc('providerBookings/b' + i).set({ providerId: DJ, status: 'confirmed' });
  await db.doc('providerServices/s1').set({ providerId: DJ, name: 'Club set' });
  await db.doc('providers/hc').set({ name: 'Clinic', status: 'active', healthcare: {} });
  const frozen = () => J({ b: dump('providerBookings/'), s: dump('providerServices/'), w: dump('walletTransactions/'), wl: dump('wallets/'), a: dump('applications/') });
  const before = frozen(); const provBefore = dump('providers/' + DJ);

  say('\n── plan (read-only) ──');
  const s = await M.snapshot(db, DJ, auth); const p = M.plan(s, 'approve', REASON);
  ck('plan ok: one provider patch (approvalDecision + approvedAt/approvedBy/status active) + one audit + role grant via role authority', p.ok && !p.noop && p.mutation.write.path === 'providers/' + DJ && p.mutation.write.fields.approvalDecision.decision === 'approve' && p.mutation.write.fields.status === 'active' && p.mutation.audit.fields.action === 'business_approval_decision' && p.mutation.role && p.mutation.role.role === 'provider', p.refusals);
  ck('plan names the untouched set with live counts (0 applications, 4 bookings, 1 service, 3 wallet tx) and that approval never classifies', p.mutation.untouched.some((u) => u.includes('none created') && u.includes('has 0')) && p.mutation.untouched.some((u) => u.includes('providerBookings (4)')) && p.mutation.untouched.some((u) => u.includes('providerServices (1)')) && p.mutation.untouched.some((u) => u.includes('walletTransactions (3)')) && p.mutation.untouched.some((u) => u.includes('never classifies')), p.mutation.untouched);
  ck('plan records evidenceNow: status active, approvedAt null, publicly listed', p.evidenceNow.status === 'active' && p.evidenceNow.approvedAt === null && p.evidenceNow.publiclyListed === true);
  ck('plan wrote nothing', dump('providers/' + DJ) === provBefore && frozen() === before && db._dump('adminAudit/').length === 0);
  const refuse = M.plan(s, 'refuse', REASON);
  ck('refuse plan: status suspended, searchable/isPublic false, NO approvedAt, no role grant', refuse.ok && refuse.mutation.write.fields.status === 'suspended' && refuse.mutation.write.fields.searchable === false && refuse.mutation.write.fields.approvedAt === undefined && refuse.mutation.role === null);
  ck('refusals mirror the handler: no provider / healthcare / bad decision / short reason', M.plan(Object.assign({}, s, { provider: null }), 'approve', REASON).refusals.includes('NO_PROVIDER') && M.plan(Object.assign({}, s, { provider: { healthcare: {} } }), 'approve', REASON).refusals.includes('HEALTHCARE_BOUNDARY') && M.plan(s, 'reinstate', REASON).refusals.includes('decision_invalid') && M.plan(s, 'approve', 'x').refusals.includes('reason_required'));

  say('\n── apply: actor must be a real admin account ──');
  let r = await M.apply(db, auth, DJ, 'approve', REASON, s.digest, 'admin-sdk:tool', handler);
  ck('a tool label is refused before any write', r.applied === false && r.reason === 'actor_required: a real admin Auth uid' && dump('providers/' + DJ) === provBefore, r.reason);
  r = await M.apply(db, auth, DJ, 'approve', REASON, s.digest, 'ghost', handler); ck('a non-account is refused', r.reason === 'actor_not_an_account');
  r = await M.apply(db, auth, DJ, 'approve', REASON, s.digest, 'plain_user', handler); ck('an account without the admin claim is refused', r.reason === 'actor_holds_no_admin_claim' && dump('providers/' + DJ) === provBefore);
  r = await M.apply(db, auth, DJ, 'approve', REASON, 'deadbeef', 'admin_D5', handler); ck('digest mismatch → nothing written', r.reason === 'digest_mismatch' && dump('providers/' + DJ) === provBefore && db._dump('adminAudit/').length === 0);

  say('\n── apply: the real handler, once, by the named admin ──');
  r = await M.apply(db, auth, DJ, 'approve', REASON, s.digest, 'admin_D5', handler);
  const prov = (await db.doc('providers/' + DJ).get()).data();
  ck('applied: decidedBy = admin_D5 (the account), approvedAt written, status active', r.applied === true && r.result.decidedBy === 'admin_D5' && prov.approvalDecision.decidedBy === 'admin_D5' && prov.approvedAt !== undefined && prov.status === 'active', r.result);
  ck('one adminAudit; role granted once through the role authority', db._dump('adminAudit/').length === 1 && grants.length === 1 && grants[0].role === 'provider');
  ck('bookings / services / wallet / applications byte-identical; no category stamp', frozen() === before && prov.business === undefined);
  const s2 = await M.snapshot(db, DJ, auth); const after = dump('providers/' + DJ);
  r = await M.apply(db, auth, DJ, 'approve', REASON, s2.digest, 'admin_D5', handler);
  ck('second apply → already_decided_same, nothing written, still one audit', r.applied === false && r.reason === 'already_decided_same' && dump('providers/' + DJ) === after && db._dump('adminAudit/').length === 1, r.reason);
  ck('a conflicting plan now refuses with DECISION_EXISTS:approve', M.plan(s2, 'refuse', REASON).refusals.includes('DECISION_EXISTS:approve'));

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
