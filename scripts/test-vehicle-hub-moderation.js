#!/usr/bin/env node
/* test-vehicle-hub-moderation.js — Car Hub C4: the REAL functions/vehicle-hub.js against an in-memory Firestore stand-in
 * (firebase-admin + firebase-functions are module-stubbed; no network, no emulator).
 *   L  listing: any signed-in account drafts (the dead numeric role gate is gone); price validated; cap per seller
 *   P  publish = submit for review (pending_review), never active; only draft/rejected; only the seller
 *   S  status: a seller can never set status through update; a material edit of an active listing → pending_review
 *   M  moderate: admin-only (named claims), approve/reject/suspend/restore transitions, reason required, audit written
 *   V  visibility: list/search/compare/enquire see ACTIVE only; getVehicle hides non-active from others
 *   C  close: seller marks sold / withdrawn; others refused
 *   X  exports: new callables in module.exports AND re-exported by name in functions/index.js
 * Run: node scripts/test-vehicle-hub-moderation.js
 */
'use strict';
const path = require('path'), Module = require('module'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 200) + ']')); ok ? pass++ : fail++; };

/* ── in-memory Firestore ── */
const store = new Map();   /* path → data */
let auto = 0;
const TS = { __ts: true };
function apply(cur, patch) {
  const out = Object.assign({}, cur);
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__inc !== undefined) out[k] = (Number(out[k]) || 0) + v.__inc; else out[k] = v;
  }
  return out;
}
function docRef(col, id) {
  const p = col + '/' + id;
  return { id, path: p,
    get: async () => ({ exists: store.has(p), id, data: () => store.get(p) }),
    set: async (d) => { store.set(p, apply({}, d)); },
    update: async (d) => { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, apply(store.get(p), d)); } };
}
function query(col, filters, lim) {
  return { where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim), orderBy: () => query(col, filters, lim),
    limit: (n) => query(col, filters, n), startAfter: () => query(col, filters, lim),
    get: async () => { let docs = [...store.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, d]) => ({ id: k.slice(col.length + 1), data: () => d }));
      for (const [f, , v] of filters) docs = docs.filter((x) => x.data()[f] === v);
      if (lim) docs = docs.slice(0, lim); return { docs, empty: !docs.length }; } };
}
const db = {
  collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => docRef(col, id || ('auto' + (++auto))) }),
  batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const o of ops) await o(); } }; },
  runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => { r.update(d); }, set: (r, d) => { r.set(d); } }),
};
const adminStub = { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => TS, increment: (n) => ({ __inc: n }) } }), auth: () => ({ getUser: async () => ({ customClaims: {} }) }) };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fnStub = { onCall: (opts, h) => h, HttpsError };
const _load = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin') return adminStub;
  if (req === 'firebase-functions/v2/https') return fnStub;
  return _load.apply(this, arguments);
};
const VH = require(path.join(ROOT, 'functions', 'vehicle-hub.js'));
Module._load = _load;

