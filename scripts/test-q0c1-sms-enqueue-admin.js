'use strict';
/**
 * CERTIFICATION — Q0c-1: the `smsEnqueue` callable is admin-only.
 *
 * Runs the REAL callable (`.run`) and the REAL internal `enqueue()` against the Firestore EMULATOR. Nothing is SENT:
 * the callable only writes `smsQueue`; delivery is the worker's, which is not invoked here. Pointed at the pre-Q0c-1
 * tree (REPAIR_ROOT = export of ceb82bf) any signed-in account queues an OTP / payment message to any number and can
 * pre-claim a victim's dedupe key; on this tree every non-admin path is refused BEFORE anything is queued, while the
 * admin callable and the internal server authority behave exactly as before.
 *
 *   Admin = the server-minted custom claim `admin` or `superAdmin` (the rules' isAdmin()). A `users/{uid}.roles`
 *   field is NOT an admin credential here: a ruleset that does not guard `roles` would let a user write it.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0c1';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 120s\n'); process.exit(3); }, 120000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

let SMS;
try { SMS = require(path.join(FN, 'sms-service.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const call = (uid, token, data) => res(quiet(() => SMS.smsEnqueue.run({ data, auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null,
  rawRequest: { headers: {} }, acceptsStreaming: false })));
const why = (r) => (r.ok ? 'QUEUED ' + JSON.stringify(r.out) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 50));
const queued = async () => (await db.collection('smsQueue').get()).size;
const denied = (r) => !r.ok && r.code === 'permission-denied' && /Admin access required/.test(r.msg);
const VICTIM = '+254700000999';
const OTP = { to: VICTIM, template: 'otp', vars: { code: '123456' } };

(async () => {
  process.stdout.write(`\nQ0c-1 — smsEnqueue is admin-only   (tree: ${ROOT})\n\n`);
  await db.doc('users/q0c1-forged').set({ roles: ['admin', 'superadmin'] });   /* a field, NOT a credential */

  process.stdout.write('[X] no non-admin path queues anything\n');
  { const q0 = await queued(); const r = await call(null, null, OTP);
    ok(!r.ok && r.code === 'unauthenticated' && (await queued()) === q0, 'X-0', 'anonymous: ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-user', {}, OTP);
    ok(denied(r) && (await queued()) === q0, 'X-1', 'a signed-in NON-admin sending a real-looking OTP to any number: ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-user', {}, { to: VICTIM, template: 'payment_success', vars: { amount: '50,000' } });
    ok(denied(r) && (await queued()) === q0, 'X-2', 'a non-admin forging a payment_success message: ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-forged', {}, OTP);
    ok(denied(r) && (await queued()) === q0, 'X-3', 'users/{uid}.roles = [admin, superadmin] with NO admin claim is not an admin: ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-rolestr', { role: 'admin' }, OTP);
    ok(denied(r) && (await queued()) === q0, 'X-4', 'a token `role: "admin"` string is not the admin claim: ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-user', { admin: 'true' }, OTP);
    ok(denied(r) && (await queued()) === q0, 'X-5', 'admin claim must be boolean true (the string "true" is not): ' + why(r)); }
  { const q0 = await queued(); const r = await call('q0c1-user', {}, Object.assign({ targetUid: 'q0c1-victim' }, OTP));
    ok(denied(r) && (await queued()) === q0, 'X-6', 'a non-admin choosing targetUid (whose preferences apply): ' + why(r)); }
  { const key = 'otp:q0c1-victim:login';
    const r = await call('q0c1-user', {}, Object.assign({ dedupeKey: key }, OTP));
    const held = (await db.collection('smsQueue').doc(key).get()).exists;
    const own = await quiet(() => SMS.enqueue({ to: VICTIM, template: 'otp', vars: { code: '777777' }, uid: 'q0c1-victim', dedupeKey: key }));
    ok(denied(r) && !held && own && own.queued === true, 'X-7',
      "a non-admin cannot PRE-CLAIM a victim's OTP dedupe key — the victim's real OTP still queues: " + why(r) + ' → victim ' + JSON.stringify(own)); }

  process.stdout.write('\n[A] the admin callable behaves exactly as before\n');
  { const r = await call('q0c1-admin', { admin: true }, { to: VICTIM, template: 'otp', vars: { code: '424242' }, targetUid: 'q0c1-t1', dedupeKey: 'q0c1-admin-1' });
    const d = (await db.collection('smsQueue').doc('q0c1-admin-1').get()).data() || {};
    ok(r.ok && r.out.queued && d.to === VICTIM && d.template === 'otp' && d.uid === 'q0c1-t1' && /424242/.test(d.body || '') && d.status === 'pending', 'A-1',
      'an admin (custom claim) queues; targetUid and dedupeKey remain admin-controlled; the template renders: ' + why(r)); }
  { const r = await call('q0c1-admin', { admin: true }, { to: VICTIM, template: 'otp', vars: { code: '424242' }, dedupeKey: 'q0c1-admin-1' });
    ok(r.ok && r.out.deduped === true, 'A-2', 'the same dedupeKey again is deduplicated (unchanged behaviour): ' + why(r)); }
  { const r = await call('q0c1-super', { superAdmin: true }, { to: VICTIM, template: 'welcome', vars: {}, dedupeKey: 'q0c1-super-1' });
    ok(r.ok && r.out.queued && (await db.collection('smsQueue').doc('q0c1-super-1').get()).exists, 'A-3', 'a superAdmin (custom claim) queues: ' + why(r)); }
  { const r = await call('q0c1-admin', { admin: true }, { to: VICTIM, template: 'not-a-template' });
    ok(!r.ok && r.code === 'invalid-argument', 'A-4', 'an admin still gets the existing validation (unknown template): ' + why(r)); }

  process.stdout.write('\n[I] the internal server authority is unchanged\n');
  { const r = await res(quiet(() => SMS.enqueue({ to: VICTIM, template: 'order_placed', vars: { orderId: 'o1' }, uid: 'q0c1-buyer', dedupeKey: 'q0c1-internal-1' })));
    ok(r.ok && r.out.queued && (await db.collection('smsQueue').doc('q0c1-internal-1').get()).exists, 'I-1',
      'the internal enqueue() (the path notify.js uses) still queues with no caller claim — it is the server, not a client: ' + why(r)); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
