'use strict';
/* The REAL deliveryPinOnAccept + getMyDeliveryPin (functions/delivery-pin.js) on the completion-PIN engine.
   Owner 2026-10-01: rider acceptance never replaces the buyer's PIN; the buyer re-views a SEALED PIN; nobody else can.
     node scripts/test-delivery-pin-accept-read.js
     BASE=2d20faa node scripts/test-delivery-pin-accept-read.js   (the live baseline must FAIL A-1 / R-1) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
process.env.SOKONI_HMAC_KEY = 'test-hmac-key-0123456789'; process.env.GCLOUD_PROJECT = 'demo-pin'; process.env.FUNCTIONS_EMULATOR = 'true';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

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

let dir = path.join(ROOT, 'functions');
if (process.env.BASE) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  fs.writeFileSync(path.join(dir, 'delivery-pin.js'), execSync('git show ' + process.env.BASE + ':functions/delivery-pin.js', { cwd: ROOT, encoding: 'utf8' })); }
const SMS = [];
const atPath = path.join(dir, 'sokoni-at.js');
if (process.env.BASE) fs.writeFileSync(atPath, 'module.exports = {};');
require.cache[atPath] = { id: atPath, filename: atPath, loaded: true, exports: { secrets: [],
  atSendSMS: async (to, text) => { SMS.push({ to, text }); return { ok: true, results: [{ messageId: 'ATX' + SMS.length, status: 'Success' }] }; } } };
const adminPath = require.resolve('firebase-admin', { paths: [NM] });
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: adminStub };
const DP = require(path.join(dir, 'delivery-pin.js'));
const CP = require(path.join(ROOT, 'functions', 'shared', 'completion-pin.js'));
const KEY = process.env.SOKONI_HMAC_KEY;

const accept = async (pkgId, orderId) => {
  const before = { orderId, status: 'awaiting_rider' }; DOCS.set('packageRequests/' + pkgId, Object.assign({}, before));
  const after = Object.assign({}, before, { status: 'driver_accepted', riderId: 'rider' });
  DOCS.set('packageRequests/' + pkgId, after);
  await DP.deliveryPinOnAccept.run({ params: { pkgId }, data: { before: { data: () => before }, after: { data: () => after, ref: ref('packageRequests/' + pkgId) } } });
};
const read = async (uid, orderId) => { try { return { ok: true, r: await DP.getMyDeliveryPin.run({ auth: { uid, token: {} }, data: { orderId }, rawRequest: { headers: {} } }) }; }
  catch (e) { return { ok: false, code: e.code }; } };
const order = (id, o) => DOCS.set('orders/' + id, Object.assign({ status: 'paid', paymentVerified: true, fulfillmentType: 'delivery', deliveryAddress: 'Kilimani',
  buyerUid: 'buyer', sellerUid: 'seller', assignedDriverUid: 'rider' }, o));
DOCS.set('users/buyer', { phone: '254700000009' });
const dump = () => JSON.stringify([...DOCS.entries()]);

(async () => {
  console.log('\nDelivery PIN — accept + buyer read   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  /* the order already has the buyer's PIN (engine) */
  order('o1'); const i1 = await CP.issueOrResend({ db: fakeDb, FV: FieldValue, key: KEY, orderId: 'o1', mode: 'auto', now: Date.now() });
  const h1 = DOCS.get('orders/o1').deliveryPinHash, s1 = JSON.stringify(DOCS.get('deliveryPins/o1'));
  await accept('pkg1', 'o1');
  ck('A-1', DOCS.get('orders/o1').deliveryPinHash === h1 && JSON.stringify(DOCS.get('deliveryPins/o1')) === s1 && !DOCS.get('packageRequests/pkg1').deliveryPinHash && SMS.length === 0,
    'RIDER ACCEPT NEVER REPLACES the buyer\'s PIN: order hash + sealed copy untouched, no package PIN minted, no SMS', { pkg: DOCS.get('packageRequests/pkg1'), sms: SMS.length });
  /* a paid delivery order with no PIN yet */
  order('o2'); await accept('pkg2', 'o2');
  const o2 = DOCS.get('orders/o2'); const smsPin = SMS.length ? (/PIN is (\d{6})/.exec(SMS[SMS.length - 1].text) || [])[1] : null;
  ck('A-2', o2.deliveryPinEngine === 2 && smsPin && !dump().includes(smsPin) && DOCS.get('deliveryPins/o2').sealed,
    'a paid order with no PIN gets its FIRST one from the engine at accept (sealed, SMS to the buyer, plaintext stored nowhere)', { o2: !!o2.deliveryPinHash, sms: SMS.length });
  /* unpaid */
  order('o3', { paymentVerified: false }); const n = SMS.length; await accept('pkg3', 'o3');
  ck('A-3', !DOCS.get('orders/o3').deliveryPinHash && !DOCS.has('deliveryPins/o3') && SMS.length === n, 'an UNPAID order gets no PIN at accept');

  /* the buyer reads it back; nobody else can */
  let r = await read('buyer', 'o2');
  ck('R-1', r.ok && r.r.issued && r.r.pin === smsPin && r.r.state && r.r.expiresAt, 'the BUYER re-views the sealed PIN (+ state and expiry)', r.ok ? Object.assign({}, r.r, { pin: r.r.pin ? '…' : null }) : r);
  r = await read('rider', 'o2');
  ck('R-2', !r.ok && r.code === 'permission-denied', 'the assigned rider cannot read the PIN', r);
  r = await read('seller', 'o2');
  ck('R-3', !r.ok && r.code === 'permission-denied', 'the seller cannot read the PIN', r);
  DOCS.set('orders/o2', Object.assign(DOCS.get('orders/o2'), { deliveryPinExpiresAt: Date.now() - 1 }));
  r = await read('buyer', 'o2');
  ck('R-4', r.ok && r.r.pin === null && r.r.state === 'EXPIRED', 'an EXPIRED PIN is not handed out — the buyer is told it expired', r.ok ? r.r : r);
  order('o4', { deliveryPinHash: 'legacy', deliveryPinBinding: 'order' }); DOCS.set('deliveryPins/o4', { pin: '123456' });
  r = await read('buyer', 'o4');
  ck('R-5', r.ok && r.r.pin === '123456', 'a legacy (pre-engine) PIN still reads back until it is reissued', r.ok ? r.r : r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
