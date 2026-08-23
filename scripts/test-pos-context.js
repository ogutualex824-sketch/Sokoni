#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — the POS context resolver, and the boundary it must hold
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-pos-context.js

   Exercises the REAL module against a stub Firestore, so the decisions are the
   module's own. The stub is shaped from PRODUCTION data measured 2026-08-23:
   two businesses, two branches, 26 devices split 20/6 by merchantId.

   THE CONTROLS ARE THE POINT. A resolver that always answers "open-pos" is
   indistinguishable from one that ignores its inputs, so every allow is paired
   with a refusal that must fail for the opposite reason.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
global.window = global;
const CTX = require(path.join(__dirname, '..', 'sokoni-pos-context.js'));

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

/* ── a stub Firestore shaped from real production data ──────────────────── */
const OWNER_A = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   /* owns SOK-E7J2Y8 */
const OWNER_B = 'xrH21J5GFbSomeOtherOwnerUid';     /* owns SOK-GL58F7 */
const OUTSIDER = 'someRandomBuyerUid';

const DATA = {
  businesses: {
    'SOK-E7J2Y8': { ownerId: OWNER_A, name: 'Shop A', status: 'active' },
    'SOK-GL58F7': { ownerId: OWNER_B, name: 'Shop B', status: 'active' },
  },
  branches: {
    'SOK-E7J2Y8-main': { merchantId: 'SOK-E7J2Y8', name: 'Nairobi CBD', isDefault: true, status: 'active' },
    'SOK-GL58F7-main': { merchantId: 'SOK-GL58F7', name: 'Langata', isDefault: true, status: 'active' },
  },
  posDevices: {
    'DEV-PAIRED-A':   { merchantId: 'SOK-E7J2Y8', branchId: 'SOK-E7J2Y8-main', status: 'active' },
    'DEV-OTHER-MERCH':{ merchantId: 'SOK-GL58F7', branchId: 'SOK-GL58F7-main', status: 'active' },
    'DEV-SUSPENDED':  { merchantId: 'SOK-E7J2Y8', branchId: 'SOK-E7J2Y8-main', suspendedAt: 1 },
  },
};

function makeDb(opts) {
  opts = opts || {};
  return {
    collection(name) {
      return {
        where(field, _op, value) {
          return { get: () => {
            if (opts.denyRead === name) return Promise.reject(new Error('permission-denied'));
            const src = DATA[name] || {};
            const docs = Object.keys(src)
              .filter((k) => src[k][field] === value)
              .map((k) => ({ id: k, data: () => src[k] }));
            return Promise.resolve({ docs });
          } };
        },
        doc(id) {
          return { get: () => {
            if (opts.denyRead === name) return Promise.reject(new Error('permission-denied'));
            const v = (DATA[name] || {})[id];
            return Promise.resolve({ exists: !!v, data: () => v });
          } };
        },
      };
    },
  };
}

function setDevice(id) {
  global.localStorage = {
    _v: id,
    getItem(k) { return k === 'sk_device_id' ? this._v : null; },
    setItem() {}, removeItem() {},
  };
}

