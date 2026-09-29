/* test-business-workspace.js — the ONE business workspace authority (CHANGELOG 238, convergence C2a).
 * Transactional fake Firestore + the REAL functions/business-workspace.js, business-category.js, healthcare-workspace.js
 * and capability-authority.js (subscription-core's resolver stubbed — the plan is its own authority). No network.
 *
 * PROVES
 *   routes       every C1 category has an explicit route decision; each route is a page that EXISTS, or null
 *                (owner 2026-09-28: restaurant → merchant-v2; hotel → provider dashboard + accommodation profile, stays
 *                NOT_IMPLEMENTED until the stay engine; property → provider dashboard + listings, NOT_IMPLEMENTED)
 *   six states   AVAILABLE · LOCKED · NOT_APPLICABLE · NOT_IMPLEMENTED · COMMERCIAL_DECISION_REQUIRED ·
 *                PENDING_APPROVAL — each appears where it should, and "not available" ≠ "not relevant"
 *   categories   a doctor gets no POS/products/inventory/rate cards/booking PIN; a plumber gets quotes and calls;
 *                a salon gets no quotes; an artist gets the booking PIN; content only for an ACTIVE creator
 *   healthcare   Healthcare is ROWS of this authority (its matrix + plan: a pharmacy's shop modules are
 *                NOT_IMPLEMENTED while the SOK-ID identity is deferred, a doctor's are NOT_APPLICABLE)
 *   eligibility  unapproved / suspended / UNCLASSIFIED → PENDING_APPROVAL with Overview + Settings only
 *   entitlement  categories without an approved plan catalogue → COMMERCIAL_DECISION_REQUIRED (never a guessed plan)
 *   server-only  free-text category and a self-selected onboarding role change NOTHING; the op answers for the caller
 *   gate         assertModule refuses every non-AVAILABLE module with a precise code (the C2b gate)
 *
 *   node scripts/test-business-workspace.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-business-workspace';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
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
const PLANS = {};
stub('./subscription-core', { resolveSubscription: async (uid) => (PLANS[uid] ? Object.assign({ found: true }, PLANS[uid]) : { found: false }) });

const BW = require(Path.join(FN, 'business-workspace.js'));
const BC = require(Path.join(FN, 'business-category.js'));
const S = BW.STATE;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const HE = class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } };
const seed = (uid, doc) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active', approvedAt: 1 /* the producer (projectProvider) always stamps approvedAt; a status alone is client-writable */ }, doc));
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const st = (w, m) => (w.modules[m] || {}).state;

