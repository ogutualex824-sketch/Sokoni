#!/usr/bin/env node
/* test-shop-availability.js — ONE shop availability authority: one evaluator, one server write path, many consumers
 * (2026-09-29, availability completion A1).
 *
 *   node scripts/test-shop-availability.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-shop-availability.js  # functions @ d83b2f3 — failures ARE the defects
 *
 * REAL code on the transactional fake Firestore: functions/shared/shop-hours.js (the evaluator), kasshop
 * (computeEffectiveAvailability · setShopAvailability · getShopAvailability · publicShopState), merchant-identity
 * (staff resolution), availability-enforce (the checkout gate), sokoni-availability-model (browser adapters).
 * Instants are fixed UTC; the shop's zone is Africa/Nairobi (UTC+3) unless stated. 2026-09-28 is a Monday.
 *
 * PROVES
 *   E1  split shift: open with its closing time → CLOSING SOON 15 min before → ON A BREAK, reopening at 14:00
 *   E2  a Friday 22:00–02:00 shift is still open at Saturday 01:00 (the midnight tail)
 *   E3  special hours with times: closed before they start ("opens at 10:00"), open during them
 *   E4  a closed holiday says so, with its label, and when the shop opens next
 *   E5  a temporary closure closes the shop, says when it reopens, and lifts BY ITSELF at `until`
 *   E6  appointment-only businesses read "by appointment", not open/closed
 *   E7  precedence: temporary closure > offline switch > schedule
 *   E8  the SHOP's timezone decides (same instant: Nairobi closed, London open)
 *   E9  a legacy DISPLAY STRING in shops.openingHours is ignored — the shop is not read as "always closed"
 *   E10 back-to-back periods (08–13, 13–18) are one stretch: no false "closing soon" at 12:45
 *   S1  the owner saves the schedule: providerAvailability.hours and shops.openingHours are the SAME object
 *   S2  the server refuses bad input (time, open day with no hours, date out of range, past closure, zone, mode)
 *   S3  a special date the owner removed stops applying (overrides are replaced, not merged)
 *   S4  staff: a manager (manageAvailability) may save; a manager whose owner withdrew it, a cashier, a former
 *       employee and a stranger may not
 *   S5  a healthcare provider's schedule is refused here (its own authority)
 *   S6  settings read: owner canEdit, cashier read-only, stranger refused; the public read returns the verdict
 *   S7  publicShopState carries status, next opening, the public closure note and only UPCOMING special dates
 *   S8  a shop whose only hours are a legacy display STRING publishes no schedule (not the string) and reads as open
 *   C1  checkout: a temporarily closed shop refuses new orders; "orders while closed" OFF refuses outside hours;
 *       ON (the default) still accepts; createCheckoutSession passes the verdict to the gate
 *   B1  the browser evaluator is byte-identical to the server's; the browser model's answers ARE the evaluator's
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = 'd83b2f3';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 280) : '')); } };
let tmp = null;
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'shophours-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, cp.execFileSync('git', ['show', BASE + ':functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  return require(out);
}
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
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: () => ({ value: () => '' }) };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: (e.details && e.details.code) || e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const T = (iso) => Date.parse(iso);

(async () => {
  say('\nSOURCE: ' + (CPM ? `functions @ ${BASE} — failures below ARE the defects` : 'working tree (fix)'));
  const KS = load('kasshop.js');
  const EN = load('availability-enforce.js');
  const CE = (live, sch, at) => { try { return KS.computeEffectiveAvailability(live, sch, at, 180) || {}; } catch (e) { return { error: e.message }; } };
  const HOURS = {
    mon: { closed: false, periods: [{ open: '08:00', close: '13:00' }, { open: '14:00', close: '18:00' }] },
    tue: { closed: false, periods: [{ open: '08:00', close: '13:00' }, { open: '13:00', close: '18:00' }] },
    wed: { closed: true, periods: [] }, thu: { closed: true, periods: [] },
    fri: { closed: false, periods: [{ open: '22:00', close: '02:00' }] }, sat: { closed: true, periods: [] }, sun: { closed: true, periods: [] },
  };
  const S = { hours: HOURS };

  say('\n── E: the evaluator ──');
  const e1a = CE({}, S, T('2026-09-28T07:00:00Z')), e1b = CE({}, S, T('2026-09-28T09:45:00Z')), e1c = CE({}, S, T('2026-09-28T10:30:00Z'));
  ck('E1  split shift: open (closes 13:00) → closing soon at 12:45 → on a break, reopening at 14:00',
    e1a.status === 'open' && e1a.closesAt && e1a.closesAt.time === '13:00' && e1b.status === 'closing_soon' && e1b.minutesToClose === 15
    && e1c.status === 'break' && e1c.opensAt && e1c.opensAt.time === '14:00' && e1c.open === false, { e1a: e1a.status, e1b: e1b.status, e1c: [e1c.status, e1c.opensAt] });
  const e2 = CE({}, S, T('2026-10-02T22:00:00Z'));
  ck('E2  the Friday 22:00–02:00 shift is still open at Saturday 01:00', e2.open === true && e2.closesAt && e2.closesAt.time === '02:00', e2);
  const SP = { hours: HOURS, overrides: { '2026-09-28': { closed: false, periods: [{ open: '10:00', close: '15:00' }], label: 'Stocktaking' } } };
  const e3a = CE({}, SP, T('2026-09-28T06:00:00Z')), e3b = CE({}, SP, T('2026-09-28T08:00:00Z'));
  ck('E3  special hours: closed before they start ("opens at 10:00"), open during them', e3a.open === false && e3a.opensAt && e3a.opensAt.time === '10:00'
    && e3b.open === true && e3b.reason === 'special_hours' && e3b.closesAt && e3b.closesAt.time === '15:00', { e3a: [e3a.status, e3a.opensAt], e3b: [e3b.reason, e3b.closesAt] });
  const e4 = CE({}, { hours: HOURS, overrides: { '2026-09-28': { closed: true, label: 'Public holiday' } } }, T('2026-09-28T07:00:00Z'));
  ck('E4  a closed holiday: closed_today, its label, and the next opening', e4.open === false && e4.reason === 'closed_today' && e4.special && e4.special.label === 'Public holiday'
    && e4.opensAt && e4.opensAt.inDays === 1 && e4.opensAt.time === '08:00', e4);
  const tc = { active: true, until: T('2026-09-28T13:00:00Z'), note: 'Back after stocktaking' };
  const e5a = CE({ temporaryClosure: tc }, S, T('2026-09-28T07:00:00Z')), e5b = CE({ temporaryClosure: tc }, S, T('2026-09-28T14:00:00Z'));
  ck('E5  temporary closure: closed, reopens at 16:00 (when until lands on the timetable), lifts by itself', e5a.status === 'temporarily_closed' && e5a.open === false
    && e5a.opensAt && e5a.opensAt.time === '16:00' && e5a.temporaryClosure && e5a.temporaryClosure.note === 'Back after stocktaking' && e5b.open === true, { e5a: [e5a.status, e5a.opensAt], e5b: e5b.status });
  const e6 = CE({ availabilityMode: 'appointment' }, S, T('2026-09-28T07:00:00Z'));
  ck('E6  appointment-only reads "by appointment"', e6.status === 'appointment' && e6.appointment === true, e6.status);
  const e7a = CE({ online: false, temporaryClosure: tc }, S, T('2026-09-28T07:00:00Z')), e7b = CE({ online: false }, S, T('2026-09-28T07:00:00Z'));
  ck('E7  precedence: temporary closure > offline > schedule', e7a.status === 'temporarily_closed' && e7b.status === 'offline' && e7b.reason === 'offline', [e7a.status, e7b.status]);
  const inst = T('2026-09-28T15:30:00Z');   /* Nairobi 18:30 (closed) · London 16:30 BST (open) */
  const e8n = CE({}, S, inst), e8l = CE({ timezone: 'Europe/London' }, S, inst);
  ck('E8  the shop\'s timezone decides: Nairobi closed, London open, at the same instant', e8n.open === false && e8l.open === true && e8l.timezone === 'Europe/London', [e8n.status, e8l.status]);
  const e9 = CE({}, { hours: 'Mon 08:00–18:00 · Tue 08:00–18:00' }, T('2026-09-28T07:00:00Z'));
  ck('E9  a legacy display STRING is ignored — not read as "always closed"', e9.open === true && e9.reason === 'no_schedule', e9);
  const e10 = CE({}, S, T('2026-09-29T09:45:00Z'));
  ck('E10 back-to-back periods are one stretch: no false "closing soon" at 12:45', e10.status === 'open' && e10.closesAt && e10.closesAt.time === '18:00', [e10.status, e10.closesAt]);

  say('\n── S: the server write path + staff authority ──');
  const OWN = 'owner1';
  await db.doc('users/' + OWN).set({ name: 'Njeri Owner' });
  await db.doc('shops/' + OWN).set({ sellerUid: OWN, ownerId: OWN, name: 'Njeri Kitenge', status: 'active', openingHours: 'Mon 08:00–18:00', hours: 'Mon 08:00–18:00' });
  await db.doc('providerAvailability/' + OWN).set({ uid: OWN, overrides: { '2026-10-20': { closed: true, label: 'Mashujaa Day' }, '2026-10-01': { closed: true } } });
  const save = (uid, data) => KS.setShopAvailability({ auth: { uid, token: {} }, data });
  const sched = { hours: HOURS, overrides: { '2026-10-20': { closed: true, label: 'Mashujaa Day' } } };
  const r1 = await tryv(save(OWN, { schedule: sched, mode: 'hours', timezone: 'Africa/Nairobi', ordersWhenClosed: false }));
  const pa = await get('providerAvailability/' + OWN), sh = await get('shops/' + OWN);
  ck('S1  the owner saves: providerAvailability.hours and shops.openingHours are the SAME object (never a string)', !r1.error && pa && pa.hours && pa.hours.mon.periods.length === 2
    && sh && typeof sh.openingHours === 'object' && JSON.stringify(sh.openingHours) === JSON.stringify(pa.hours) && sh.ordersWhenClosed === false && sh.timezone === 'Africa/Nairobi', { r1: r1.error || r1.success, oh: sh && sh.openingHours, pa: pa && pa.hours, owc: sh && sh.ordersWhenClosed, tz: sh && sh.timezone });
  ck('S3  a removed special date stops applying (overrides replaced, not merged)', pa && pa.overrides && pa.overrides['2026-10-20'] && !pa.overrides['2026-10-01'], pa && pa.overrides);
  const bad = await Promise.all([
    codeOf(save(OWN, { schedule: { hours: { mon: { closed: false, periods: [{ open: '8am', close: '18:00' }] } } } })),
    codeOf(save(OWN, { schedule: { hours: { mon: { closed: false, periods: [] } } } })),
    codeOf(save(OWN, { schedule: { hours: HOURS, overrides: { '1999-01-01': { closed: true } } } })),
    codeOf(save(OWN, { temporaryClosure: { until: Date.now() - 60000 } })),
    codeOf(save(OWN, { timezone: 'Mars/Olympus' })),
    codeOf(save(OWN, { mode: 'always' })),
  ]);
  ck('S2  bad input is refused (time, open day with no hours, date range, past closure, zone, mode)', bad.every((c) => c === 'invalid-argument'), bad);

  /* staff */
  const emp = (uid, role, extra) => db.doc(`shopEmployees/${OWN}_${uid}`).set(Object.assign({ shopId: OWN, uid, role, shopOwnerId: OWN, name: uid + ' Name', active: true }, extra || {}));
  await emp('mgr1', 'manager'); await emp('mgr2', 'manager', { restrictions: ['manageAvailability'] }); await emp('cash1', 'cashier'); await emp('gone1', 'manager', { active: false });
  const staffSave = (uid) => tryv(save(uid, { shopId: OWN, availability: { delivery: false } }));
  const [m1, m2, c1, g1, x1] = await Promise.all([staffSave('mgr1'), staffSave('mgr2'), staffSave('cash1'), staffSave('gone1'), staffSave('stranger')]);
  ck('S4  a manager may save; withdrawn manager, cashier, former employee and stranger may not', m1.success === true && (await get('shops/' + OWN)).delivery === false
    && m2.error === 'NO_CAPABILITY' && c1.error === 'NO_CAPABILITY' && g1.error === 'NOT_AUTHORISED' && x1.error === 'NOT_AUTHORISED', { m1: m1.success || m1.error, m2: m2.error, c1: c1.error, g1: g1.error, x1: x1.error });
  await db.doc('shops/hc1').set({ sellerUid: 'hc1', status: 'active' }); await db.doc('providers/hc1').set({ healthcare: { category: 'clinician' } });
  ck('S5  a healthcare provider\'s schedule is refused here', await codeOf(save('hc1', { schedule: { hours: HOURS } })) === 'HEALTHCARE_OWNED');
  const getA = (uid, data) => tryv(KS.getShopAvailability({ auth: uid ? { uid, token: {} } : null, data }));
  const [so, sc, sx, pub] = await Promise.all([getA(OWN, { settings: true }), getA('cash1', { settings: true, shopId: OWN }), getA('stranger', { settings: true, shopId: OWN }), getA(null, { shopId: OWN })]);
  ck('S6  settings: owner canEdit, cashier read-only, stranger refused; the public read returns the verdict', so.canEdit === true && so.settings && so.settings.hours && so.settings.ordersWhenClosed === false
    && sc.canEdit === false && sc.settings && sx.error === 'NOT_AUTHORISED' && pub && typeof pub.status === 'string', { so: so.canEdit, sc: sc.canEdit, sx: sx.error, pub: pub.status || pub.error });
  await tryv(save(OWN, { temporaryClosure: { until: Date.now() + 2 * 3600000, note: 'Restocking' } }));
  /* a PAST special date in the stored map — it must not be published */
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await db.doc('providerAvailability/' + OWN).set({ overrides: { [past]: { closed: true, label: 'Old closure' } } }, { merge: true });
  const ps = (KS.publicShopState ? await tryv(KS.publicShopState(OWN, OWN)) : {}) || {};
  const av = ps.availability || {};
  ck('S7  publicShopState: status, next opening, the public note, only upcoming special dates', av.status === 'temporarily_closed' && av.temporaryClosure && av.temporaryClosure.note === 'Restocking'
    && ps.schedule && ps.schedule.hours && ps.schedule.overrides && !(past in ps.schedule.overrides) && Object.keys(ps.schedule.overrides).length >= 1
    && !Object.keys(ps.schedule.overrides).some((k) => k < av.date), { st: av.status, note: av.temporaryClosure, ov: ps.schedule && ps.schedule.overrides });
  await db.doc('shops/legacy9').set({ sellerUid: 'legacy9', status: 'active', openingHours: 'Mon–Sat 08:00–18:00' });
  const lg = (KS.publicShopState ? await tryv(KS.publicShopState('legacy9', 'legacy9')) : {}) || {};
  ck('S8  a legacy display-string shop publishes no schedule (not the string) and reads as open', lg.schedule && lg.schedule.hours === null && lg.availability && lg.availability.open === true, lg);

  say('\n── C: checkout ──');
  const prod = { status: 'active' };
  const t1 = EN.itemAvailability(prod, { temporaryClosure: { active: true, until: Date.now() + 3600000 } });
  const closedV = CE({}, S, T('2026-09-28T16:00:00Z'));
  const t2 = EN.itemAvailability(prod, { ordersWhenClosed: false }, closedV);
  const t3 = EN.itemAvailability(prod, {}, closedV);
  const t4 = EN.itemAvailability(prod, { temporaryClosure: { active: true, until: Date.now() - 1000 } });
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const wired = CPM ? /shopVerdict/.test(cp.execFileSync('git', ['show', BASE + ':functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }))
    : /_avail\.itemAvailability\(prod, shopState\[prod\.sellerUid\], shopVerdict\[prod\.sellerUid\]\)/.test(idx) && /kasshop\.verdictFor\(sdoc/.test(idx);
  ck('C1  temporarily closed refuses; orders-while-closed OFF refuses outside hours; ON accepts; an ended closure accepts; checkout passes the verdict',
    t1.available === false && t1.reason === 'temporarily-closed' && t2.available === false && t2.reason === 'closed-now' && t3.available === true && t4.available === true && wired,
    { t1: t1.reason, t2: t2.reason, t3: t3.available, t4: t4.available, wired });

  say('\n── B: one evaluator in the browser ──');
  let b1 = false, detail = null;
  try {
    const srv = fs.readFileSync(path.join(FN, 'shared', 'shop-hours.js'));
    const web = fs.readFileSync(path.join(ROOT, 'sokoni-shop-hours.js'));
    const H = require(path.join(FN, 'shared', 'shop-hours.js'));
    const M = require(path.join(ROOT, 'sokoni-availability-model.js'));
    const at = [T('2026-09-28T07:00:00Z'), T('2026-09-28T10:30:00Z'), T('2026-10-02T22:00:00Z')];
    const same = at.every((t) => JSON.stringify(M.computeEffective(HOURS, null, t)) === JSON.stringify(H.evaluate({ hours: HOURS }, t)));
    b1 = srv.equals(web) && same && M.closesAt(HOURS, null, at[0]) === '13:00' && M.nextOpening(HOURS, null, at[1]).time === '14:00';
    detail = { identical: srv.equals(web), same };
  } catch (e) { detail = e.message; }
  ck('B1  the browser evaluator is byte-identical to the server\'s, and the browser model answers with it', b1, detail);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
