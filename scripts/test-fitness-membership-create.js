#!/usr/bin/env node
'use strict';
/* ============================================================================
   Fitness membership CREATE from a gym's providerServices offer (owner 2026-10-03) — security matrix
   Modules: functions/fitness-membership-create.js, functions/shared/membership-offer.js; end-to-end with 2f's
   payment-purposes.fitness_membership pricer, membership-settlement.initialSettlementFields and fitness-attendance.
   In-memory Firestore (transactions: reads recorded, contention re-run, all-or-nothing writes, create() fails on an
   existing doc). firebase-admin is INERT (any real admin.firestore()/getFirestore() call throws). Emulator: QUEUED.

   Negative controls (each re-compiles a module from a MUTATED source string in memory; must FAIL its named row):
     NC-a  client priceCents accepted                     → C9  client-supplied fields ignored
     NC-b  provider approval check skipped                → C6  provider not approved / suspended
     NC-c  single-flight claim dropped                    → C10 double call idempotent
     NC-d  pricer re-reads the OFFER at pay time (2f)     → C12 offer edit after creation changes nothing
     NC-e  reuse ignores payBy                            → C16 reuse never returns an expired membership
     NC-f  payBy not written                              → C15 payBy set server-side
     NC-g  sales-flag check removed                       → C18 sales flag gates creation
     NC-h  sales flag compared truthy (=='true' accepted)  → C18 sales flag gates creation

   Rows C12/C13 run on the REAL clock (payment-purposes' payBy check reads Date.now(), 2f df88d4b S3).

   Run: NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require <block-admin.js> node scripts/test-fitness-membership-create.js
   ============================================================================ */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) { console.error('refusing to run inside a Cloud Functions runtime'); process.exit(2); }

/* ── inert firebase-admin + a firestore entry point bound to the CURRENT fake db (payment-purposes uses getFirestore) ── */
let CURRENT_DB = null;
const _prevLoad = Module._load;
const INERT_ADMIN = {
  apps: [1], initializeApp () {},
  firestore: Object.assign(function () { throw new Error('[suite] real admin.firestore() called'); }, {
    FieldValue: { serverTimestamp: () => 'SERVER_TS', increment: (n) => ({ __inc: n }) },
    Timestamp: { now: () => ({ toDate: () => new Date() }), fromDate: (d) => ({ toDate: () => d }) },
  }),
  auth () { throw new Error('[suite] real admin.auth() called'); },
};
const FAKE_FIRESTORE_ENTRY = {
  getFirestore: () => { if (!CURRENT_DB) throw new Error('[suite] getFirestore() with no fake db bound'); return CURRENT_DB; },
  FieldPath: { documentId: () => '__name__' },
};
Module._load = function (req) {
  if (req === 'firebase-admin') return INERT_ADMIN;
  if (req === 'firebase-admin/firestore') return FAKE_FIRESTORE_ENTRY;
  return _prevLoad.apply(this, arguments);
};

const OFFER = require(path.join(FN, 'shared', 'membership-offer.js'));
const MS = require(path.join(FN, 'membership-settlement.js'));
const FA = require(path.join(FN, 'fitness-attendance.js'));
const SRC_FILE = path.join(FN, 'fitness-membership-create.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const OFFER_FILE = path.join(FN, 'shared', 'membership-offer.js');
const OFFER_SRC = fs.readFileSync(OFFER_FILE, 'utf8');
const DEFAULTS = require(path.join(FN, 'shared', 'fitness-offer-defaults.js'));   /* 2f's file — read, never mutated */
const SWITCH = require(path.join(FN, 'shared', 'fitness-sales-switch.js'));   /* 2f's file — read, never mutated */
const PP_FILE = path.join(FN, 'payment-purposes.js');
const PP_SRC = fs.readFileSync(PP_FILE, 'utf8');

function compile (file, src, tag) {
  if (!tag) { const e = require(file); return Object.assign(Object.create(e), e, { __src: src }); }
  const filename = file.replace(/\.js$/, `.${tag}.js`);     /* virtual — never written to disk */
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(FN);
  m._compile(src, filename);
  return Object.assign(Object.create(m.exports), m.exports, { __src: src });
}

/* ── in-memory Firestore (same semantics as test-fitness-attendance.js) ── */
function fakeDb (seed) {
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const INC = Symbol('inc');
  const clone = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
  const apply = (cur, patch) => {
    const out = Object.assign({}, cur || {});
    for (const [k, v] of Object.entries(patch)) out[k] = v && v[INC] !== undefined ? (Number(out[k]) || 0) + v[INC] : v;
    return out;
  };
  let autoId = 0;
  const snap = (p) => { const d = docs.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (c) => col(p + '/' + c), get: async () => snap(p),
    set: async (v, o) => { docs.set(p, apply(o && o.merge ? docs.get(p) : null, v)); }, update: async (v) => { docs.set(p, apply(docs.get(p), v)); } });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + (id || ('auto' + String(++autoId).padStart(6, '0')))),
    add: async (v) => { const id = 'auto' + String(++autoId).padStart(6, '0'); docs.set(c + '/' + id, apply(null, v)); return ref(c + '/' + id); },
  });
  const db = {
    _docs: docs, _inc: (n) => ({ [INC]: n }), collection: col, txAttempts: 0,
    async runTransaction (fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        db.txAttempts++;
        const reads = new Map(); const writes = [];
        const t = {
          get: async (r) => { reads.set(r.path, JSON.stringify(docs.get(r.path) === undefined ? null : docs.get(r.path))); return snap(r.path); },
          create: (r, v) => { writes.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, apply(null, v)); }); return t; },
          set: (r, v, o) => { writes.push(() => docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v))); return t; },
          update: (r, v) => { writes.push(() => { if (!docs.has(r.path)) throw new Error('NOT_FOUND'); docs.set(r.path, apply(docs.get(r.path), v)); }); return t; },
        };
        const out = await fn(t);
        if (db.beforeCommit) { const f = db.beforeCommit; db.beforeCommit = null; await f(); }
        let conflict = false;
        for (const [p, v] of reads) if (JSON.stringify(docs.get(p) === undefined ? null : docs.get(p)) !== v) conflict = true;
        if (conflict) continue;
        const before = new Map(docs);
        try { writes.forEach((w) => w()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
        return out;
      }
      throw new Error('ABORTED: too much contention');
    },
  };
  return db;
}

