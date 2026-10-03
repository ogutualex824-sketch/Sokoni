#!/usr/bin/env node
'use strict';
/**
 * DE-2 — commerceDispatch must no longer serve digitalProductPurchase / digitalProductDownload.
 *
 * Hermetic: firebase-admin and firebase-functions are stubbed in-process (no network, no
 * credentials, no emulator). Every Firestore / Storage touch goes through a tripwire.
 *
 *   node scripts/test-commerce-dispatch-retired-digital.js [--target=<functionsDir>] [--live=<archiveDir>]
 *
 *   --target  functions dir under test             (default: ./functions of this repo)
 *   --live    serving-archive dir used as CONTROL  (default: same as --target; R3 then degenerates
 *             to "map minus the two" on the target itself and is reported as such)
 *
 * R1  merged handler map has no digitalProductPurchase / digitalProductDownload
 * R2  calling the dispatcher with either op -> HttpsError 'not-found' (unknown op), zero db/storage touches
 * R3  CONTROL: every other op served by the LIVE archive is still served (set equality minus the two)
 * R4  the other digitalProduct* ops (Create / GetMyLibrary / GetSales) are still routed
 *
 * Negative control: --target=<unmodified archive> must FAIL R1 and R2.
 */
const Module = require('module');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, true];
}));
const TARGET = path.resolve(args.target || path.join(__dirname, '..', 'functions'));
const LIVE = path.resolve(args.live || TARGET);
const RETIRED = ['digitalProductPurchase', 'digitalProductDownload'];

// ── Tripwire stubs ───────────────────────────────────────────────────────────
let touches = [];
function tripwire(label) {
  const fn = function () { touches.push(label + '()'); throw new Error('[tripwire] ' + label + ' called'); };
  return new Proxy(fn, {
    get(_, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return tripwire(label + '.' + String(prop));
    },
    apply(_, __, a) { touches.push(label + '()'); throw new Error('[tripwire] ' + label + ' called'); },
  });
}
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = { canonicalName: code }; }
}
const firestoreFn = function () { return tripwire('db'); };
Object.assign(firestoreFn, {
  FieldValue: tripwire('FieldValue'), Timestamp: tripwire('Timestamp'), FieldPath: tripwire('FieldPath'),
});
const adminStub = {
  apps: [{}],                      // non-empty -> modules skip initializeApp
  initializeApp() {},
  firestore: firestoreFn,
  storage() { return tripwire('storage'); },
  auth() { return tripwire('auth'); },
  messaging() { return tripwire('messaging'); },
};
const passthroughWrap = (a, b) => (typeof a === 'function' ? a : b);
const stubs = {
  'firebase-admin': adminStub,
  'firebase-functions/v2/https': {
    HttpsError,
    onCall: passthroughWrap,        // onCall(opts, handler) -> handler itself
    onRequest: passthroughWrap,
  },
  'firebase-functions/v2/scheduler': { onSchedule: passthroughWrap },
  'firebase-functions/params': {
    defineSecret: n => ({ name: n, value: () => '' }),
    defineString: n => ({ name: n, value: () => '' }),
  },
  'firebase-functions/logger': { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  '@anthropic-ai/sdk': tripwire('anthropic'),
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
  if (/^firebase-admin\//.test(req)) return tripwire(req);
  return origLoad.apply(this, arguments);
};

// ── Load a commerceDispatch from a functions dir and read its served op set ─────
const _origErr = console.error;
function load(dir) {
  console.error = () => {};        // silence "[dispatch] op collision" lines at load
  try { return require(path.join(dir, 'commerce-dispatch.js')).commerceDispatch; }
  finally { console.error = _origErr; }
}
async function call(dispatch, data) {
  try { return { ok: true, value: await dispatch({ data, auth: { uid: 'de2-test-uid', token: {} }, app: {} }) }; }
  catch (e) { return { ok: false, err: e }; }
}
async function servedOps(dispatch) {
  const r = await call(dispatch, { op: '__de2_probe_unknown_op__' });
  if (r.ok || !r.err || r.err.code !== 'not-found') throw new Error('probe did not yield not-found: ' + (r.err && r.err.message));
  const m = /Valid ops: (.*)$/.exec(r.err.message);
  if (!m) throw new Error('could not parse op list');
  return m[1].split(', ').filter(Boolean);
}

let pass = 0, fail = 0;
function check(id, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + id + (detail ? ' — ' + detail : '')); }
  else { fail++; console.log('FAIL ' + id + (detail ? ' — ' + detail : '')); }
}

(async () => {
  console.log('target:', TARGET);
  console.log('live  :', LIVE + (LIVE === TARGET ? '  (same as target)' : ''));
  const tgt = load(TARGET);
  const liveDispatch = LIVE === TARGET ? tgt : load(LIVE);
  touches = [];
  const tgtOps = await servedOps(tgt);
  const liveOps = await servedOps(liveDispatch);
  check('R0 load touched no db/storage', touches.length === 0, touches.join(', '));

  // R1
  for (const op of RETIRED) check('R1 map lacks ' + op, !tgtOps.includes(op));

  // R2
  for (const op of RETIRED) {
    touches = [];
    const r = await call(tgt, { op, productId: 'de2-prod', purchaseId: 'de2-purchase', paymentMethod: 'wallet' });
    const isUnknown = !r.ok && r.err && r.err.code === 'not-found' && /Unknown commerce operation/.test(r.err.message);
    check('R2 ' + op + ' -> unknown-op not-found', isUnknown,
      r.ok ? 'returned a value' : (r.err && (r.err.code + ': ' + String(r.err.message).slice(0, 80))));
    check('R2 ' + op + ' touched no db/storage', touches.length === 0, touches.slice(0, 3).join(', '));
  }

  // R3 CONTROL
  /* ADDED: ops deliberately introduced on later revisions of the SAME commerceDispatch lineage (each named, never a wildcard).
     rentalOwnerListings — sokoni-f3 rentals fix on 53100ff (owner list op for the Construction workspace). */
  const ADDED = ['rentalOwnerListings'];
  const expected = liveOps.filter(o => !RETIRED.includes(o)).concat(ADDED).sort();
  const got = tgtOps.slice().sort();
  const missing = expected.filter(o => !got.includes(o));
  const added = got.filter(o => !expected.includes(o));
  check('R3 CONTROL live ops minus the two == target ops', missing.length === 0 && added.length === 0,
    `live=${liveOps.length} target=${got.length} expected=${expected.length}` +
    (missing.length ? ' missing=' + missing.join(',') : '') + (added.length ? ' added=' + added.join(',') : ''));
  check('R3 live archive DID serve both retired ops (control is meaningful)',
    RETIRED.every(o => liveOps.includes(o)), LIVE === TARGET ? 'live==target' : '');

  // R4
  for (const op of ['digitalProductCreate', 'digitalProductGetMyLibrary', 'digitalProductGetSales']) {
    if (!liveOps.includes(op)) { console.log('SKIP R4 ' + op + ' (not in live map)'); continue; }
    check('R4 ' + op + ' still routed', got.includes(op));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e && e.stack); process.exit(2); });
