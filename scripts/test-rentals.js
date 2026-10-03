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
const hooks = {};   /* path → fn run AFTER a read returns (race injection) */
const ref = (p) => ({ id: p.split('/').pop(), path: p,
  get: async () => { const snap = { exists: store.has(p), id: p.split('/').pop(), data: ((v) => () => v)(store.get(p)) }; if (hooks[p]) { const h = hooks[p]; delete hooks[p]; h(); } return snap; },
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
  complete_status_blind:  ["    if (b.status !== 'returned') throw new HttpsError('failed-precondition', 'A ' + b.status + ' booking cannot be completed.');", ""],
  settle_outside_txn:     ["    plan.apply(t);\n  });", "  });\n  plan.apply({ update: () => {}, set: () => {}, create: () => {} });"],
  settle_owner_from_caller: ["plan = await RS.settleRentalBooking(t, _db(), { bookingId: String(bookingId), booking: b, ownerUid,", "plan = await RS.settleRentalBooking(t, _db(), { bookingId: String(bookingId), booking: b, ownerUid: req.auth.uid,"],
  receipt_on_refusal:     ["  if (plan.ok && plan.receipt) {\n    const TR", "  if (true) {\n    const TR"],
  complete_refund_due:    ["    if (b.paymentStatus === 'refund_due') throw new HttpsError('failed-precondition', RENTAL_REFUND_DUE_MSG);\n    /* phase 2", "    /* phase 2"],
  paid_cancel_flip:       ["    if (b.status === 'paid_held') throw new HttpsError(", "    if (false) throw new HttpsError("],
  start_before_paid:      ["_rentalTransition(req, { from: ['paid_held'], to: 'active',", "_rentalTransition(req, { from: ['accepted', 'paid_held'], to: 'active',"],
  overlap_unchecked:      ["    if (conflict) throw new HttpsError('failed-precondition', 'Those dates are already booked.');", ""],
  fake_mpesa:             ["paymentMethod: 'none', paymentStatus: 'unpaid',", "paymentMethod: 'mpesa', paymentStatus: 'unpaid',"],
  return_pin_skipped:     ["  if (b0.paymentStatus === 'held') {\n    const v = await _pinCore()", "  if (false) {\n    const v = await _pinCore()"],
  return_race_unguarded:  ["    guard: (b) => { if (b.paymentStatus === 'held' && !pinVerified)", "    guard: (b) => { if (false)"],
  refund_due_unblocked:   ["    if (b.paymentStatus === 'refund_due' && !['declined', 'cancelled'].includes(to))", "    if (false)"],
  return_pin_wrong_owner: ["providerUid: await _shopOwnerUid(shopId), actorUid", "providerUid: req.auth.uid, actorUid"],
};
const M = process.env.RENTAL_MUTANT;
if (M) { const m = MUT[M]; if (!m || src.split(m[0]).length !== 2) { console.error('mutant anchor missing: ' + M); process.exit(2); } src = src.replace(m[0], m[1]); console.log('MUTANT ' + M); }
const tmp = path.join(os.tmpdir(), 'mx-under-test-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
const PIN = { calls: [], verify: async (a) => { PIN.calls.push(a); return a.pin === '4321' ? { ok: true } : { ok: false, reason: a.pin ? 'That PIN does not match this booking.' : 'Ask the renter for their rental PIN.' }; } };
const BW_STUB = { _bw: true }, SD_STUB = { _sd: true };
const TR = { events: [], committedAtCall: [],
  receiptIdFor: (k, id) => k + '_' + id,
  safely: async (db, label, fn) => fn(),
  recordEvent: async (db, id, e) => { TR.events.push({ id, e }); TR.committedAtCall.push(store.has('zzSettleApplied/' + id.replace(/^rental_booking_/, ''))); return { ok: true }; } };
const RS = { quotes: [], settles: [], next: { ok: true },
  quoteRentalSettlement: async (db, a) => { RS.quotes.push(a); return { ok: true, q: 1 }; },
  settleRentalBooking: async (txn, db, a) => { RS.settles.push(a); const n = (a.booking && a.booking.paymentStatus === 'held') ? RS.next : { ok: false, reason: 'not_held' };   /* the module's contract: nothing held → not_held */
    return Object.assign({ receipt: n.ok ? { rentCents: 450000, commissionCents: 45000, netCents: 405000 } : undefined }, n, { apply: (tx) => tx.set(db.collection('zzSettleApplied').doc(a.bookingId), { ok: !!n.ok, reason: n.reason || null }) }); } };
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, f) => f, onRequest: (o, f) => f, HttpsError };
  if (req === 'firebase-functions/v2/scheduler') return { onSchedule: (o, f) => f };
  if (req === 'firebase-admin') return { firestore: firestoreFn };
  if (req === './booking-pin-core') return PIN;
  if (req === './rental-settlement') return RS;
  if (req === './transaction-receipts') return TR;
  if (req === './business-wallet') return BW_STUB;
  if (req === './settlement-destination') return SD_STUB;
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
  ck('C4h1 money HELD: confirming the return WITHOUT the renter\'s PIN is refused (still return_pending)', !r.ok && r.code === 'failed-precondition' && /PIN/.test(r.msg) && store.get('rentalBookings/' + b1).status === 'return_pending', r);
  r = await call('rentalConfirmReturn', 'staffU', { bookingId: b1, shopId: 'ownerU', pin: '1111' });
  ck('C4h2 a WRONG PIN is refused with the PIN authority\'s reason', !r.ok && /does not match/.test(r.msg) && store.get('rentalBookings/' + b1).status === 'return_pending', r);
  const lastV = PIN.calls[PIN.calls.length - 1] || {};
  ck('C4h3 the PIN authority gets source rentalBookings, provider = SHOP OWNER (server-resolved), actor = the staff member typing', lastV.source === 'rentalBookings' && lastV.providerUid === 'ownerU' && lastV.actorUid === 'staffU' && lastV.bookingId === b1, lastV);
  r = await call('rentalConfirmReturn', 'staffU', { bookingId: b1, shopId: 'ownerU', pin: '4321' });
  ck('C4h seller (staff) enters the renter\'s PIN → returned, returnPinVerified stamped', r.ok && store.get('rentalBookings/' + b1).status === 'returned' && store.get('rentalBookings/' + b1).returnPinVerified === true, r);
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

  /* RP — rental PIN at return: state first, legacy unpaid, race */
  const mk = (id, d) => store.set('rentalBookings/' + id, Object.assign({ rentalProductId: 'rp1', shopId: 'ownerU', buyerId: 'buyer9' }, d));
  mk('rpA', { status: 'paid_held', paymentStatus: 'held' });
  const nCalls = PIN.calls.length;
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: 'rpA', shopId: 'ownerU', pin: '4321' });
  ck('RP1 a rental not yet handed over (paid_held) cannot be returned — and the PIN is NOT spent on it', !r.ok && r.code === 'failed-precondition' && PIN.calls.length === nCalls && store.get('rentalBookings/rpA').status === 'paid_held', r);
  mk('rpB', { status: 'active', paymentStatus: 'unpaid' });
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: 'rpB', shopId: 'ownerU' });
  ck('RP2 a legacy UNPAID active rental returns without a PIN (nothing held to release)', r.ok && store.get('rentalBookings/rpB').status === 'returned' && store.get('rentalBookings/rpB').returnPinVerified === false, r);
  mk('rpC', { status: 'active', paymentStatus: 'unpaid' });
  hooks['rentalBookings/rpC'] = () => store.set('rentalBookings/rpC', Object.assign({}, store.get('rentalBookings/rpC'), { paymentStatus: 'held' }));
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: 'rpC', shopId: 'ownerU' });
  ck('RP3 RACE: the payment is held between the read and the transaction → refused, still active (no PIN-less release)', !r.ok && r.code === 'failed-precondition' && /PIN/.test(r.msg) && store.get('rentalBookings/rpC').status === 'active', r);
  mk('rpD', { status: 'return_pending', paymentStatus: 'held', shopId: 'otherShop' });
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: 'rpD', shopId: 'ownerU', pin: '4321' });
  ck('RP4 a booking of ANOTHER shop is refused before any PIN check', !r.ok && r.code === 'permission-denied' && store.get('rentalBookings/rpD').status === 'return_pending', r);
  r = await call('rentalConfirmReturn', 'stranger', { bookingId: b1, shopId: 'ownerU', pin: '4321' });
  ck('RP5 a stranger cannot confirm a return even with the right PIN', !r.ok && r.code === 'permission-denied', r);

  /* S — settlement call contract */
  const lastS = RS.settles.find((s) => s.bookingId === b1) || {};
  const lastQ = RS.quotes[0] || {};
  ck('S1 completing a HELD, PIN-verified rental quotes with the business-wallet deps injected (BW + SD)', lastQ.deps && lastQ.deps.BW === BW_STUB && lastQ.deps.SD === SD_STUB && lastQ.booking && lastQ.booking.paymentStatus === 'held', lastQ);
  ck('S2 the settlement is asked with owner = SHOP OWNER (server-resolved), actor = caller, and the quote', lastS.ownerUid === 'ownerU' && lastS.actorUid === 'ownerU' && lastS.quote && lastS.quote.q === 1 && lastS.booking.returnPinVerified === true, lastS);
  ck('S3 its writes land in the SAME transaction as the completion (applied, outcome stamped released)', store.has('zzSettleApplied/' + b1) && store.get('rentalBookings/' + b1).settlementOutcome === 'released', store.get('rentalBookings/' + b1));
  mk('sU', { status: 'returned', paymentStatus: 'unpaid' });
  const nq = RS.quotes.length;
  r = await call('rentalComplete', 'ownerU', { bookingId: 'sU', shopId: 'ownerU' });
  ck('S4 an UNPAID legacy rental completes with NO quote (nothing held to settle)', r.ok && RS.quotes.length === nq && store.get('rentalBookings/sU').status === 'completed', r);
  mk('sR', { status: 'returned', paymentStatus: 'held', returnPinVerified: true });
  RS.next = { ok: false, reason: 'commission_unpriced' };
  r = await call('rentalComplete', 'staffU', { bookingId: 'sR', shopId: 'ownerU' });
  const sS = RS.settles.find((s) => s.bookingId === 'sR') || {};
  ck('S5a a STAFF completion still settles to the SHOP OWNER (owner never taken from the caller)', sS.ownerUid === 'ownerU' && sS.actorUid === 'staffU', sS);
  ck('S5 a REFUSED settlement still completes the rental, stamps the reason, applies only its review row', r.ok && r.r.settlement === 'commission_unpriced' && store.get('rentalBookings/sR').settlementOutcome === 'commission_unpriced' && store.get('zzSettleApplied/sR').ok === false, r);
  RS.next = { ok: true };
  r = await call('rentalComplete', 'ownerU', { bookingId: 'sR', shopId: 'ownerU' });
  ck('S6 completing again is a no-op (no second settlement call)', r.ok && r.r.unchanged === true && RS.settles.filter((s) => s.bookingId === 'sR').length === 1, r);

  /* R — receipts (sokoni-2f transaction-receipts) */
  const ev1 = TR.events.find((x) => x.id === 'rental_booking_' + b1);
  ck('R1 a released settlement records ONE "released" event on receipt rental_booking_<id>, balanced (fee + net = rent)', ev1 && ev1.e.type === 'released' && ev1.e.amountCents === 450000 && ev1.e.platformFeeCents + ev1.e.providerNetCents === ev1.e.amountCents && ev1.e.opKey === 'release_' + b1, ev1);
  ck('R2 the receipt is written AFTER the completion transaction committed', TR.committedAtCall[TR.events.indexOf(ev1)] === true, TR.committedAtCall);
  ck('R3 a REFUSED settlement records NO receipt event', !TR.events.some((x) => x.id === 'rental_booking_sR'), TR.events.map((x) => x.id));
  ck('R4 an UNPAID completion records NO receipt event', !TR.events.some((x) => x.id === 'rental_booking_sU'), TR.events.map((x) => x.id));

  /* RD — refund_due (sokoni-5b webhook: paid after the rental stopped being payable) */
  mk('rdA', { status: 'active', paymentStatus: 'refund_due' });
  r = await call('rentalConfirmReturn', 'ownerU', { bookingId: 'rdA', shopId: 'ownerU' });
  ck('RD1 a REFUND-DUE active rental cannot be returned (no PIN-less path to a release)', !r.ok && r.code === 'failed-precondition' && /refunded/.test(r.msg) && store.get('rentalBookings/rdA').status === 'active', r);
  mk('rdB', { status: 'returned', paymentStatus: 'refund_due' });
  r = await call('rentalComplete', 'ownerU', { bookingId: 'rdB', shopId: 'ownerU' });
  ck('RD2 a REFUND-DUE returned rental cannot be completed (no settlement)', !r.ok && r.code === 'failed-precondition' && store.get('rentalBookings/rdB').status === 'returned', r);
  mk('rdC', { status: 'requested', paymentStatus: 'refund_due' });
  r = await call('rentalAccept', 'ownerU', { bookingId: 'rdC', shopId: 'ownerU' });
  ck('RD3 a REFUND-DUE request cannot be accepted (would re-open a payable state)', !r.ok && r.code === 'failed-precondition', r);
  r = await call('rentalDecline', 'ownerU', { bookingId: 'rdC', shopId: 'ownerU' });
  ck('RD4 CONTROL: a refund-due request can still be declined (terminal, no money)', r.ok && store.get('rentalBookings/rdC').status === 'declined', r);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.stack); process.exit(2); });