/* ── fixtures ── */
const NOW = new Date('2026-03-20T07:30:00.000Z');
const SVC = 'svc_gold3';
const offer = (over) => Object.assign({ providerId: 'gym_A', name: 'Gold 3-month', category: 'Gym', subcategory: '', description: 'All classes',
  priceType: 'fixed', price: 600000, fee: 0, deposit: 0, images: [], durationMins: 0, active: true,
  serviceKind: 'membership', periodCount: 3, periodUnit: 'month', createdAt: 'T0', updatedAt: 'T0' }, over || {});
const FIT = { status: 'approved', business: { category: 'fitness_studio', source: 'application' } };
const FLAG_ON = { key: 'fitness_membership_sales', enabled: true };
const seedBase = (svcOver, extra) => Object.assign({
  'featureFlags/fitness_membership_sales': FLAG_ON,
  [`providerServices/${SVC}`]: offer(svcOver),
  'providerServices/svc_pt': offer({ serviceKind: undefined, periodCount: undefined, periodUnit: undefined, name: 'PT session', price: 150000, durationMins: 60 }),
  'providers/gym_A': FIT,
  'providers/salon_S': { status: 'approved', business: { category: 'salon', source: 'application' } },
  'providers/gym_U': { status: 'approved', category: 'gym' },                     /* free-text "gym", UNCLASSIFIED */
  'providerServices/svc_salon': offer({ providerId: 'salon_S' }),
  'providerServices/svc_unclassified': offer({ providerId: 'gym_U' }),
}, extra || {});
const AUTH = (uid) => ({ uid, token: { uid } });
const req = (uid, data) => ({ auth: uid ? AUTH(uid) : null, data });
const EXPECTED_KEYS = ['buyerUid', 'category', 'createdAt', 'payBy', 'paymentStatus', 'periodCount', 'periodUnit', 'priceCents', 'providerId', 'serviceId', 'startAt', 'status', 'title'];

function harness (FMC, seed, opts) {
  const o = opts || {};
  const db = fakeDb(seed);
  CURRENT_DB = db;
  let now = o.now || NOW; let n = 0;
  FMC._test.use({ db, ts: () => 'TS', now: () => now, tsFromDate: (d) => d.toISOString(), newId: () => 'mem_' + String(++n).padStart(6, '0') });
  const mems = () => [...db._docs.keys()].filter((k) => /^providerMemberships\/[^/]+$/.test(k));
  return { db, mems, setNow: (d) => { now = d; }, get: (p) => db._docs.get(p) };
}
async function attempt (fn) { try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, e, reason: e && e.details && e.details.reason, code: e && e.code, msg: e && e.message }; } }
const create = (FMC, uid, data) => attempt(() => FMC._h.createMembershipHandler(req(uid, data)));

