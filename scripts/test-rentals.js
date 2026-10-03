#!/usr/bin/env node
/* Equipment rentals (Construction convergence, sokoni-f3 2026-10-03) — the REAL marketplace-extensions rental handlers
   against an in-memory Firestore. Proves the six gaps sokoni-e3 found are closed:
     1 shop owner resolution (shopId == uid, no ownerId)   2 seller can cancel (no token.shopId)
     3 rentalComplete status-checked                        4 HttpsError reasons reach the client
     5 owner list op                                        6 no fake payment method
   plus one-transaction booking (overlap re-checked inside) and no self-rental.
   Mutants: RENTAL_MUTANT=<name> node scripts/test-rentals.js */
'use strict';
const path = require('path'), Module = require('module'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 200) + ']')); ok ? pass++ : fail++; };

const store = new Map(); let auto = 0; const TS = { __ts: true };
const INC = (n) => ({ __inc: n });
const apply = (prev, d) => { const o = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(d)) o[k] = v && v.__inc != null ? (Number(o[k]) || 0) + v.__inc : v; return o; };
const tsOf = (date) => ({ _d: date, toDate() { return this._d; }, toMillis() { return this._d.getTime(); } });
const ref = (p) => ({ id: p.split('/').pop(), path: p,
  get: async () => ({ exists: store.has(p), id: p.split('/').pop(), data: () => store.get(p) }),
  set: async (d) => store.set(p, apply({}, d)), update: async (d) => { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, apply(store.get(p), d)); },
  create: async (d) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, apply({}, d)); } });
const col = (c, f = [], lim = 0) => ({ _q: true,
  where: (a, op, v) => col(c, f.concat([[a, v]]), lim), limit: (n) => col(c, f, n), doc: (id) => ref(c + '/' + (id || 'auto' + (++auto))),
  get: async () => { let docs = [...store.entries()].filter(([k]) => k.startsWith(c + '/') && k.split('/').length === 2).map(([k, d]) => ({ id: k.split('/')[1], data: () => d }));
    for (const [a, v] of f) docs = docs.filter((x) => x.data()[a] === v); if (lim) docs = docs.slice(0, lim); return { docs, empty: !docs.length, size: docs.length }; } });
const db = { collection: (c) => col(c),
  runTransaction: async (fn) => { const w = []; const out = await fn({ get: (r) => r.get(), set: (r, d) => w.push(() => r.set(d)), update: (r, d) => w.push(() => r.update(d)), create: (r, d) => w.push(() => r.create(d)) }); for (const x of w) await x(); return out; } };
const firestoreFn = () => db; firestoreFn.FieldValue = { serverTimestamp: () => TS, increment: INC }; firestoreFn.Timestamp = { fromDate: tsOf };
class HttpsError extends Error { constructor(code, m) { super(m); this.code = code; } }