const U = (uid, claims) => ({ auth: { uid, token: Object.assign({ uid }, claims || {}) } });
const call = async (fn, who, data) => { try { return { ok: true, r: await VH[fn](Object.assign({}, who, { data: data || {} })) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const CAR = { make: 'Toyota', model: 'Probox', year: 2016, vehicleType: 'sedan', listingType: 'for_sale', price: 850000, condition: 'used_good' };
const status = (id) => (store.get('vehicleListings/' + id) || {}).status;

(async () => {
  console.log('\n── L: listing ──');
  let r = await call('createVehicleListing', U('sellerA'), CAR);
  ck('L1 a plain signed-in account (no numeric role claim) can draft a listing', r.ok && r.r.status === 'draft', r);
  const A = r.ok ? r.r.listingId : null;
  r = await call('createVehicleListing', U('sellerA'), Object.assign({}, CAR, { price: -5 }));
  ck('L2 a non-positive price is refused', !r.ok && r.code === 'invalid-argument', r);
  r = await call('createVehicleListing', { auth: null }, CAR);
  ck('L3 signed-out → unauthenticated', !r.ok && r.code === 'unauthenticated', r);
  for (let i = 0; i < 19; i++) await call('createVehicleListing', U('spammer'), CAR);
  r = await call('createVehicleListing', U('spammer'), CAR);
  const r2 = await call('createVehicleListing', U('spammer'), CAR);
  ck('L4 the 20-open-listing cap holds (20th allowed, 21st refused)', r.ok && !r2.ok && r2.code === 'resource-exhausted', { r20: r.ok, r21: r2.code });

  console.log('\n── P: publish = submit for review ──');
  r = await call('publishVehicleListing', U('mallory'), { listingId: A });
  ck('P1 another account cannot submit my listing', !r.ok && r.code === 'permission-denied', r);
  r = await call('publishVehicleListing', U('sellerA'), { listingId: A });
  ck('P2 the seller submits → pending_review (NOT active)', r.ok && status(A) === 'pending_review', status(A));
  r = await call('publishVehicleListing', U('sellerA'), { listingId: A });
  ck('P3 a pending listing cannot be re-submitted', !r.ok && r.code === 'failed-precondition', r);

  console.log('\n── S: status is never the seller\'s ──');
  r = await call('updateVehicleListing', U('sellerA'), { listingId: A, status: 'active', price: 820000 });
  ck('S1 update with status:"active" does not change status (still pending_review); price applied', r.ok && status(A) === 'pending_review' && store.get('vehicleListings/' + A).price === 820000, store.get('vehicleListings/' + A));

  console.log('\n── M: moderation (AdminOS) ──');
  r = await call('moderateVehicleListing', U('sellerA'), { listingId: A, decision: 'approve' });
  ck('M1 the seller cannot approve their own listing', !r.ok && r.code === 'permission-denied', r);
  r = await call('moderateVehicleListing', U('mod1', { role: 2 }), { listingId: A, decision: 'approve' });
  ck('M2 an old numeric role claim (2) is not admin', !r.ok && r.code === 'permission-denied', r);
  r = await call('moderateVehicleListing', U('adm', { admin: true }), { listingId: A, decision: 'reject' });
  ck('M3 reject without a reason is refused', !r.ok && r.code === 'invalid-argument', r);
  r = await call('moderateVehicleListing', U('adm', { admin: true }), { listingId: A, decision: 'approve' });
  ck('M4 admin approves → active', r.ok && status(A) === 'active', status(A));
  const audit = [...store.entries()].filter(([k, v]) => k.startsWith('adminAudit/') && v.targetId === A);
  ck('M5 an adminAudit record names the actor, from/to', audit.length === 1 && audit[0][1].actorUid === 'adm' && audit[0][1].from === 'pending_review' && audit[0][1].to === 'active', audit.map((x) => x[1]));
  r = await call('moderateVehicleListing', U('adm', { admin: true }), { listingId: A, decision: 'approve' });
  ck('M6 approving an active listing is refused (transition check)', !r.ok && r.code === 'failed-precondition', r);

  console.log('\n── S2 / V: re-review + visibility ──');
  r = await call('updateVehicleListing', U('sellerA'), { listingId: A, description: 'Now with new photos', images: ['https://x/1.jpg'] });
  ck('S2 a material edit of an ACTIVE listing returns it to pending_review', r.ok && status(A) === 'pending_review', status(A));
  await call('moderateVehicleListing', U('adm', { admin: true }), { listingId: A, decision: 'approve' });
  r = await call('createVehicleListing', U('sellerB'), CAR); const B = r.r.listingId;   /* B stays draft */
  r = await call('listVehicles', U('anyone'), {});
  ck('V1 listVehicles returns active listings only', r.ok && r.r.listings.some((v) => v.listingId === A) && !r.r.listings.some((v) => v.listingId === B), r.r && r.r.listings.map((v) => v.listingId));
  r = await call('getVehicle', U('stranger'), { listingId: B });
  ck('V2 a draft is not visible to another account', !r.ok && r.code === 'not-found', r);
  r = await call('getVehicle', U('sellerB'), { listingId: B });
  ck('V3 …but is visible to its seller', r.ok && r.r.status === 'draft', r);
  r = await call('submitVehicleEnquiry', U('buyer1'), { listingId: B, message: 'Is it available?' });
  ck('V4 an enquiry on a non-active listing is refused', !r.ok && r.code === 'not-found', r);
  r = await call('submitVehicleEnquiry', U('buyer1'), { listingId: A, message: 'Is it available?' });
  ck('V5 an enquiry on an active listing is recorded for the seller', r.ok && [...store.values()].some((v) => v.enquiryId === r.r.enquiryId && v.sellerUid === 'sellerA'), r);
  r = await call('moderateVehicleListing', U('adm', { superAdmin: true }), { listingId: A, decision: 'suspend', reason: 'reported' });
  ck('M7 super admin suspends with a reason → suspended, hidden from listVehicles', r.ok && status(A) === 'suspended' && !(await call('listVehicles', U('x'), {})).r.listings.some((v) => v.listingId === A), status(A));
  r = await call('moderateVehicleListing', U('adm', { admin: true }), { listingId: A, decision: 'restore' });
  ck('M8 restore → active again', r.ok && status(A) === 'active', status(A));

  console.log('\n── C: close ──');
  r = await call('closeVehicleListing', U('mallory'), { listingId: A, outcome: 'sold' });
  ck('C1 another account cannot close my listing', !r.ok && r.code === 'permission-denied', r);
  r = await call('closeVehicleListing', U('sellerA'), { listingId: A, outcome: 'sold' });
  ck('C2 the seller marks it sold (the sale happened outside SOKONI)', r.ok && status(A) === 'sold', status(A));
  r = await call('updateVehicleListing', U('sellerA'), { listingId: A, price: 1 });
  ck('C3 a closed listing cannot be edited', !r.ok && r.code === 'failed-precondition', r);
  r = await call('listMyVehicleListings', U('sellerA'), {});
  ck('C4 listMyVehicleListings returns the seller\'s own listings in every status', r.ok && r.r.listings.length === 1 && r.r.listings[0].status === 'sold', r.r);
  r = await call('listVehicleReviewQueue', U('sellerA'), {});
  ck('C5 the review queue is admin-only', !r.ok && r.code === 'permission-denied', r);

  console.log('\n── X: exports ──');
  const IX = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const NEW = ['moderateVehicleListing', 'closeVehicleListing', 'listMyVehicleListings', 'listVehicleReviewQueue'];
  ck('X1 new callables are in module.exports (not orphaned by the rebind)', NEW.every((n) => typeof VH[n] === 'function'));
  ck('X2 …and re-exported by name in functions/index.js', NEW.every((n) => new RegExp('exports\\.' + n + '\\s*=\\s*vehicleHub\\.' + n + ';').test(IX)));
  ck('X3 no numeric role gate left in vehicle-hub.js', !/role < [24]/.test(fs.readFileSync(path.join(ROOT, 'functions', 'vehicle-hub.js'), 'utf8')));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