async function matrix (FMC, PP, OFF) {
  const OF = OFF || OFFER;      /* the membership-offer module under test for C21/C22 (an 'offer' mutant swaps it) */
  const rows = {};
  const ck = (name, ok, detail) => { rows[name] = { ok: !!ok, detail }; };

  /* C1 */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, null, { serviceId: SVC });
    ck('C1 not signed in → unauthenticated; nothing written', r.code === 'unauthenticated' && h.mems().length === 0, r.code); }

  /* C2 */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, 'member_1', { serviceId: 'svc_nope' });
    const bad = await create(FMC, 'member_1', { serviceId: '../providers/x' });
    const none = await create(FMC, 'member_1', {});
    ck('C2 service missing → not-found; malformed / absent serviceId → invalid-argument; nothing written',
      r.code === 'not-found' && bad.code === 'invalid-argument' && none.code === 'invalid-argument' && h.mems().length === 0, [r.code, bad.code, none.code]); }

  /* C3 */
  { const h = harness(FMC, seedBase());
    const pt = await create(FMC, 'member_1', { serviceId: 'svc_pt' });
    const h2 = harness(FMC, seedBase({ active: false })); const off = await create(FMC, 'member_1', { serviceId: SVC });
    const h3 = harness(FMC, seedBase({ removedAt: 'T1' })); const del = await create(FMC, 'member_1', { serviceId: SVC });
    const h4 = harness(FMC, seedBase({ serviceKind: 'Membership' })); const kind = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C3 non-membership service (a PT slot) → not_membership; inactive / deleted offer → inactive; wrong-case kind → not_membership',
      pt.reason === 'not_membership' && off.reason === 'inactive' && del.reason === 'inactive' && kind.reason === 'not_membership'
      && [h, h2, h3, h4].every((x) => x.mems().length === 0), [pt.reason, off.reason, del.reason, kind.reason]); }

  /* C4 */
  { const out = [];
    for (const pc of [0, 61, 2.5, '3', null, -1, NaN]) {
      const h = harness(FMC, seedBase({ periodCount: pc }));
      const r = await create(FMC, 'member_1', { serviceId: SVC });
      out.push([pc, r.reason, h.mems().length]);
    }
    const units = [];
    for (const pu of ['year', 'Week', '', 'toString', 7]) {
      const hu = harness(FMC, seedBase({ periodUnit: pu })); const r = await create(FMC, 'member_1', { serviceId: SVC }); units.push([pu, r.reason, hu.mems().length]);
    }
    const hw = harness(FMC, seedBase({ periodUnit: 'week', periodCount: 3 })); const w3 = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C4 periodCount 0 / 61 / 2.5 / "3" / null / -1 / NaN → bad_period; periodUnit year / Week / "" / toString / 7 → bad_unit; nothing written on refusal; week×3 is a valid 3-week pass',
      out.every((x) => x[1] === 'bad_period' && x[2] === 0) && units.every((x) => x[1] === 'bad_unit' && x[2] === 0) && w3.ok && hw.mems().length === 1 && hw.get(hw.mems()[0]).periodUnit === 'week' && hw.get(hw.mems()[0]).periodCount === 3,
      { out, units, w3: w3.r || w3.reason }); }

  /* C5 */
  { const out = [];
    for (const [label, over] of [['missing', { price: undefined }], ['negative', { price: -600000 }], ['string', { price: '600000' }], ['zero', { price: 0 }],
      ['cents remainder', { price: 600050 }], ['fraction', { price: 600000.5 }], ['above max', { price: 150000 * 100 + 100 }], ['NaN', { price: NaN }]]) {
      const h = harness(FMC, seedBase(over));
      const r = await create(FMC, 'member_1', { serviceId: SVC });
      out.push([label, r.reason, h.mems().length]);
    }
    const hq = harness(FMC, seedBase({ priceType: 'quotation' })); const q = await create(FMC, 'member_1', { serviceId: SVC });
    const hr = harness(FMC, seedBase({ pricing: { basePrice: 100 } })); const rc = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C5 price missing / negative / non-number / 0 / not whole shillings / fraction / above KES 150,000 → bad_price; quotation or rate-card offer → bad_price_type',
      out.every((x) => x[1] === 'bad_price' && x[2] === 0) && q.reason === 'bad_price_type' && rc.reason === 'bad_price_type' && hq.mems().length + hr.mems().length === 0,
      { out, q: q.reason, rc: rc.reason }); }

  /* C6 */
  { const out = [];
    for (const [label, prov] of [['pending', Object.assign({}, FIT, { status: 'pending' })], ['suspended status', Object.assign({}, FIT, { status: 'suspended' })],
      ['suspended flag', Object.assign({}, FIT, { suspended: true })], ['rejected', Object.assign({}, FIT, { status: 'rejected' })],
      ['not selling', Object.assign({}, FIT, { acceptsBookings: false })], ['missing', undefined]]) {
      const seed = seedBase(); if (prov) seed['providers/gym_A'] = prov; else delete seed['providers/gym_A'];
      const h = harness(FMC, seed);
      const r = await create(FMC, 'member_1', { serviceId: SVC });
      out.push([label, r.reason, h.mems().length]);
    }
    const hOk = harness(FMC, seedBase(null, { 'providers/gym_A': Object.assign({}, FIT, { status: 'active' }) }));
    const okActive = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C6 provider not approved (pending / rejected) / suspended (status or flag) / not selling / missing → refused; status active is accepted',
      out.every((x) => /^provider_(not_active|missing)$/.test(x[1] || '') && x[2] === 0) && okActive.ok && hOk.mems().length === 1, { out, okActive: okActive.ok }); }

  /* C7 */
  { const h = harness(FMC, seedBase());
    const salon = await create(FMC, 'member_1', { serviceId: 'svc_salon' });
    const unc = await create(FMC, 'member_1', { serviceId: 'svc_unclassified' });
    ck('C7 non-fitness provider (salon) and an UNCLASSIFIED provider whose free-text category says "gym" → not_fitness',
      salon.reason === 'not_fitness' && unc.reason === 'not_fitness' && h.mems().length === 0, [salon.reason, unc.reason]); }

  /* C8 */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, 'gym_A', { serviceId: SVC });
    ck('C8 buyer == provider → self_purchase; nothing written', r.reason === 'self_purchase' && h.mems().length === 0, r.reason); }

  /* C9 */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, 'member_1', { serviceId: SVC, priceCents: 100, price: 100, periodCount: 60, periodUnit: 'day', providerId: 'gym_B',
      buyerUid: 'member_9', title: 'Free', status: 'active', paymentStatus: 'paid_held', startAt: '2020-01-01T00:00:00.000Z', category: 'x', payBy: '2099-01-01T00:00:00.000Z', requestedStartAt: '2099-01-01T00:00:00.000Z' });
    const m = r.ok && h.get('providerMemberships/' + r.r.membershipId);
    ck('C9 client-supplied priceCents / periodCount / periodUnit / providerId / buyerUid / title / status / startAt / payBy / requestedStartAt ignored',
      !!m && m.priceCents === 600000 && m.periodCount === 3 && m.periodUnit === 'month' && m.providerId === 'gym_A' && m.buyerUid === 'member_1'
      && m.title === 'Gold 3-month' && m.status === 'pending_payment' && m.paymentStatus === 'pending' && m.startAt === NOW.toISOString() && m.category === 'fitness'
      && m.payBy === new Date(NOW.getTime() + 5 * 60 * 1000).toISOString() && !('requestedStartAt' in m)
      && r.r.priceCents === 600000, m || r.reason); }

  /* C10 */
  { const h = harness(FMC, seedBase());
    const a = await create(FMC, 'member_1', { serviceId: SVC });
    const b = await create(FMC, 'member_1', { serviceId: SVC });
    const seqOk = a.ok && b.ok && a.r.membershipId === b.r.membershipId && b.r.reused === true && h.mems().length === 1;
    /* concurrent double tap: the second call runs to completion INSIDE the first one's transaction window */
    const hc = harness(FMC, seedBase());
    let inner = null;
    hc.db.beforeCommit = async () => { inner = await create(FMC, 'member_1', { serviceId: SVC }); };
    const outer = await create(FMC, 'member_1', { serviceId: SVC });
    const concOk = outer.ok && inner && inner.ok && outer.r.membershipId === inner.r.membershipId && hc.mems().length === 1;
    /* another buyer gets their own; 30 min later a fresh one; a PAID one is never reused */
    const other = await create(FMC, 'member_2', { serviceId: SVC });
    hc.setNow(new Date(NOW.getTime() + 30 * 60 * 1000));
    const late = await create(FMC, 'member_1', { serviceId: SVC });
    const hp = harness(FMC, seedBase());
    const p1 = await create(FMC, 'member_1', { serviceId: SVC });
    hp.db._docs.set('providerMemberships/' + p1.r.membershipId, Object.assign(hp.get('providerMemberships/' + p1.r.membershipId), { paymentStatus: 'paid_held', status: 'active' }));
    const p2 = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C10 double call idempotent: sequential and concurrent double tap → ONE pending membership (reused); other buyer separate; ≥30 min or paid → a new one',
      seqOk && concOk && other.ok && other.r.membershipId !== outer.r.membershipId && late.ok && late.r.reused === false && late.r.membershipId !== outer.r.membershipId
      && p2.ok && p2.r.reused === false && p2.r.membershipId !== p1.r.membershipId,
      { seqOk, concOk, mems: hc.mems(), late: late.r, p2: p2.r }); }

  /* C11 */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, 'member_1', { serviceId: SVC });
    const m = h.get('providerMemberships/' + r.r.membershipId) || {};
    const keys = Object.keys(m).sort();
    const resKeys = Object.keys(r.r).sort().join();
    ck('C11 created doc shape EXACT (create contract v2 + serviceId + createdAt + payBy): no fee/deposit/commission/attendance/settlement fields, no requestedStartAt (2f writes it at payment)',
      keys.join() === EXPECTED_KEYS.join() && Number.isInteger(m.priceCents) && m.serviceId === SVC && m.createdAt === 'TS'
      && resKeys === 'membershipId,payBy,periodCount,periodUnit,priceCents,reused,title', { keys, resKeys }); }

  /* C12 — SNAPSHOT (2f): an offer edit after creation changes neither the membership nor what the purpose charges */
  { const h = harness(FMC, seedBase(), { now: new Date() });
    const r = await create(FMC, 'member_1', { serviceId: SVC });
    const P = 'providerMemberships/' + r.r.membershipId;
    const before = JSON.stringify(h.get(P));
    h.db._docs.set(`providerServices/${SVC}`, Object.assign(h.get(`providerServices/${SVC}`), { price: 100, periodCount: 12, name: 'Cheap' }));
    const after = JSON.stringify(h.get(P));
    const q = await attempt(() => PP.priceFor('fitness_membership', 'member_1', { membershipId: r.r.membershipId }));
    ck('C12 offer edit after creation (price → KES 1, months → 12) changes NEITHER the membership doc NOR the amount fitness_membership charges',
      before === after && q.ok && q.r.amountCents === 600000 && q.r.amount === 6000 && q.r.metadata.periodCount === 3, { same: before === after, q: q.ok ? q.r.amountCents : q.msg }); }

  /* C13 — end to end (real clock: the purpose's payBy check and 2f's start-at-payment both read "now") */
  { const RT = new Date(); const h = harness(FMC, seedBase(), { now: RT });
    const r = await create(FMC, 'member_1', { serviceId: SVC });
    const id = r.r.membershipId; const P = 'providerMemberships/' + id;
    const q = await attempt(() => PP.priceFor('fitness_membership', 'member_1', { membershipId: id }));
    const wrongBuyer = await attempt(() => PP.priceFor('fitness_membership', 'member_2', { membershipId: id }));
    MS._test.use({ db: h.db, ts: () => 'MSTS', inc: h.db._inc, tsFromDate: (d) => d.toISOString(), now: () => RT, notify: async () => null });
    /* the intent createPaymentIntent would persist from this quote; then 2f's REAL webhook hold (initialSettlementFields inside) */
    h.db._docs.set('paymentIntents/int_1', { uid: 'member_1', purpose: 'fitness_membership', resourceType: q.ok ? q.r.resourceType : null, resourceId: id, amountCents: q.ok ? q.r.amountCents : 0, currency: 'KES' });
    const held = await MS.holdMembershipPayment(h.db, null, 'API_TEST', 'int_1', q.ok ? q.r.amount : 0);
    const mh = h.get(P);
    const holdOk = held === true && mh.paymentStatus === 'paid_held' && mh.status === 'active' && mh.heldCents === 600000 && mh.releasedPeriods === 0;
    let tsN = 0; const released = [];
    FA._test.use({ db: h.db, ts: () => 'FTS#' + (++tsN), now: () => new Date(RT.getTime() + 86400000), correlationId: () => 'cid', release: async (x) => { released.push(x); }, staffAuthority: null, notify: async () => null });
    const tok = (await FA._h.membershipQrHandler(req('member_1', { membershipId: id }))).token;
    const ci = await attempt(() => FA._h.checkInHandler(req('gym_A', { token: tok })));
    const m = h.get(P);
    ck('C13 end to end: create → 2f pricer charges the snapshot (KES 6,000, buyer-bound) → 2f webhook hold (paid_held + initialSettlementFields) → QR check-in records attendance and locks refund',
      holdOk && q.ok && q.r.amountCents === 600000 && q.r.resourceType === 'providerMembership' && q.r.resourceId === id && wrongBuyer.code === 'permission-denied'
      && ci.ok && ci.r.firstCheckIn === true && m.attendedSessions === 1 && m.refundEligible === false && !!m.firstAttendedAt && m.status === 'active'
      && released[0] === id && MS.refundDecision(m, new Date(RT.getTime() + 86400000)).code === 'used' && m.requestedStartAt === RT.toISOString(),
      { holdOk, q: q.ok ? q.r : q.msg, wrongBuyer: wrongBuyer.code, ci: ci.ok ? ci.r : ci.reason, m }); }

  /* C14 — writer hook (for sokoni-5b's providerDispatch release; pure) */
  { const mk = (d) => { const out = { providerId: 'gym_A', name: d.name || 'Gold', priceType: d.priceType || 'quotation', price: Math.max(0, Math.round(Number(d.price) || 0)), active: true, createdAt: 'T' }; return { out, v: OFFER.applyToServiceWrite('create', d, null, out) }; };
    const c1 = mk({ name: 'Gold', price: 600000, serviceKind: 'membership', periodCount: 3 });
    const c2 = mk({ price: 600000, serviceKind: 'membership', periodCount: 61 });
    const c3 = mk({ price: 0, serviceKind: 'membership', periodCount: 3 });
    const c4 = mk({ price: 600000, periodCount: 3 });
    const c5 = mk({ price: 600000, serviceKind: 'subscription' });
    const plain = mk({ price: 150000 });
    const cur = Object.assign({}, c1.out);
    const u1p = { price: 0 }; const u1 = OFFER.applyToServiceWrite('update', { price: 0 }, cur, u1p);
    const u2p = { name: 'Gold+' }; const u2 = OFFER.applyToServiceWrite('update', { name: 'Gold+' }, cur, u2p);
    const u3p = { priceType: 'quotation' }; const u3 = OFFER.applyToServiceWrite('update', { priceType: 'quotation' }, cur, u3p);
    const dupOut = { providerId: 'gym_A', name: 'Gold (copy)', priceType: cur.priceType, price: cur.price, active: true, createdAt: 'T' };
    const dup = OFFER.applyToServiceWrite('duplicate', { serviceKind: null }, cur, dupOut);
    ck('C14 writer hook: membership create forces priceType fixed + periodUnit month; 61 months / price 0 / periods without kind / unknown kind refused; plain service untouched; edits re-validated; duplicate keeps the kind',
      c1.v.ok && c1.out.priceType === 'fixed' && c1.out.periodUnit === 'month' && c1.out.periodCount === 3 && OFFER.validateMembershipOffer(c1.out).ok
      && c2.v.reason === 'bad_period' && c3.v.reason === 'bad_price' && c4.v.reason === 'not_membership' && c5.v.reason === 'bad_kind'
      && plain.v.ok && plain.out.serviceKind === undefined && plain.out.priceType === 'quotation'
      && u1.reason === 'bad_price' && u2.ok && u3.ok && u3p.priceType === 'fixed' && dup.ok && dupOut.serviceKind === 'membership' && dupOut.periodCount === 3,
      { c1, c2: c2.v, c3: c3.v, c4: c4.v, c5: c5.v, u1, u2, u3p, dupOut }); }

  /* C14b — writer hook with short units: week×1 create keeps the unit; week×9 refused; an edit that switches the unit is
     re-validated against the NEW unit's bound; a duplicate keeps the unit; an update that omits periodUnit keeps it */
  { const mk = (d) => { const out = { providerId: 'gym_A', name: 'Pass', priceType: 'quotation', price: Math.max(0, Math.round(Number(d.price) || 0)), active: true, createdAt: 'T' }; return { out, v: OFFER.applyToServiceWrite('create', d, null, out) }; };
    const wk = mk({ price: 150000, serviceKind: 'membership', periodUnit: 'week', periodCount: 1 });
    const w9 = mk({ price: 150000, serviceKind: 'membership', periodUnit: 'week', periodCount: 9 });
    const yr = mk({ price: 150000, serviceKind: 'membership', periodUnit: 'year', periodCount: 1 });
    const cur = Object.assign({}, wk.out);
    const keepP = { price: 200000 }; const keep = OFFER.applyToServiceWrite('update', { price: 200000 }, cur, keepP);
    const toDayP = { periodUnit: 'day', periodCount: 40 }; const toDay = OFFER.applyToServiceWrite('update', { periodUnit: 'day', periodCount: 40 }, cur, toDayP);
    const toMonP = { periodUnit: 'month', periodCount: 12 }; const toMon = OFFER.applyToServiceWrite('update', { periodUnit: 'month', periodCount: 12 }, cur, toMonP);
    const dupOut = { providerId: 'gym_A', name: 'Pass (copy)', price: cur.price, active: true, createdAt: 'T' };
    const dup = OFFER.applyToServiceWrite('duplicate', null, cur, dupOut);
    ck('C14b writer hook short units: week×1 kept; week×9 / unit year refused; update without unit keeps week; switch to day×40 refused, to month×12 accepted; duplicate keeps week',
      wk.v.ok && wk.out.periodUnit === 'week' && wk.out.periodCount === 1 && OFFER.validateMembershipOffer(wk.out).ok
      && w9.v.reason === 'bad_period' && yr.v.reason === 'bad_unit' && keep.ok && keepP.periodUnit === 'week'
      && toDay.reason === 'bad_period' && toMon.ok && toMonP.periodUnit === 'month' && dup.ok && dupOut.periodUnit === 'week' && dupOut.periodCount === 1,
      { wk, w9: w9.v, yr: yr.v, keepP, toDay, toMonP, dupOut }); }

  /* C20 — the membership snapshots periodUnit FROM THE OFFER (day / week passes; no hard-coded 'month') */
  { const got = {};
    for (const [unit, price] of [['day', 50000], ['week', 150000], ['month', 500000]]) {
      const h = harness(FMC, seedBase({ periodUnit: unit, periodCount: 1, price, name: unit + ' pass' }));
      const r = await create(FMC, 'member_1', { serviceId: SVC, periodUnit: 'month' });          /* client unit ignored */
      const m = h.mems().length === 1 ? h.get(h.mems()[0]) : null;
      got[unit] = r.ok && m && m.periodUnit === unit && m.periodCount === 1 && m.priceCents === price && r.r.periodUnit === unit
        && MS.slicesOf(m).length === 1 ? 'ok' : { r: r.r || r.reason, m };
    }
    const hl = harness(FMC, seedBase({ periodUnit: undefined, periodCount: 3 })); const legacy = await create(FMC, 'member_1', { serviceId: SVC });
    ck("C20 membership snapshots the offer's periodUnit (day / week / month; client value ignored); one settlement slice for day×1 / week×1 / month×1; an offer with no periodUnit stays month",
      Object.values(got).every((x) => x === 'ok') && legacy.ok && hl.get(hl.mems()[0]).periodUnit === 'month', { got, legacy: legacy.r || legacy.reason }); }

  /* C21 — per-unit bounds are EXACTLY membership-settlement.slicesOf's: n = limit accepted by both, n + 1 refused by both */
  { const res = {};
    for (const unit of ['day', 'week', 'month']) {
      const lim = OF.PERIOD_LIMITS[unit];
      const at = (n) => ({ v: OF.validateMembershipOffer(offer({ periodUnit: unit, periodCount: n })).ok,
        s: (() => { try { MS.slicesOf({ priceCents: 600000, periodCount: n, periodUnit: unit, startAt: NOW.toISOString() }); return true; } catch (_) { return false; } })() });
      res[unit] = { lim, atLim: at(lim), over: at(lim + 1), one: at(1) };
    }
    const expected = { day: 31, week: 8, month: 60 };
    ck('C21 offer bounds = settlement bounds per unit (day 31, week 8, month 60): limit accepted by validator AND slicesOf, limit+1 refused by both, 1 accepted by both',
      Object.keys(expected).every((u) => res[u].lim === expected[u] && res[u].atLim.v && res[u].atLim.s && !res[u].over.v && !res[u].over.s && res[u].one.v && res[u].one.s)
      && Object.keys(OF.PERIOD_LIMITS).sort().join() === 'day,month,week', res); }

  /* C22 — every SOKONI default (2f's shared/fitness-offer-defaults.js) is a valid offer when published as a service */
  { const res = DEFAULTS.OFFER_DEFAULTS.map((d) => {
      const v = OF.validateMembershipOffer(offer({ name: d.label, price: d.priceCents, periodUnit: d.periodUnit, periodCount: d.periodCount }));
      return { key: d.key, ok: v.ok && v.priceCents === d.priceCents && v.periodUnit === d.periodUnit && v.periodCount === d.periodCount, reason: v.reason };
    });
    /* shilling rule probe: a default-shaped offer with a cents remainder must be refused by the same module */
    const centsProbe = OF.validateMembershipOffer(offer({ price: 50050, periodUnit: 'day', periodCount: 1 })).reason;
    const sav = DEFAULTS.withSavings();
    ck('C22 all six OFFER_DEFAULTS (Daily 500 / Weekly 1,500 / Monthly 5,000 / 3M 14,000 / 6M 26,000 / Annual 48,000) validate as published offers (whole shillings, in range, unit bounds); a cents remainder is still refused; withSavings computes',
      res.length === 6 && res.every((x) => x.ok) && DEFAULTS.OFFER_DEFAULTS.map((d) => d.priceCents / 100).join() === '500,1500,5000,14000,26000,48000'
      && centsProbe === 'bad_price' && sav.length === 6 && sav.find((x) => x.key === 'annual').savingPct === 20 && sav.find((x) => x.key === 'daily').savingPct === null,
      { res, centsProbe, sav }); }

  /* C15 — payBy (2f df88d4b S3: the purpose refuses a NEW intent once payBy has passed; this path must set it) */
  { const h = harness(FMC, seedBase());
    const r = await create(FMC, 'member_1', { serviceId: SVC, payBy: '2099-01-01T00:00:00.000Z' });
    const m = r.ok ? h.get('providerMemberships/' + r.r.membershipId) : {};
    const want = new Date(NOW.getTime() + FMC.PAY_BY_MS).toISOString();
    /* end to end with 2f's purpose: NOW is in the past, so this membership's payBy has passed on the real clock */
    const q = await attempt(() => PP.priceFor('fitness_membership', 'member_1', { membershipId: r.r.membershipId }));
    ck('C15 payBy set SERVER-side = creation + PAY_BY_MS (client payBy ignored), returned to the client; 2f purpose refuses a new intent after it',
      r.ok && m.payBy === want && r.r.payBy === want && FMC.PAY_BY_MS === 5 * 60 * 1000 && !q.ok && q.code === 'failed-precondition' && /expired/i.test(q.msg || ''),
      { payBy: m.payBy, res: r.r && r.r.payBy, q: q.ok ? q.r : [q.code, q.msg] }); }

  /* C16 — the 30-min double-tap reuse window never outlives payBy */
  { const h = harness(FMC, seedBase());
    const a = await create(FMC, 'member_1', { serviceId: SVC });
    h.setNow(new Date(NOW.getTime() + FMC.PAY_BY_MS - 1));
    const inside = await create(FMC, 'member_1', { serviceId: SVC });
    h.setNow(new Date(NOW.getTime() + FMC.PAY_BY_MS));          /* exactly payBy: expired */
    const atPayBy = await create(FMC, 'member_1', { serviceId: SVC });
    const hn = harness(FMC, seedBase());
    const b = await create(FMC, 'member_1', { serviceId: SVC });
    const P = 'providerMemberships/' + b.r.membershipId;
    const legacy = Object.assign({}, hn.get(P)); delete legacy.payBy; hn.db._docs.set(P, legacy);   /* a record without payBy */
    const noPayBy = await create(FMC, 'member_1', { serviceId: SVC });
    ck('C16 reuse never returns an expired membership: reused 1 ms before payBy; a NEW one at payBy (well inside 30 min); a record with no payBy is never reused',
      a.ok && inside.ok && inside.r.reused === true && inside.r.membershipId === a.r.membershipId
      && atPayBy.ok && atPayBy.r.reused === false && atPayBy.r.membershipId !== a.r.membershipId && noPayBy.ok && noPayBy.r.reused === false,
      { inside: inside.r, atPayBy: atPayBy.r, noPayBy: noPayBy.r }); }

  /* C17 — PAY_BY_MS is the booking hold window (booking-service.js HOLD_MS is not exported → the VALUE is pinned) */
  { const bs = fs.readFileSync(path.join(FN, 'booking-service.js'), 'utf8');
    const mm = /const HOLD_MS = ([0-9 *]+);/.exec(bs);
    const hold = mm ? Function('return (' + mm[1] + ')')() : null;
    ck('C17 PAY_BY_MS equals booking-service.js HOLD_MS (the platform pre-payment hold window) — drift fails here',
      hold != null && hold === FMC.PAY_BY_MS, { hold, payBy: FMC.PAY_BY_MS }); }

  return Object.assign(rows, await flagRows(FMC));
}

