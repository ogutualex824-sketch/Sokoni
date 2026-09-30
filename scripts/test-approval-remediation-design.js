#!/usr/bin/env node
/* test-approval-remediation-design.js — the REAPPLICATION_REQUIRED design, proven: the pure derivation
 * (functions/shared/approval-remediation.js) over census-shaped fixtures, and the REAL authorities (c4 applicationDecide,
 * bizAdminApprovalDecide) on the transactional fake store for the transition's write-side behaviour. No network.
 *
 * PROVES (owner's list, in order)
 *   1 transition predicate   INVALID_LEGACY_APPROVAL | NO_APPROVAL → REAPPLICATION_REQUIRED; nothing else transitions
 *   2 buyer exclusion        buyer-only (incl. buyer+rider, buyer+admin claim) → BUYER_ONLY, protected, no transition
 *   3 valid protection       admin-account-approved application → VALID_APPROVAL, protected
 *   4 invalid vs none        Kasindi ("reindex") / Langa'ta ("founder-decision…") / KASS D5 (self-decided, other role)
 *                            → INVALID_LEGACY; DJ / stubs / role-only → NO_APPROVAL with the right subtype
 *   5 self-approval refusal  decisionValidity rejects decidedBy === applicant; BOTH real authorities refuse an admin
 *                            deciding their own record/application BEFORE any write
 *   6 reuse vs fresh         continue_existing / select_among_pending (Heights: 3 candidates, requiresSelection, none
 *                            chosen, none created) / redecide_existing / fresh
 *   7 agreement/version      required for the transition; satisfied only by agreementAccepted === true at the CURRENT version
 *   8 preservation           preserve lists every historical decision; a real re-decision appends it to priorDecisions
 *   9 cleanup ownership      an identity claimed by the cleanup manifest reports its state but NO transition (ownership cleanup)
 *  10 admin authority reuse  the fresh decision is the REAL c4 applicationDecide (agreement gate, server record, audit)
 *  11 projection             after a valid decision the provider is live by evidence; DJ's provider still has NO category →
 *                            resolver PENDING_CLASSIFICATION; Langa'ta's `cleaning` stamp survives re-approval
 *  12 idempotency/conflict   repeat decision dedupes preservation; bizAdminApprovalDecide conflicting → DECISION_EXISTS;
 *                            applicationDecide suspend-after-approve is a lifecycle change that preserves the approval
 *  13 classification independent  no category written by approval; classification stays bizAdminClassify
 *  14 zero mutation          wallet, walletTransactions, bookings, services, products byte-identical throughout;
 *                            the two KASS SHOP identities stay separate and 32 wallet tx are never evidence
 *
 *   node scripts/test-approval-remediation-design.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-remediation';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const { onCall, HttpsError } = require(resolveIn('firebase-functions/v2/https'));
stub('firebase-functions/v2/https', { onCall, HttpsError });
stub('firebase-functions/v2/firestore', { onDocumentWritten: (o, h) => ({ run: h }) });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'x' }) });
stub('firebase-functions/logger', { info() {}, warn() {}, error() {}, debug() {}, log() {} });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
const accounts = { admin_D5: { admin: true, superAdmin: true }, admin_2: { admin: true } };
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (uid) => { if (!accounts[uid]) throw new Error('no user'); return { uid, customClaims: accounts[uid] }; }, setCustomUserClaims: async () => { throw new Error('direct claim write'); } }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
const grants = []; stub('./role-authority', { grantAccountRole: async (dbx, uid, role, on) => { grants.push({ uid, role, on }); await db.doc('users/' + uid).set({ roles: F.FieldValue.arrayUnion(role) }, { merge: true }); return { ok: true }; }, roleKeyFor: (r) => r, ROLE_KEY: {} });
stub('./seller-trial', { startSellerFreeTrial: async () => ({}) }); stub('./notify', { notify: async () => ({}), send: async () => ({}) });
stub('./legal-agreements', { complianceFor: async () => ({ compliant: true, missing: [] }) }); stub('./business-wallet', { ensureWallet: async () => ({}) });
stub('./sokoni-till', {}); stub('./search-terms', { buildSearchTerms: () => [], termsFor: () => [], searchTerms: () => [] }); stub('./legal-verification', {});
stub('./business-bootstrap', { ensureBusinessForOwner: async () => ({}), _ensureBusinessForOwner: async () => ({}) }); stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const R = require(Path.join(FN, 'shared', 'approval-remediation.js'));
const AL = require(Path.join(FN, 'application-lifecycle.js'));
const AA = require(Path.join(FN, 'business-approval-admin.js'))._adminH.bizAdminApprovalDecide;
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const J = (x) => JSON.stringify(x); const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const err = async (p) => { try { const r = await p; return { ok: true, r }; } catch (e) { return { ok: false, code: e.code, details: e.details, message: e.message }; } };
const V = '2026-09-07-lanes-mkt-ladder-pos-5pct';
const isAdmin = (u) => !!accounts[u];
const D = (o) => R.deriveApprovalState(Object.assign({ isAdminAccount: isAdmin, agreementVersion: V, cleanupIds: new Set(['providers/shave', 'sellers/maina', 'users/maina']) }, o));
const ADMIN = { uid: 'admin_D5', token: { admin: true, superAdmin: true } };
const decide = (data, auth) => AL.applicationDecide.run({ auth: auth || ADMIN, data, rawRequest: {} });
(async () => {
  say('\n── 1–4 · derivation over census-shaped fixtures ──');
  const kas = D({ uid: 'kas', roles: ['buyer', 'provider'], claims: ['provider'], provider: { status: 'active', approvedAt: '2026-07-30T15:13:13Z', searchable: true, isPublic: true }, seller: { branches: [] }, applications: [{ id: 'PRVMS7IACKG', status: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12Z', role: 'provider' }] });
  ck('Kasindi → INVALID_LEGACY_APPROVAL / artefact_without_authority; transition REAPPLICATION_REQUIRED; path redecide_existing PRVMS7IACKG', kas.state === 'INVALID_LEGACY_APPROVAL' && kas.transition === 'REAPPLICATION_REQUIRED' && kas.applicationPath.mode === 'redecide_existing' && kas.applicationPath.applicationId === 'PRVMS7IACKG', { state: kas.state, path: kas.applicationPath.mode, reasons: kas.reasons });
  const lang = D({ uid: 'lang', roles: ['provider'], claims: ['provider'], provider: { status: 'active', approvedAt: '2026-08-01T06:14:23Z', business: { category: 'cleaning', source: 'application' } }, applications: [{ id: 'e0cO', status: 'approved', decidedBy: 'founder-decision-2026-08-01', role: 'provider' }] });
  ck('Langa\'ta mamafua → INVALID_LEGACY (label decider); categoryStamp cleaning KEEP; transition required', lang.state === 'INVALID_LEGACY_APPROVAL' && lang.transition === 'REAPPLICATION_REQUIRED' && lang.categoryStamp && lang.categoryStamp.category === 'cleaning' && lang.categoryStamp.keep === true, lang.reasons);
  const kassD5 = D({ uid: 'admin_D5', roles: ['buyer', 'seller', 'driver'], claims: ['admin', 'superAdmin', 'seller'], seller: { status: 'active' }, businesses: [{ id: 'admin_D5', status: 'active' }], shops: [{ id: 'admin_D5', status: 'active' }], applications: [{ id: 'DRV1', status: 'approved', decidedBy: 'admin_D5', role: 'driver' }, { id: 'DRV2', status: 'approved', decidedBy: 'admin_D5', role: 'driver' }] });
  ck('KASS SHOP (admin account): self-decided driver approvals are NOT approval → not VALID; selfDecided lists both; transition required', kassD5.state !== 'VALID_APPROVAL' && kassD5.selfDecided.length === 2 && kassD5.transition === 'REAPPLICATION_REQUIRED', { state: kassD5.state, self: kassD5.selfDecided, reasons: kassD5.reasons });
  const dj = D({ uid: 'dj', roles: ['provider', 'buyer'], claims: [], provider: { status: 'active', searchable: true, isPublic: true }, applications: [] });
  ck('DJ Bvmbxno → NO_APPROVAL / live_status_only; transition required; path fresh; routed + public now', dj.state === 'NO_APPROVAL' && dj.subtype === 'live_status_only' && dj.transition === 'REAPPLICATION_REQUIRED' && dj.applicationPath.mode === 'fresh' && dj.routedByShellNow && dj.publicNow);
  const kass2 = D({ uid: 'xrH', roles: ['buyer', 'seller', 'driver'], claims: [], seller: { status: 'active', searchable: true }, applications: [] });
  ck('second KASS SHOP (xrH…) → NO_APPROVAL; a separate identity from admin_D5; wallet activity is not an input (no field for it)', kass2.state === 'NO_APPROVAL' && kass2.uid !== kassD5.uid && !('walletTx' in kass2));
  ck('seller stub (no status) → NO_APPROVAL / registry_stub_not_live; role-only seller claim → role_without_registry', D({ uid: 's1', roles: ['buyer'], seller: { branches: [] } }).subtype === 'registry_stub_not_live' && D({ uid: 'rc', roles: ['buyer'], claims: ['seller'] }).subtype === 'role_without_registry');
  const kb = D({ uid: 'kb', roles: ['buyer', 'merchant', 'provider'], provider: { status: 'suspended', suspended: true, approvalDecision: { decision: 'refuse', decidedBy: 'admin_D5', source: 'admin_decision' } } });
  ck('King Bruce → REFUSED (admin_decision), no transition, roles still route the shell (flagged)', kb.state === 'REFUSED' && kb.transition === null && kb.routedByShellNow === true);
  const heights = D({ uid: 'hc', roles: ['buyer'], provider: { status: 'pending' }, applications: [{ id: 'A', status: 'pending', role: 'provider' }, { id: 'B', status: 'pending', role: 'provider' }, { id: 'C', status: 'pending', role: 'provider' }] });
  ck('Heights Creations → PENDING_APPROVAL; path select_among_pending with 3 candidates, requiresSelection, none chosen', heights.state === 'PENDING_APPROVAL' && heights.transition === null && heights.applicationPath.mode === 'select_among_pending' && heights.applicationPath.candidates.length === 3 && heights.applicationPath.requiresSelection === true && !heights.applicationPath.applicationId, heights.applicationPath);
  say('\n── 2–3 · exclusions and protection ──');
  const b1 = D({ uid: 'b1', roles: ['buyer'] }), b2 = D({ uid: 'b2', roles: ['buyer', 'rider'] }), b3 = D({ uid: 'b3', roles: ['buyer'], claims: ['admin'] });
  ck('buyer-only, buyer+rider, buyer+admin claim → BUYER_ONLY, protected, no transition', [b1, b2, b3].every((x) => x.state === 'BUYER_ONLY' && x.protected && x.transition === null));
  const kriss = D({ uid: 'kriss', roles: ['buyer', 'provider'], claims: ['provider'], provider: { status: 'active', approvedAt: '2026-08-26T05:02:14Z', business: { category: 'artist_creator', source: 'admin' } }, applications: [{ id: 'ENT', status: 'approved', decidedBy: 'admin_D5', role: 'provider' }] });
  ck('k Riss (admin-account approval) → VALID_APPROVAL, protected, no transition, ownership none', kriss.state === 'VALID_APPROVAL' && kriss.protected && kriss.transition === null && kriss.ownership === 'none');
  ck('an approval decided by an admin account for ANOTHER role does not protect (driver app, seller record)', D({ uid: 'x', roles: ['seller'], seller: { status: 'active' }, applications: [{ id: 'd', status: 'approved', decidedBy: 'admin_2', role: 'driver' }] }).state !== 'VALID_APPROVAL');
  say('\n── 9 · cleanup ownership ──');
  const shave = D({ uid: 'shave', roles: ['provider'], provider: { status: 'active', searchable: true }, applications: [] });
  ck('Shave \'n\' Trims (claimed by the cleanup manifest) → state NO_APPROVAL reported, ownership cleanup, transition WITHHELD', shave.state === 'NO_APPROVAL' && shave.ownership === 'cleanup' && shave.transition === null && shave.claimedBy.includes('providers/shave'), shave.claimedBy);
  say('\n── 5 · self-approval: derivation and BOTH real authorities, before any write ──');
  ck('decisionValidity: decidedBy === applicant → invalid (self_decision) even though the decider is an admin account', R.decisionValidity({ status: 'approved', decidedBy: 'admin_D5', role: 'seller' }, 'admin_D5', isAdmin, ['seller']).why === 'self_decision');
  await db.doc('providers/admin_D5').set({ name: 'KASS SHOP', status: 'active' });
  let r = await err(AA({ auth: ADMIN, data: { uid: 'admin_D5', decision: 'approve', reason: 'approving myself' } }));
  ck('bizAdminApprovalDecide: an admin deciding their OWN provider record → permission-denied SELF_DECISION, nothing written', !r.ok && r.code === 'permission-denied' && r.details.code === 'SELF_DECISION' && (await get('providers/admin_D5')).approvalDecision === undefined && db._dump('adminAudit/').length === 0, r.code);
  await db.doc('applications/SELF1').set({ uid: 'admin_D5', status: 'pending', role: 'seller', agreementAccepted: true, agreementVersion: V, agreementAcceptedAt: new Date().toISOString() });
  r = await err(decide({ applicationId: 'SELF1', decision: 'approve', reason: 'approving my own application' }));
  ck('applicationDecide: an admin deciding their OWN application → permission-denied SELF_DECISION; application, decision record, audit untouched', !r.ok && r.code === 'permission-denied' && r.details.code === 'SELF_DECISION' && (await get('applications/SELF1')).decidedBy === undefined && (await get('applicationDecisions/SELF1')) === null && db._dump('adminAudit/').length === 0, r.code);

  say('\n── 6–8, 10–14 · the transition, end to end, on DJ Bvmbxno (fixture application = what the surface would submit) ──');
  await db.doc('providers/dj').set({ name: 'DJ Bvmbxno', status: 'active', category: 'Entertainment Performer', searchable: true, isPublic: true, acceptsBookings: true });
  await db.doc('users/dj').set({ roles: ['provider', 'buyer'] }); await db.doc('wallets/dj').set({ balance: 1500 });
  for (let i = 1; i <= 3; i++) await db.doc('walletTransactions/w' + i).set({ uid: 'dj', amount: 500 });
  for (let i = 1; i <= 4; i++) await db.doc('providerBookings/b' + i).set({ providerId: 'dj', status: 'confirmed' });
  await db.doc('providerServices/s1').set({ providerId: 'dj', name: 'Club set' }); await db.doc('products/p1').set({ sellerUid: 'other' });
  const frozen = () => J({ w: db._dump('wallets/'), t: db._dump('walletTransactions/'), b: db._dump('providerBookings/'), s: db._dump('providerServices/'), p: db._dump('products/') });
  const before = frozen();
  /* the surface submits a fresh application through the existing schema: pending, applicant uid, current agreement version */
  const submitted = { applicationId: 'DJAPP', uid: 'dj', name: 'DJ Bvmbxno', type: 'Mobile disco & sound hire', hub: 'entertainment', category: 'Entertainment Performer', role: 'provider', status: 'pending', statusCanonical: 'pending', agreementAccepted: true, agreementVersion: V, agreementAcceptedAt: new Date().toISOString(), phone: '+254700000009', intakeVersion: 3 };
  await db.doc('applications/DJAPP').set(submitted);
  const s6 = D({ uid: 'dj', roles: ['provider', 'buyer'], provider: await get('providers/dj'), applications: [Object.assign({ id: 'DJAPP' }, submitted)] });
  ck('7 · with a pending acknowledged application: agreement.required true, satisfied true (current version); path continue_existing DJAPP', s6.agreement.required && s6.agreement.satisfied && s6.agreement.on === 'DJAPP' && s6.applicationPath.mode === 'continue_existing');
  ck('7 · an OLD agreement version does not satisfy', D({ uid: 'dj', roles: ['provider'], provider: { status: 'active' }, applications: [{ id: 'A', status: 'pending', role: 'provider', agreementAccepted: true, agreementVersion: '2026-05-old' }] }).agreement.satisfied === false);
  r = await err(decide({ applicationId: 'DJAPP', decision: 'approve', reason: 'Fresh decision after reapplication' }));
  ck('10 · the REAL c4 applicationDecide approves: ok, projected; server record + audit name admin_D5', r.ok && (await get('applicationDecisions/DJAPP')).decidedBy === 'admin_D5' && db._dump('adminAudit/').some((a) => a.action === 'application_approve' && a.performedBy === 'admin_D5'), r);
  const pd = await get('providers/dj');
  ck('11 · projection: provider live by evidence (approvedAt server ts, status active, sourceApplicationId DJAPP)', pd.status === 'active' && pd.approvedAt !== undefined && pd.sourceApplicationId === 'DJAPP');
  const post = D({ uid: 'dj', roles: ['provider', 'buyer'], provider: pd, applications: [Object.assign({ id: 'DJAPP' }, await get('applications/DJAPP'))] });
  ck('11 · derived state now VALID_APPROVAL, protected, transition gone', post.state === 'VALID_APPROVAL' && post.protected && post.transition === null);
  ck('13 · approval did NOT classify: C1 finds no exact match for the application text → business.category null; resolver → PENDING_CLASSIFICATION, no route', (pd.business == null || pd.business.category == null) && (await BW.workspaceFor(db, 'dj')).state === 'PENDING_CLASSIFICATION', pd.business);
  ck('13 · authority separation: had the application said "DJ", the stamp would come from C1 derivation (source application, exact), never from the admin approve decision', require(Path.join(FN, 'business-category.js')).categoryFromApplication({ type: 'DJ', hub: 'entertainment' }, 'provider').reason === 'exact');
  ck('14 · wallet, transactions, bookings, services, products byte-identical', frozen() === before);
  ck('8 · first decision on the fresh application preserved nothing (no prior decision existed)', (await get('applications/DJAPP')).priorDecisions === undefined);
  r = await err(decide({ applicationId: 'DJAPP', decision: 'approve', reason: 'repeat' }));
  const a2 = await get('applications/DJAPP');
  ck('12 · repeat approve: priorDecisions gets the FIRST admin decision once; provider still active; wallet untouched', r.ok && a2.priorDecisions.length === 1 && a2.priorDecisions[0].decidedBy === 'admin_D5' && frozen() === before);
  r = await err(decide({ applicationId: 'DJAPP', decision: 'suspend', reason: 'later lifecycle change' }));
  const a3 = await get('applications/DJAPP'); const pd3 = await get('providers/dj');
  ck('12 · suspend after approve is a lifecycle change (applicationDecide), the approval preserved in priorDecisions[1]; provider suspended + delisted; wallet untouched', r.ok && a3.priorDecisions.length === 2 && a3.priorDecisions[1].status === 'approved' && pd3.status === 'suspended' && pd3.searchable === false && frozen() === before, a3.priorDecisions.map((e) => e.status));
  say('\n── 12 · the admin approval authority: conflicting decision refuses ──');
  await db.doc('providers/kb').set({ name: 'King Bruce', status: 'active' });
  r = await err(AA({ auth: ADMIN, data: { uid: 'kb', decision: 'refuse', reason: 'no evidence, dormant' } }));
  r = await err(AA({ auth: ADMIN, data: { uid: 'kb', decision: 'approve', reason: 'changed my mind' } }));
  ck('approve after refuse → failed-precondition DECISION_EXISTS (history kept; a reversal is a separate authority)', !r.ok && r.details && r.details.code === 'DECISION_EXISTS');
  say('\n── 8/11 · Langa\'ta mamafua: re-decision preserves the label decider AND keeps the cleaning stamp ──');
  await db.doc('providers/lang').set({ name: "Langa'ta mamafua", status: 'active', approvedAt: '2026-08-01T06:14:23.000Z', sourceApplicationId: 'e0cO', business: { category: 'cleaning', source: 'application', lane: { hub: 'provider', entClass: null } } });
  await db.doc('applications/e0cO').set({ applicationId: 'e0cO', uid: 'lang', name: "Langa'ta mamafua", type: 'business', role: 'provider', hub: 'service', category: 'Service Provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'founder-decision-2026-08-01', decidedAt: '2026-08-01T06:14:20.000Z', decisionAppliedFor: 'approved', projectionStatus: 'applied', phone: '+254700000010', intakeVersion: 3 });
  r = await err(decide({ applicationId: 'e0cO', decision: 'approve', reason: 'fresh decision' }));
  ck('without acknowledgement the fresh decision is REFUSED by the agreement gate (application byte-identical, decider still the label)', !r.ok && r.code === 'failed-precondition' && (await get('applications/e0cO')).decidedBy === 'founder-decision-2026-08-01');
  await db.doc('applications/e0cO').set({ agreementAccepted: true, agreementVersion: V, agreementAcceptedAt: new Date().toISOString(), agreementAcknowledgedSurface: 'agreement-acknowledge' }, { merge: true });
  r = await err(decide({ applicationId: 'e0cO', decision: 'approve', reason: 'Fresh legitimate decision; the 2026-08-01 founder label is preserved as history' }));
  const la = await get('applications/e0cO'); const lp = await get('providers/lang');
  ck('after acknowledgement: approved by admin_D5; priorDecisions[0] = { approved, decidedBy "founder-decision-2026-08-01" } verbatim', r.ok && la.decidedBy === 'admin_D5' && la.priorDecisions.length === 1 && la.priorDecisions[0].decidedBy === 'founder-decision-2026-08-01' && la.priorDecisions[0].status === 'approved', la.priorDecisions);
  ck('the cleaning category stamp SURVIVES re-approval although C1 cannot derive it from type "business" (an existing stamp is never nulled by a failed derivation)', lp.business && lp.business.category === 'cleaning' && lp.business.source === 'application', lp.business);
  ck('derived state now VALID_APPROVAL; resolver AVAILABLE on provider-dashboard', D({ uid: 'lang', roles: ['provider'], provider: lp, applications: [Object.assign({ id: 'e0cO' }, la)] }).state === 'VALID_APPROVAL' && (await BW.workspaceFor(db, 'lang')).state === 'AVAILABLE');
  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