(async () => {
  /* ── C1 · an owner on a NEW device is discovered, not re-registered ──── */
  setDevice('DEV-BRAND-NEW');
  let r = await CTX.resolve({ db: makeDb(), uid: OWNER_A });
  ck('C1  an owner on a new device discovers their existing business',
    r.ok && r.businesses.length === 1 && r.businesses[0].id === 'SOK-E7J2Y8',
    'businesses=' + JSON.stringify(r.businesses.map((b) => b.id)));
  ck('C1b ...and is sent to PAIR the device, never to create a business',
    r.decision === 'pair-device', 'decision=' + r.decision +
    '  | "create a business" is not a decision this resolver can return');
  ck('C1c ...and the branch is resolved from the server, not from storage',
    r.branches.length === 1 && r.branches[0].id === 'SOK-E7J2Y8-main',
    'branches=' + JSON.stringify(r.branches.map((b) => b.id)));

  /* ── C2 · an already-paired device opens POS ─────────────────────────── */
  setDevice('DEV-PAIRED-A');
  r = await CTX.resolve({ db: makeDb(), uid: OWNER_A });
  ck('C2  a registered device proceeds straight to POS',
    r.decision === 'open-pos' && r.device.registered === true,
    'decision=' + r.decision + ' branch=' + (r.selected && r.selected.branchId));

  /* ── C6 · THE SECURITY BOUNDARY ──────────────────────────────────────── */
  setDevice('DEV-OTHER-MERCH');
  r = await CTX.resolve({ db: makeDb(), uid: OWNER_A });
  ck('C6  a device paired to ANOTHER merchant does not count as paired',
    r.device.registered === false && r.device.reason === 'paired-elsewhere',
    'reason=' + r.device.reason +
    '  | the record exists; it just is not this user\'s to use');
  ck('C6b ...and the user is NOT handed the other merchant\'s branch',
    r.selected.merchantId === 'SOK-E7J2Y8',
    'selected merchant=' + r.selected.merchantId);

  r = await CTX.resolve({ db: makeDb(), uid: OUTSIDER });
  ck('C6c an account owning no business gets NO business',
    r.ok && r.businesses.length === 0 && r.decision === 'no-owned-business',
    'decision=' + r.decision + '  | reported honestly, not guessed as "new merchant"');

  r = await CTX.resolve({ db: makeDb(), uid: '' });
  ck('C6d an unauthenticated caller is refused as unauthenticated',
    r.ok === false && r.reason === 'unauthenticated',
    'reason=' + r.reason + '  | distinct from "no business", which is the point');

  /* ── a refused read must never read as "unpaired" ────────────────────── */
  setDevice('DEV-PAIRED-A');
  r = await CTX.resolve({ db: makeDb({ denyRead: 'posDevices' }), uid: OWNER_A });
  ck('C2b a REFUSED device read yields retry, not a trip through setup',
    r.decision === 'retry' && r.device.reason === 'unreadable',
    'decision=' + r.decision +
    '  | treating a denied read as "not paired" is how a working merchant gets re-registered');

  /* ── suspension is not the same as unpaired ──────────────────────────── */
  setDevice('DEV-SUSPENDED');
  r = await CTX.resolve({ db: makeDb(), uid: OWNER_A });
  ck('C2c a SUSPENDED device is reported as suspended, not unpaired',
    r.decision === 'device-suspended',
    'decision=' + r.decision + '  | re-pairing must not be a way around suspension');

  /* ── no device id at all ─────────────────────────────────────────────── */
  global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  r = await CTX.resolve({ db: makeDb(), uid: OWNER_A });
  ck('C3  with no device id the answer is pair-device, and none is invented',
    r.decision === 'pair-device' && r.device.deviceId === null &&
      r.device.reason === 'no-device-id',
    'reason=' + r.device.reason +
    '  | minting an id here would re-pair on every visit');

  /* ── the module must not read the forgeable field ────────────────────── */
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-pos-context.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  ck('C6e the resolver never reads users/{uid}.merchantId',
    !/users['"\)\s]*\)[\s\S]{0,80}merchantId/.test(code) && !/\.merchantId\s*\|\|\s*localStorage/.test(code),
    'a known self-writable field is not an authority');
  ck('C6f no client-supplied merchantId/branchId is accepted as authority',
    !/opts\.(merchantId|branchId|role)/.test(code),
    'the client may request; it may not assert');

  const passed = rows.filter((r) => r.ok).length;
  console.log('');
  console.log('  POS CONTEXT RESOLVER — one login, server-resolved business/branch/device');
  console.log('  ' + '='.repeat(70));
  console.log('');
  for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
  console.log('');
  console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
  console.log('');
  process.exit(passed === rows.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILED: ' + ((e && e.stack) || e)); process.exit(2); });
