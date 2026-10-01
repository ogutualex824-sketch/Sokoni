'use strict';
/* The REAL completeDeliveryWithPin + sendDeliveryPin (functions/delivery-complete.js) on the completion-PIN engine,
   against a serialised in-memory Firestore. firebase-admin and the AT SMS sender are stubbed; firebase-functions is real.
     node scripts/test-delivery-pin-callables.js
     BASE=5f3c96c node scripts/test-delivery-pin-callables.js   (the live baseline must FAIL the new rows) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
process.env.SOKONI_HMAC_KEY = 'test-hmac-key-0123456789';
process.env.GCLOUD_PROJECT = 'demo-pin'; process.env.FUNCTIONS_EMULATOR = 'true';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── serialised in-memory Firestore ── */
const DOCS = new Map(); const DEL = { __del: 1 }; let AUTO = 0;
const apply = (prev, d, merge) => { const o = merge ? Object.assign({}, prev || {}) : {}; for (const [k, v] of Object.entries(d)) { if (v === DEL) delete o[k]; else o[k] = v; } return o; };
const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => ({ exists: DOCS.has(p), data: () => DOCS.get(p) }),
  set: async (d, o) => { DOCS.set(p, apply(DOCS.get(p), d, o && o.merge)); }, update: async (d) => { DOCS.set(p, apply(DOCS.get(p), d, true)); } });
let chain = Promise.resolve();
const fakeDb = { collection: (c) => ({ doc: (id) => ref(c + '/' + id), add: async (d) => { const p = c + '/auto' + (++AUTO); DOCS.set(p, d); return ref(p); } }),
  runTransaction: (fn) => { const run = chain.then(async () => { const w = [];
    const t = { get: async (r) => ({ exists: DOCS.has(r.path), data: () => DOCS.get(r.path) }),
      set: (r, d, o) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, o && o.merge))),
      update: (r, d) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, true))) };
    const out = await fn(t); w.forEach((f) => f()); return out; }); chain = run.catch(() => {}); return run; } };
const FieldValue = { serverTimestamp: () => 'TS', delete: () => DEL, increment: (n) => ({ __inc: n }) };
const adminStub = { initializeApp() {}, apps: [1], firestore: Object.assign(() => fakeDb, { FieldValue }) };

/* ── load the module under test (this tree, or BASE) with stubs ── */
let dir = path.join(ROOT, 'functions');
if (process.env.BASE) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(dir, 'delivery-complete.js'), execSync('git show ' + process.env.BASE + ':functions/delivery-complete.js', { cwd: ROOT, encoding: 'utf8' })); }
const SMS = [];
const atPath = path.join(dir, 'sokoni-at.js');
if (process.env.BASE) fs.writeFileSync(atPath, 'module.exports = {};');
require.cache[atPath] = { id: atPath, filename: atPath, loaded: true, exports: { secrets: [],
  atSendSMS: async (to, text) => { SMS.push({ to, text }); return { ok: true, results: [{ messageId: 'ATX' + SMS.length, status: 'Success' }] }; } } };
const adminPath = require.resolve('firebase-admin', { paths: [NM] });
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: adminStub };
if (!process.env.BASE) { const cpp = path.join(dir, 'shared', 'completion-pin.js'); require(cpp); }
const DC = require(path.join(dir, 'delivery-complete.js'));
const P = process.env.BASE ? null : require(path.join(dir, 'shared', 'completion-pin.js'));

const call = async (fn, uid, data) => { try { return { ok: true, r: await fn.run({ auth: uid ? { uid, token: {} } : null, data, rawRequest: { headers: {} } }) }; }
  catch (e) { return { ok: false, code: e.code, reason: e.details && e.details.reason, msg: e.message }; } };
const KEY = process.env.SOKONI_HMAC_KEY;
const seed = (id, o) => { DOCS.set('orders/' + id, Object.assign({ status: 'paid', paymentVerified: true, fulfillmentType: 'delivery', deliveryAddress: 'Kilimani',
  buyerUid: 'buyer', sellerUid: 'seller', assignedDriverUid: 'rider', packageRequestId: 'pkg_' + id }, o));
  DOCS.set('packageRequests/pkg_' + id, { orderId: id, riderId: 'rider', status: 'in_transit' }); };
