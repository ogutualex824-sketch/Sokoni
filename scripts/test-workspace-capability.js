#!/usr/bin/env node
/* test-workspace-capability.js — the workspace authority CONSUMES the capability read model (capability slice 1).
 * Transactional fake Firestore + the REAL functions/business-workspace.js and functions/shared/business-capabilities.js.
 * No network. Nothing here or in the module under test writes a capability.
 *
 * PROVES (the owner's seven, 2026-09-29)
 *   1 existing category routing still works      an approved (approvedAt) provider in `trades` → provider-dashboard with
 *                                                 the same modules; `retail_store` → merchant-v2; healthcare rows unchanged
 *   2 capability-aware routing works              a live seller with no provider → merchant-v2 (PRODUCTS) — before this
 *                                                 slice: "no approved business"; seller + provider live → merchant-v2 WITH
 *                                                 the Services workspace (PRODUCTS_AND_SERVICES), category kept
 *   3 UNCLASSIFIED refuses routing                a seller present-not-live and no provider → no route, home says apply
 *   4 CONFLICT refuses routing                    a provider with status active and NO approvedAt → CAPABILITY_CONFLICT,
 *                                                 route null, the conflict named; the module gate refuses too
 *   5 unstamped ≠ silently a provider/merchant    every answer carries authorityStatus; NOT_YET_STAMPED never routes by
 *                                                 itself — the registry evidence does, and its absence routes nowhere
 *   6 no capability writes                        the fake store's write log holds no `capabilities` field and no write
 *                                                 to businesses/sellers/providers from the authority
 *   7 unrelated behaviour                         the pre-existing suites are run by the slice's runner (see CHANGELOG)
 *   stamps                                        a VALID stamp is honoured (STAMPED); one that disagrees with the registry
 *                                                 → CONFLICT; a client-shaped stamp → CONFLICT
 *   unreadable ≠ unclassified                     a failing capability read → readable:false and the category path answers
 *
 *   node scripts/test-workspace-capability.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-workspace-capability';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub); AF.autoApproveOnWrite(db); /* shell gate: approvedAt fixtures carry their admin decision */
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const BW = require(Path.join(FN, 'business-workspace.js'));
const CAPS = require(Path.join(FN, 'shared', 'business-capabilities.js'));
const S = BW.STATE;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const HE = class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const APPROVED = { status: 'active', approvedAt: 1 };
const stamp = (p, s) => ({ version: 1,
  PRODUCTS: p ? { state: p, decidedBy: 'admin_1', decidedAt: 1, applicationId: 'a1', source: 'application_approval' } : undefined,
  SERVICES: s ? { state: s, decidedBy: 'admin_1', decidedAt: 1, applicationId: 'a2', source: 'application_approval' } : undefined });

/* a write log on the fake store: every set/update on the three registries and businesses is recorded */
const writes = [];
for (const m of ['set', 'update']) {
  const proto = Object.getPrototypeOf(db.doc('x/y'));
  const orig = proto[m];
  if (typeof orig === 'function') proto[m] = function (...a) { writes.push({ m, path: this.path || String(this._path || ''), data: a[0] }); return orig.apply(this, a); };
}