/* C18/C19 — the sales switch. Separate so a flag mutant (NC-g..j) is judged on its NAMED row alone: a mutant that
   refuses EVERY creation (NC-h) would otherwise crash the earlier rows that need a created membership. */
async function flagRows (FMC) {
  const rows = {};
  const ck = (name, ok, detail) => { rows[name] = { ok: !!ok, detail }; };

  /* C18 — SALES FLAG (owner 2026-10-03): featureFlags/fitness_membership_sales.enabled === true, read server-side */
  { const out = {};
    const run = async (label, flagDoc, opts) => {
      const seed = seedBase();
      if (flagDoc === undefined) delete seed['featureFlags/fitness_membership_sales']; else seed['featureFlags/fitness_membership_sales'] = flagDoc;
      const h = harness(FMC, seed);
      if (opts && opts.readError) {
        const realCol = h.db.collection;
        const wrapped = Object.assign({}, h.db, { collection: (c) => (c === 'featureFlags'
          ? { doc: () => ({ get: async () => { throw new Error('UNAVAILABLE: flag read failed'); } }) } : realCol(c)) });
        FMC._test.use({ db: wrapped });
      }
      const r = await create(FMC, 'member_1', { serviceId: SVC });
      out[label] = { ok: r.ok, code: r.code, reason: r.reason, msg: r.msg, mems: h.mems().length, claims: [...h.db._docs.keys()].filter((k) => k.startsWith('fitnessMembershipClaims/')).length };
    };
    await run('missing doc', undefined);
    await run('missing field', { key: 'fitness_membership_sales' });
    await run('false', { enabled: false });
    await run("'true' string", { enabled: 'true' });
    await run('1', { enabled: 1 });
    await run('read error', FLAG_ON, { readError: true });
    await run('true', FLAG_ON);
    const refused = ['missing doc', 'missing field', 'false', "'true' string", '1', 'read error'].every((k) => {
      const o = out[k]; return !o.ok && o.code === 'failed-precondition' && o.reason === 'SALES_DISABLED' && o.msg === "Memberships aren't on sale yet." && o.mems === 0 && o.claims === 0; });
    /* THE shared predicate (2f fe33bcc) with an explicit db agrees with what the handler did */
    const onDb = fakeDb({ 'featureFlags/fitness_membership_sales': FLAG_ON }); const offDb = fakeDb({ 'featureFlags/fitness_membership_sales': { enabled: 'true' } });
    out.sharedPredicate = [await SWITCH.salesEnabled(onDb), await SWITCH.salesEnabled(offDb), await SWITCH.salesEnabled(fakeDb({}))];
    ck("C18 sales flag gates creation: missing doc / missing field / false / 'true' string / 1 / read error → failed-precondition SALES_DISABLED, nothing written; enabled === true → created; the shared predicate agrees",
      refused && out.true.ok && out.true.mems === 1 && out.sharedPredicate.join() === 'true,false,false', out); }

  /* C19 — ONE predicate: the create path reads the flag ONLY through functions/shared/fitness-sales-switch.js (2f), the
     same function payment-purposes.fitness_membership calls; no local reader, no exported copy. Checked on the module
     under test (FMC), so a mutant that re-grows a private copy fails here. */
  { const src = FMC.__src || '';
    const usesShared = src.includes("const { salesEnabled } = require('./shared/fitness-sales-switch');") && src.includes('await salesEnabled(_db())');
    const noLocal = !src.includes("collection('featureFlags')") && !src.includes('collection(FLAGS)') && !/function salesEnabled|salesEnabled\s*=\s*async/.test(src);
    const ppShared = PP_SRC.includes("require('./shared/fitness-sales-switch').salesEnabled(db())");
    ck('C19 one sales predicate: create imports shared/fitness-sales-switch salesEnabled and passes its db; no local featureFlags read or copy; no salesEnabled export; payment-purposes calls the same module',
      usesShared && noLocal && ppShared && FMC.salesEnabled === undefined && FMC.SALES_FLAG === undefined, { usesShared, noLocal, ppShared, exported: typeof FMC.salesEnabled }); }

  return rows;
}