let src = fs.readFileSync(path.join(ROOT, 'functions', 'marketplace-extensions.js'), 'utf8');
const MUT = {
  owner_by_ownerId_only: ["if (shop.ownerId === auth.uid || (!('ownerId' in shop) && shopId === auth.uid)) return shop;", "if (shop.ownerId === auth.uid) return shop;"],
  complete_status_blind:  ["_rentalTransition(req, { from: ['returned'], to: 'completed',", "_rentalTransition(req, { from: ['requested', 'pending', 'accepted', 'active', 'cancelled', 'declined', 'returned'], to: 'completed',"],
  paid_cancel_flip:       ["    if (b.status === 'paid_held') throw new HttpsError(", "    if (false) throw new HttpsError("],
  start_before_paid:      ["_rentalTransition(req, { from: ['paid_held'], to: 'active',", "_rentalTransition(req, { from: ['accepted', 'paid_held'], to: 'active',"],
  overlap_unchecked:      ["    if (conflict) throw new HttpsError('failed-precondition', 'Those dates are already booked.');", ""],
  fake_mpesa:             ["paymentMethod: 'none', paymentStatus: 'unpaid',", "paymentMethod: 'mpesa', paymentStatus: 'unpaid',"],
};
const M = process.env.RENTAL_MUTANT;
if (M) { const m = MUT[M]; if (!m || src.split(m[0]).length !== 2) { console.error('mutant anchor missing: ' + M); process.exit(2); } src = src.replace(m[0], m[1]); console.log('MUTANT ' + M); }
const tmp = path.join(os.tmpdir(), 'mx-under-test-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, f) => f, onRequest: (o, f) => f, HttpsError };
  if (req === 'firebase-functions/v2/scheduler') return { onSchedule: (o, f) => f };
  if (req === 'firebase-admin') return { firestore: firestoreFn };
  return _load.apply(this, arguments);
};
const X = require(tmp); fs.unlinkSync(tmp);
const H = X._h;
const call = async (op, uid, data, token) => { try { return { ok: true, r: await H[op]({ auth: uid ? { uid, token: token || {} } : null, data: data || {} }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message, plain: !(e instanceof HttpsError) }; } };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

(async () => {
  console.log('\nRentals (marketplace-extensions)' + (M ? '  [' + M + ']' : '') + '\n');
  store.set('shops/ownerU', { name: 'Plant Hire Co' });                      /* shop identity model: doc id = owner uid, no ownerId */
  store.set('shopEmployees/e1', { shopId: 'ownerU', uid: 'staffU' });
  store.set('rentalProducts/rp1', { shopId: 'ownerU', createdBy: 'ownerU', title: 'Excavator', dailyRate: 28000, deposit: 50000, status: 'active' });
  store.set('rentalProducts/rp2', { shopId: 'ownerU', createdBy: 'ownerU', title: 'Crane', dailyRate: 60000, status: 'paused' });

  let r = await call('rentalOwnerListings', 'ownerU', { shopId: 'ownerU' });
  ck('O1 the shop owner (shopId == uid, no ownerId field) lists all their equipment incl. paused', r.ok && r.r.listings.length === 2, r);
  r = await call('rentalOwnerListings', 'staffU', { shopId: 'ownerU' });
  ck('O2 a shop employee may list it too', r.ok && r.r.listings.length === 2, r);
  r = await call('rentalOwnerListings', 'stranger', { shopId: 'ownerU' });
  ck('O3 a stranger is refused with permission-denied (an HttpsError reason, not internal)', !r.ok && r.code === 'permission-denied' && !r.plain, r);

  r = await call('rentalBook', 'ownerU', { rentalProductId: 'rp1', startDate: day(2), endDate: day(4) });
  ck('B1 an owner cannot rent their own equipment', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalBook', 'buyer1', { rentalProductId: 'rp1', startDate: day(2), endDate: day(4), durationUnit: 'daily' });
  const b1 = r.ok ? r.r.bookingId : 'x'; const bk = store.get('rentalBookings/' + b1) || {};
  ck('B2 a booking is server-priced (2 days × 28,000) with the deposit', r.ok && r.r.totalAmount === 56000 && r.r.depositAmount === 50000, r);
  ck('B3 no fake payment: paymentMethod none + paymentStatus unpaid', bk.paymentMethod === 'none' && bk.paymentStatus === 'unpaid', bk);
  r = await call('rentalBook', 'buyer2', { rentalProductId: 'rp1', startDate: day(3), endDate: day(5) });
  ck('B4 overlapping dates are refused', !r.ok && r.code === 'failed-precondition' && /already booked/.test(r.msg), r);
  r = await call('rentalBook', 'buyer2', { rentalProductId: 'rp2', startDate: day(3), endDate: day(5) });
  ck('B5 paused equipment cannot be booked', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalBook', 'buyer2', { rentalProductId: 'rp1', startDate: 'garbage', endDate: day(5) });
  ck('B6 invalid dates are refused with a reason', !r.ok && r.code === 'invalid-argument', r);

  r = await call('rentalComplete', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C1 a PENDING booking cannot be completed (was status-blind)', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalConfirm', 'stranger', { bookingId: b1, shopId: 'ownerU' });
  ck('C2 a stranger cannot confirm', !r.ok && r.code === 'permission-denied', r);
  r = await call('rentalConfirm', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C3 the owner ACCEPTS the request (requested → accepted, shop identity model)', r.ok && store.get('rentalBookings/' + b1).status === 'accepted', r);
  r = await call('rentalComplete', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4a an accepted (unpaid) rental cannot be completed', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalStart', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4b hand-over is refused until the payment authority has HELD the money', !r.ok && r.code === 'failed-precondition', r);
  /* the payment authority (rental_booking purpose + verified webhook) — never these handlers — moves it to paid_held */
  store.set('rentalBookings/' + b1, Object.assign({}, store.get('rentalBookings/' + b1), { status: 'paid_held', paymentStatus: 'held', paymentMethod: 'MPESA' }));
  r = await call('rentalCancel', 'buyer1', { bookingId: b1 });
  ck('C4c a PAID rental is not cancelled by a status flip (refund policy decides)', !r.ok && /refund policy/.test(r.msg) && store.get('rentalBookings/' + b1).status === 'paid_held', r);
  r = await call('rentalStart', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4d paid_held → active (hand-over)', r.ok && store.get('rentalBookings/' + b1).status === 'active', r);
  r = await call('rentalComplete', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4e an ACTIVE rental cannot be completed before it is returned', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalReportReturn', 'stranger', { bookingId: b1 });
  ck('C4f only the renter reports the return', !r.ok && r.code === 'permission-denied', r);
  r = await call('rentalReportReturn', 'buyer1', { bookingId: b1 });
  ck('C4g renter reports the return → return_pending', r.ok && store.get('rentalBookings/' + b1).status === 'return_pending', r);
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4h seller confirms the equipment is back → returned', r.ok && store.get('rentalBookings/' + b1).status === 'returned', r);
  r = await call('rentalComplete', 'ownerU', { bookingId: b1, shopId: 'ownerU' });
  ck('C4 returned → completed; listing bookingCount +1', r.ok && store.get('rentalBookings/' + b1).status === 'completed' && store.get('rentalProducts/rp1').bookingCount === 1, r);
  r = await call('rentalCancel', 'ownerU', { bookingId: b1 });
  ck('C5 a completed booking cannot be cancelled', !r.ok && r.code === 'failed-precondition', r);

  r = await call('rentalBook', 'buyer2', { rentalProductId: 'rp1', startDate: day(10), endDate: day(11) });
  const b2 = r.r.bookingId;
  r = await call('rentalCancel', 'ownerU', { bookingId: b2, reason: 'machine in service' });
  ck('C6 the SELLER can cancel (no token.shopId claim needed any more)', r.ok && store.get('rentalBookings/' + b2).status === 'cancelled' && store.get('rentalBookings/' + b2).cancelledByRole === 'seller', r);
  r = await call('rentalBook', 'buyer3', { rentalProductId: 'rp1', startDate: day(10), endDate: day(11) });
  ck('C7 the cancelled dates are bookable again', r.ok, r);
  const b3 = r.r.bookingId;
  r = await call('rentalCancel', 'stranger', { bookingId: b3 });
  ck('C8 a stranger cannot cancel someone\'s booking', !r.ok && r.code === 'permission-denied', r);
  r = await call('rentalCancel', 'buyer3', { bookingId: b3 });
  ck('C9 the renter cancels their own booking', r.ok && store.get('rentalBookings/' + b3).cancelledByRole === 'renter', r);
  r = await call('rentalBook', 'buyer4', { rentalProductId: 'rp1', startDate: day(20), endDate: day(21) });
  const b4 = r.r.bookingId;
  r = await call('rentalDecline', 'ownerU', { bookingId: b4, shopId: 'ownerU', reason: 'booked offline' });
  ck('D1 the seller declines a request → declined (terminal)', r.ok && store.get('rentalBookings/' + b4).status === 'declined', r);
  r = await call('rentalComplete', 'ownerU', { bookingId: b4, shopId: 'ownerU' });
  ck('D2 a DECLINED rental cannot be completed', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalComplete', 'ownerU', { bookingId: b3, shopId: 'ownerU' });
  ck('D3 a CANCELLED rental cannot be completed', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalProductCreate', 'ownerU', { shopId: 'ownerU', title: '', pricingType: 'daily', dailyRate: 1000 });
  ck('L1 listing create refuses a missing name WITH a reason (HttpsError, not "unexpected")', !r.ok && r.code === 'invalid-argument' && !r.plain, r);
  r = await call('rentalProductCreate', 'ownerU', { shopId: 'ownerU', title: 'Generator 250kVA', pricingType: 'daily', dailyRate: 12000, deposit: 20000 });
  const np = r.ok ? r.r.rentalProductId : 'x';
  ck('L2 a new listing starts as DRAFT (owner lifecycle)', r.ok && store.get('rentalProducts/' + np).status === 'draft', r);
  r = await call('rentalBook', 'buyer5', { rentalProductId: np, startDate: day(5), endDate: day(6) });
  ck('L3 a draft listing cannot be booked', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalProductPublish', 'stranger', { rentalProductId: np, shopId: 'ownerU' });
  ck('L4 a stranger cannot publish the listing', !r.ok && r.code === 'permission-denied', r);
  r = await call('rentalProductPublish', 'ownerU', { rentalProductId: np, shopId: 'ownerU' });
  ck('L5 the owner publishes: draft → active (Available)', r.ok && store.get('rentalProducts/' + np).status === 'active', r);
  r = await call('rentalProductCreate', 'ownerU', { shopId: 'ownerU', title: 'X', pricingType: 'daily', dailyRate: -5 });
  ck('L6 a negative rate is refused with a reason', !r.ok && r.code === 'invalid-argument', r);
  r = await call('rentalList', null, {});
  ck('E1 signed-out calls get unauthenticated (HttpsError)', !r.ok && r.code === 'unauthenticated' && !r.plain, r);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.stack); process.exit(2); });
