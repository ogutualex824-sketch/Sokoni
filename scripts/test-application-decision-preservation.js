#!/usr/bin/env node
/* test-application-decision-preservation.js — re-deciding an application PRESERVES the decision it supersedes
 * (owner decision 2026-09-29, Kasindi repair): the REAL c4 `applicationDecide` handler on the transactional fake
 * store, invoked through CallableFunction.run. No network.
 *
 * PROVES
 *   preserve      re-approving a document decided by "reindex" appends that decision VERBATIM to `priorDecisions`
 *                 (status, decidedBy "reindex", decidedAt July, projection fields) before decidedBy/decidedAt are
 *                 overwritten by the named admin + server timestamp — the document itself now tells the truth
 *   not laundered the preserved entry still says "reindex"; nothing in the entry names the admin as the July decider
 *   dedupe        deciding the same document a second time preserves the (now admin) decision once and does not
 *                 duplicate the "reindex" entry; a first decision on an undecided document preserves nothing
 *   gate first    the agreement gate refuses approve BEFORE any write — an application without agreementAccepted is
 *                 byte-identical after the refusal (no priorDecisions, no decision record, no audit)
 *   real decision decidedBy = the calling admin uid; applicationDecisions/{appId} server record written FIRST;
 *                 adminAudit application_approve names the admin; agreementVerifiedAt/Version stamped
 *   isolation     wallets, walletTransactions, sellers untouched; provider projected (approvedAt refreshed, status
 *                 active, sourceApplicationId) with the role granted through the injected role authority
 *   pure helper   _internal.priorDecisionsPatch is deterministic on its inputs
 *
 *   node scripts/test-application-decision-preservation.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-preserve';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const { onCall, HttpsError } = require(resolveIn('firebase-functions/v2/https'));
stub('firebase-functions/v2/https', { onCall, HttpsError });
stub('firebase-functions/v2/firestore', { onDocumentWritten: (opts, h) => ({ run: h, __trigger: true }) });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'x' }) });
stub('firebase-functions/logger', { info() {}, warn() {}, error() {}, debug() {}, log() {} });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
const accounts = { admin_D5: { customClaims: { admin: true, superAdmin: true } } };
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (uid) => { if (!accounts[uid]) throw new Error('no user ' + uid); return { uid, customClaims: accounts[uid].customClaims }; }, setCustomUserClaims: async () => { throw new Error('claims written directly'); } }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
const grants = []; stub('./role-authority', { grantAccountRole: async (dbx, uid, role, on, ctx) => { grants.push({ uid, role, on }); await db.doc('users/' + uid).set({ roles: F.FieldValue.arrayUnion(role) }, { merge: true }); return { ok: true }; }, roleKeyFor: (r) => r, ROLE_KEY: {} });
stub('./seller-trial', { startSellerFreeTrial: async () => ({ ok: true }) });
stub('./notify', { notify: async () => ({}), send: async () => ({}) });
stub('./legal-agreements', { complianceFor: async () => ({ compliant: true, missing: [] }) });
stub('./business-wallet', { ensureWallet: async () => ({}) });
stub('./sokoni-till', {});
stub('./search-terms', { buildSearchTerms: () => [], termsFor: () => [], searchTerms: () => [] });
stub('./legal-verification', {});
stub('./business-bootstrap', { ensureBusinessForOwner: async () => ({}) , _ensureBusinessForOwner: async () => ({}) });
const AL = require(Path.join(FN, 'application-lifecycle.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const J = (x) => JSON.stringify(x);
const isTs = (v) => v instanceof Date || !!(v && typeof v._ms === 'number');
const err = async (p) => { try { const r = await p; return { ok: true, r }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
const ADMIN = { uid: 'admin_D5', token: { admin: true, superAdmin: true } };
const decide = (data, auth) => AL.applicationDecide.run({ auth: auth || ADMIN, data, rawRequest: {} });
const UID = 'kasindi', APP = 'PRVMS7IACKG', JULY = '2026-07-30T15:11:12.000Z';
const KAS_APP = { applicationId: APP, uid: UID, name: 'Kasindi holdings limited', type: 'Cleaning Company / Housekeeper', category: 'Service Provider', hub: 'service', role: 'provider', roleResolvedBy: 'keyword', status: 'approved', statusCanonical: 'approved', decidedBy: 'reindex', decidedAt: JULY, decisionAppliedFor: 'approved', projectionStatus: 'applied', phone: '+254700000000', city: 'Nairobi', intakeVersion: 3 };
(async () => {
  say('\n── pure helper ──');
  const P = AL._internal.priorDecisionsPatch;
  ck('undecided document → nothing to preserve', J(P({ status: 'pending' }, 'admin_D5', 'approve')) === '{}');
  const one = P(KAS_APP, 'admin_D5', 'approve');
  ck('decided-by-"reindex" document → one verbatim entry {approved, reindex, July, applied} + preservedBy admin, supersededBy approve', one.priorDecisions && one.priorDecisions.length === 1 && one.priorDecisions[0].decidedBy === 'reindex' && one.priorDecisions[0].decidedAt === JULY && one.priorDecisions[0].status === 'approved' && one.priorDecisions[0].projectionStatus === 'applied' && one.priorDecisions[0].preservedBy === 'admin_D5' && one.priorDecisions[0].supersededBy === 'approve', one);
  ck('same (decidedBy, decidedAt) already preserved → nothing appended (dedupe)', J(P(Object.assign({}, KAS_APP, { priorDecisions: one.priorDecisions }), 'admin_D5', 'approve')) === '{}');

  say('\n── gate first: no agreement → refused before any write ──');
  await db.doc('applications/' + APP).set(KAS_APP);
  await db.doc('providers/' + UID).set({ name: 'Kasindi holdings limited', status: 'active', approvedAt: '2026-07-30T15:13:13.000Z', sourceApplicationId: APP, searchable: true, isPublic: true });
  await db.doc('users/' + UID).set({ roles: ['buyer', 'provider'], approved: true });
  await db.doc('wallets/' + UID).set({ balance: 50 }); await db.doc('walletTransactions/rcv1').set({ uid: UID, type: 'receive', amount: 50, status: 'completed' });
  await db.doc('sellers/' + UID).set({ branches: [], updatedAt: 'x' });
  const frozen = () => J({ w: db._dump('wallets/'), t: db._dump('walletTransactions/'), s: db._dump('sellers/') });
  const before = { app: J(await get('applications/' + APP)), iso: frozen() };
  let r = await err(decide({ applicationId: APP, decision: 'approve', reason: 'Fresh audited decision; July "reindex" state is historical' }));
  ck('approve without agreementAccepted → failed-precondition (the Seller Agreement gate)', !r.ok && r.code === 'failed-precondition' && /Seller Agreement/.test(r.message), r.code + ' ' + r.message);
  ck('application byte-identical after the refusal (no priorDecisions, decidedBy still "reindex"), no decision record, no audit', J(await get('applications/' + APP)) === before.app && (await get('applicationDecisions/' + APP)) === null && db._dump('adminAudit/').length === 0);
  r = await err(decide({ applicationId: APP, decision: 'approve', reason: 'x' }, { uid: UID, token: { provider: true } }));
  ck('the applicant cannot decide their own application → permission-denied', !r.ok && r.code === 'permission-denied', r.code);

  say('\n── the business acknowledges (client fields, dated now), then the named admin decides ──');
  const ackAt = new Date().toISOString();
  await db.doc('applications/' + APP).set({ agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct', agreementAcceptedAt: ackAt }, { merge: true });
  const REASON = 'Fresh audited decision by a named admin; the July 2026 reindex approval is preserved as historical, not treated as an admin decision';
  r = await err(decide({ applicationId: APP, decision: 'approve', reason: REASON }));
  ck('approve → ok, projected', r.ok && r.r.ok === true && r.r.projected === true, r);
  const app = await get('applications/' + APP);
  ck('priorDecisions[0] preserves the July decision VERBATIM: status approved, decidedBy "reindex", decidedAt July, decisionAppliedFor approved, projectionStatus applied', Array.isArray(app.priorDecisions) && app.priorDecisions.length === 1 && app.priorDecisions[0].decidedBy === 'reindex' && app.priorDecisions[0].decidedAt === JULY && app.priorDecisions[0].status === 'approved' && app.priorDecisions[0].decisionAppliedFor === 'approved' && app.priorDecisions[0].projectionStatus === 'applied', app.priorDecisions);
  ck('the preserved entry is NOT laundered: preservedBy names the admin as the preserver, decidedBy stays "reindex", supersededBy approve', app.priorDecisions[0].preservedBy === 'admin_D5' && app.priorDecisions[0].decidedBy === 'reindex' && app.priorDecisions[0].supersededBy === 'approve' && typeof app.priorDecisions[0].preservedAt === 'string');
  ck('the CURRENT decision names the admin: decidedBy admin_D5, decidedAt server ts, status approved, reviewReason', app.decidedBy === 'admin_D5' && isTs(app.decidedAt) && app.status === 'approved' && app.reviewReason === REASON);
  ck('agreementVerifiedAt (server) + agreementVerifiedVersion stamped; client acknowledgement fields untouched (acceptedAt = now, not July)', isTs(app.agreementVerifiedAt) && app.agreementVerifiedVersion === '2026-09-07-lanes-mkt-ladder-pos-5pct' && app.agreementAcceptedAt === ackAt && app.agreementAccepted === true);
  const rec = await get('applicationDecisions/' + APP);
  ck('server decision record applicationDecisions/{appId}: status approved, decidedBy admin_D5', rec && rec.status === 'approved' && rec.decidedBy === 'admin_D5' && rec.decision === 'approve', rec);
  const audits = db._dump('adminAudit/');
  ck('exactly one adminAudit application_approve naming the admin, the application and the target uid', audits.length === 1 && audits[0].action === 'application_approve' && audits[0].performedBy === 'admin_D5' && audits[0].applicationId === APP && audits[0].targetUid === UID, audits);
  const prov = await get('providers/' + UID);
  ck('provider re-projected: status active, approvedAt refreshed (server ts), sourceApplicationId, searchable/isPublic true', prov.status === 'active' && isTs(prov.approvedAt) && prov.sourceApplicationId === APP && prov.searchable === true && prov.isPublic === true, { status: prov.status, approvedAt: prov.approvedAt });
  ck('role granted through the injected role authority (provider)', grants.some((g) => g.uid === UID && g.role === 'provider' && g.on === true), grants);
  ck('wallets, walletTransactions (KES 50) and the stray sellers record byte-identical', frozen() === before.iso);

  say('\n── deciding again: dedupe, the admin decision now becomes history once ──');
  const snap2 = J(app);
  r = await err(decide({ applicationId: APP, decision: 'approve', reason: 'repeat' }));
  const app2 = await get('applications/' + APP);
  ck('second decision → priorDecisions has 2 entries: [reindex/July, admin_D5/first decision] — the "reindex" entry is not duplicated', r.ok && app2.priorDecisions.length === 2 && app2.priorDecisions[0].decidedBy === 'reindex' && app2.priorDecisions[1].decidedBy === 'admin_D5' && app2.priorDecisions.filter((e) => e.decidedBy === 'reindex').length === 1, app2.priorDecisions.map((e) => e.decidedBy));
  ck('the first entry is byte-identical to what the first decision preserved', J(app2.priorDecisions[0]) === J(JSON.parse(snap2).priorDecisions[0]));

  say('\n── first decision on an undecided application preserves nothing ──');
  await db.doc('applications/NEW1').set({ applicationId: 'NEW1', uid: 'newbie', name: 'New Co', type: 'Plumber', category: 'Service Provider', hub: 'service', role: 'provider', status: 'pending', statusCanonical: 'pending', agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct', agreementAcceptedAt: ackAt, phone: '+254700000001', intakeVersion: 3 });
  r = await err(decide({ applicationId: 'NEW1', decision: 'approve', reason: 'first decision' }));
  const n1 = await get('applications/NEW1');
  ck('approve on a pending application → ok; no priorDecisions field written', r.ok && n1.priorDecisions === undefined && n1.decidedBy === 'admin_D5', { prior: n1.priorDecisions, by: n1.decidedBy });

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
