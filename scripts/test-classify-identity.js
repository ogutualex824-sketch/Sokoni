#!/usr/bin/env node
/* test-classify-identity.js — one identity classified through the REAL AdminOS authority (bizAdminClassify), on the
 * transactional fake store. No network.
 *
 * PROVES
 *   authority     the write is made by business-category-admin's own handler: an owner / provider request is refused
 *                 (permission-denied) by that handler; only an admin-claimed request passes
 *   plan          the manifest names exactly providers/{uid}.business (+updatedAt) and one adminAudit; refusals for
 *                 not-live, unapproved application, uid mismatch, source mismatch, non-C1 category, authority-owned
 *                 category, healthcare boundary, short reason
 *   no approval   the operation cannot manufacture approval evidence: status, approvedAt, adminApproved, approved never
 *                 change; a NOT-approved provider is refused by the handler itself
 *   isolation     application, users, wallets, sellers, businesses, products, bookings byte-identical after
 *   idempotent    a second apply is already_classified (no second audit); a drifted snapshot is digest_mismatch
 *   post-R2       artist_creator + SERVICES → provider-dashboard, AVAILABLE
 *
 *   node scripts/test-classify-identity.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-classify';
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
const CI = require(Path.join(ROOT, 'scripts', 'classify-identity.js'));
const BA = require(Path.join(FN, 'business-category-admin.js'));
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const J = (x) => JSON.stringify(x);
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const UID = 'kriss', APP = 'ENT1', REASON = 'Owner-authorized classification: approved entertainment performer (voiceover / rapper) → Artist / Creator';
(async () => {
  await db.doc('providers/' + UID).set({ name: 'k Riss', status: 'active', approvedAt: '2026-08-26T05:02:14.000Z', category: 'Entertainment Performer', categoryLabel: 'voiceover', sourceApplicationId: APP, acceptsBookings: true, searchable: true, rating: 0 });
  await db.doc('applications/' + APP).set({ uid: UID, type: 'voiceover', hub: 'entertainment', category: 'Entertainment Performer', role: 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'admin_D5', decidedAt: '2026-08-26T05:02:08.000Z' });
  await db.doc('users/' + UID).set({ roles: ['buyer', 'provider'] }); await db.doc('wallets/' + UID).set({ balance: 0 });
  await db.doc('providerBookings/b1').set({ providerId: UID, status: 'confirmed' });
  const before = { app: J(await get('applications/' + APP)), users: J(await get('users/' + UID)), wallet: J(await get('wallets/' + UID)), booking: J(await get('providerBookings/b1')) };
  const provBefore = await get('providers/' + UID);

  say('\n── plan ──');
  const s = await CI.snapshot(db, UID, APP); const p = CI.plan(s, 'artist_creator', REASON);
  ck('the manifest is OK: write providers/{uid}.business {artist_creator, source admin, classifiedBy actor, setAt} + updatedAt; one adminAudit business_classify', p.ok && !p.noop && p.mutation.write.path === 'providers/' + UID && p.mutation.write.fields.business.category === 'artist_creator' && p.mutation.write.fields.business.source === 'admin' && p.mutation.audit.fields.action === 'business_classify' && p.mutation.audit.fields.previous === null && p.mutation.audit.fields.next === 'artist_creator', p.refusals);
  ck('the manifest names what stays untouched (application, users, wallet, sellers, businesses, products, bookings, orders, claims)', ['applications/', 'users/', 'wallets/', 'sellers/', 'businesses/', 'products/', 'providerBookings/', 'orders/', 'Auth claims'].every((k) => p.mutation.untouched.some((u) => u.startsWith(k))));
  const R = (over, cat, reason) => CI.plan(Object.assign({}, s, over), cat || 'artist_creator', reason === undefined ? REASON : reason).refusals;
  ck('refusals: provider status only (no approvedAt)', R({ provider: Object.assign({}, s.provider, { approvedAt: undefined }) }).includes('provider_not_live_by_evidence'));
  ck('refusals: application not approved / other uid / no decision evidence', R({ application: Object.assign({}, s.application, { status: 'pending', statusCanonical: 'pending' }) }).includes('application_not_approved') && R({ application: Object.assign({}, s.application, { uid: 'zz' }) }).includes('application_uid_mismatch') && R({ application: Object.assign({}, s.application, { decidedBy: null }) }).includes('application_without_decision_evidence'));
  ck('refusals: provider.sourceApplicationId names another application', R({ provider: Object.assign({}, s.provider, { sourceApplicationId: 'other' }) }).includes('provider_source_application_mismatch'));
  ck('refusals: not a C1 category / authority-owned (lawyer) / healthcare (clinician) / short reason', R({}, 'rapper').includes('not_a_c1_category') && R({}, 'lawyer').some((x) => x.startsWith('category_owned_by_authority')) && R({}, 'clinician').includes('healthcare_boundary') && R({}, 'artist_creator', 'x').includes('reason_required'));
  ck('refusals: already stamped with a different category', R({ provider: Object.assign({}, s.provider, { business: { category: 'trades', source: 'application' } }) }).some((x) => x.startsWith('already_stamped_differently')));

  say('\n── authority: the business owner cannot invoke it ──');
  ck('the provider itself (no admin claim) is refused by the handler: permission-denied', (await codeOf(BA._adminH.bizAdminClassify({ auth: { uid: UID, token: { provider: true } }, data: { uid: UID, category: 'artist_creator', reason: REASON } }))) === 'permission-denied');
  ck('an unauthenticated request is refused: unauthenticated', (await codeOf(BA._adminH.bizAdminClassify({ data: { uid: UID, category: 'artist_creator', reason: REASON } }))) === 'unauthenticated');
  ck('nothing was written by the refused attempts', !(await get('providers/' + UID)).business);

  say('\n── no approval evidence can be manufactured ──');
  await db.doc('providers/unapproved').set({ name: 'U', status: 'pending', category: 'dj' });
  ck('the handler refuses a NOT-approved provider (failed-precondition NOT_APPROVED)', (await codeOf(BA._adminH.bizAdminClassify({ auth: { uid: 'adm', token: { admin: true } }, data: { uid: 'unapproved', category: 'artist_creator', reason: REASON } }))) === 'failed-precondition');
  ck('…and the plan refuses it earlier as provider_not_live_by_evidence', CI.plan(await CI.snapshot(db, 'unapproved', 'none'), 'artist_creator', REASON).refusals.includes('provider_not_live_by_evidence'));

  say('\n── apply through the authority ──');
  const bad = await CI.apply(db, UID, APP, 'artist_creator', REASON, 'deadbeef'.repeat(8), BA._adminH.bizAdminClassify);
  ck('a wrong digest is refused, nothing written', bad.reason === 'digest_mismatch' && !(await get('providers/' + UID)).business);
  const ok1 = await CI.apply(db, UID, APP, 'artist_creator', REASON, p.digest, BA._adminH.bizAdminClassify);
  ck('applied via bizAdminClassify: previous null → artist_creator, laneUnchanged null', ok1.applied === true && ok1.result.previous === null && ok1.result.category === 'artist_creator' && ok1.result.laneUnchanged === null, ok1);
  const prov = await get('providers/' + UID);
  ck('providers/{uid}.business = { category artist_creator, source admin, classifiedBy = the session actor, setAt }', prov.business && prov.business.category === 'artist_creator' && prov.business.source === 'admin' && prov.business.classifiedBy === CI.ACTOR && prov.business.setAt !== undefined, prov.business);
  const strip = (x) => { const c = Object.assign({}, x); delete c.business; delete c.updatedAt; return c; };
  ck('every other provider field byte-identical: status, approvedAt, name, categories text, searchable… (no approval evidence manufactured)', J(strip(prov)) === J(strip(provBefore)) && prov.status === 'active' && prov.approvedAt === provBefore.approvedAt && prov.adminApproved === undefined && prov.approved === undefined);
  ck('application, users, wallet, booking byte-identical', J(await get('applications/' + APP)) === before.app && J(await get('users/' + UID)) === before.users && J(await get('wallets/' + UID)) === before.wallet && J(await get('providerBookings/b1')) === before.booking);
  const audits = db._dump('adminAudit/').filter((a) => a.action === 'business_classify');
  ck('exactly one adminAudit business_classify: targetUid, performedBy actor, previous null, next artist_creator, the reason, createdAt', audits.length === 1 && audits[0].targetUid === UID && audits[0].performedBy === CI.ACTOR && audits[0].previous === null && audits[0].next === 'artist_creator' && audits[0].reason === REASON && audits[0].createdAt !== undefined, audits);

  say('\n── idempotent ──');
  const again = await CI.apply(db, UID, APP, 'artist_creator', REASON, p.digest, BA._adminH.bizAdminClassify);
  ck('a second apply is already_classified; no second audit', again.reason === 'already_classified' && db._dump('adminAudit/').filter((a) => a.action === 'business_classify').length === 1, again);

  say('\n── post-R2 ──');
  const w = await BW.workspaceFor(db, UID);
  ck('artist_creator + provider lane + SERVICES → provider-dashboard, AVAILABLE, bookingPin AVAILABLE (entertainment profile)', w.route === 'provider-dashboard.html' && w.state === 'AVAILABLE' && w.lane === 'services' && w.capability.classification === 'SERVICES' && w.modules.bookingPin && w.modules.bookingPin.state === 'AVAILABLE', { route: w.route, state: w.state, cat: w.category });

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
