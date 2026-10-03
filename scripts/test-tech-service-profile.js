#!/usr/bin/env node
/* TECH HUB SLICE 4b — the device-repair service editor's server authority.
 * Part A: the pure validator (shared/tech-service-profile.js).
 * Part B: the REAL providerAddService / providerUpdateService / providerDuplicateService and bookingCreateService, executed
 *         in-process on an in-memory Firestore with firebase-admin/auth stubbed (admin deciders injected) — no network.
 *   node scripts/test-tech-service-profile.js          BASE=81cde54 node scripts/test-tech-service-profile.js (must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nTech service profile (Tech Hub slice 4b)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* ── in-memory Firestore (enough for these handlers) ── */
const DOCS = new Map();
let autoId = 0;
const DEL = { __delete: true };
const clone = (o) => JSON.parse(JSON.stringify(o));
const snap = (k, id) => ({ exists: DOCS.has(k), id, ref: docRef(k), data: () => (DOCS.has(k) ? clone(DOCS.get(k)) : undefined) });
function docRef(k) {
  const id = k.split('/').pop();
  return {
    id, path: k,
    get: async () => snap(k, id),
    set: async (v, o) => { DOCS.set(k, o && o.merge ? Object.assign({}, DOCS.get(k) || {}, strip(v)) : strip(v)); },
    update: async (v) => { if (!DOCS.has(k)) throw new Error('NOT_FOUND ' + k); const cur = Object.assign({}, DOCS.get(k)); for (const [f, x] of Object.entries(v)) { if (x && x.__delete) delete cur[f]; else cur[f] = x; } DOCS.set(k, strip(cur)); },
    collection: (c) => coll(k + '/' + c),
  };
}
const strip = (v) => JSON.parse(JSON.stringify(v, (key, x) => (x && x.__ts ? x.__ts : x)));
function coll(c, filters, lim) {
  return {
    doc: (id) => docRef(c + '/' + (id || ('auto' + (++autoId)))),
    add: async (v) => { const r = docRef(c + '/auto' + (++autoId)); await r.set(v); return r; },
    where: (f, op, v) => coll(c, (filters || []).concat([[f, op, v]]), lim),
    orderBy: () => coll(c, filters, lim), limit: (n) => coll(c, filters, n), startAfter: () => coll(c, filters, lim),
    get: async () => {
      const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1)
        .filter((k) => (filters || []).every(([f, op, v]) => { const x = (DOCS.get(k) || {})[f]; return op === 'in' ? v.includes(x) : x === v; }))
        .slice(0, lim || 1e9).map((k) => snap(k, k.split('/').pop()));
      return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
const db = {
  collection: (c) => coll(c, [], 0), doc: (p) => docRef(p),
  runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v), create: (r, v) => r.set(v) }),
  batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), commit: async () => { for (const o of ops) await o(); } }; },
};
const ADMINS = new Set(['admin1']);
const fsStub = {
  getFirestore: () => db,
  FieldValue: { delete: () => DEL, serverTimestamp: () => ({ __ts: 'TS' }), increment: (n) => n, arrayUnion: (...a) => a },
  Timestamp: { now: () => ({ __ts: Date.now(), toMillis: () => Date.now() }), fromMillis: (ms) => ({ __ts: ms, toMillis: () => ms }), fromDate: (d) => ({ __ts: +d }) },
};
const authStub = { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: ADMINS.has(u) ? { admin: true } : {} }) }) };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin/firestore') return fsStub;
  if (req === 'firebase-admin/auth') return authStub;
  if (req === 'firebase-admin') { const real = origLoad.apply(this, arguments); const fsNs = Object.assign(() => db, fsStub); return new Proxy(real, { get: (t, k) => (k === 'firestore' ? fsNs : k === 'auth' ? authStub.getAuth : t[k]) }); }
  return origLoad.apply(this, arguments);
};