DOCS.set('users/buyer', { phone: '254700000009' });
const lastSmsPin = () => { const m = SMS.length ? /PIN is (\d{6})/.exec(SMS[SMS.length - 1].text) : null; return m ? m[1] : null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nDelivery PIN callables   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const send = DC.sendDeliveryPin, done = DC.completeDeliveryWithPin;
  ck('X-0', typeof send === 'function' || !!process.env.BASE, 'sendDeliveryPin is exported');
  /* send: authorisation */
  seed('o1');
  let s = send ? await call(send, 'stranger', { orderId: 'o1' }) : { ok: false, code: 'NO_CALLABLE' };
  ck('S-1', !s.ok && s.code === 'permission-denied', 'a stranger cannot make the server send a PIN', s);
  s = send ? await call(send, 'seller', { orderId: 'o1' }) : { ok: false };
  const pinA = lastSmsPin();
  ck('S-2', s.ok && s.r.action === 'issued' && SMS.length === 1 && SMS[0].to === '254700000009' && pinA && !JSON.stringify(s.r).includes(pinA),
    'the SELLER asks → the server issues + SMSes the BUYER (profile phone); the seller gets the masked state only', s.ok ? s.r : s);
  ck('S-3', !JSON.stringify([...DOCS.entries()]).includes(pinA), 'the PIN is in NO stored document (order hash + sealed copy only)');
  s = send ? await call(send, 'rider', { orderId: 'o1' }) : { ok: false };
  ck('S-4', !s.ok && s.reason === 'PIN_RATE_LIMITED', 'the assigned rider asking again within 60 s is rate-limited', s);
  seed('o1u', { paymentVerified: false });
  s = send ? await call(send, 'seller', { orderId: 'o1u' }) : { ok: false };
  ck('S-5', !s.ok && s.reason === 'ORDER_NOT_PAID' && !DOCS.get('orders/o1u').deliveryPinHash, 'an UNPAID order gets no PIN', s);

  /* complete: authorisation + shape */
  let c = await call(done, 'stranger', { deliveryRef: 'pkg_o1', pin: pinA });
  ck('C-1', !c.ok && c.code === 'permission-denied', 'a rider not assigned is refused BEFORE the PIN is compared (no PIN oracle)', c);
  c = await call(done, 'rider', { deliveryRef: 'pkg_o1', pin: (pinA || '1234').slice(0, 4) });
  ck('C-2', !c.ok && c.code === 'invalid-argument', 'a 4-digit entry is refused — 6 digits only', c);
  /* lockout */
  const wrong = pinA === '000000' ? '000001' : '000000';
  const burst = await Promise.all(Array.from({ length: 6 }, () => call(done, 'rider', { deliveryRef: 'pkg_o1', pin: wrong })));
  const o1 = DOCS.get('orders/o1');
  ck('C-3', o1.deliveryVerifyAttempts === 5 && burst.filter((x) => x.reason === 'PIN_LOCKED').length === 2 && Number(o1.deliveryPinLockedUntil) > Date.now(),
    '6 concurrent wrong PINs: exactly 5 counted, verification locks (no guess slips past)', { attempts: o1.deliveryVerifyAttempts, r: burst.map((x) => x.reason) });
  c = await call(done, 'rider', { deliveryRef: 'pkg_o1', pin: pinA });
  ck('C-4', !c.ok && c.reason === 'PIN_LOCKED' && DOCS.get('orders/o1').status === 'paid', 'locked: even the right PIN does not complete', c);
  /* happy path + one-shot + concurrency */
  seed('o2'); await call(send, 'seller', { orderId: 'o2' }); const pinB = lastSmsPin();
  const two = await Promise.all([call(done, 'rider', { deliveryRef: 'pkg_o2', pin: pinB }), call(done, 'rider', { deliveryRef: 'pkg_o2', pin: pinB })]);
  const o2 = DOCS.get('orders/o2');
  ck('C-5', two.every((x) => x.ok) && two.filter((x) => x.r.alreadyDelivered === false).length === 1 && o2.deliveryAuthorizedBy === 'rider_pin' && o2.deliveryPinStatus === 'USED',
    'two simultaneous right PINs: exactly ONE completion; proof = rider_pin; PIN marked USED', two.map((x) => x.ok ? x.r : x));
  ck('C-6', o2.status === 'completed' || o2.status === 'delivered', 'the order reaches delivered → completed (the settlement trigger)', o2.status);
  c = await call(done, 'rider', { deliveryRef: 'pkg_o2', pin: pinB });
  ck('C-7', (c.ok && c.r.alreadyDelivered === true) || (!c.ok && c.reason === 'ALREADY_COMPLETED'), 'a used PIN never completes twice', c);
  /* expiry + reissue */
  seed('o3'); await call(send, 'seller', { orderId: 'o3' }); const pinOld = lastSmsPin();
  DOCS.set('orders/o3', Object.assign(DOCS.get('orders/o3'), { deliveryPinExpiresAt: Date.now() - 1, deliveryPinLastSentAt: 0 }));
  c = await call(done, 'rider', { deliveryRef: 'pkg_o3', pin: pinOld });
  ck('C-8', !c.ok && c.reason === 'PIN_EXPIRED', 'an expired PIN does not complete (safe, actionable reason)', c);
  s = await call(send, 'seller', { orderId: 'o3' }); const pinNew = lastSmsPin();
  const cOld = await call(done, 'rider', { deliveryRef: 'pkg_o3', pin: pinOld });
  const cNew = await call(done, 'rider', { deliveryRef: 'pkg_o3', pin: pinNew });
  ck('C-9', s.ok && s.r.action === 'issued' && pinNew !== pinOld && !cOld.ok && cNew.ok, 'seller resends after expiry → NEW PIN; the old one is dead, the new one works', { s: s.ok && s.r.action, cOld: cOld.reason, cNew: cNew.ok });
  /* cancelled */
  seed('o4', { status: 'cancelled' });
  s = await call(send, 'seller', { orderId: 'o4' });
  ck('C-10', !s.ok && !DOCS.get('orders/o4').deliveryPinHash, 'a cancelled order: no PIN, no reissue', s);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
