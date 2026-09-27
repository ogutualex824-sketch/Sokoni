/* test-healthcare-availability.js — Healthcare appointments use the ONE availability authority (CHANGELOG 234).
 *
 * The REAL functions/ent-availability.js, shared/ent-availability-core.js, booking-service.js, availability.js and
 * healthcare-hub.js on the transactional fake Firestore (optimistic retry, strict read order), plus the REAL
 * sokoni-health-workspace.js routing under a minimal page stub. No network, no production.
 *
 * PROVES — for a server-classified Healthcare provider (providers/{uid}.healthcare, application role `health`)
 *   commission   the booking is a Healthcare booking (commissionHub 'healthcare')
 *   hours        outside working hours and on a closed weekday is refused; a break is refused
 *   duration     the slot is the configured appointment length
 *   buffers      a buffer after an appointment closes the next slot; beyond it opens
 *   blackouts    a closed date (closedDates), a closed override (overrides/{date}) and vacation all refuse
 *   notice       inside the minimum notice is refused; beyond the horizon is refused
 *   limits       the per-day limit refuses the next appointment of the day
 *   atomic       12 patients race ONE slot → exactly one booking; 12 race OVERLAPPING windows → one
 *   config       the provider edits availability through entAvailSetConfig (server) and it takes effect
 *   legacy       bookAppointment (healthSlotLocks, 30-minute buckets, no payment) is RETIRED and writes nothing
 *   dashboard    for a Healthcare workspace the quick actions and the editor call the server callables — never a
 *                direct Firestore write — and show success only after the server answered
 *
 *   node scripts/test-healthcare-availability.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hc-availability';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const REAL_NOW = Date.now();
let NOW = REAL_NOW;
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const CORE = require(Path.join(FN, 'shared', 'ent-availability-core.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const HUB = require(Path.join(FN, 'healthcare-hub.js'));
AV._setClock(() => NOW);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function errCode(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || 'error'; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const M = 60e3;
const today = CORE.dateOf(REAL_NOW);
const D10 = CORE.addDays(today, 10);
const DOW_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dowOf = (date) => DOW_LONG[new Date(CORE.dayStartMs(date) + 12 * 3600e3).getUTCDay()];
/* A clinic week: 08:00–17:00 with a 12:00–13:00 lunch break, closed on the weekday of D10+1. */
const CLOSED_DAY = CORE.addDays(D10, 1);
function week() {
  const w = {};
  DOW_LONG.forEach((d) => { w[d] = { closed: false, periods: [{ open: '08:00', close: '17:00' }], breaks: [{ start: '12:00', end: '13:00' }] }; });
  w[dowOf(CLOSED_DAY)] = { closed: true, periods: [], breaks: [] };
  return w;
}
async function seedHc(uid, cfgExtra) {
  await db.doc(`providers/${uid}`).set({ name: uid, status: 'active', acceptsBookings: true, healthcare: { category: 'clinician', source: 'admin' } });
  await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: 'health', category: 'doctor' });
  await db.doc(`providerAvailability/${uid}`).set(Object.assign({ uid, modes: ['fixed_hours'], schedule: week(),
    appt: { enabled: true, durationMins: 30, bufferMins: 0, travelMins: 0, maxDaysAhead: 60, minNoticeHours: 2, allowSameDay: true }, cap: {} }, cfgExtra || {}));
  await db.doc(`providerServices/svc_${uid}`).set({ providerId: uid, name: 'General consultation', price: 150000, fee: 0, deposit: 0, durationMins: 30, active: true });
  await db.doc(`users/${uid}`).set({ displayName: uid });
}
const book = (patient, provider, date, time) => BS._h.bookingCreateService({ ...who(patient), data: { providerId: provider, serviceId: 'svc_' + provider, date, startTime: time } });