/* ── PART A ── */
console.log('PART A — the pure validator');
let TSP = null; try { TSP = require(path.join(FN, 'shared', 'tech-service-profile.js')); } catch (_) { TSP = null; }
if (!TSP) ck('A-0', false, 'shared/tech-service-profile.js exists');
else {
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };
  const REPAIR = ['DEVICE_REPAIR', 'WORKSHOP', 'PICKUP_DROP_OFF', 'QUOTE_REQUEST', 'DIRECT_BOOKING'];
  const NET = ['NETWORKING', 'FIELD_SERVICE', 'ONSITE_SUPPORT', 'QUOTE_REQUEST'];
  const p = TSP.sanitizeProfile({ deviceTypes: ['phone', 'tablet'], brands: ['samsung', 'Apple'], repairTypes: ['screen'], models: ['A54', 'A54'], serviceModes: ['workshop'], turnaroundHours: 24, serviceArea: 'Nairobi CBD<script>' }, REPAIR);
  ck('A-1', p.brands.join() === 'Apple,Samsung' && p.models.join() === 'A54' && p.serviceModes.join() === 'WORKSHOP' && !/[<>]/.test(p.serviceArea) && p.turnaroundHours === 24,
    'a device-repair profile is normalised (canonical brand spelling, deduped models, modes upper-case, text stripped)', p);
  ck('A-2', err(() => TSP.sanitizeProfile({ deviceTypes: ['router'] }, NET)) === 'DEVICE_CAPABILITY_REQUIRED', 'device fields without DEVICE_REPAIR / ELECTRONICS are refused');
  ck('A-3', err(() => TSP.sanitizeProfile({ serviceModes: ['ONSITE_SUPPORT'] }, REPAIR)) === 'MODE_NOT_GRANTED', 'a service mode the provider was not granted (on-site for a workshop business) is refused');
  ck('A-4', err(() => TSP.sanitizeProfile({ brands: ['Fakebrand'] }, REPAIR)) === 'BAD_VALUE' && err(() => TSP.sanitizeProfile({ deviceTypes: ['spaceship'] }, REPAIR)) === 'BAD_VALUE'
    && err(() => TSP.sanitizeProfile({ turnaroundHours: 9999 }, REPAIR)) === 'BAD_VALUE', 'unknown brand / device / out-of-range turnaround are refused');
  ck('A-5', err(() => TSP.sanitizeProfile({ serviceModes: ['WORKSHOP'] }, ['IT_SUPPORT_FAKE'])) === 'NO_TECH_CAPABILITY' && err(() => TSP.sanitizeProfile({}, [])) === 'NO_TECH_CAPABILITY',
    'no Tech capability → no profile at all');
  const rd = TSP.sanitizeRepairDetails({ deviceType: 'phone', brand: 'samsung', model: 'A54', repairType: 'screen', serviceMode: 'workshop', problem: 'cracked' }, p);
  ck('A-6', rd && rd.brand === 'Samsung' && rd.serviceMode === 'WORKSHOP' && !('price' in rd), 'repair details are validated against what the service covers, and carry no price', rd);
  ck('A-7', err(() => TSP.sanitizeRepairDetails({ deviceType: 'laptop' }, p)) === 'BAD_VALUE' && err(() => TSP.sanitizeRepairDetails({ deviceType: 'phone', brand: 'Dell' }, p)) === 'BAD_VALUE'
    && err(() => TSP.sanitizeRepairDetails({ deviceType: 'phone', serviceMode: 'ONSITE_SUPPORT' }, p)) === 'BAD_VALUE', 'a device / brand / mode the service does not cover is refused');
}

