#!/usr/bin/env node
'use strict';
/* ============================================================================
   Legal free plan — the auto consultation card does NOT count toward the service cap (owner 2026-10-03)
   Drives the REAL provider-ops handlers (add / duplicate / toggle) on an in-memory Firestore.
     C1  free plan (cap 1) + the auto card legal_consult_{uid} → the advocate may add ONE service of their own
     C2  a second own service is refused ("Your plan allows 1 active service")
     C3  re-activating a deactivated own service while another own service is active → refused; the auto card itself
         can always be re-activated
     C4  only THAT document is exempt: a card with createdBy 'legal-verification' but another id, or the right id without
         createdBy, still counts
     C5  a duplicate of the auto card is an ordinary card (createdBy not copied) and counts
     C6  without the exemption (control) a free lawyer with the auto card could add nothing
   NODE_PATH=<functions/node_modules> node scripts/test-legal-auto-card-cap.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 220) : '')); } };

class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }
const DOCS = new Map(); let AUTO = 0;
const snap = (k) => { const d = DOCS.get(k); return { id: k.split('/').pop(), exists: !!d, data: () => (d ? Object.assign({}, d) : undefined) }; };
const ref = (k) => ({ id: k.split('/').pop(), get: async () => snap(k), update: async (v) => DOCS.set(k, Object.assign({}, DOCS.get(k), v)), set: async (v) => DOCS.set(k, Object.assign({}, v)) });
const query = (c, filters) => ({ where: (f, op, v) => query(c, filters.concat([[f, v]])), limit () { return this; }, orderBy () { return this; },
  get: async () => { const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2 && filters.every(([f, v]) => DOCS.get(k)[f] === v)).map(snap); return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) }; } });
const db = { collection: (c) => Object.assign({ doc: (id) => ref(c + '/' + id), add: async (v) => { const id = 'auto' + (++AUTO); DOCS.set(c + '/' + id, Object.assign({}, v)); return { id }; } }, query(c, [])),
  runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v) => r.set(v), update: (r, v) => r.update(v), create: (r, v) => r.set(v) }) };
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n, delete: () => undefined, arrayUnion: (...a) => a };
const Timestamp = { now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }), fromDate: (d) => d, fromMillis: (m) => m };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-functions/v2/https') return { HttpsError, onCall: (_o, h) => h };
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue, Timestamp };
  if (id === 'firebase-admin') return { apps: [1], initializeApp () {}, firestore: Object.assign(() => db, { FieldValue, Timestamp }), auth: () => ({}) };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {}, debug () {} };
  if (id === './legal-agreements') return { assertLegalCompliance: async () => {} };
  if (id === './provider-hub') return { resolveProviderHub: async () => 'provider', commissionArgsForHub: () => ({}) };
  return orig.apply(this, arguments);
};
let PO, loadErr = null;
try { PO = require(path.join(FN, 'provider-ops.js')); } catch (e) { loadErr = e; }
Module.prototype.require = orig;
const UID = 'adv1';
const req = (data) => ({ auth: { uid: UID, token: {} }, data });
const tryH = async (h, d) => { try { return { ok: true, r: await PO._h[h](req(d)) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const own = () => [...DOCS.keys()].filter((k) => k.startsWith('providerServices/') && DOCS.get(k).providerId === UID && !k.endsWith('legal_consult_' + UID));
function reset () {
  DOCS.clear(); AUTO = 0;
  DOCS.set('providerServices/legal_consult_' + UID, { providerId: UID, name: 'Legal consultation', active: true, createdBy: 'legal-verification', price: 300000 });
}

(async () => {
  if (loadErr) { ck('provider-ops loads', false, loadErr.stack); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  reset();
  let x = await tryH('providerAddService', { name: 'Term sheet review', priceType: 'fixed', price: 500000 });
  ck('C1 free plan + the auto consultation card → the advocate adds ONE service of their own', x.ok && own().length === 1, x);
  x = await tryH('providerAddService', { name: 'Contract drafting' });
  ck('C2 a second own service is refused (cap 1)', !x.ok && x.code === 'resource-exhausted' && /allows 1 active service/.test(x.msg), x);

  const ownId = own()[0].split('/').pop();
  await ref('providerServices/' + ownId).update({ active: false });
  DOCS.set('providerServices/own2', { providerId: UID, name: 'Second', active: true });
  x = await tryH('providerToggleService', { serviceId: ownId, active: true });
  ck('C3a re-activating an own service while another own one is active → refused', !x.ok && x.code === 'resource-exhausted', x);
  await ref('providerServices/legal_consult_' + UID).update({ active: false });
  x = await tryH('providerToggleService', { serviceId: 'legal_consult_' + UID, active: true });
  ck('C3b the auto card itself can always be re-activated (it never counts)', x.ok && DOCS.get('providerServices/legal_consult_' + UID).active === true, x);

  reset();
  DOCS.set('providerServices/fake1', { providerId: UID, name: 'Forged', active: true, createdBy: 'legal-verification' });
  x = await tryH('providerAddService', { name: 'Another' });
  ck('C4a a card with createdBy legal-verification but ANOTHER id still counts → add refused', !x.ok && x.code === 'resource-exhausted', x);
  reset();
  DOCS.set('providerServices/legal_consult_' + UID, { providerId: UID, name: 'No marker', active: true });
  x = await tryH('providerAddService', { name: 'Another' });
  ck('C4b the right id WITHOUT createdBy legal-verification counts → add refused', !x.ok && x.code === 'resource-exhausted', x);

  reset();
  x = await tryH('providerDuplicateService', { serviceId: 'legal_consult_' + UID });
  const dupId = x.ok ? x.r.serviceId : null;
  ck('C5a duplicating the auto card is allowed once (it does not count) and the copy carries no createdBy', x.ok && dupId && DOCS.get('providerServices/' + dupId).createdBy === undefined, x);
  x = await tryH('providerAddService', { name: 'Another' });
  ck('C5b the copy counts like any own service → a further add is refused', !x.ok && x.code === 'resource-exhausted', x);

  reset();
  DOCS.set('providerServices/legal_consult_' + UID, Object.assign(DOCS.get('providerServices/legal_consult_' + UID), { createdBy: 'someone-else' }));
  x = await tryH('providerAddService', { name: 'Term sheet review' });
  ck('C6 CONTROL: without the exemption marker the auto card fills the free slot → the advocate could add nothing', !x.ok && x.code === 'resource-exhausted', x);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
