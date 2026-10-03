#!/usr/bin/env node
/* TECH HUB SLICE 4L — booking conversations on the engine's providerBookings.
 * Executes the REAL messages.js createConversation / getConversationContext in-process on an in-memory Firestore
 * (same harness as test-tech-service-profile.js) — no network.
 *   node scripts/test-messages-service-booking.js        BASE=5dc505e node scripts/test-messages-service-booking.js (must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nBooking conversations (Tech Hub slice 4L)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* ── in-memory Firestore (enough for these handlers) ── */
const DOCS = new Map();
let autoId = 0;
const DEL = { __delete: true };
const clone = (o) => JSON.parse(JSON.stringify(o));
const snap = (k, id) => ({ exists: DOCS.has(k), id, ref: docRef(k), data: () => (DOCS.has(k) ? clone(DOCS.get(k)) : undefined) });
function docRef(k) {
  const id = k.split('/').pop();
  return {
    id, path: k,
    get: async () => snap(k, id),
    set: async (v, o) => { DOCS.set(k, o && o.merge ? Object.assign({}, DOCS.get(k) || {}, strip(v)) : strip(v)); },
    update: async (v) => { if (!DOCS.has(k)) throw new Error('NOT_FOUND ' + k); const cur = Object.assign({}, DOCS.get(k)); for (const [f, x] of Object.entries(v)) { if (x && x.__delete) delete cur[f]; else cur[f] = x; } DOCS.set(k, strip(cur)); },
    collection: (c) => coll(k + '/' + c),
  };
}
const strip = (v) => JSON.parse(JSON.stringify(v, (key, x) => (x && x.__ts ? x.__ts : x)));
function coll(c, filters, lim) {
  return {
    doc: (id) => docRef(c + '/' + (id || ('auto' + (++autoId)))),
    add: async (v) => { const r = docRef(c + '/auto' + (++autoId)); await r.set(v); return r; },
    where: (f, op, v) => coll(c, (filters || []).concat([[f, op, v]]), lim),
    orderBy: () => coll(c, filters, lim), limit: (n) => coll(c, filters, n), startAfter: () => coll(c, filters, lim),
    get: async () => {
      const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1)
        .filter((k) => (filters || []).every(([f, op, v]) => { const x = (DOCS.get(k) || {})[f]; return op === 'in' ? v.includes(x) : x === v; }))
        .slice(0, lim || 1e9).map((k) => snap(k, k.split('/').pop()));
      return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
const db = {
  collection: (c) => coll(c, [], 0), doc: (p) => docRef(p),
  runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v), create: (r, v) => r.set(v) }),
  batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), commit: async () => { for (const o of ops) await o(); } }; },
};
const ADMINS = new Set(['admin1']);
const fsStub = {
  getFirestore: () => db,
  FieldValue: { delete: () => DEL, serverTimestamp: () => ({ __ts: 'TS' }), increment: (n) => n, arrayUnion: (...a) => a },
  Timestamp: { now: () => ({ __ts: Date.now(), toMillis: () => Date.now() }), fromMillis: (ms) => ({ __ts: ms, toMillis: () => ms }), fromDate: (d) => ({ __ts: +d }) },
};
const authStub = { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: ADMINS.has(u) ? { admin: true } : {} }) }) };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin/firestore') return fsStub;
  if (req === 'firebase-admin/auth') return authStub;
  if (req === 'firebase-admin') { const real = origLoad.apply(this, arguments); const fsNs = Object.assign(() => db, fsStub); return new Proxy(real, { get: (t, k) => (k === 'firestore' ? fsNs : k === 'auth' ? authStub.getAuth : t[k]) }); }
  return origLoad.apply(this, arguments);
};