/* ── PART B ── */
console.log('\nPART B — the real handlers, executed');
const APPROVED_AT = '2026-09-01T00:00:00.000Z';
const seedProvider = (uid, category, appCategory, status, decidedBy) => {
  DOCS.set('providers/' + uid, { status: 'active', approvedAt: APPROVED_AT, searchable: true, business: { category, source: 'application' } });
  DOCS.set('users/' + uid, { role: 'provider' });
  DOCS.set('providerSubscriptions/' + uid, { limits: { listings: -1 } });
  DOCS.set('applications/' + uid + '--a', { uid, category: appCategory, role: 'provider', status: status || 'approved', decidedBy: decidedBy === undefined ? 'admin1' : decidedBy });
};
(async () => {
  let PO = null, BS = null, loadErr = null;
  try { PO = require(path.join(FN, 'provider-ops.js'))._h || require(path.join(FN, 'provider-ops.js')); } catch (e) { loadErr = e.message; }
  try { BS = require(path.join(FN, 'booking-service.js'))._h || require(path.join(FN, 'booking-service.js')); } catch (e) { loadErr = loadErr || e.message; }
  if (!PO || !PO.providerAddService) { ck('B-0', false, 'provider-ops loads', loadErr); return done(); }
  const call = async (fn, uid, data) => { try { return { ok: await fn({ auth: { uid, token: {} }, data }) }; } catch (e) { return { code: e.code, msg: e.message, det: e.details }; } };
  const DEVICE = { deviceTypes: ['phone'], brands: ['Samsung'], repairTypes: ['screen', 'battery'], serviceModes: ['WORKSHOP'], turnaroundHours: 4 };

  /* B-1 approved phone-repair provider saves a device profile */
  DOCS.clear(); seedProvider('p1', 'it_services', 'phone-repair');
  let r = await call(PO.providerAddService, 'p1', { name: 'Screen replacement', priceType: 'fixed', price: 350000, techProfile: DEVICE });
  const saved = r.ok && DOCS.get('providerServices/' + r.ok.serviceId);
  ck('B-1', !!(saved && saved.techProfile && saved.techProfile.brands.join() === 'Samsung' && saved.price === 350000),
    'an APPROVED device-repair provider saves a service with its device profile (price untouched by the profile)', r.code ? r : saved);

  /* B-2 pending applicant: no workspace → refused, nothing written */
  DOCS.clear(); seedProvider('p2', 'it_services', 'phone-repair', 'pending');
  const before = [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length;
  r = await call(PO.providerAddService, 'p2', { name: 'Screen', techProfile: DEVICE });
  ck('B-2', r.code === 'failed-precondition' && [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length === before,
    'a PENDING applicant cannot save a device profile, and nothing is written', r);

  /* B-3 self-decided approval grants nothing */
  DOCS.clear(); seedProvider('p3', 'it_services', 'phone-repair', 'approved', 'p3');
  r = await call(PO.providerAddService, 'p3', { name: 'Screen', techProfile: DEVICE });
  ck('B-3', r.code === 'failed-precondition', 'a SELF-decided approval cannot unlock the device editor', r);

  /* B-4 networking provider (no device capability) → device fields refused; its own modes accepted */
  DOCS.clear(); seedProvider('p4', 'it_services', 'networking');
  r = await call(PO.providerAddService, 'p4', { name: 'Router fix', techProfile: DEVICE });
  const r4b = await call(PO.providerAddService, 'p4', { name: 'Office Wi-Fi install', techProfile: { serviceModes: ['FIELD_SERVICE', 'ONSITE_SUPPORT'] } });
  const s4 = r4b.ok && DOCS.get('providerServices/' + r4b.ok.serviceId);
  ck('B-4', r.code === 'failed-precondition' && s4 && s4.techProfile.serviceModes.join() === 'FIELD_SERVICE,ONSITE_SUPPORT' && !s4.techProfile.deviceTypes,
    'a networking business cannot claim devices, but saves its granted service modes', { refused: r.code, saved: s4 && s4.techProfile });

  /* B-5 browser claims a mode not granted */
  DOCS.clear(); seedProvider('p5', 'it_services', 'phone-repair');
  r = await call(PO.providerAddService, 'p5', { name: 'Home visit repair', techProfile: { deviceTypes: ['phone'], serviceModes: ['ONSITE_SUPPORT'] } });
  ck('B-5', r.code === 'failed-precondition' && r.det && r.det.code === 'TECH_PROFILE_MODE_NOT_GRANTED', 'claiming on-site support without the capability is refused', r);

  /* B-6 update: wrong owner refused; owner can clear the profile */
  DOCS.clear(); seedProvider('p6', 'it_services', 'phone-repair'); seedProvider('p7', 'it_services', 'phone-repair');
  r = await call(PO.providerAddService, 'p6', { name: 'Battery', techProfile: DEVICE });
  const sid = r.ok && r.ok.serviceId;
  const cross = await call(PO.providerUpdateService, 'p7', { serviceId: sid, techProfile: DEVICE });
  const clear = await call(PO.providerUpdateService, 'p6', { serviceId: sid, techProfile: null });
  ck('B-6', cross.code === 'permission-denied' && clear.ok && !('techProfile' in (DOCS.get('providerServices/' + sid) || {})),
    'another provider cannot edit the service; the owner can clear the profile', { cross: cross.code, clear: clear.code || 'ok' });

  /* B-7 duplicate re-validates against today's capabilities */
  DOCS.clear(); seedProvider('p8', 'it_services', 'phone-repair');
  r = await call(PO.providerAddService, 'p8', { name: 'Screen', techProfile: DEVICE });
  DOCS.set('applications/p8--a', Object.assign(DOCS.get('applications/p8--a'), { status: 'suspended' }));
  const dup = await call(PO.providerDuplicateService, 'p8', { serviceId: r.ok && r.ok.serviceId });
  ck('B-7', dup.code === 'failed-precondition', 'duplicating a device service after the approval is withdrawn is refused (capability not copied blindly)', dup);

  /* B-8 booking: repair details validated against the service, price unaffected */
  if (!BS || !BS.bookingCreateService) ck('B-8', false, 'booking-service loads', loadErr);
  else {
    DOCS.clear(); seedProvider('p9', 'it_services', 'phone-repair');
    r = await call(PO.providerAddService, 'p9', { name: 'Screen', priceType: 'fixed', price: 250000, techProfile: DEVICE });
    const bad = await call(BS.bookingCreateService, 'cust1', { providerId: 'p9', serviceId: r.ok && r.ok.serviceId, date: '2026-12-01', startTime: '10:00', repairDetails: { deviceType: 'laptop' } });
    const good = await call(BS.bookingCreateService, 'cust1', { providerId: 'p9', serviceId: r.ok && r.ok.serviceId, date: '2026-12-01', startTime: '10:00', repairDetails: { deviceType: 'phone', brand: 'Samsung', repairType: 'screen', problem: 'cracked', price: 1 } });
    const bk = [...DOCS.entries()].find(([k]) => k.startsWith('providerBookings/'));
    /* a valid request must pass the repair gate; whether the slot books depends on availability seeding, which this suite
       does not model — so: refused for an uncovered device, and NEVER refused for repair details when valid. */
    ck('B-8', bad.code === 'invalid-argument' && /REPAIR_DETAILS_/.test((bad.det || {}).code || '') && !/REPAIR_DETAILS_/.test(((good.det || {}).code) || '')
      && (!bk || (bk[1].price === 250000 && bk[1].repairDetails && !('price' in bk[1].repairDetails))),
      'booking a device service refuses an uncovered device; a valid request passes the repair gate and never changes the server price',
      { bad: bad.det, good: good.code || 'ok', goodMsg: good.msg, booked: bk && { price: bk[1].price, rd: bk[1].repairDetails } });
  }

  /* B-10 a SUSPENDED provider keeps its (valid) approval, so capabilities still compose — only the workspace gate refuses */
  DOCS.clear(); seedProvider('p10', 'it_services', 'phone-repair');
  DOCS.set('providers/p10', Object.assign(DOCS.get('providers/p10'), { status: 'suspended', searchable: false }));
  const BW10 = require(path.join(FN, 'business-workspace.js'));
  const w10 = await BW10.workspaceFor(db, 'p10');
  r = await call(PO.providerAddService, 'p10', { name: 'Screen', techProfile: DEVICE });
  ck('B-10', r.code === 'failed-precondition' && ![...DOCS.keys()].some((k) => k.startsWith('providerServices/')),
    'a SUSPENDED provider cannot save a device service (the workspace gate, not just capabilities)', { refused: r.code, msg: r.msg, wsState: w10.state, wsReason: w10.reason, caps: w10.serviceCapabilities });

  /* B-9 the modules are implemented (and the rest of Tech stays honest) */
  const BW = require(path.join(FN, 'business-workspace.js'));
  const M = BW.MODULES || {};
  ck('B-9', (M.repairs || {}).implemented === true && (M.supportedDevices || {}).implemented === true && (M.diagnostics || {}).implemented === false,
    'repairs + supportedDevices are implemented; diagnostics (no screen yet) stays NOT_IMPLEMENTED', { repairs: M.repairs, supportedDevices: M.supportedDevices, diagnostics: M.diagnostics });
  ck('B-11', (M.enquiries || {}).implemented === false && (M.enquiries || {}).why === 'NOT_BUILT' && (M.calls || {}).implemented === false && (M.calls || {}).why === 'NOT_BUILT'
    && (M.quotes || {}).implemented === true && (M.quotes || {}).label === 'Rate cards',
    'modules with no backing (enquiries, call requests) are NOT_IMPLEMENTED; the built rate-card editor is labelled as what it is', { enquiries: M.enquiries, calls: M.calls, quotes: M.quotes });
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