(async () => {
  say('\n── every category has a route decision ──');
  const missingRoute = BC.KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(BW.ROUTE_OF, k));
  ck('every C1 category has an explicit route decision (a page or UNROUTED)', missingRoute.length === 0, missingRoute);
  const badPages = [...new Set(Object.values(BW.ROUTE_OF).filter(Boolean))].filter((p) => !fs.existsSync(Path.join(ROOT, p)));
  ck('every route is a page that exists', badPages.length === 0, badPages);
  /* owner 2026-09-28: food → merchant-v2 (menu = products); hotel → accommodation profile; property → property profile */
  ck('restaurant → merchant-v2; hotel and property → the provider dashboard (accommodation / property profiles)',
    BW.ROUTE_OF.restaurant === 'merchant-v2.html' && BW.ROUTE_OF.hotel === 'provider-dashboard.html' && BW.ROUTE_OF.property === 'provider-dashboard.html'
    && BW.PROFILE_OF.hotel === 'accommodation' && BW.PROFILE_OF.property === 'property');
  ck('owner routes: Healthcare/Legal/trades → provider-dashboard; shop → merchant-v2; organiser → event-manager; venue → venue-manager; delivery → driver app',
    BW.ROUTE_OF.clinician === 'provider-dashboard.html' && BW.ROUTE_OF.lawyer === 'provider-dashboard.html' && BW.ROUTE_OF.trades === 'provider-dashboard.html'
    && BW.ROUTE_OF.retail_store === 'merchant-v2.html' && BW.ROUTE_OF.event_organizer === 'event-manager.html' && BW.ROUTE_OF.venue === 'venue-manager.html' && BW.ROUTE_OF.delivery === 'driver.html');
  ck('no route is healthcare.html (the public directory) and no route is a missing *-dashboard page', !Object.values(BW.ROUTE_OF).includes('healthcare.html'));

  say('\n── the six states, by category ──');
  await seed('plumber', biz('trades'));
  await seed('salon1', biz('salon'));
  await seed('dj1', biz('artist_creator'));
  await seed('dj2', biz('artist_creator'));
  await db.doc('creators/dj2').set({ state: 'ACTIVE' });
  await seed('lawyer1', biz('lawyer'));
  await seed('doc1', { healthcare: { category: 'clinician', source: 'admin' }, business: { category: 'clinician', source: 'admin', lane: { hub: 'healthcare', entClass: null } } });
  await seed('pharm1', { healthcare: { category: 'pharmacy', source: 'admin' }, business: { category: 'pharmacy', source: 'admin', lane: { hub: 'healthcare', entClass: null } } });
  PLANS.pharm1 = { tier: 'clinic', status: 'active' };
  await seed('pharm0', { healthcare: { category: 'pharmacy', source: 'admin' }, business: { category: 'pharmacy', source: 'admin', lane: { hub: 'healthcare', entClass: null } } });
  await seed('hotel1', biz('hotel'));
  await seed('shop1', biz('retail_store'));
  await seed('unc1', biz(null));
  await seed('pend1', Object.assign({ status: 'pending' }, biz('trades')));
  await seed('susp1', Object.assign({ status: 'suspended' }, biz('trades')));
  const W = {};
  for (const u of ['plumber', 'salon1', 'dj1', 'dj2', 'lawyer1', 'doc1', 'pharm1', 'pharm0', 'hotel1', 'shop1', 'unc1', 'pend1', 'susp1', 'nobody']) W[u] = await BW.workspaceFor(db, u);

  ck('a plumber: provider-dashboard, quotes + calls AVAILABLE, booking PIN NOT_APPLICABLE, staff NOT_IMPLEMENTED, POS NOT_APPLICABLE',
    W.plumber.route === 'provider-dashboard.html' && st(W.plumber, 'quotes') === S.AVAILABLE && st(W.plumber, 'calls') === S.AVAILABLE
    && st(W.plumber, 'bookingPin') === S.NOT_APPLICABLE && st(W.plumber, 'staff') === S.NOT_IMPLEMENTED && st(W.plumber, 'pos') === S.NOT_APPLICABLE, W.plumber.modules);
  ck('a salon: no quotes (NOT_APPLICABLE); products/inventory/POS NOT_IMPLEMENTED (identity deferred) — never exposed',
    st(W.salon1, 'quotes') === S.NOT_APPLICABLE && ['products', 'inventory', 'pos'].every((m) => st(W.salon1, m) === S.NOT_IMPLEMENTED));
  ck('an artist: booking PIN AVAILABLE; content NOT_APPLICABLE unless an ACTIVE creator, then AVAILABLE',
    st(W.dj1, 'bookingPin') === S.AVAILABLE && st(W.dj1, 'content') === S.NOT_APPLICABLE && st(W.dj2, 'content') === S.AVAILABLE);
  ck('a lawyer is folded into provider-dashboard with the quoted-service profile', W.lawyer1.route === 'provider-dashboard.html' && st(W.lawyer1, 'quotes') === S.AVAILABLE);
  ck('a doctor gets NO POS, products, inventory, rate cards, booking PIN or calls; patients AVAILABLE',
    ['pos', 'products', 'inventory', 'quotes', 'bookingPin', 'calls'].every((m) => st(W.doc1, m) === S.NOT_APPLICABLE) && st(W.doc1, 'customers') === S.AVAILABLE, W.doc1.modules);
  ck('a pharmacy (Healthcare row): its shop modules exist in its matrix but the screens are deferred → NOT_IMPLEMENTED, with or without a plan',
    ['pos', 'products', 'inventory', 'delivery'].every((m) => st(W.pharm1, m) === S.NOT_IMPLEMENTED && st(W.pharm0, m) === S.NOT_IMPLEMENTED));
  ck('a hotel: routed to the provider dashboard; rooms / enquiries / reviews AVAILABLE; stays NOT_IMPLEMENTED (STAY_ENGINE_PENDING), never minute slots',
    W.hotel1.route === 'provider-dashboard.html' && W.hotel1.state === S.AVAILABLE && st(W.hotel1, 'services') === S.AVAILABLE
    && st(W.hotel1, 'enquiries') === S.AVAILABLE && st(W.hotel1, 'reviews') === S.AVAILABLE
    && ['bookings', 'availability', 'calendar'].every((m) => st(W.hotel1, m) === S.NOT_IMPLEMENTED && W.hotel1.modules[m].reason === 'STAY_ENGINE_PENDING'), W.hotel1.modules);
  ck('a shop: routed to merchant-v2, whose own authority decides its modules', W.shop1.route === 'merchant-v2.html' && Object.values(W.shop1.modules).every((m) => m.state === S.NOT_APPLICABLE));
  ck('UNCLASSIFIED (approved): PENDING_APPROVAL — no privileged workspace, Overview + Settings only',
    W.unc1.state === S.PENDING_APPROVAL && W.unc1.reason === 'UNCLASSIFIED' && st(W.unc1, 'bookings') === S.PENDING_APPROVAL && st(W.unc1, 'overview') === S.AVAILABLE);
  ck('pending and suspended businesses are PENDING_APPROVAL (NOT_APPROVED / SUSPENDED)', W.pend1.reason === 'NOT_APPROVED' && W.susp1.reason === 'SUSPENDED' && st(W.susp1, 'earnings') === S.PENDING_APPROVAL);
  ck('no provider record: not found, PENDING_APPROVAL', W.nobody.found === false && st(W.nobody, 'overview') === S.PENDING_APPROVAL);

  say('\n── entitlement: no guessed plans ──');
  ck('a plumber (no approved plan catalogue): entitlement COMMERCIAL_DECISION_REQUIRED', W.plumber.entitlement.state === S.COMMERCIAL_DECISION_REQUIRED);
  ck('a Healthcare business reads its real plan authority (MAPPED with a plan, MAPPED_NO_PLAN without)', W.pharm1.entitlement.state === 'MAPPED' && W.pharm1.entitlement.tier === 'clinic' && W.pharm0.entitlement.state === 'MAPPED_NO_PLAN');
  const allStates = new Set();
  Object.values(W).forEach((w) => Object.values(w.modules || {}).forEach((m) => allStates.add(m.state)));
  allStates.add(W.plumber.entitlement.state);
  /* LOCKED: a Healthcare facility's patients are always offered, so LOCKED needs a plan-gated IMPLEMENTED module —
     proven directly on the pure mapping: a healthcare op the matrix offers but the plan does not unlock. */
  ck('five of the six states appear in real workspaces (LOCKED is proven below)', [S.AVAILABLE, S.NOT_APPLICABLE, S.NOT_IMPLEMENTED, S.COMMERCIAL_DECISION_REQUIRED, S.PENDING_APPROVAL].every((x) => allStates.has(x)), [...allStates]);

  say('\n── server facts only ──');
  await seed('forger', Object.assign({ category: 'hotel', categories: ['pharmacy'] }, biz('trades')));
  await db.doc('accounts/forger').set({ currentRole: 'healthcare', roles: ['healthcare', 'hotel'] });
  const fw = await BW.workspaceFor(db, 'forger');
  ck('free-text category and a self-selected onboarding role change NOTHING (still trades)', fw.category === 'trades' && fw.route === 'provider-dashboard.html' && st(fw, 'pos') === S.NOT_APPLICABLE);
  ck('the op refuses the signed-out', await codeOf(BW._h.businessWorkspace({ auth: null, data: {} })) === 'unauthenticated');
  const mine = await BW._h.businessWorkspace({ auth: { uid: 'plumber' }, data: { uid: 'doc1' } });
  ck('the op answers for the CALLER only (data.uid ignored)', mine.category === 'trades');
  ck('providerDispatch routes businessWorkspace', /'businessWorkspace',/.test(fs.readFileSync(Path.join(FN, 'provider-dispatch.js'), 'utf8')));

  say('\n── the gate (C2b consumes this) ──');
  ck('assertModule passes an AVAILABLE module', !(await codeOf(BW.assertModule(db, 'plumber', 'quotes', HE))));
  ck('…refuses NOT_APPLICABLE (a doctor\'s rate cards)', await codeOf(BW.assertModule(db, 'doc1', 'quotes', HE)) === 'WORKSPACE_MODULE_NOT_APPLICABLE');
  ck('…refuses NOT_IMPLEMENTED (a salon\'s POS)', await codeOf(BW.assertModule(db, 'salon1', 'pos', HE)) === 'WORKSPACE_MODULE_NOT_IMPLEMENTED');
  ck('…refuses PENDING_APPROVAL (an unclassified business\'s bookings)', await codeOf(BW.assertModule(db, 'unc1', 'bookings', HE)) === 'WORKSPACE_MODULE_PENDING_APPROVAL');
  ck('…refuses an unknown module', await codeOf(BW.assertModule(db, 'plumber', 'launchRockets', HE)) === 'WORKSPACE_MODULE_UNKNOWN');

  say('\n── LOCKED is reachable (entitlement missing on an implemented module) ──');
  /* The day a Healthcare shop screen is wired (implementedOf injected): the SAME healthcare answers now yield LOCKED
     without a plan and AVAILABLE with one — proven on the pure mapping, the registry itself stays frozen. */
  const HWm = require(Path.join(FN, 'healthcare-workspace.js'));
  const wired = (k) => k === 'pos' || BW.MODULES[k].implemented;
  const lockedM = BW.healthcareModules('pharmacy', await HWm.workspaceFor(db, 'pharm0'), wired);
  const openM = BW.healthcareModules('pharmacy', await HWm.workspaceFor(db, 'pharm1'), wired);
  ck('with the POS screen wired: a pharmacy WITHOUT a plan → LOCKED; WITH a plan → AVAILABLE', lockedM.pos.state === S.LOCKED && openM.pos.state === S.AVAILABLE, { locked: lockedM.pos, open: openM.pos });
  try { BW.MODULES.pos.implemented = true; } catch (_) { /* strict-mode TypeError is the expected refusal */ }
  ck('…and the registry is frozen (a caller cannot flip a module to implemented)', Object.isFrozen(BW.MODULES) && Object.isFrozen(BW.MODULES.pos) && BW.MODULES.pos.implemented === false);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
