/* test-accommodation-profile.js — hotels / BnBs and property businesses land on the provider dashboard with honest
 * module states, and a hotel room is never sold as a minute slot (owner decisions 2026-09-28).
 *
 *   node scripts/test-accommodation-profile.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-accommodation-profile.js  # booking-service.js + business-workspace.js @ 4e9607b
 *
 * The REAL booking-service.js on the transactional fake Firestore (scripts/lib/fake-firestore-txn). No network, no
 * provider, no production.
 *
 * PROVES
 *   P1  a hotel's workspace: rooms (services), enquiries, reviews, storefront, earnings AVAILABLE; bookings /
 *       availability / calendar NOT_IMPLEMENTED with reason STAY_ENGINE_PENDING (tracked, never hidden)
 *   P2  a property business: viewings (bookings) AVAILABLE; listings NOT_IMPLEMENTED (LISTINGS_MODULE_PENDING)
 *   P3  a customer booking a hotel room through bookingCreateService is REFUSED (WORKSPACE_MODULE_NOT_IMPLEMENTED) and
 *       NOTHING is written — the engine books minute slots, so it would have sold a 30-minute "room"
 *   P4  control: a photographer's session books normally through the same handler (the gate is category-scoped)
 *   P5  control: notBuiltFor is null for every category whose profile declares nothing unbuilt
 *   P6  the hotel workspace carries a plain "being built" notice — the sidebar hides non-AVAILABLE modules, so the
 *       missing capability is explained, never silently omitted
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-accommodation';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const fs = require('fs');
const cp = require('child_process');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const REAL_NOW = Date.now();
const F = makeFakeFirestore({ clock: () => REAL_NOW, strictReadOrder: true });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: /^admin/.test(u) ? { admin: true } : {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

/* the counterproof runs the BASELINE booking-service.js / business-workspace.js from temp files INSIDE functions/ (so
   their relative requires resolve); both are removed in `finally`, whatever happens */
const TMP = [];
function loadModule(name) {
  if (!CPM) return require(Path.join(FN, name + '.js'));
  const f = Path.join(FN, '.cp-' + process.pid + '-' + name + '.js');
  fs.writeFileSync(f, cp.execFileSync('git', ['show', '4e9607b:functions/' + name + '.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  TMP.push(f);
  return require(f);
}

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid) => ({ auth: { uid, token: {} }, rawRequest: { headers: {} } });
async function errCode(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || 'error'; } }

(async () => {
  let BS, BW;
  try {
    const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
    BW = loadModule('business-workspace');
    BS = loadModule('booking-service');
    say('\nSOURCE: booking-service.js / business-workspace.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));
    const today = CORE.dateOf(REAL_NOW); const D = CORE.addDays(today, 10);
    const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '20:00' }], breaks: [] }; });
    const seed = async (uid, category, svcName) => {
      await db.doc(`providers/${uid}`).set({ name: uid, status: 'active', approvedAt: 1, category, acceptsBookings: true, business: { category, source: 'application' } });
      await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: 'provider', category, decidedBy: 'admin_1', decidedAt: 1 });
      await db.doc(`providerAvailability/${uid}`).set({ uid, modes: ['fixed_hours'], schedule: WEEK,
        appt: { enabled: true, durationMins: 60, bufferMins: 0, travelMins: 0, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
      await db.doc(`providerServices/svc_${uid}`).set({ providerId: uid, name: svcName, price: 500000, fee: 0, deposit: 0, durationMins: 60, active: true });
    };
    await seed('lakehotel', 'hotel', 'Deluxe double room');
    await seed('lens', 'artist_creator', 'Portrait session');

    /* P1 / P2 — the module states the dashboard projects */
    const mh = BW.modulesForProfile('hotel', {}); const mp = BW.modulesForProfile('property', {});
    const S = BW.STATE;
    ck('P1  hotel: rooms / enquiries / reviews / storefront / earnings AVAILABLE; bookings / availability / calendar NOT_IMPLEMENTED (STAY_ENGINE_PENDING)',
      BW.ROUTE_OF.hotel === 'provider-dashboard.html' && ['services', 'enquiries', 'reviews', 'storefront', 'earnings'].every((k) => mh[k] && mh[k].state === S.AVAILABLE)
      && ['bookings', 'availability', 'calendar'].every((k) => mh[k] && mh[k].state === S.NOT_IMPLEMENTED && mh[k].reason === 'STAY_ENGINE_PENDING'),
      { route: BW.ROUTE_OF.hotel, bookings: mh.bookings, services: mh.services && mh.services.state });
    ck('P2  property: viewings (bookings) AVAILABLE; listings NOT_IMPLEMENTED (LISTINGS_MODULE_PENDING)',
      BW.ROUTE_OF.property === 'provider-dashboard.html' && mp.bookings && mp.bookings.state === S.AVAILABLE && mp.listings && mp.listings.state === S.NOT_IMPLEMENTED && mp.listings.reason === 'LISTINGS_MODULE_PENDING',
      { route: BW.ROUTE_OF.property, listings: mp.listings });

    /* P3 — a customer books a hotel room */
    const before = (await db.collection('providerBookings').get()).size;
    const c = await errCode(BS._h.bookingCreateService({ ...who('guest1'), data: { providerId: 'lakehotel', serviceId: 'svc_lakehotel', date: D, startTime: '14:00' } }));
    const after = (await db.collection('providerBookings').get()).size;
    ck('P3  a hotel room booked through bookingCreateService is REFUSED and nothing is written', c === 'WORKSPACE_MODULE_NOT_IMPLEMENTED' && after === before, { code: c, bookingsWritten: after - before });

    /* P4 — the control: a photographer session books normally */
    const c2 = await errCode(BS._h.bookingCreateService({ ...who('buyer1'), data: { providerId: 'lens', serviceId: 'svc_lens', date: D, startTime: '10:00' } }));
    ck('P4  control: a photographer session books normally through the same handler', c2 === null, c2);

    /* P6 — the dashboard says why stays are missing (the sidebar hides every non-AVAILABLE module) */
    const ws = await BW.workspaceFor(db, 'lakehotel');
    ck('P6  the hotel workspace carries a plain notice that stays are being built (no silent omission)',
      ws.route === 'provider-dashboard.html' && /being built/.test(ws.message || '') && !/STAY_ENGINE|NOT_IMPLEMENTED/.test(ws.message || ''), { route: ws.route, message: ws.message });

    /* P5 — the helper is category-scoped */
    const others = ['trades', 'salon', 'artist_creator', 'education', 'property', 'retail_store', 'lawyer'].filter((k) => BW.notBuiltFor && BW.notBuiltFor({ business: { category: k } }, 'bookings'));
    ck('P5  control: notBuiltFor(bookings) is null for every category whose profile declares nothing unbuilt', !!BW.notBuiltFor && others.length === 0, others);
  } finally {
    TMP.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
  }
  say(`\n${pass} passed, ${fail} failed`);
  if (CPM) say('(counter-proof: failures here ARE the defects; P4 is a control and must pass in both modes)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { TMP.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} }); say('CRASH ' + (e && e.stack || e)); process.exit(2); });
