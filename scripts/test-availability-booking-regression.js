#!/usr/bin/env node
/**
 * AVAILABILITY → BOOKING REGRESSION — QUEUED RUNTIME SUITE (emulators only; written 2026-10-03, NOT yet run)
 *
 * Owner (via sokoni-2f, 2026-10-03): availability is a LOCKED PREREQUISITE for certifying paid service bookings.
 *   1. merchant-v2 schedule editor saves through kasshop.setShopAvailability   (this chain, hosting)
 *   2. deploy — only AFTER the functions release carrying the schedule-capable setShopAvailability
 *   3. verify availability is server-authoritative (f3's rules deny on client providerAvailability writes)
 *   4. THIS regression
 * 2f's booking side (commercial-fn 8d127ab): booking-service._prepareSlot consults kasshop.verdictFor at the slot's
 * instant; slot locks are taken inside the booking transaction.
 *
 * RUN (never against production — the suite REFUSES anything else):
 *   firebase emulators:exec --only auth,firestore,functions --project demo-sokoni-avbook \
 *     "node scripts/test-availability-booking-regression.js"
 *   needs: FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST (set by emulators:exec),
 *          SOKONI_FUNCTIONS_EMULATOR_HOST (e.g. 127.0.0.1:5001), project id demo-* (GCLOUD_PROJECT).
 *   the functions emulator must serve 2f's functions (setShopAvailability with `schedule`, providerDispatch with
 *   booking-service @ 8d127ab or later). NOTE `emulators:exec` loads NO rules unless firebase.json points at them —
 *   R2 needs f3's rules loaded explicitly.
 *
 * ROWS
 *   R1 a provider edits ANOTHER provider's availability via setShopAvailability → rejected, and the victim's
 *      providerAvailability document is byte-for-byte unchanged
 *   R2 a direct browser write to providerAvailability → rejected. BLOCKED until f3's rules deny is in the loaded
 *      ruleset (SOKONI_F3_RULES_DENY=<commit> AND the local firestore.rules denies it). BLOCKED is never a pass.
 *   R3 two concurrent bookings of the same slot → exactly one succeeds, exactly one slot lock
 *   R4 booking on a closed date, and during a temporary closure → refused (CLOSED_DATE / TEMPORARILY_CLOSED)
 *   R5 the schedule the editor saved (via the callable) is what verdictFor uses: inside hours books, outside refused
 *   PC positive control — a plain booking inside hours on an open day succeeds. If it does not, the fixture is
 *      wrong: R3–R5 are BLOCKED (fixture), never counted as pass or fail.
 *
 * Paid Education and electronics receipts stay OFF (owner). This suite uses a salon category, fee 0, and never
 * enables or test-enables either.
 *
 * Exit: 0 all executed rows pass and none blocked · 1 any fail · 2 refused (environment) · 3 blocked rows only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ── REFUSE unless this is unambiguously a local demo emulator ────────────── */
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostOf(v) { if (!v) return null; const s = String(v).replace(/^https?:\/\//, ''); const i = s.lastIndexOf(':'); return (i > 0 ? s.slice(0, i) : s).toLowerCase(); }
const ENV = {
  fs: process.env.FIRESTORE_EMULATOR_HOST, auth: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  fn: process.env.SOKONI_FUNCTIONS_EMULATOR_HOST,
  project: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.SOKONI_EMULATOR_PROJECT || '',
};
const refusals = [];
for (const k of ['fs', 'auth', 'fn']) if (!ENV[k] || !LOCAL.has(hostOf(ENV[k]))) refusals.push(k + ' emulator host is not localhost (' + (ENV[k] || 'unset') + ')');
if (!/^demo-/.test(ENV.project)) refusals.push('project "' + (ENV.project || 'unset') + '" is not demo-*');
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) refusals.push('GOOGLE_APPLICATION_CREDENTIALS is set — refusing to hold real credentials');
if (refusals.length) {
  console.log('REFUSED — this suite runs only against local demo-* emulators:' + '\n  · ' + refusals.join('\n  · '));
  process.exit(2);
}

const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: ENV.project });
const db = admin.firestore();

let pass = 0, fail = 0, blocked = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS    ' + n); } else { fail++; console.log('  FAIL    ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
const blk = (n, why) => { blocked++; console.log('  BLOCKED ' + n + ' — ' + why); };

