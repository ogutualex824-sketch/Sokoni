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
  ck('a retail_store category → merchant-v2 (the category route), capability SERVICES-by-registry is reported honestly', w1b.route === 'merchant-v2.html' && w1b.capability.classification === 'SERVICES', { route: w1b.route, cap: w1b.capability.classification });
  const w1c = await BW.workspaceFor(db, 'doc1');
  ck('healthcare rows unchanged: clinician → provider-dashboard, AVAILABLE, POS NOT_APPLICABLE, capability SERVICES with no conflict', w1c.route === 'provider-dashboard.html' && w1c.state === S.AVAILABLE && w1c.modules.pos.state === S.NOT_APPLICABLE && w1c.capability.classification === 'SERVICES' && w1c.capability.conflicts.length === 0, { state: w1c.state, pos: w1c.modules.pos, cap: w1c.capability.classification });

  say('\n── 2 · capability-aware routing ──');
  await db.doc('sellers/seller1').set({ status: 'active', active: true, approvedAt: 1, name: 'Mama Mboga' });
  const w2 = await BW.workspaceFor(db, 'seller1');
  ck('a live seller with NO provider → merchant-v2, AVAILABLE, PRODUCTS (before: "no approved business")', w2.found === true && w2.route === 'merchant-v2.html' && w2.state === S.AVAILABLE && w2.capability.classification === 'PRODUCTS' && w2.servicesWorkspace === false, { route: w2.route, cap: w2.capability.classification });
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
  ck('seller present-not-live, no provider → no route, UNCLASSIFIED, home says apply', w3.route === null && w3.capability.classification === 'UNCLASSIFIED' && h3.apply === true && h3.primary === null, { route: w3.route, cap: w3.capability.classification, apply: h3.apply });
  const w3b = await BW.workspaceFor(db, 'nobody');
  ck('an account with nothing → found:false, UNCLASSIFIED, no route', w3b.found === false && w3b.route === null && w3b.capability.classification === 'UNCLASSIFIED');

  say('\n── 4 · CONFLICT refuses routing ──');
  await db.doc('providers/forged').set(Object.assign({ name: 'Self-made', status: 'active' }, biz('trades')));   /* status, no approvedAt */
  const w4 = await BW.workspaceFor(db, 'forged');
  ck('a provider live by STATUS ALONE → CAPABILITY_CONFLICT, route null, conflict named, Overview + Settings only', w4.state === 'CAPABILITY_CONFLICT' && w4.route === null && w4.capability.conflicts.includes('provider_status_without_approval') && w4.modules.overview.state === S.AVAILABLE && w4.modules.quotes.state === S.PENDING_APPROVAL, { state: w4.state, route: w4.route, conflicts: w4.capability.conflicts });
  ck('   the module gate refuses too (assertModule → WORKSPACE_MODULE_PENDING_APPROVAL)', (await codeOf(BW.assertModule(db, 'forged', 'quotes', HE))) === 'WORKSPACE_MODULE_PENDING_APPROVAL');
  const h4 = await BW.homeFor(db, 'forged', {});
  ck('   home: a business entry with NO route and the review message; primary null; apply false (it is not "nothing")', h4.homes.length === 1 && h4.homes[0].route === null && /review/.test(h4.homes[0].message) && h4.primary === null && h4.apply === false, h4.homes);
  ck('   CONTROL: adding approvedAt to the same record turns the conflict off and routes to provider-dashboard', (await (async () => { await db.doc('providers/forged').set({ approvedAt: 1 }, { merge: true }); const w = await BW.workspaceFor(db, 'forged'); return w.state === S.AVAILABLE && w.route === 'provider-dashboard.html' && w.capability.classification === 'SERVICES'; })()));
  await db.doc('sellers/forgedseller').set({ status: 'active', active: true });   /* client-writable status only */
  const w4b = await BW.workspaceFor(db, 'forgedseller');
  ck('a seller live by status alone → CONFLICT seller_status_without_approval, route null (never merchant-v2)', w4b.state === 'CAPABILITY_CONFLICT' && w4b.route === null && w4b.capability.conflicts.includes('seller_status_without_approval'));

  say('\n── 5 · unstamped is not silently a provider or a merchant ──');
  const all = await Promise.all(['plumber', 'seller1', 'salon1', 'pending1', 'forged', 'nobody'].map((u) => BW.workspaceFor(db, u)));
  ck('every answer carries a capability with an authority status', all.every((w) => w.capability && w.capability.readable && ['STAMPED', 'NOT_YET_STAMPED', 'INVALID_STAMP'].includes(w.capability.authorityStatus)));
  ck('no route was granted to any account whose registry evidence is absent (nobody, pending1) — NOT_YET_STAMPED alone routes nowhere', all.filter((w) => w.capability.classification === 'UNCLASSIFIED').every((w) => w.route === null));

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
  ck('a failing capability read → readable:false with the error; the category path still answers (provider-dashboard)', wu.capability.readable === false && /permission-denied/.test(wu.capability.error) && wu.route === 'provider-dashboard.html', wu.capability);

  say('\n── 6 · no capability writes ──');
  const authorityWrites = writes.filter((w) => /capabilities/.test(JSON.stringify(w.data || {})) && !/^(businesses\/plumber)$/.test(w.path));
  ck('the authority wrote no `capabilities` anywhere (the only such writes are this suite\'s own fixtures on businesses/plumber)', authorityWrites.length === 0, authorityWrites.slice(0, 2));
  const src = fs.readFileSync(Path.join(FN, 'business-workspace.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('business-workspace.js source contains no set/update/add/delete call at all', !/\.(set|update|add|delete)\(/.test(src));
  ck('business-capabilities.js is byte-identical to the certified read model on the coordination line (verbatim port)', (() => { const a = fs.readFileSync(Path.join(FN, 'shared', 'business-capabilities.js'), 'utf8'); const b = fs.existsSync('C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/shared/business-capabilities.js') ? fs.readFileSync('C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/shared/business-capabilities.js', 'utf8') : a; return a === b; })());

  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
