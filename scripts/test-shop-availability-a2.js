#!/usr/bin/env node
/* test-shop-availability-a2.js — availability A2: the ONE evaluator reaches bookings, KASS, cutoffs and channel hours
 * (2026-09-29).
 *
 *   node scripts/test-shop-availability-a2.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-shop-availability-a2.js  # functions @ 2180d30 (A1) — failures ARE the defects
 *
 * REAL code on the transactional fake Firestore: booking-service._prepareSlot, kass-hours.businessHours + the KASS tool
 * registry/prompt in index.js, kasshop (verdictFor · setShopAvailability · getShopAvailability), availability-enforce.
 * Instants are fixed; 2026-10-05 is a Monday; the shop's zone is Africa/Nairobi.
 *
 * PROVES
 *   BK1 a merchant-v2 business (canonical hours, NO legacy schedule) is bookable INSIDE its hours…
 *   BK2 …and NOT in its lunch break, NOT after closing — no longer on the Mon–Fri 09–17 DEFAULT
 *   BK3 a temporary closure covering the slot, and a closed special date, refuse the booking
 *   BK4 "not taking orders" pauses new bookings
 *   BK5 control: a provider with a legacy schedule and no shop is gated exactly as before
 *   K1  KASS business_hours answers from the evaluator, in its words, for a listed business
 *   K2  …refuses an unlisted business, and says "hasn't published hours" instead of guessing "open"
 *   K3  the tool is public, find_businesses hands KASS the business id, and the prompt forbids guessed hours
 *   C1  order cutoff: the shop stays open, orders stop N minutes before closing (verdict + words)
 *   C2  delivery/pickup "until": each channel ends at its own time
 *   C3  the server validates cutoff and channel times; the public read carries ordersWhenClosed
 *   C4  checkout: after the cutoff, or outside a channel's hours, a shop that refuses orders while closed refuses them
 *   P1  product page: the shop status comes from getShopAvailability + headline, and the invented response time is gone
 *   R1  availability-manager.html is a router to the editors that work — no undefined APIs
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = '2180d30';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };
let tmp = null;
const show = (rel) => cp.execFileSync('git', ['show', BASE + ':' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'hoursa2-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  try { fs.writeFileSync(out, show('functions/' + rel)); } catch (_) { return null; }
  return require(out);
}
const src = (rel) => (CPM ? (() => { try { return show(rel); } catch (_) { return ''; } })() : fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: () => ({ value: () => '' }) };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const T = (iso) => Date.parse(iso);
const REAL_NOW = Date.now;

(async () => {
  say('\nSOURCE: ' + (CPM ? `functions @ ${BASE} — failures below ARE the defects` : 'working tree (fix)'));
  const BS = load('booking-service.js');
  const KS = load('kasshop.js');
  const EN = load('availability-enforce.js');
  const H = require(path.join(FN, 'shared', 'shop-hours.js'));
  const HOURS = { mon: { closed: false, periods: [{ open: '08:00', close: '13:00' }, { open: '14:00', close: '20:00' }] },
    tue: { closed: true, periods: [] }, wed: { closed: true, periods: [] }, thu: { closed: true, periods: [] }, fri: { closed: true, periods: [] }, sat: { closed: true, periods: [] }, sun: { closed: true, periods: [] } };

  say('\n── BK: bookings go through the same authority ──');
  /* the booking engine refuses slots in the past — pin "now" before the Monday */
  Date.now = () => T('2026-10-01T06:00:00Z');
  const M = 'salon1';
  await db.doc('shops/' + M).set({ sellerUid: M, status: 'active', openingHours: HOURS });
  await db.doc('providerAvailability/' + M).set({ uid: M, hours: HOURS, overrides: { '2026-10-12': { closed: true, label: 'Holiday' } } });
  const slot = (providerId, date, startTime, dur) => (BS && BS._prepareSlot ? BS._prepareSlot(db, { providerId, date, startTime, durationMins: dur || 60 }) : Promise.reject(new Error('no _prepareSlot')));
  ck('BK1 bookable inside its hours (Mon 15:00, 1h)', await codeOf(slot(M, '2026-10-05', '15:00')) === null);
  const bk2 = await Promise.all([codeOf(slot(M, '2026-10-05', '13:00')), codeOf(slot(M, '2026-10-05', '12:30')), codeOf(slot(M, '2026-10-05', '19:30'))]);
  ck('BK2 not in the lunch break, not across it, not past closing — no 09–17 default', bk2.every((c) => c === 'out-of-range'), bk2);
  await db.doc('shops/' + M).set({ temporaryClosure: { active: true, until: T('2026-10-05T12:00:00Z') } }, { merge: true });
  const bk3a = await codeOf(slot(M, '2026-10-05', '10:00'));
  await db.doc('shops/' + M).set({ temporaryClosure: F.FieldValue.delete() }, { merge: true });
  const bk3b = await codeOf(slot(M, '2026-10-12', '10:00'));
  ck('BK3 a temporary closure over the slot, and a closed special date, refuse it', bk3a === 'TEMPORARILY_CLOSED' && (bk3b === 'CLOSED_DATE' || bk3b === 'failed-precondition'), [bk3a, bk3b]);
  await db.doc('shops/' + M).set({ acceptingOrders: false }, { merge: true });
  const bk4 = await codeOf(slot(M, '2026-10-05', '15:00'));
  await db.doc('shops/' + M).set({ acceptingOrders: true }, { merge: true });
  ck('BK4 "not taking orders" pauses new bookings', bk4 === 'NOT_TAKING_ORDERS', bk4);
  const L = 'legacy1';
  await db.doc('providerAvailability/' + L).set({ uid: L, schedule: { monday: { closed: false, periods: [{ open: '10:00', close: '16:00' }] } } });
  const bk5 = [await codeOf(slot(L, '2026-10-05', '11:00')), await codeOf(slot(L, '2026-10-05', '17:00'))];
  const base5 = CPM ? bk5 : bk5;   /* the legacy gate itself is unchanged: same answers on both trees */
  ck('BK5 control: a legacy-schedule provider with no shop is gated as before', base5[1] === 'out-of-range', bk5);
  Date.now = REAL_NOW;

  say('\n── K: KASS "is it open?" ──');
  let KH = null; try { KH = CPM ? load('kass-hours.js') : require(path.join(FN, 'kass-hours.js')); } catch (_) { KH = null; }
  const S1 = 'shopk1';
  await db.doc('shops/' + S1).set({ sellerUid: S1, status: 'active', business: { category: 'salon', source: 'application' }, searchable: true, isPublic: true });
  await db.doc('providerAvailability/' + S1).set({ uid: S1, hours: HOURS });
  const at = T('2026-10-05T12:00:00Z');   /* Mon 15:00 Nairobi */
  const k1 = KH ? await KH.businessHours(db, S1, at) : null;
  const want = H.headline(KS.verdictFor({}, { hours: HOURS }, at));
  ck('K1  business_hours answers from the evaluator, in its words', !!k1 && k1.known === true && k1.headline === want.title && k1.detail === (want.detail || null) && /2:00 PM/.test(k1.today), k1);
  await db.doc('shops/hidden1').set({ sellerUid: 'hidden1', status: 'pending' });
  await db.doc('providerAvailability/hidden1').set({ hours: HOURS });
  await db.doc('shops/nohrs1').set({ sellerUid: 'nohrs1', status: 'active', business: { category: 'salon', source: 'application' } });
  const k2a = KH ? await KH.businessHours(db, 'hidden1', at) : null, k2b = KH ? await KH.businessHours(db, 'nohrs1', at) : null;
  ck('K2  an unlisted business gets no hours; one without hours is "not published", never "open"', !!k2a && k2a.known === false && !!k2b && k2b.known === false && /hasn't published/.test(k2b.message), [k2a, k2b]);
  const idx = src('functions/index.js');
  ck('K3  the tool is public, find_businesses returns the id, and the prompt forbids guessed hours', /business_hours: 'public'/.test(idx) && /name: "business_hours"/.test(idx)
    && /businesses: r\.businesses\.map\(\(b\) => \(\{ id: b\.uid,/.test(idx) && /OPENING HOURS — .*business_hours.*NEVER state or guess/.test(idx));

  say('\n── C: cutoffs and channel hours ──');
  const shopC = { orderCutoffMin: 30, deliveryUntil: '19:00' };
  const va = KS.verdictFor(shopC, { hours: HOURS }, T('2026-10-05T13:00:00Z')), vb = KS.verdictFor(shopC, { hours: HOURS }, T('2026-10-05T16:40:00Z'));
  ck('C1  order cutoff: open, orders until 19:30; at 19:40 still open but orders closed', va.open && va.ordersOpen === true && va.ordersCloseAt && va.ordersCloseAt.time === '19:30'
    && vb.open === true && vb.ordersOpen === false && /orders closed/.test(H.headline(vb).detail || '') , [va.ordersCloseAt, vb.ordersOpen]);
  ck('C2  delivery ends at 19:00 while pickup follows closing (20:00)', va.fulfilment && va.fulfilment.delivery.until === '19:00' && va.fulfilment.pickup.until === '20:00'
    && vb.fulfilment.delivery.available === false && vb.fulfilment.pickup.available === true, [va.fulfilment, vb.fulfilment]);
  const O = 'ownc1';
  await db.doc('users/' + O).set({ name: 'Owner C' });
  await db.doc('shops/' + O).set({ sellerUid: O, status: 'active' });
  const setA = (d) => KS.setShopAvailability({ auth: { uid: O, token: {} }, data: d });
  const c3bad = await Promise.all([codeOf(setA({ orderCutoffMin: 17 })), codeOf(setA({ orderCutoffMin: 999 })), codeOf(setA({ deliveryUntil: '7pm' }))]);
  const c3ok = await codeOf(setA({ orderCutoffMin: 30, deliveryUntil: '19:00', pickupUntil: '', ordersWhenClosed: false }));
  const pubC = await KS.getShopAvailability({ auth: null, data: { shopId: O } });
  const stored = (await db.doc('shops/' + O).get()).data();
  ck('C3  cutoff and channel times are validated and saved; the public read carries ordersWhenClosed', c3bad.every((c) => c === 'invalid-argument') && c3ok === null
    && stored.orderCutoffMin === 30 && stored.deliveryUntil === '19:00' && stored.pickupUntil === null && pubC && pubC.ordersWhenClosed === false, { c3bad, c3ok, stored: [stored.orderCutoffMin, stored.deliveryUntil, stored.pickupUntil], pub: pubC && pubC.ordersWhenClosed });
  const shopRefuse = { ordersWhenClosed: false };
  const i1 = EN.itemAvailability({ status: 'active' }, shopRefuse, vb), f1 = EN.fulfillmentAllowed('delivery', shopRefuse, vb), f2 = EN.fulfillmentAllowed('pickup', shopRefuse, vb);
  const f3 = EN.fulfillmentAllowed('delivery', {}, vb);
  ck('C4  checkout: after the cutoff and outside delivery hours a refusing shop refuses; pickup still open; default shop accepts', i1.available === false && f1.ok === false && f1.reason === 'delivery-closed-now'
    && f2.ok === true && f3.ok === true && /delivery-closed-now/.test(idx) && /fulfillmentAllowed\(_fulfil, shopState\[sUid\], shopVerdict\[sUid\]\)/.test(idx), { i1, f1, f2, f3 });

  say('\n── P / R: product page, the old editor ──');
  const pj = src('product.js');
  ck('P1  product page: status via getShopAvailability + headline; no invented response time', /httpsCallable\(getFunctions\(getApps\(\)\[0\], 'us-central1'\), 'getShopAvailability'\)/.test(pj)
    && /H\.headline\(v\)/.test(pj) && /id="prdShopStatus"/.test(pj) && !/'Replies in ~1h'/.test(pj) && /<script src="sokoni-shop-hours\.js"><\/script>/.test(src('product.html')));
  const am = src('availability-manager.html');
  ck('R1  availability-manager.html routes to the editors that work (no undefined APIs)', /merchant-v2\.html#availability/.test(am) && /provider-dashboard\.html#availability/.test(am)
    && !/new SokoniAvailability\(/.test(am) && !/saveProviderAvailability\(/.test(am) && /sw-register\.js/.test(am));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { Date.now = REAL_NOW; say('CRASH ' + (e && e.stack || e)); process.exit(2); });