async function signUp(email) {
  const r = await fetch('http://' + ENV.auth + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo-pass-123', returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error('auth emulator signUp failed: ' + JSON.stringify(j).slice(0, 200));
  return { uid: j.localId, token: j.idToken };
}
/** Call a callable on the functions emulator. Resolves { ok, data } or { ok:false, code, message, details }. */
async function call(name, user, data) {
  const r = await fetch('http://' + ENV.fn + '/' + ENV.project + '/us-central1/' + name, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, user ? { authorization: 'Bearer ' + user.token } : {}),
    body: JSON.stringify({ data }) });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (j && 'result' in j) return { ok: true, data: j.result };
  const e = (j && j.error) || {};
  return { ok: false, code: String(e.status || r.status).toLowerCase().replace(/_/g, '-'), message: e.message, details: e.details };
}
const book = (cust, providerId, serviceId, date, startTime, key) =>
  call('providerDispatch', cust, { op: 'bookingCreateService', providerId, serviceId, date, startTime, idempotencyKey: key });
const codeOf = (r) => (r.ok ? null : ((r.details && r.details.code) || r.code));

/* a Monday ≥ 7 days ahead (Nairobi), and the Monday after it */
function mondays() {
  const d = new Date(Date.now() + 7 * 86400000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const a = d.toISOString().slice(0, 10);
  const b = new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  return [a, b];
}
const CLOSED = { closed: true, periods: [] };
const HOURS = { mon: { closed: false, periods: [{ open: '09:00', close: '12:00' }] }, tue: CLOSED, wed: CLOSED, thu: CLOSED, fri: CLOSED, sat: CLOSED, sun: CLOSED };

(async () => {
  console.log('\nAVAILABILITY → BOOKING REGRESSION  project=' + ENV.project + '  fs=' + ENV.fs + '  fn=' + ENV.fn);
  const [MON, MON2] = mondays();
  const P1 = await signUp('p1@demo.test'), P2 = await signUp('p2@demo.test');
  const C1 = await signUp('c1@demo.test'), C2 = await signUp('c2@demo.test');

  /* fixture — shop + provider registry + one free service (fee 0; salon; no Education, no electronics) */
  for (const p of [P1, P2]) {
    await db.doc('shops/' + p.uid).set({ sellerUid: p.uid, status: 'active', name: 'Demo ' + p.uid.slice(0, 5), online: true, acceptingOrders: true });
    await db.doc('providers/' + p.uid).set({ uid: p.uid, status: 'active', acceptsBookings: true, category: 'salon' });
  }
  const SVC = 'svc-' + P1.uid.slice(0, 8);
  await db.doc('providerServices/' + SVC).set({ providerId: P1.uid, name: 'Haircut', active: true, fee: 0, durationMins: 60 });

  /* R5 setup — the EDITOR's save path: the callable, exactly the payload merchant-v2 sends */
  const save = await call('setShopAvailability', P1, { schedule: { hours: HOURS, overrides: {} } });
  if (!save.ok) {
    blk('R1–R5', 'setShopAvailability (schedule) is not served by this emulator: ' + codeOf(save) + ' ' + (save.message || ''));
    return done();
  }

  /* ── R1 ── */
  const before = JSON.stringify((await db.doc('providerAvailability/' + P1.uid).get()).data() || null);
  const r1 = await call('setShopAvailability', P2, { shopId: P1.uid, schedule: { hours: Object.assign({}, HOURS, { tue: { closed: false, periods: [{ open: '00:00', close: '23:00' }] } }), overrides: {} } });
  const after = JSON.stringify((await db.doc('providerAvailability/' + P1.uid).get()).data() || null);
  ck('R1 another provider editing P1\'s availability is rejected (permission-denied)', !r1.ok && r1.code === 'permission-denied', r1);
  ck('R1 …and P1\'s providerAvailability is unchanged', before === after);

  /* ── R2 ── */
  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const f3 = process.env.SOKONI_F3_RULES_DENY;
  const ruleDenies = /match \/providerAvailability\/\{[^}]+\}\s*\{[\s\S]{0,400}allow (?:create, ?update|write|update)[^;]*:\s*if false/.test(RULES);
  if (!f3 || !ruleDenies) {
    blk('R2 direct browser write to providerAvailability rejected', 'f3\'s rules deny is not in the loaded ruleset' + (f3 ? ' (SOKONI_F3_RULES_DENY set, but firestore.rules still permits the owner write)' : ' (SOKONI_F3_RULES_DENY unset)'));
  } else {
    const url = 'http://' + ENV.fs + '/v1/projects/' + ENV.project + '/databases/(default)/documents/providerAvailability/' + P1.uid + '?updateMask.fieldPaths=hours';
    const w = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + P1.token },
      body: JSON.stringify({ fields: { hours: { mapValue: { fields: {} } } } }) });
    ck('R2 the owner\'s own browser write to providerAvailability is rejected by rules (f3 ' + f3 + ')', w.status === 403, w.status);
  }

  /* ── PC: the fixture can book at all ── */
  const pc = await book(C1, P1.uid, SVC, MON, '09:00', 'pc-' + Date.now());
  if (!pc.ok) {
    blk('R3–R5', 'POSITIVE CONTROL failed — a plain in-hours booking was refused (' + codeOf(pc) + ': ' + (pc.message || '') + '); fix the fixture before reading any booking row');
    return done();
  }
  ck('PC a plain booking inside hours on an open Monday succeeds', true);

  /* ── R3 ── */
  const [a, b] = await Promise.all([book(C1, P1.uid, SVC, MON, '10:00', 'r3a-' + Date.now()), book(C2, P1.uid, SVC, MON, '10:00', 'r3b-' + Date.now())]);
  const wins = [a, b].filter((r) => r.ok).length;
  ck('R3 two concurrent bookings of one slot → exactly one succeeds', wins === 1, [codeOf(a), codeOf(b)]);
  const locks = await db.collection('providerAvailability').doc(P1.uid).collection('slotLocks').where('startTime', '==', '10:00').where('date', '==', MON).get();
  ck('R3 …and exactly one slot lock exists for it', locks.size === 1, locks.size);

  /* ── R4 ── closed date and temporary closure, both set through the callable */
  const ov = {}; ov[MON2] = { closed: true, label: 'Holiday' };
  const s4 = await call('setShopAvailability', P1, { schedule: { hours: HOURS, overrides: ov } });
  const r4a = await book(C1, P1.uid, SVC, MON2, '09:00', 'r4a-' + Date.now());
  ck('R4 booking on a closed date is refused', s4.ok && !r4a.ok && /CLOSED_DATE|failed-precondition/.test(codeOf(r4a)), [s4.ok, codeOf(r4a)]);
  const until = Date.parse(MON + 'T09:00:00Z');   /* = 12:00 Nairobi on MON → covers 11:00 */
  const t4 = await call('setShopAvailability', P1, { temporaryClosure: { until } });
  const r4b = await book(C2, P1.uid, SVC, MON, '11:00', 'r4b-' + Date.now());
  ck('R4 booking during a temporary closure is refused (TEMPORARILY_CLOSED)', t4.ok && !r4b.ok && codeOf(r4b) === 'TEMPORARILY_CLOSED', [t4.ok, codeOf(r4b), t4.message]);
  await call('setShopAvailability', P1, { temporaryClosure: null });

  /* ── R5 ── the saved schedule is the one the booking gate reads */
  const r5in = await book(C2, P1.uid, SVC, MON, '11:00', 'r5in-' + Date.now());
  const r5out = await book(C2, P1.uid, SVC, MON, '14:00', 'r5out-' + Date.now());
  ck('R5 inside the saved hours (Mon 11:00) books', r5in.ok, codeOf(r5in));
  ck('R5 outside the saved hours (Mon 14:00) is refused (out-of-range)', !r5out.ok && codeOf(r5out) === 'out-of-range', codeOf(r5out));
  const s5 = await call('setShopAvailability', P1, { schedule: { hours: Object.assign({}, HOURS, { mon: { closed: false, periods: [{ open: '13:00', close: '17:00' }] } }), overrides: {} } });
  const r5flip = await book(C1, P1.uid, SVC, MON, '14:00', 'r5flip-' + Date.now());
  ck('R5 re-saving the schedule moves the gate with it (Mon 14:00 now books)', s5.ok && r5flip.ok, [s5.ok, codeOf(r5flip)]);

  done();
})().catch((e) => { fail++; console.log('  FAIL    harness crashed: ' + (e && e.stack || e)); done(); });

function done() {
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + blocked + ' blocked');
  process.exit(fail ? 1 : blocked ? 3 : 0);
}