(async () => {
  say('\n── 1 · existing category routing still works ──');
  await db.doc('providers/plumber').set(Object.assign({ name: 'Plumb Co' }, APPROVED, biz('trades')));
  await db.doc('providers/shop1').set(Object.assign({ name: 'Duka' }, APPROVED, biz('retail_store')));
  await db.doc('providers/doc1').set(Object.assign({ name: 'Dr One' }, APPROVED, { healthcare: { category: 'clinician', source: 'admin' }, business: { category: 'clinician', source: 'admin', lane: { hub: 'healthcare', entClass: null } } }));
  const w1 = await BW.workspaceFor(db, 'plumber');
  ck('an approved trades provider → provider-dashboard, quotes AVAILABLE, POS NOT_APPLICABLE (as before)', w1.route === 'provider-dashboard.html' && w1.state === S.AVAILABLE && w1.modules.quotes.state === S.AVAILABLE && w1.modules.pos.state === S.NOT_APPLICABLE, { route: w1.route, q: w1.modules.quotes, pos: w1.modules.pos });
  ck('   …and now carries its capability: SERVICES, NOT_YET_STAMPED, no conflicts, servicesWorkspace false', w1.capability.classification === 'SERVICES' && w1.capability.authorityStatus === 'NOT_YET_STAMPED' && w1.capability.conflicts.length === 0 && w1.servicesWorkspace === false, w1.capability);
  const w1b = await BW.workspaceFor(db, 'shop1');
  ck('R2: a PROVIDER-ONLY record with a retail_store (products-lane) category and capability SERVICES → CONFLICT (category/capability disagreement), NO route — not merchant-v2, not provider-dashboard',
     w1b.route === null && w1b.state === 'CAPABILITY_CONFLICT' && w1b.reason === 'CATEGORY_CAPABILITY_DISAGREEMENT' && w1b.lane === 'products' && w1b.capability.classification === 'SERVICES', { route: w1b.route, state: w1b.state, lane: w1b.lane, cap: w1b.capability.classification });
  await db.doc('sellers/shopx').set({ status: 'active', active: true, approvedAt: 1 });
  await db.doc('businesses/shopx').set({ uid: 'shopx', ownerId: 'shopx', business: { category: 'retail_store', source: 'application' } });
  const w1s = await BW.workspaceFor(db, 'shopx');
  ck('R2: the PRODUCER shape of a shop (live seller + businesses.business retail_store from approval, no provider) → merchant-v2, PRODUCTS, AVAILABLE',
     w1s.route === 'merchant-v2.html' && w1s.state === S.AVAILABLE && w1s.capability.classification === 'PRODUCTS' && w1s.category === 'retail_store' && w1s.lane === 'products', { route: w1s.route, cap: w1s.capability.classification, cat: w1s.category });
  const w1c = await BW.workspaceFor(db, 'doc1');
  ck('healthcare rows unchanged: clinician → provider-dashboard, AVAILABLE, POS NOT_APPLICABLE, capability SERVICES with no conflict', w1c.route === 'provider-dashboard.html' && w1c.state === S.AVAILABLE && w1c.modules.pos.state === S.NOT_APPLICABLE && w1c.capability.classification === 'SERVICES' && w1c.capability.conflicts.length === 0, { state: w1c.state, pos: w1c.modules.pos, cap: w1c.capability.classification });

  say('\n── 2 · capability-aware routing ──');
  await db.doc('sellers/seller1').set({ status: 'active', active: true, approvedAt: 1, name: 'Mama Mboga' });
  const w2u = await BW.workspaceFor(db, 'seller1');
  ck('R2: a live seller with NO category anywhere → PENDING_CLASSIFICATION, no route (capability alone never routes)', w2u.route === null && w2u.state === 'PENDING_CLASSIFICATION' && w2u.capability.classification === 'PRODUCTS' && w2u.category === null, { route: w2u.route, state: w2u.state });
  await db.doc('businesses/seller1').set({ uid: 'seller1', ownerId: 'seller1', business: { category: 'supermarket', source: 'application' } });
  const w2 = await BW.workspaceFor(db, 'seller1');
  ck('a live seller with a products-lane category (supermarket) and NO provider → merchant-v2, AVAILABLE, PRODUCTS', w2.found === true && w2.route === 'merchant-v2.html' && w2.state === S.AVAILABLE && w2.capability.classification === 'PRODUCTS' && w2.servicesWorkspace === false, { route: w2.route, cap: w2.capability.classification });
  ck('   modules are OWN_WORKSPACE (merchant-v2 decides its own)', Object.values(w2.modules).every((m) => m.state === S.NOT_APPLICABLE && m.reason === 'OWN_WORKSPACE'));
  await db.doc('sellers/salon1').set({ status: 'active', active: true, approvedAt: 1 });
  await db.doc('providers/salon1').set(Object.assign({ name: 'Cuts & Co' }, APPROVED, biz('salon')));
  const w2b = await BW.workspaceFor(db, 'salon1');
  ck('seller + provider live (salon) → ONE business: merchant-v2 WITH the Services workspace, category kept, service modules kept',
     w2b.route === 'merchant-v2.html' && w2b.servicesWorkspace === true && w2b.capability.classification === 'PRODUCTS_AND_SERVICES' && w2b.category === 'salon' && w2b.modules.services && w2b.modules.services.state === S.AVAILABLE, { route: w2b.route, sw: w2b.servicesWorkspace, cat: w2b.category, cap: w2b.capability.classification });
  ck('   CONTROL: the same salon WITHOUT the seller record routes to provider-dashboard (SERVICES only)', (await (async () => { await db.doc('providers/salon2').set(Object.assign({ name: 'Cuts Only' }, APPROVED, biz('salon'))); const w = await BW.workspaceFor(db, 'salon2'); return w.route === 'provider-dashboard.html' && w.servicesWorkspace === false && w.capability.classification === 'SERVICES'; })()));
  const h2 = await BW.homeFor(db, 'salon1', {});
  ck('home: the double business is ONE home, merchant-v2, servicesWorkspace true, capability PRODUCTS_AND_SERVICES', h2.homes.length === 1 && h2.primary.route === 'merchant-v2.html' && h2.homes[0].servicesWorkspace === true && h2.homes[0].capability === 'PRODUCTS_AND_SERVICES', h2.homes);

  say('\n── 3 · UNCLASSIFIED refuses routing ──');
  await db.doc('sellers/pending1').set({ status: 'pending' });
  const w3 = await BW.workspaceFor(db, 'pending1');
  const h3 = await BW.homeFor(db, 'pending1', {});
  ck('seller present-not-live, no provider → the shell gate: REAPPLICATION_REQUIRED, the only route is the completion surface; capability UNCLASSIFIED; home points there', w3.route === 'complete-application.html' && w3.state === 'REAPPLICATION_REQUIRED' && w3.capability.classification === 'UNCLASSIFIED' && h3.primary && h3.primary.route === 'complete-application.html', { route: w3.route, cap: w3.capability.classification, apply: h3.apply });
  const w3b = await BW.workspaceFor(db, 'nobody');
  ck('an account with nothing → found:false, UNCLASSIFIED, no route', w3b.found === false && w3b.route === null && w3b.capability.classification === 'UNCLASSIFIED');

  say('\n── 4 · CONFLICT refuses routing ──');
  await db.doc('providers/forged').set(Object.assign({ name: 'Self-made', status: 'active' }, biz('trades')));   /* status, no approvedAt */
  const w4 = await BW.workspaceFor(db, 'forged');
  ck('a provider live by STATUS ALONE → the shell gate answers first: REAPPLICATION_REQUIRED, route = complete-application.html (the capability read model still names the conflict), Overview + Settings only', w4.state === 'REAPPLICATION_REQUIRED' && w4.route === 'complete-application.html' && w4.approval.state === 'NO_APPROVAL' && w4.capability.conflicts.includes('provider_status_without_approval') && w4.modules.overview.state === S.AVAILABLE && w4.modules.quotes.state === S.PENDING_APPROVAL, { state: w4.state, route: w4.route, conflicts: w4.capability.conflicts });
  ck('   the module gate refuses too (assertModule → WORKSPACE_MODULE_PENDING_APPROVAL)', (await codeOf(BW.assertModule(db, 'forged', 'quotes', HE))) === 'WORKSPACE_MODULE_PENDING_APPROVAL');
  const h4 = await BW.homeFor(db, 'forged', {});
  ck('   home: a business entry routed to the completion surface with the completion message; apply false (it is not "nothing")', h4.homes.length === 1 && h4.homes[0].route === 'complete-application.html' && /completed/.test(h4.homes[0].message) && h4.apply === false, h4.homes);
  ck('   CONTROL: a real admin decision (approvedAt + the approved application that produced it) turns the gate off and routes to provider-dashboard', (await (async () => { await db.doc('providers/forged').set({ approvedAt: 1 }, { merge: true }); const w = await BW.workspaceFor(db, 'forged'); return w.state === S.AVAILABLE && w.route === 'provider-dashboard.html' && w.capability.classification === 'SERVICES'; })()));
  await db.doc('sellers/forgedseller').set({ status: 'active', active: true });   /* client-writable status only */
  const w4b = await BW.workspaceFor(db, 'forgedseller');
  ck('a seller live by status alone → REAPPLICATION_REQUIRED (never merchant-v2); the read model still names seller_status_without_approval', w4b.state === 'REAPPLICATION_REQUIRED' && w4b.route === 'complete-application.html' && w4b.capability.conflicts.includes('seller_status_without_approval'));

  say('\n── 5 · unstamped is not silently a provider or a merchant ──');
  const all = await Promise.all(['plumber', 'seller1', 'salon1', 'pending1', 'forged', 'nobody'].map((u) => BW.workspaceFor(db, u)));
  ck('every answer carries a capability with an authority status', all.every((w) => w.capability && w.capability.readable && ['STAMPED', 'NOT_YET_STAMPED', 'INVALID_STAMP'].includes(w.capability.authorityStatus)));
  ck('no route was granted to any account whose registry evidence is absent (nobody, pending1) — NOT_YET_STAMPED alone routes nowhere', all.filter((w) => w.capability.classification === 'UNCLASSIFIED').every((w) => w.route === null || w.route === 'complete-application.html'));

  say('\n── stamps ──');
  await db.doc('businesses/plumber').set({ capabilities: stamp(undefined, 'approved') });
  const ws1 = await BW.workspaceFor(db, 'plumber');
  ck('a VALID stamp agreeing with the registry → STAMPED, same route', ws1.capability.authorityStatus === 'STAMPED' && ws1.route === 'provider-dashboard.html' && ws1.capability.conflicts.length === 0);
  await db.doc('businesses/plumber').set({ capabilities: stamp('approved', 'approved') });
  const ws2 = await BW.workspaceFor(db, 'plumber');
  ck('a stamp claiming PRODUCTS approved while no seller is live → CONFLICT stamp_disagrees_with_registry:PRODUCTS, route null', ws2.state === 'CAPABILITY_CONFLICT' && ws2.capability.conflicts.includes('stamp_disagrees_with_registry:PRODUCTS') && ws2.route === null, ws2.capability.conflicts);
  await db.doc('businesses/plumber').set({ capabilities: { version: 1, SERVICES: { state: 'approved' } } });
  const ws3 = await BW.workspaceFor(db, 'plumber');
  ck('a client-shaped stamp (no decidedBy/source) → INVALID_STAMP, CONFLICT, route null', ws3.capability.authorityStatus === 'INVALID_STAMP' && ws3.route === null);
  await db.doc('businesses/plumber').set({});
  ck('   CONTROL: removing the stamp restores NOT_YET_STAMPED and the route', (await (async () => { const w = await BW.workspaceFor(db, 'plumber'); return w.capability.authorityStatus === 'NOT_YET_STAMPED' && w.route === 'provider-dashboard.html'; })()));

  say('\n── unreadable ≠ unclassified ──');
  const brokenDb = { collection: (c) => c === 'sellers' ? { doc: () => ({ get: async () => { throw new Error('permission-denied'); } }) } : db.collection(c) };
  const wu = await BW.workspaceFor(brokenDb, 'plumber');
  ck('R2: a failing capability read → readable:false with the error, CAPABILITY_UNREADABLE, NO route (fail closed — never a route on one authority)', wu.capability.readable === false && /permission-denied/.test(wu.capability.error) && wu.route === null && ['CAPABILITY_UNREADABLE', 'APPROVAL_UNREADABLE'].includes(wu.state), { cap: wu.capability, route: wu.route, state: wu.state });

  say('\n── R2 · THE MATRIX — route = f(category lane, capability), both required ──');
  const seedProv = (uid, cat, extra) => db.doc('providers/' + uid).set(Object.assign({ name: uid }, APPROVED, cat ? biz(cat) : {}, extra || {}));
  const seedSeller = (uid, cat) => Promise.all([db.doc('sellers/' + uid).set({ status: 'active', active: true, approvedAt: 1 }), cat ? db.doc('businesses/' + uid).set({ uid, ownerId: uid, business: { category: cat, source: 'application' } }) : Promise.resolve()]);
  const M = {};
  await seedSeller('m_prod_prodcat', 'hardware');                                  /* products lane + PRODUCTS */
  await seedProv('m_svc_svccat', 'cleaning');                                       /* services lane + SERVICES */
  await seedProv('m_both_svccat', 'salon'); await seedSeller('m_both_svccat');      /* services lane + BOTH */
  await seedProv('m_both_prodcat', 'electronics'); await seedSeller('m_both_prodcat'); /* products lane + BOTH */
  await seedProv('m_svc_nocat', null);                                              /* SERVICES, no category (the seven grandfathered) */
  await seedSeller('m_prod_nocat');                                                 /* PRODUCTS, no category */
  await seedProv('m_both_nocat', null); await seedSeller('m_both_nocat');          /* BOTH, no category */
  await seedProv('m_svc_prodcat', 'wholesale');                                     /* products lane + SERVICES only (DG Wine / Latomi once stamped) */
  await seedSeller('m_prod_svccat', 'trades');                                      /* services lane + PRODUCTS only */
  await db.doc('providers/m_unc_pending').set(Object.assign({ name: 'p', status: 'pending' }, biz('cleaning'))); await db.doc('applications/m_unc_pending-app').set({ uid: 'm_unc_pending', role: 'provider', status: 'pending' }); /* UNCLASSIFIED, category present, application pending */
  await db.doc('providers/m_susp').set(Object.assign({ name: 's', status: 'suspended', approvedAt: 1 }, biz('cleaning')));
  await db.doc('providers/m_conf').set(Object.assign({ name: 'c', status: 'active' }, biz('cleaning')));  /* status only → CONFLICT */
  for (const u of ['m_prod_prodcat', 'm_svc_svccat', 'm_both_svccat', 'm_both_prodcat', 'm_svc_nocat', 'm_prod_nocat', 'm_both_nocat', 'm_svc_prodcat', 'm_prod_svccat', 'm_unc_pending', 'm_susp', 'm_conf', 'nobody']) M[u] = await BW.workspaceFor(db, u);
  const row = (u) => ({ route: M[u].route, state: M[u].state, cap: M[u].capability.classification, lane: M[u].lane, sw: M[u].servicesWorkspace });
  ck('M1  products lane (hardware) + PRODUCTS → merchant-v2', M.m_prod_prodcat.route === 'merchant-v2.html' && M.m_prod_prodcat.state === S.AVAILABLE, row('m_prod_prodcat'));
  ck('M2  services lane (cleaning) + SERVICES → provider-dashboard with its modules', M.m_svc_svccat.route === 'provider-dashboard.html' && M.m_svc_svccat.state === S.AVAILABLE && M.m_svc_svccat.modules.quotes.state === S.AVAILABLE, row('m_svc_svccat'));
  ck('M3  services lane (salon) + PRODUCTS_AND_SERVICES → merchant-v2 + Services workspace, service modules kept', M.m_both_svccat.route === 'merchant-v2.html' && M.m_both_svccat.servicesWorkspace === true && M.m_both_svccat.modules.services.state === S.AVAILABLE, row('m_both_svccat'));
  ck('M4  products lane (electronics) + PRODUCTS_AND_SERVICES → merchant-v2 + Services workspace', M.m_both_prodcat.route === 'merchant-v2.html' && M.m_both_prodcat.servicesWorkspace === true, row('m_both_prodcat'));
  ck('M5  missing category + SERVICES (an approved provider with no C1 stamp — the seven) → PENDING_CLASSIFICATION, no route, NOT the provider dashboard', M.m_svc_nocat.route === null && M.m_svc_nocat.state === 'PENDING_CLASSIFICATION', row('m_svc_nocat'));
  ck('M6  missing category + PRODUCTS → no route', M.m_prod_nocat.route === null && M.m_prod_nocat.state === 'PENDING_CLASSIFICATION', row('m_prod_nocat'));
  ck('M7  missing category + BOTH → no route (both authorities are required)', M.m_both_nocat.route === null && M.m_both_nocat.state === 'PENDING_CLASSIFICATION', row('m_both_nocat'));
  ck('M8  products lane (wholesale) + SERVICES only → CONFLICT, no route — not merchant-v2, not a service provider (DG Wine / Latomi if C1 stamps them wholesale)', M.m_svc_prodcat.route === null && M.m_svc_prodcat.state === 'CAPABILITY_CONFLICT' && M.m_svc_prodcat.reason === 'CATEGORY_CAPABILITY_DISAGREEMENT', row('m_svc_prodcat'));
  ck('M9  services lane (trades) + PRODUCTS only → CONFLICT, no route', M.m_prod_svccat.route === null && M.m_prod_svccat.state === 'CAPABILITY_CONFLICT', row('m_prod_svccat'));
  ck('M10 UNCLASSIFIED (pending provider, category present) → PENDING_APPROVAL, no route', M.m_unc_pending.route === null && M.m_unc_pending.state === S.PENDING_APPROVAL && M.m_unc_pending.reason === 'NOT_APPROVED', row('m_unc_pending'));
  ck('M11 suspended → PENDING_APPROVAL / SUSPENDED, no route', M.m_susp.route === null && M.m_susp.reason === 'SUSPENDED', row('m_susp'));
  ck('M12 status without approval evidence → the shell gate: REAPPLICATION_REQUIRED, route = the completion surface only (never a dashboard)', M.m_conf.route === 'complete-application.html' && M.m_conf.state === 'REAPPLICATION_REQUIRED' && M.m_conf.approval.state === 'NO_APPROVAL', row('m_conf'));
  ck('M13 nothing → not found, no route', M.nobody.found === false && M.nobody.route === null);
  ck('M14 no answer routes on ONE authority: every routed row has BOTH a category and a routable capability', Object.values(M).filter((w) => w.route && w.route !== 'complete-application.html').every((w) => w.category && ['PRODUCTS', 'SERVICES', 'PRODUCTS_AND_SERVICES'].includes(w.capability.classification)));
  ck('M15 every answer carries category, lane and capability', Object.values(M).every((w) => 'category' in w && 'lane' in w && w.capability && w.capability.authorityStatus !== undefined));

  say('\n── R2 · DG Wine and Latomi, as they are in production and as C1 would stamp them ──');
  /* production shape (17:31Z census): provider live, SERVICES stamped on businesses/{uid}, NO C1 category stamp anywhere */
  await db.doc('providers/dg').set(Object.assign({ name: 'DG wines and spirits', category: 'wholesaler' }, APPROVED));
  await db.doc('businesses/dg').set({ uid: 'dg', ownerId: 'dg', source: 'capability_migration_c4', capabilities: stamp(undefined, 'approved') });
  const dgNow = await BW.workspaceFor(db, 'dg');
  ck('DG/Latomi TODAY: SERVICES / STAMPED / no C1 category → PENDING_CLASSIFICATION, no route (free-text category "wholesaler" is NOT read)', dgNow.route === null && dgNow.state === 'PENDING_CLASSIFICATION' && dgNow.capability.authorityStatus === 'STAMPED' && dgNow.category === null, { route: dgNow.route, state: dgNow.state, cat: dgNow.category });
  await db.doc('providers/dg').set({ business: { category: 'wholesale', source: 'admin', lane: { hub: 'provider', entClass: null } } }, { merge: true });
  const dgStamped = await BW.workspaceFor(db, 'dg');
  ck('DG/Latomi ONCE C1 STAMPS wholesale: category wholesale (products lane) + SERVICES → CONFLICT, no route — never merchant-v2, never the provider dashboard', dgStamped.route === null && dgStamped.state === 'CAPABILITY_CONFLICT' && dgStamped.reason === 'CATEGORY_CAPABILITY_DISAGREEMENT' && dgStamped.category === 'wholesale' && dgStamped.lane === 'products', { route: dgStamped.route, state: dgStamped.state, reason: dgStamped.reason });
  ck('   CONTROL: the same record with an admin-stamped SERVICES-lane category (service_business) routes to the provider dashboard', await (async () => { await db.doc('providers/dg').set({ business: { category: 'service_business', source: 'admin' } }, { merge: true }); const w = await BW.workspaceFor(db, 'dg'); return w.route === 'provider-dashboard.html' && w.state === S.AVAILABLE; })());

  say('\n── R2 · the resolver CONSUMES the canonical authority; it does not re-derive capability ──');
  const srcNoComments = fs.readFileSync(Path.join(FN, 'business-workspace.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('X1  business-workspace.js requires ./shared/business-capabilities and calls readModel() exactly once (in capabilityFor)', /require\('\.\/shared\/business-capabilities'\)/.test(srcNoComments) && (srcNoComments.match(/\.readModel\(/g) || []).length === 1);
  /* 'UNCLASSIFIED' is ALSO the category authority's word (the reason on a PENDING_CLASSIFICATION holding answer, which
     the dashboard's MESSAGE map keys on); it is allowed there and nowhere else. The capability classifications are
     never spelled out — they are read through CAPS.CLASSIFICATION. */
  const capLiterals = srcNoComments.match(/'(PRODUCTS|SERVICES|PRODUCTS_AND_SERVICES|CONFLICT)'/g) || [];
  const unclassifiedUses = (srcNoComments.match(/'UNCLASSIFIED'/g) || []).length;
  const unclassifiedAsReason = (srcNoComments.match(/_holding\('PENDING_CLASSIFICATION', 'UNCLASSIFIED'/g) || []).length;
  ck('X2  no local liveness or classification logic: never tests approvedAt / adminApproved, never spells a capability classification, never requires business-scope; UNCLASSIFIED appears only as the pending-classification reason',
     !/approvedAt|adminApproved/.test(srcNoComments) && capLiterals.length === 0 && unclassifiedUses === unclassifiedAsReason && !/business-scope/.test(srcNoComments), { capLiterals, unclassifiedUses, unclassifiedAsReason });
  ck('X3  category comes only from the C1 authority (categoryOf / isCategory) — the source never reads free-text category, categoryLabel, hub or type to route', !/prov\.category\b|\.categoryLabel|\.hub\b|prov\.type\b/.test(srcNoComments));
  ck('X4  lane comes only from C1\'s SELLER_CATEGORIES', /BCAT\.SELLER_CATEGORIES\.includes\(category\)/.test(srcNoComments) && !/'retail_store'|'wholesale'|'supermarket'/.test(srcNoComments));
  ck('X5  the grandfather clause is gone: no LEGACY_UNCLASSIFIED in the resolver', !/LEGACY_UNCLASSIFIED/.test(srcNoComments));

  say('\n── 6 · no capability writes ──');
  const authorityWrites = writes.filter((w) => /capabilities/.test(JSON.stringify(w.data || {})) && !/^(businesses\/plumber)$/.test(w.path));
  ck('the authority wrote no `capabilities` anywhere (the only such writes are this suite\'s own fixtures on businesses/plumber)', authorityWrites.length === 0, authorityWrites.slice(0, 2));
  const src = fs.readFileSync(Path.join(FN, 'business-workspace.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('business-workspace.js source contains no set/update/add/delete call at all', !/\.(set|update|add|delete)\(/.test(src));
  ck('business-capabilities.js is byte-identical to the certified read model on the coordination line (verbatim port)', (() => { const a = fs.readFileSync(Path.join(FN, 'shared', 'business-capabilities.js'), 'utf8'); const b = fs.existsSync('C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/shared/business-capabilities.js') ? fs.readFileSync('C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/shared/business-capabilities.js', 'utf8') : a; return a === b; })());

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