(async () => {
  for (let i = 0; i < 14; i++) await db.doc(`users/pt${i}`).set({ displayName: 'Patient ' + i });

  say('\n── a Healthcare booking through the ONE authority ──');
  await seedHc('dr1');
  const b1 = await book('pt0', 'dr1', D10, '09:00').catch((e) => ({ error: (e.details && e.details.code) || e.message }));
  const bk = b1 && b1.bookingId ? await get('providerBookings/' + b1.bookingId) : null;
  ck('a patient books an open slot', !!(bk && bk.providerId === 'dr1'), b1);
  ck('…and it is a Healthcare booking (commissionHub "healthcare")', bk && bk.commissionHub === 'healthcare', bk && bk.commissionHub);
  const items = ((await get(`entAvailability/svc_dr1/months/${CORE.monthOf(D10)}`)) || { items: [] }).items;
  ck('the slot is claimed on the provider\'s calendar (svc_dr1) for the configured 30 minutes', items.some((it) => it.e - it.s === 30 * M), items.map((i) => (i.e - i.s) / M));

  say('\n── hours, breaks, closed days ──');
  ck('before opening (07:00) is refused', !!(await errCode(book('pt1', 'dr1', D10, '07:00'))));
  ck('after closing (17:30) is refused', !!(await errCode(book('pt1', 'dr1', D10, '17:30'))));
  ck('the lunch break (12:00) is refused', !!(await errCode(book('pt1', 'dr1', D10, '12:00'))));
  ck('a closed weekday is refused', !!(await errCode(book('pt1', 'dr1', CLOSED_DAY, '09:00'))));

  say('\n── buffers ──');
  await seedHc('dr2', { appt: { enabled: true, durationMins: 30, bufferMins: 30, travelMins: 0, maxDaysAhead: 60, minNoticeHours: 2, allowSameDay: true } });
  ck('dr2: 10:00 books', !(await errCode(book('pt2', 'dr2', D10, '10:00'))));
  ck('a 30-minute buffer refuses 10:30 (ends inside the buffer)', !!(await errCode(book('pt3', 'dr2', D10, '10:30'))));
  /* What the patient is SHOWN must agree with what booking DOES — for every slot around the buffer. */
  const shownNow = async (t) => {
    const day = await AV._h.entAvailDay({ ...who(null), data: { providerId: 'dr2', serviceId: 'svc_dr2', date: D10 } });
    return ((day.slots || []).find((x) => x.start === t) || {}).state;
  };
  const agree = [];
  for (const [t, p] of [['10:30', 'pt11'], ['11:00', 'pt10'], ['11:30', 'pt11']]) {
    const shown = await shownNow(t);          /* read the calendar IMMEDIATELY before each attempt */
    const c = await errCode(book(p, 'dr2', D10, t));
    agree.push({ t, shown, booked: !c, code: c });
  }
  ck('the public calendar and the booking agree on every slot around the buffer (no bookable-looking slot is refused)',
    agree.every((x) => (x.shown === 'AVAILABLE') === x.booked), agree);
  ck('…with the buffer meeting, not doubled: 11:00 books right after a 10:00–10:30 + 30-minute buffer', agree[1].booked === true, agree[1]);

  say('\n── blackouts ──');
  const B1 = CORE.addDays(D10, 3), B2 = CORE.addDays(D10, 4), V1 = CORE.addDays(D10, 6);
  await seedHc('dr3', { closedDates: { [B1]: true }, isOnVacation: false });
  await db.doc(`providerAvailability/dr3/overrides/${B2}`).set({ date: B2, closed: true, periods: [] });
  ck('a closed date (closedDates) is refused', !!(await errCode(book('pt4', 'dr3', B1, '09:00'))));
  ck('a closed override (overrides/{date}) is refused', !!(await errCode(book('pt4', 'dr3', B2, '09:00'))));
  await seedHc('dr4', { isOnVacation: true, vacationStartDate: today, vacationEndDate: CORE.addDays(today, 30) });
  ck('a provider on vacation is refused', !!(await errCode(book('pt4', 'dr4', V1, '09:00'))));
  ck('(control) an open date for dr3 books', !(await errCode(book('pt4', 'dr3', CORE.addDays(D10, 5), '09:00'))));

  say('\n── notice and horizon ──');
  const soon = new Date(REAL_NOW + 30 * M);
  const soonDate = CORE.dateOf(soon.getTime());
  const hh = String(Math.floor(CORE.toMins(CORE.timeOf ? CORE.timeOf(soon.getTime()) : '00:00') / 60)).padStart(2, '0');
  const soonCode = await errCode(book('pt5', 'dr3', soonDate, `${hh}:${soon.getMinutes() < 30 ? '30' : '00'}`));
  ck('inside the 2-hour minimum notice is refused', !!soonCode, soonCode);
  ck('beyond the 60-day horizon is refused', !!(await errCode(book('pt5', 'dr3', CORE.addDays(today, 75), '09:00'))));

  say('\n── booking limits ──');
  await seedHc('dr5', { cap: { maxPerDay: 2 } });
  ck('dr5 (2 per day): the 1st books', !(await errCode(book('pt6', 'dr5', D10, '09:00'))));
  ck('…the 2nd books', !(await errCode(book('pt7', 'dr5', D10, '10:00'))));
  ck('…the 3rd of the day is refused', !!(await errCode(book('pt8', 'dr5', D10, '11:00'))));

  say('\n── atomic protection ──');
  await seedHc('dr6');
  const race = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => book('pt' + i, 'dr6', D10, '14:00')));
  ck('12 patients race ONE slot → exactly one booking', race.filter((r) => r.status === 'fulfilled').length === 1, race.map((r) => r.status === 'fulfilled' ? 'ok' : ((r.reason.details && r.reason.details.code) || r.reason.code)).join(','));
  await seedHc('dr7', { appt: { enabled: true, durationMins: 60, bufferMins: 0, travelMins: 0, maxDaysAhead: 60, minNoticeHours: 2, allowSameDay: true } });
  await db.doc('providerServices/svc_dr7').set({ providerId: 'dr7', name: 'Long consultation', price: 150000, fee: 0, deposit: 0, durationMins: 60, active: true });
  const race2 = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => book('pt' + i, 'dr7', D10, i % 2 ? '14:00' : '14:30')));
  ck('12 patients race OVERLAPPING windows (14:00–15:00 vs 14:30–15:30) → exactly one wins', race2.filter((r) => r.status === 'fulfilled').length === 1, race2.filter((r) => r.status === 'fulfilled').length);
  const all = (await db.collection('providerBookings').get()).docs.map((d) => d.data()).filter((b) => b.providerId === 'dr6' || b.providerId === 'dr7');
  ck('no duplicate booking document was written by the losers', all.length === 2, all.length);

  say('\n── the provider edits availability through the server ──');
  const B3 = CORE.addDays(D10, 7);
  const set = await AV._h.entAvailSetConfig({ ...who('dr1'), data: { config: { closedDates: [B3], maxPerDay: 1 } } }).catch((e) => ({ error: (e.details && e.details.code) || e.message }));
  ck('entAvailSetConfig saves a Healthcare provider\'s closed date and per-day limit', !set.error, set);
  ck('…and the authority applies it: that date is refused', !!(await errCode(book('pt9', 'dr1', B3, '09:00'))));
  ck('…another provider cannot edit dr1\'s calendar', !!(await errCode(AV._h.entAvailSetConfig({ ...who('dr2'), data: { providerId: 'dr1', config: { closedDates: [] } } }))) || (await get('providerAvailability/dr1')).closedDates[B3] === true);

  say('\n── the legacy healthcare booking path is retired ──');
  await db.doc('healthProviders/legacy1').set({ name: 'Legacy', status: 'active', consultationFee: 1000 });
  const before = (await db.collection('healthAppointments').get()).docs.length + (await db.collection('healthSlotLocks').get()).docs.length;
  const lc = await errCode(HUB.bookAppointment.run({ ...who('pt0'), data: { providerId: 'legacy1', dateTime: new Date(REAL_NOW + 5 * 86400e3).toISOString(), idempotencyKey: 'k_legacy_1' } }));
  const after = (await db.collection('healthAppointments').get()).docs.length + (await db.collection('healthSlotLocks').get()).docs.length;
  ck('bookAppointment refuses with HEALTH_BOOKING_MOVED', lc === 'HEALTH_BOOKING_MOVED', lc);
  ck('…and writes no appointment and no slot lock', before === after, { before, after });
  ck('no page loads its only client caller (sokoni-health.js)', !fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).some((f) => fs.readFileSync(Path.join(ROOT, f), 'utf8').includes('sokoni-health.js')));

  say('\n── the dashboard routes a Healthcare workspace to the server ──');
  const CALLS = []; const TOASTS = []; const DIRECT = [];
  const directRef = { set: async () => { DIRECT.push('set'); }, delete: async () => { DIRECT.push('delete'); }, collection: () => ({ doc: () => directRef }) };
  let wsOpened = null;
  global.window = {};
  global.firebase = {
    functions: () => ({ httpsCallable: (name) => async (data) => { CALLS.push({ name, op: data.op, data }); if (data.op === 'setVacationMode' && data.active && !data.endDate) throw new Error('endDate required'); return { data: { success: true } }; } }),
    firestore: () => ({ collection: () => ({ doc: () => directRef }) }),
  };
  global.WS = { open: (s) => { wsOpened = s; } };
  global.prompt = (() => { const q = ['2099-01-10', '2099-01-01', '2099-01-05']; return () => q.shift(); })();
  global.alert = () => {};
  window.toast = (m, k) => TOASTS.push({ m, k }); window.showLoad = () => {}; window.hideLoad = () => {};
  window.AvQ = { _refresh() {}, openToday: async () => DIRECT.push('page-openToday'), emergencyClose: async () => DIRECT.push('page-close'), blockDate: async () => DIRECT.push('page-block'), vacation: async () => DIRECT.push('page-vac') };
  window.AvE = { open: () => DIRECT.push('page-AvE') };
  global.document = { readyState: 'complete', documentElement: { setAttribute() {} }, head: { appendChild() {} }, createElement: () => ({}),
    querySelectorAll: () => [], getElementById: () => null, addEventListener() {} };
  new Function(fs.readFileSync(Path.join(ROOT, 'sokoni-health-workspace.js'), 'utf8'))();
  window.SokoniHealthWorkspace.apply({ healthcare: true, category: 'clinician', classified: true, label: 'Doctor', customersLabel: 'Patients', plan: { found: false }, blocked: {}, sections: [] });
  await window.AvQ.blockDate();
  await window.AvQ.emergencyClose();
  await window.AvQ.openToday();
  await window.AvQ.vacation();
  window.AvE.open();
  const ops = CALLS.map((c) => c.op);
  ck('block a date → addAvailabilityOverride (closed) through bookingDispatch', CALLS.some((c) => c.name === 'bookingDispatch' && c.op === 'addAvailabilityOverride' && c.data.date === '2099-01-10' && c.data.closed === true), ops);
  ck('close today → addAvailabilityOverride for today', CALLS.filter((c) => c.op === 'addAvailabilityOverride').length === 2);
  ck('open today → removeAvailabilityOverride then setVacationMode(false)', ops.join().includes('removeAvailabilityOverride,setVacationMode') && CALLS.some((c) => c.op === 'setVacationMode' && c.data.active === false));
  ck('vacation → setVacationMode with a start AND an end date', CALLS.some((c) => c.op === 'setVacationMode' && c.data.active === true && c.data.startDate === '2099-01-01' && c.data.endDate === '2099-01-05'));
  ck('the editor opens the server-backed workspace editor', wsOpened === 'availability');
  ck('NOTHING was written to Firestore from the page, and no page handler ran', DIRECT.length === 0, DIRECT);
  ck('success toasts appear only after a server answer (one per action)', TOASTS.filter((t) => t.k !== 'err').length === 4, TOASTS);
  CALLS.length = 0; TOASTS.length = 0;
  global.firebase.functions = () => ({ httpsCallable: () => async () => { throw new Error('Server said no'); } });
  global.prompt = () => '2099-02-02';
  await window.AvQ.blockDate();
  ck('a server refusal shows an error and no success', TOASTS.length === 1 && TOASTS[0].k === 'err', TOASTS);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