(async () => {
  let M = null, loadErr = null;
  try { M = require(path.join(FN, 'messages.js'))._h; } catch (e) { loadErr = e.message; }
  if (!M || !M.createConversation) { ck('M-0', false, 'messages.js loads', loadErr); return done(); }
  const call = async (fn, uid, data) => { try { return { ok: await fn({ auth: { uid, token: {} }, data }) }; } catch (e) { return { code: e.code, msg: e.message }; } };
  const seed = () => { DOCS.clear();
    ['cust1', 'prov1', 'stranger'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
    DOCS.set('providerBookings/bk1', { providerId: 'prov1', customerUid: 'cust1', service: 'Screen', status: 'pending', price: 250000, currency: 'KES' });
    DOCS.set('bookings/old1', { providerId: 'prov1', buyerId: 'cust1', status: 'confirmed' }); };

  seed();
  let r = await call(M.createConversation, 'cust1', { transactionType: 'service_booking', transactionId: 'bk1' });
  const conv = DOCS.get('conversations/service_booking_bk1');
  ck('M-1', !!(r.ok && conv && conv.participants && conv.participants.includes('cust1') && conv.participants.includes('prov1')),
    'the customer opens the conversation of an ENGINE booking (providerBookings, customerUid); both parties are seated', r.code ? r : conv && conv.participants);
  r = await call(M.createConversation, 'prov1', { transactionType: 'service_booking', transactionId: 'bk1' });
  ck('M-2', !!(r.ok && r.ok.conversationId === 'service_booking_bk1'), 'the provider opens the same conversation (deterministic id)', r);
  seed();
  r = await call(M.createConversation, 'stranger', { transactionType: 'service_booking', transactionId: 'bk1' });
  ck('M-3', r.code === 'permission-denied' && !DOCS.has('conversations/service_booking_bk1'), 'a stranger is refused and nothing is created', r);
  seed();
  r = await call(M.createConversation, 'cust1', { transactionType: 'service_booking', transactionId: 'old1' });
  ck('M-4', !!(r.ok && DOCS.get('conversations/service_booking_old1')), 'a LEGACY service booking (bookings collection) still opens', r);
  seed();
  await call(M.createConversation, 'cust1', { transactionType: 'service_booking', transactionId: 'bk1' });
  const cx = await call(M.getConversationContext, 'prov1', { conversationId: 'service_booking_bk1' });
  ck('M-5', !!(cx.ok && cx.ok.context && cx.ok.context.status === 'pending'), 'the conversation context reads the engine booking (status from providerBookings)', cx);
  r = await call(M.createConversation, 'cust1', { transactionType: 'service_booking', transactionId: 'nope' });
  ck('M-6', r.code === 'not-found' && !/providerBookings|bookings/.test(r.msg || ''), 'an unknown booking is not-found without naming the collection', r);
  /* M-7 — B2B RFQ (sokoni-f3): one conversation per (rfq, supplier) on rfqRecipients; buyer + supplier owner only */
  DOCS.set('rfqRecipients/rfq1__bizS', { rfqId: 'rfq1', buyerUid: 'buyerA', buyerBusinessId: 'bizB', supplierBusinessId: 'bizS', supplierOwnerUid: 'ownerS', status: 'delivered' });
  const rb = await call(M.createConversation, 'buyerA', { transactionType: 'rfq', transactionId: 'rfq1__bizS' });
  const rs = await call(M.createConversation, 'ownerS', { transactionType: 'rfq', transactionId: 'rfq1__bizS' });
  const rx = await call(M.createConversation, 'otherSupplier', { transactionType: 'rfq', transactionId: 'rfq1__bizS' });
  const rc = DOCS.get('conversations/rfq_rfq1__bizS') || {};
  ck('M-7', !!(rb.ok && rs.ok && rb.ok.conversationId === rs.ok.conversationId && rx.code === 'permission-denied'
    && rc.participants && rc.participants.length === 2 && rc.participants.includes('buyerA') && rc.participants.includes('ownerS')),
    'RFQ: buyer and supplier owner open ONE conversation (rfqRecipients); another supplier is refused', { rb, rs, rx: rx.code, parts: rc.participants });
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