/* ── mutants (negative controls) ── */
const ROW = (rows, prefix) => Object.keys(rows).find((k) => k.startsWith(prefix + ' '));
const MUTANTS = [
  { tag: 'a', row: 'C9', what: 'client priceCents accepted', file: 'fmc',
    from: 'priceCents: offer.priceCents,', to: 'priceCents: Number(req.data.priceCents) || offer.priceCents,' },
  { tag: 'b', row: 'C6', what: 'provider approval check skipped', file: 'fmc',
    from: 'const refusal = providerRefusal(provSnap.exists ? provSnap.data() : null);', to: 'const refusal = null;' },
  { tag: 'c', row: 'C10', what: 'single-flight claim dropped', file: 'fmc',
    from: 'if (prior && prior.m.buyerUid === uid', to: 'if (false && prior && prior.m.buyerUid === uid' },
  { tag: 'd', row: 'C12', what: 'fitness_membership pricer re-reads the OFFER at pay time', file: 'pp',
    from: 'const cents = Number(m.priceCents);',
    to: "const cents = Number(((await db().collection('providerServices').doc(String(m.serviceId)).get()).data() || {}).price);" },
  { tag: 'e', row: 'C16', what: 'reuse ignores payBy', file: 'fmc',
    from: '&& now.getTime() < _ms(prior.m.payBy)) {', to: ') {' },
  { tag: 'f', row: 'C15', what: 'payBy not written', file: 'fmc',
    from: 'startAt: _tsFromDate(now), payBy: _tsFromDate(new Date(now.getTime() + PAY_BY_MS)),', to: 'startAt: _tsFromDate(now),' },
  { tag: 'k', row: 'C20', what: "periodUnit hard-coded 'month' at creation (the pre-2026-10-03 behaviour)", file: 'fmc',
    from: 'periodUnit: offer.periodUnit, startAt:', to: "periodUnit: 'month', startAt:" },
  { tag: 'l', row: 'C21', what: 'week bound widened beyond settlement (8 → 52)', file: 'offer',
    from: 'Object.freeze({ day: 31, week: 8, month: 60 })', to: 'Object.freeze({ day: 31, week: 52, month: 60 })' },
  { tag: 'm', row: 'C22', what: "'day' unit dropped from the offer module (Daily Pass default unpublishable)", file: 'offer',
    from: 'Object.freeze({ day: 31, week: 8, month: 60 })', to: 'Object.freeze({ week: 8, month: 60 })' },
  { tag: 'n', row: 'C22', what: 'shilling rule loosened to cents (price % 100 check removed)', file: 'offer',
    from: ' || p % 100 !== 0) return no(', to: ') return no(' },
  { tag: 'g', row: 'C18', what: 'sales-flag check removed', file: 'fmc',
    from: "if (!(await salesEnabled(_db()))) throw new HttpsError(", to: "if (false && !(await salesEnabled(_db()))) throw new HttpsError(" },
  { tag: 'h', row: 'C18', what: 'call site drops the db handle (shared predicate then always reads OFF — sales can never open)', file: 'fmc',
    from: "if (!(await salesEnabled(_db()))) throw new HttpsError(", to: "if (!(await salesEnabled())) throw new HttpsError(" },
  { tag: 'i', row: 'C18', what: "shared import replaced by a private truthy copy ('true' string / 1 accepted)", file: 'fmc',
    from: "const { salesEnabled } = require('./shared/fitness-sales-switch');",
    to: "const salesEnabled = async (db) => { try { const f = await db.collection('featureFlags').doc('fitness_membership_sales').get(); return !!(f.exists && (f.data() || {}).enabled); } catch (_) { return false; } };" },
  { tag: 'j', row: 'C19', what: 'an exact private copy of the predicate (behaviour identical, second reader)', file: 'fmc',
    from: "const { salesEnabled } = require('./shared/fitness-sales-switch');",
    to: "const salesEnabled = async (db) => { try { const f = await db.collection('featureFlags').doc('fitness_membership_sales').get(); return !!(f && f.exists && (f.data() || {}).enabled === true); } catch (_) { return false; } };" },
];

