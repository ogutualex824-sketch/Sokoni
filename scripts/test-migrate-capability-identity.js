#!/usr/bin/env node
/* test-migrate-capability-identity.js — the C4 migration contract on the transactional fake store. No network.
 *
 * PROVES
 *   plan      the C3 shape (provider live, seller absent, no business/shop, approved provider application, 0 products)
 *             yields exactly TWO writes — businesses/{uid} with a SERVICES stamp whose evidence is the ORIGINAL approval,
 *             and one adminAudit — and names what stays untouched; PRODUCTS is never stamped; discovery flags stay false
 *   refuses   seller present · shop present · another business owned · provider not live (status only) · application
 *             not approved / wrong uid / wrong role · products present · business exists and differs → no plan
 *   apply     writes exactly the manifest; provider, application, users, wallet byte-identical after; a second apply is
 *             a no-op (already_migrated); a wrong digest is refused with no write; drift between plan and transaction
 *             (a seller appears) aborts with no write
 *   after     the read model reads the migrated identity as SERVICES / STAMPED / no conflicts, and the workspace
 *             authority routes it exactly as before (provider path) — the stamp changed authority, not behaviour
 *   others    an unrelated identity is byte-identical after the migration
 *
 *   node scripts/test-migrate-capability-identity.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-c4';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..'); const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue }), auth: () => ({}) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const M = require(Path.join(ROOT, 'scripts', 'migrate-capability-identity.js'));
const CAPS = require(Path.join(FN, 'shared', 'business-capabilities.js'));
const BW = require(Path.join(FN, 'business-workspace.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const J = (x) => JSON.stringify(x);
const UID = 'dg1', APP = 'app_dg1';
const PROVIDER = { name: 'DG wines and spirits', status: 'active', approvedAt: '2026-09-03T22:55:03.000Z', category: 'wholesaler', categoryLabel: 'Wholesaler / Bulk Supplier', sourceApplicationId: APP, city: 'Nairobi', phone: '07***', email: 'st@x', description: 'Door to door.' };
const APPLICATION = { uid: UID, applicationId: APP, name: 'DG wines and spirits', role: 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'admin_D5', decidedAt: '2026-09-03T22:55:02.000Z', category: 'wholesaler', location: 'Nairobi Kasarani', phoneNumber: '+254***' };

(async () => {
  await db.doc('providers/' + UID).set(PROVIDER);
  await db.doc('applications/' + APP).set(APPLICATION);
  await db.doc('users/' + UID).set({ roles: ['buyer', 'provider'] });
  await db.doc('wallets/' + UID).set({ balance: 0 });
  /* an unrelated identity */
  await db.doc('providers/other').set({ name: 'Other', status: 'active', approvedAt: 1, sourceApplicationId: 'app_o' });
  await db.doc('sellers/other').set({ status: 'active', active: true, approvedAt: 1 });
  const before = { prov: J(await get('providers/' + UID)), app: J(await get('applications/' + APP)), users: J(await get('users/' + UID)), wallet: J(await get('wallets/' + UID)), otherP: J(await get('providers/other')), otherS: J(await get('sellers/other')) };

  say('\n── plan ──');
  const s = await M.snapshot(db, UID, APP);
  const p = M.plan(s);
  ck('the C3 shape plans OK: exactly two writes (businesses/{uid}, adminAudit), no refusals', p.ok && !p.noop && p.refusals.length === 0 && p.manifest.length === 2 && p.manifest[0].path === 'businesses/' + UID && /^adminAudit/.test(p.manifest[1].path), { refusals: p.refusals, paths: p.manifest.map((m) => m.path) });
  const biz = p.manifest[0].data;
  ck('the business identity: same owner uid, id = uid, name from the provider, source names the migration, application linked', biz.uid === UID && biz.ownerId === UID && biz.name === 'DG wines and spirits' && biz.source === 'capability_migration_c4' && biz.applicationId === APP);
  ck('the stamp: SERVICES approved with the ORIGINAL approval as evidence (decidedBy/decidedAt/applicationId, source application_approval); PRODUCTS absent', biz.capabilities.version === 1 && biz.capabilities.SERVICES.state === 'approved' && biz.capabilities.SERVICES.decidedBy === 'admin_D5' && biz.capabilities.SERVICES.decidedAt === APPLICATION.decidedAt && biz.capabilities.SERVICES.source === 'application_approval' && biz.capabilities.PRODUCTS === undefined && CAPS.validateStamp(biz.capabilities).ok, biz.capabilities);
  ck('discovery flags are NOT granted by a migration (searchable/isPublic false); no shopId; no branch', biz.searchable === false && biz.isPublic === false && biz.shopId === undefined && biz.defaultBranchId === undefined);
  ck('the plan names what stays untouched (provider, application, users, wallet; no shop, branch or product created)', p.untouched.some((u) => u.startsWith('providers/')) && p.untouched.some((u) => /shops/.test(u)) && p.untouched.some((u) => /branches/.test(u)) && p.untouched.some((u) => /products/.test(u)));
  ck('the plan carries the read model: SERVICES / NOT_YET_STAMPED / no conflicts, and a digest', p.readModel.classification === 'SERVICES' && p.readModel.authorityStatus === 'NOT_YET_STAMPED' && p.readModel.conflicts.length === 0 && /^[a-f0-9]{64}$/.test(p.digest));

  say('\n── refusals (pure) ──');
  const R = (patch) => M.plan(Object.assign({}, s, patch)).refusals;
  ck('seller present → refused', R({ seller: { status: 'active', approvedAt: 1 } }).includes('seller_present'));
  ck('shop present (by id or by owner) → refused', R({ shopById: { name: 'x' } }).includes('shop_present') && R({ shopsByOwner: ['S1'] }).includes('shop_present'));
  ck('another business owned → refused', R({ businessesByOwner: ['SOK-XYZ'] }).some((r) => r.startsWith('other_business_owned')));
  ck('provider live by status alone (no approvedAt) → refused', R({ provider: Object.assign({}, PROVIDER, { approvedAt: undefined }) }).some((r) => r.startsWith('provider_not_live')));
  ck('provider absent → refused', R({ provider: null }).includes('provider_absent'));
  ck('application not approved / other uid / seller role / no decider → each refused', R({ application: Object.assign({}, APPLICATION, { status: 'pending', statusCanonical: 'pending' }) }).includes('application_not_approved') && R({ application: Object.assign({}, APPLICATION, { uid: 'zz' }) }).includes('application_uid_mismatch') && R({ application: Object.assign({}, APPLICATION, { role: 'seller' }) }).some((r) => r.startsWith('application_role_not_services')) && R({ application: Object.assign({}, APPLICATION, { decidedBy: null }) }).includes('application_without_decider'));
  ck('products present → refused (never PRODUCTS, never a product invented)', R({ productCount: 3 }).some((r) => r.startsWith('products_present')));
  ck('a business that exists and differs → refused', R({ businessById: { ownerId: UID, source: 'onboarding-v2' } }).includes('business_exists_and_differs'));
  ck('provider whose sourceApplicationId names a different application → refused', R({ provider: Object.assign({}, PROVIDER, { sourceApplicationId: 'other_app' }) }).includes('provider_source_application_mismatch'));

  say('\n── apply ──');
  const bad = await M.apply(db, s, 'deadbeef', F.FieldValue);
  ck('a wrong --expect-digest is refused with NO write', bad.applied === false && bad.reason === 'digest_mismatch' && (await get('businesses/' + UID)) === null);
  /* drift: a seller appears between plan and transaction */
  await db.doc('sellers/' + UID).set({ status: 'active', approvedAt: 1 });
  const drift = await M.apply(db, s, p.digest, F.FieldValue);
  ck('drift (a seller appeared after the plan) → transaction aborts, NO write', drift.applied === false && drift.reason === 'drift_abort' && drift.refusals.includes('seller_present') && (await get('businesses/' + UID)) === null, drift);
  await db.doc('sellers/' + UID).delete();
  const ok1 = await M.apply(db, s, p.digest, F.FieldValue);
  ck('the real apply: applied, businessId = uid, audit id returned, digest matches the plan', ok1.applied === true && ok1.businessId === UID && !!ok1.auditId && ok1.digest === p.digest, ok1);
  const written = await get('businesses/' + UID);
  ck('businesses/{uid} equals the manifest (+ timestamps)', !!written && written.ownerId === UID && J(written.capabilities) === J(biz.capabilities) && written.source === 'capability_migration_c4' && written.createdAt !== undefined);
  const audit = await get('adminAudit/' + ok1.auditId);
  ck('one adminAudit record names the action, the target, the capability and the evidence', !!audit && audit.action === 'capability_migration_c4' && audit.targetUid === UID && audit.capability === 'SERVICES' && /admin_D5/.test(audit.reason));
  ck('provider, application, users doc and wallet are byte-identical after', J(await get('providers/' + UID)) === before.prov && J(await get('applications/' + APP)) === before.app && J(await get('users/' + UID)) === before.users && J(await get('wallets/' + UID)) === before.wallet);
  ck('no shop, no branch, no seller, no product was created', (await get('shops/' + UID)) === null && (await get('sellers/' + UID)) === null && (await db.collection('branches').where('merchantId', '==', UID).get()).size === 0 && (await db.collection('products').where('sellerUid', '==', UID).get()).size === 0);
  const again = await M.apply(db, await M.snapshot(db, UID, APP), undefined, F.FieldValue);
  ck('a second apply is a no-op (already_migrated), nothing written twice', again.applied === false && again.reason === 'already_migrated' && (await db.collection('adminAudit').get()).size === 1);

  say('\n── after ──');
  const rm = CAPS.readModel({ seller: null, provider: await get('providers/' + UID), business: await get('businesses/' + UID), applications: [await get('applications/' + APP)], productCount: 0 });
  ck('the read model now reads SERVICES / STAMPED / no conflicts', rm.classification === 'SERVICES' && rm.authorityStatus === 'STAMPED' && rm.conflicts.length === 0, rm.conflicts);
  const w = await BW.workspaceFor(db, UID);
  ck('the workspace authority: SERVICES, STAMPED, route unchanged by the stamp (provider path — LEGACY_UNCLASSIFIED until the category authority stamps)', w.capability.classification === 'SERVICES' && w.capability.authorityStatus === 'STAMPED' && w.route === 'provider-dashboard.html' && w.servicesWorkspace === false, { route: w.route, state: w.state, cap: w.capability });
  ck('the unrelated identity is byte-identical', J(await get('providers/other')) === before.otherP && J(await get('sellers/other')) === before.otherS);

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