(async () => {
  let fails = 0;
  const realFMC = compile(SRC_FILE, SRC);
  const realPP = compile(PP_FILE, PP_SRC);
  const real = await matrix(realFMC, realPP);
  const names = Object.keys(real);
  for (const n of names) { console.log(`  ${real[n].ok ? 'PASS' : 'FAIL'}  ${n}${real[n].ok ? '' : '  -> ' + JSON.stringify(real[n].detail).slice(0, 600)}`); if (!real[n].ok) fails++; }
  console.log(`\n${names.length - fails} passed, ${fails} failed\n\nNegative controls:`);
  let ctlBad = 0;
  for (const mu of MUTANTS) {
    const base = mu.file === 'pp' ? PP_SRC : (mu.file === 'offer' ? OFFER_SRC : SRC);
    if (!base.includes(mu.from)) { console.log(`  CONTROL BROKEN  NC-${mu.tag}: mutation anchor not found in source`); ctlBad++; continue; }
    const fmc = mu.file === 'fmc' ? compile(SRC_FILE, SRC.replace(mu.from, mu.to), 'mutant_' + mu.tag) : realFMC;
    const pp = mu.file === 'pp' ? compile(PP_FILE, PP_SRC.replace(mu.from, mu.to), 'mutant_' + mu.tag) : realPP;
    const off = mu.file === 'offer' ? compile(OFFER_FILE, OFFER_SRC.replace(mu.from, mu.to), 'mutant_' + mu.tag) : OFFER;
    const rows = (mu.row === 'C18' || mu.row === 'C19') ? await flagRows(fmc) : await matrix(fmc, pp, off);
    const named = rows[ROW(rows, mu.row)];
    const failed = Object.keys(rows).filter((k) => !rows[k].ok);
    const ok = named && named.ok === false;
    if (!ok) ctlBad++;
    console.log(`  ${ok ? 'CAUGHT' : 'MISSED'}  NC-${mu.tag} (${mu.what}) → named row ${mu.row} ${ok ? 'FAILED' : 'did not fail'}; failing rows: ${failed.map((k) => k.split(' ')[0]).join(', ') || 'none'}`);
  }
  console.log(`\n${MUTANTS.length - ctlBad}/${MUTANTS.length} negative controls caught`);
  process.exit(fails || ctlBad ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
