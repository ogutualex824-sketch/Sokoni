#!/usr/bin/env node
'use strict';
/* ============================================================================
   Fitness membership QR check-in / attendance — owner security matrix (OWNER POLICY #2, 2026-10-03)
   Module: functions/fitness-attendance.js. In-memory Firestore (transactions: reads recorded, contention re-run up to
   5×, all-or-nothing writes, create() fails on an existing doc). Emulator proof: QUEUED (memory floor).
   firebase-admin is stubbed INERT here (any admin.firestore() call throws) — the suite injects its own db.

   Negative controls (each re-compiles the module from a MUTATED source string in memory; must FAIL its named row):
     NC-a  the gym-ownership check skipped         → A5 other gym's scanner refused
     NC-b  refundEligible set only on the 2nd scan → A9 first scan sets all three
     NC-c  client refundEligible accepted          → A16 client-supplied fields ignored
     NC-d  state decided on the pre-txn read       → A21 check-in vs refund-request race
   FINAL RELEASE (staff, gym reads, notifications):
     NC-e  staff business-match skipped (any business the caller works at) → S3 staff of business B refused for gym A
     NC-f  workforce permission check skipped                               → S2 staff WITHOUT 'attendance' refused
     NC-g  client providerId accepted by fitnessGymMemberships              → G1 owner sees own gym only
     NC-h  duplicate-scan idempotency dropped                               → A10 duplicate scan is idempotent
   RESPONSE CONTRACT (docs/FITNESS_MEMBERSHIP_API.md):
     NC-i  membershipId dropped from the check-in response                  → A22 check-in response contract

   Also a MODULE: required (not run) by scripts/gen-fitness-api-fixtures.js, which drives the REAL handlers through this
   suite's fake db + fixtures to write scripts/fixtures/fitness-api-fixtures.json.

   workforce-identity.js is the REAL module (its firebase-admin firestore() is bound to the current fake db), so
   _assertBusinessPermission itself decides every staff row.

   Run: NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require <block-admin.js> node scripts/test-fitness-attendance.js
   ============================================================================ */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

/* ── inert firebase-admin (wins over block-admin for the bare name) ── */
const _prevLoad = Module._load;
let CURRENT_DB = null;
const DELEGATE_DB = { collection: (c) => { if (!CURRENT_DB) throw new Error('[suite] admin.firestore() with no fake db bound'); return CURRENT_DB.collection(c); },
  runTransaction: (fn) => { if (!CURRENT_DB) throw new Error('[suite] no fake db'); return CURRENT_DB.runTransaction(fn); } };
const INERT_AUTH = new Proxy({}, { get: (_, p) => (typeof p === 'symbol' || p === 'then' ? undefined : () => { throw new Error('[suite] real admin.auth().' + String(p) + ' called'); }) });
const INERT_ADMIN = {
  apps: [1], initializeApp () {},
  firestore: Object.assign(function () { return DELEGATE_DB; }, {
    FieldValue: { serverTimestamp: () => 'SERVER_TS', increment: (n) => ({ __inc: n }) },
    Timestamp: { now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }), fromDate: (d) => ({ toDate: () => d, toMillis: () => d.getTime() }) },
  }),
  auth () { return INERT_AUTH; },
};
Module._load = function (req) { if (req === 'firebase-admin') return INERT_ADMIN; return _prevLoad.apply(this, arguments); };
if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) { console.error('refusing to run inside a Cloud Functions runtime'); process.exit(2); }

const MS = require(path.join(FN, 'membership-settlement.js'));
const FU = require(path.join(FN, 'finos-utils.js'));
const EO = require(path.join(FN, 'event-ops.js'));
const WFI = require(path.join(FN, 'workforce-identity.js'));
const SRC_FILE = path.join(FN, 'fitness-attendance.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const FG_FILE = path.join(FN, 'fitness-gym-memberships.js');
const FG_SRC = fs.readFileSync(FG_FILE, 'utf8');
/* the gym read module compiled against the FA instance under test (real or mutant) */
function loadFG (FA, src, tag) {
  const filename = path.join(FN, `fitness-gym-memberships.${tag || 'real'}.js`);
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(FN);
  global.__FA_UNDER_TEST = FA;
  m._compile((src || FG_SRC).replace("require('./fitness-attendance')", 'global.__FA_UNDER_TEST'), filename);
  return m.exports;
}

function loadModule (src, tag) {
  if (!tag) return require(SRC_FILE);
  const filename = path.join(FN, `fitness-attendance.${tag}.js`);   /* virtual — never written to disk */
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(FN);
  m._compile(src, filename);
  return m.exports;
}

/* ── in-memory Firestore ── */
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
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (c) => col(p + '/' + c), get: async () => snap(p) });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + id),
    add: async (v) => { const id = 'auto' + (++autoId); docs.set(c + '/' + id, apply(null, v)); return ref(c + '/' + id); },
    where: (f, op, v) => query(c, {}).where(f, op, v),
    orderBy: (f, dir) => query(c, {}).orderBy(f, dir),
    limit: (n) => query(c, {}).limit(n),
    get: () => query(c, {}).get(),
  });
  /* a small Firestore query: equality / in / <= filters, ONE orderBy (+ implicit doc-id tiebreak in the same direction),
     startAfter(snapshot), limit. A missing orderBy field excludes the doc (Firestore semantics). */
  const query = (c, q) => ({
    where: (f, op, v) => query(c, Object.assign({}, q, { filters: (q.filters || []).concat([[f, op, v]]) })),
    orderBy: (f, dir) => query(c, Object.assign({}, q, { order: [f, dir === 'desc' ? -1 : 1] })),
    startAfter: (sn) => query(c, Object.assign({}, q, { after: sn })),
    limit: (n) => query(c, Object.assign({}, q, { lim: n })),
    get: async () => {
      if (db.queries) db.queries.push({ c, q });
      let hits = [...docs.entries()].filter(([k]) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1);
      for (const [f, op, v] of q.filters || []) {
        hits = hits.filter(([, d]) => d[f] != null && (op === '<=' ? d[f] <= v : op === 'in' ? v.includes(d[f]) : d[f] === v));
      }
      if (q.order) {
        const [f, dir] = q.order;
        hits = hits.filter(([, d]) => d[f] != null);
        const key = ([k, d]) => [d[f], k];
        hits.sort((a, b) => { const [x1, k1] = key(a); const [x2, k2] = key(b); return (x1 < x2 ? -1 : x1 > x2 ? 1 : k1 < k2 ? -1 : k1 > k2 ? 1 : 0) * dir; });
        if (q.after) { const i = hits.findIndex(([k]) => k === c + '/' + q.after.id); hits = i >= 0 ? hits.slice(i + 1) : hits; }
      }
      if (q.lim != null) hits = hits.slice(0, q.lim);
      return { size: hits.length, empty: !hits.length, docs: hits.map(([k]) => snap(k)) };
    },
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
        /* deterministic interleaving: a one-shot callback runs a competing operation to completion between this
           transaction's reads and its commit — the commit must then see the conflict and re-run */
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
const START = '2026-01-15T09:00:00.000Z';
const NOW = new Date('2026-03-20T07:30:00.000Z');          /* 10:30 EAT, two months into a 3-month membership */
const MID = 'mem_000001', MID2 = 'mem_000002';
const mem = (over) => Object.assign({ providerId: 'gym_A', buyerUid: 'member_1', priceCents: 600000, periodCount: 3, periodUnit: 'month',
  startAt: START, category: 'fitness', title: 'Gold 3-month', paymentStatus: 'paid_held', status: 'active', releasedPeriods: 0, releasedCents: 0,
  attendedSessions: 0, firstAttendedAt: null }, over || {});
const seedBase = (over, extra) => Object.assign({
  [`providerMemberships/${MID}`]: mem(over),
  [`providerMemberships/${MID2}`]: mem({ buyerUid: 'member_2' }),
  'providers/gym_A': { uid: 'gym_A', status: 'active' }, 'providers/gym_B': { uid: 'gym_B', status: 'active' },
  'businesses/biz_gymA': { ownerId: 'gym_A', merchantId: 'biz_gymA', status: 'active' },
  'businesses/biz_gymB': { ownerId: 'gym_B', merchantId: 'biz_gymB', status: 'active' },
  'workspaceMemberships/wm1': { uid: 'cashier_1', businessId: 'biz_gymA', status: 'active', role: 'cashier', permissions: ['pos', 'view_products', 'customers', 'refunds'] },
  'workspaceMemberships/wm2': { uid: 'trainer_1', businessId: 'biz_gymA', status: 'active', role: 'trainer', permissions: ['bookings', 'customers'] },
  'workspaceMemberships/wm3': { uid: 'desk_1', businessId: 'biz_gymA', status: 'active', role: 'receptionist', permissions: ['bookings', 'customers', 'attendance'] },
  'workspaceMemberships/wm4': { uid: 'desk_B', businessId: 'biz_gymB', status: 'active', role: 'receptionist', permissions: ['attendance'] },
  'workspaceMemberships/wm5': { uid: 'former_1', businessId: 'biz_gymA', status: 'revoked', role: 'receptionist', permissions: ['attendance'] },
  'users/member_1': { displayName: 'Alex <b>M</b>', phone: '+254700000001', email: 'alex@example.com' },
}, extra || {});
/* the canonical link (server-written by approval provisioning — the docs' hand-off) */
const LINKED = { 'providers/gym_A': { uid: 'gym_A', status: 'active', linkedBusinessId: 'biz_gymA' }, 'providers/gym_B': { uid: 'gym_B', status: 'active', linkedBusinessId: 'biz_gymB' } };
const seedLinked = (over, extra) => seedBase(over, Object.assign({}, LINKED, extra || {}));
const AUTH = (uid, token) => ({ uid, token: Object.assign({ uid }, token || {}) });
const req = (uid, data, token) => ({ auth: uid ? AUTH(uid, token) : null, data });

function harness (FA, seed, opts) {
  const o = opts || {};
  const db = fakeDb(seed);
  let tsN = 0; let now = o.now || NOW;
  const releases = [];
  const notices = [];
  CURRENT_DB = db;
  FA._test.use({
    db, ts: () => 'TS#' + (++tsN), now: () => now, correlationId: () => 'cid-' + (tsN + 1),
    release: o.release || (async (id) => { releases.push(id); }), staffAuthority: o.staffAuthority || null,
    wfi: null, moduleGate: o.moduleGate || null, notify: o.notify || (async (a) => { notices.push(a); }),
  });
  return { db, releases, notices, setNow: (d) => { now = d; }, get: (p) => db._docs.get(p) };
}
async function attempt (fn) { try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, e, reason: e && e.details && e.details.reason, code: e && e.code, msg: e && e.message }; } }
const H = (FA) => FA._h;
async function qr (FA, uid, id) { return (await H(FA).membershipQrHandler(req(uid, { membershipId: id || MID }))).token; }
const scan = (FA, uid, token, extra) => attempt(() => H(FA).checkInHandler(req(uid, Object.assign({ token }, extra || {}))));

/* ── the matrix — returns { name: { ok, detail } } ── */
async function matrix (FA) {
  const rows = {};
  const ck = (name, ok, detail) => { rows[name] = { ok: !!ok, detail }; };
  const P = `providerMemberships/${MID}`;

  /* A1 mint */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    const other = await attempt(() => H(FA).membershipQrHandler(req('member_2', { membershipId: MID })));
    const anon = await attempt(() => H(FA).membershipQrHandler(req(null, { membershipId: MID })));
    ck('A1 buyer-only QR: owner of membership gets a signed 5-min token with ids/times only; another buyer gets not_found; anonymous refused',
      Object.keys(payload).sort().join() === 'b,exp,iat,m,p' && payload.exp - payload.iat === 300000 && other.reason === 'not_found' && anon.code === 'unauthenticated' && h.db._docs.size === Object.keys(seedBase()).length,
      { payload, other: other.reason, anon: anon.code }); }

  /* A2 forged (another key) */
  { const h = harness(FA, seedBase());
    const b64 = Buffer.from(JSON.stringify({ m: MID, b: 'member_1', p: 'gym_A', iat: NOW.getTime(), exp: NOW.getTime() + 300000 })).toString('base64url');
    const forged = `fm1.${b64}.${crypto.createHmac('sha256', 'attacker-key').update('fitmem1|' + b64).digest('hex')}`;
    const r = await scan(FA, 'gym_A', forged);
    const junk = await scan(FA, 'gym_A', 'not-a-token');
    ck('A2 forged token (signed with another key) refused token_invalid; junk refused; nothing written',
      r.reason === 'token_invalid' && junk.reason === 'token_invalid' && h.get(P).attendedSessions === 0, { r: r.reason, junk: junk.reason }); }

  /* A3 modified */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const [v, b64, sig] = tok.split('.');
    const c = JSON.parse(Buffer.from(b64, 'base64url').toString());
    const swap = (o) => `${v}.${Buffer.from(JSON.stringify(Object.assign({}, c, o))).toString('base64url')}.${sig}`;
    const r1 = await scan(FA, 'gym_A', swap({ m: MID2, b: 'member_2' }));
    const r2 = await scan(FA, 'gym_A', swap({ exp: c.exp + 86400000 }));
    const r3 = await scan(FA, 'gym_B', swap({ p: 'gym_B' }));
    ck('A3 modified token (membership swapped / expiry extended / gym swapped, signature kept) refused token_invalid',
      [r1, r2, r3].every((x) => x.reason === 'token_invalid') && h.get(P).attendedSessions === 0 && h.get(`providerMemberships/${MID2}`).attendedSessions === 0, [r1.reason, r2.reason, r3.reason]); }

  /* A4 expired */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    h.setNow(new Date(NOW.getTime() + 300001));
    const r = await scan(FA, 'gym_A', tok);
    ck('A4 expired token (5 min + 1 ms) refused token_expired', r.reason === 'token_expired' && h.get(P).attendedSessions === 0, r.reason); }

  /* A5 other gym */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const r = await scan(FA, 'gym_B', tok);
    const leak = JSON.stringify(r.e && r.e.details || {});
    ck("A5 other gym's scanner refused other_gym — no membership data in the error, nothing written",
      r.reason === 'other_gym' && !/member_1|Gold|600000|active|paid/.test(leak + (r.msg || '')) && h.get(P).attendedSessions === 0 && !h.db._docs.has(P + '/attendance/d_2026-03-20'), { reason: r.reason, leak }); }

  /* A6 other membership / wrong member */
  { const h = harness(FA, seedBase());
    const notMine = await attempt(() => H(FA).membershipQrHandler(req('member_1', { membershipId: MID2 })));
    const tok = await qr(FA, 'member_1');
    h.db._docs.set(P, Object.assign(h.get(P), { buyerUid: 'member_9' }));    /* record re-assigned after the token was minted */
    const r = await scan(FA, 'gym_A', tok);
    ck('A6 other membership: a buyer cannot mint for a membership that is not theirs (not_found); a token whose member no longer matches the record → wrong_member',
      notMine.reason === 'not_found' && r.reason === 'wrong_member' && h.get(P).attendedSessions === 0, { notMine: notMine.reason, r: r.reason }); }

  /* A7 unpermitted staff */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const c = await scan(FA, 'cashier_1', tok);
    const t = await scan(FA, 'trainer_1', tok);
    const hl = harness(FA, seedLinked());
    const tok2 = await qr(FA, 'member_1');
    const c2 = await scan(FA, 'cashier_1', tok2);
    const t2 = await scan(FA, 'trainer_1', tok2);
    ck('A7 unpermitted staff: cashier and trainer (active members, no attendance permission) refused no_permission — with or without a business link (link state is never told to them)',
      c.reason === 'no_permission' && t.reason === 'no_permission' && c2.reason === 'no_permission' && t2.reason === 'no_permission'
      && h.get(P).attendedSessions === 0 && hl.get(P).attendedSessions === 0, [c.reason, t.reason, c2.reason, t2.reason]); }
  { const h = harness(FA, seedBase(), { staffAuthority: async () => ({ allowed: false }) });
    const tok = await qr(FA, 'member_1');
    const c = await scan(FA, 'cashier_1', tok);
    ck('A7b the staff seam is consulted and its denial holds', c.reason === 'no_permission' && h.get(P).attendedSessions === 0, c.reason); }

  /* A8 self-scan */
  { const h = harness(FA, seedBase({}, { [`providerMemberships/${MID2}`]: mem({ buyerUid: 'gym_A' }) }));
    const tok = await qr(FA, 'member_1');
    const r = await scan(FA, 'member_1', tok);
    const own = await qr(FA, 'gym_A', MID2);
    const r2 = await scan(FA, 'gym_A', own);
    ck('A8 buyer self-scan refused (no_permission); a gym owner holding its own membership cannot check itself in (self_scan)',
      r.reason === 'no_permission' && r2.reason === 'self_scan' && h.get(P).attendedSessions === 0 && h.get(`providerMemberships/${MID2}`).attendedSessions === 0, [r.reason, r2.reason]); }

  /* A9 first scan + A10 duplicate + A11 second scan + A19 release */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const r = await scan(FA, 'gym_A', tok);
    const m = h.get(P); const row = h.get(P + '/attendance/d_2026-03-20');
    ck('A9 first scan sets all three atomically: attendedSessions 1, firstAttendedAt, refundEligible false',
      r.ok && r.r.firstCheckIn === true && m.attendedSessions === 1 && !!m.firstAttendedAt && m.refundEligible === false, { r: r.r || r.reason, m });
    ck('A9b ledger row: memberUid, providerId, method qr, actorUid/actorRole owner, status checked_in, completedAt null, correlationId, server checkedInAt',
      row && row.memberUid === 'member_1' && row.providerId === 'gym_A' && row.method === 'qr' && row.actorUid === 'gym_A' && row.actorRole === 'owner'
      && row.status === 'checked_in' && row.completedAt === null && !!row.correlationId && /^TS#/.test(row.checkedInAt) && row.sessionRef === null, row);
    const snapRow = JSON.stringify(row); const snapM = JSON.stringify(h.get(P));
    const d = await scan(FA, 'gym_A', tok);
    ck('A10 duplicate scan is idempotent: returns the existing result, attendedSessions unchanged, ledger and membership byte-identical',
      d.ok && d.r.duplicate === true && d.r.attendanceId === 'd_2026-03-20' && JSON.stringify(h.get(P + '/attendance/d_2026-03-20')) === snapRow && JSON.stringify(h.get(P)) === snapM, d.r || d.reason);
    const first = h.get(P).firstAttendedAt;
    const s2 = await scan(FA, 'gym_A', tok, { sessionRef: 'evening_hiit' });
    h.setNow(new Date(NOW.getTime() + 86400000));
    const s3 = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    const m2 = h.get(P);
    ck('A11 later scans (named session, next day) increment only: attendedSessions 3, firstAttendedAt unchanged, refundEligible false',
      s2.ok && s3.ok && s2.r.firstCheckIn === false && m2.attendedSessions === 3 && m2.firstAttendedAt === first && m2.refundEligible === false && h.db._docs.has(P + '/attendance/s_evening_hiit') && h.db._docs.has(P + '/attendance/d_2026-03-21'), m2);
    ck('A19 releaseDueSlices called exactly once — after the first check-in only (never on duplicate / later scans)',
      h.releases.length === 1 && h.releases[0] === MID, h.releases); }

  /* A12 refused statuses (closes check-in vs refund-request race on the record side) */
  { const want = { pending_payment: 'not_covered', refund_requested: 'not_covered', refunded: 'not_covered', expired: 'expired', cancelled: 'cancelled', suspended: 'suspended', disputed: 'not_covered', payment_review: 'not_covered' };
    const got = {};
    for (const [st, reason] of Object.entries(want)) {
      const h = harness(FA, seedBase());
      const tok = await qr(FA, 'member_1');                       /* minted while active */
      h.db._docs.set(P, Object.assign(h.get(P), { status: st }));
      const r = await scan(FA, 'gym_A', tok);
      got[st] = r.reason === reason && h.get(P).attendedSessions === 0 && !h.get(P).firstAttendedAt && h.get(P).refundEligible === undefined && !h.db._docs.has(P + '/attendance/d_2026-03-20') ? 'ok' : r.reason;
    }
    ck('A12 status !== active refused with nothing written: pending_payment, refund_requested, refunded, expired, cancelled, suspended, disputed, payment_review',
      Object.values(got).every((x) => x === 'ok'), got);
    const h = harness(FA, seedBase({ status: 'refund_requested' }));
    const q = await attempt(() => H(FA).membershipQrHandler(req('member_1', { membershipId: MID })));
    ck('A12b no QR is issued for a non-active membership', q.reason === 'not_covered' && h.get(P).attendedSessions === 0, q.reason); }

  /* A13 unpaid (defence in depth) */
  { const got = [];
    for (const ps of ['pending', 'refund_requested', undefined, 'unpaid']) {
      const h = harness(FA, seedBase());
      const tok = await qr(FA, 'member_1');
      h.db._docs.set(P, Object.assign(h.get(P), { paymentStatus: ps }));
      const r = await scan(FA, 'gym_A', tok);
      got.push(r.reason === 'not_covered' && h.get(P).attendedSessions === 0);
    }
    ck('A13 status active but payment not held/released (pending, refund_requested, missing, unpaid) → refused', got.every(Boolean), got); }

  /* A14 period window */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    h.db._docs.set(P, Object.assign(h.get(P), { startAt: '2026-04-01T00:00:00.000Z' }));
    const early = await scan(FA, 'gym_A', tok);
    const h2 = harness(FA, seedBase());
    h2.setNow(new Date('2026-04-15T08:58:00.000Z'));                 /* minted 2 minutes before the end … */
    const tok2 = await qr(FA, 'member_1');
    h2.setNow(new Date('2026-04-15T09:00:00.000Z'));                 /* … scanned exactly at the end of month 3 */
    const late = await scan(FA, 'gym_A', tok2);
    ck('A14 period window: before startAt → not_covered; at/after the end (membership-settlement.endsAt) → expired',
      early.reason === 'not_covered' && late.reason === 'expired' && h.get(P).attendedSessions === 0 && h2.get(P).attendedSessions === 0, [early.reason, late.reason]); }

  /* A15 entitlement */
  { const h = harness(FA, seedBase({ sessionsIncluded: 2 }));
    const tok = await qr(FA, 'member_1');
    const a = await scan(FA, 'gym_A', tok, { sessionRef: 's1' });
    const b = await scan(FA, 'gym_A', tok, { sessionRef: 's2' });
    const c = await scan(FA, 'gym_A', tok, { sessionRef: 's3' });
    const neg = await scan(FA, 'gym_A', tok, { sessionRef: '../x' });
    ck('A15 entitlement: a 2-session membership admits 2 then refuses entitlement_exhausted; malformed sessionRef refused; count never exceeds the cap',
      a.ok && b.ok && c.reason === 'entitlement_exhausted' && neg.code === 'invalid-argument' && h.get(P).attendedSessions === 2, [a.ok, b.ok, c.reason, neg.code]); }

  /* A16 client-supplied fields ignored */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    const evil = { attendedSessions: 99, sessionsUsed: 0, sessionsRemaining: 99, refundEligible: true, membershipUsed: false, checkedInAt: '2020-01-01', firstAttendedAt: null, providerId: 'gym_B', buyerUid: 'x', actorRole: 'owner', status: 'completed' };
    const r1 = await scan(FA, 'gym_A', tok, evil);
    const r2 = await scan(FA, 'gym_A', tok, Object.assign({ sessionRef: 'evil2' }, evil));
    const m = h.get(P); const row = h.get(P + '/attendance/d_2026-03-20');
    ck('A16 client-supplied attendedSessions / refundEligible / timestamps / ownership / status ignored (first AND second scan)',
      r1.ok && r2.ok && m.attendedSessions === 2 && m.refundEligible === false && !!m.firstAttendedAt && m.firstAttendedAt !== null && row.providerId === 'gym_A' && row.memberUid === 'member_1' && row.status === 'checked_in' && /^TS#/.test(row.checkedInAt), { m, row }); }

  /* A17 correction */
  { const h = harness(FA, seedBase({ sessionsIncluded: 1 }));
    const tok = await qr(FA, 'member_1');
    await scan(FA, 'gym_A', tok);
    const before = h.get(P);
    const owner = await attempt(() => H(FA).correctAttendanceHandler(req('gym_A', { membershipId: MID, attendanceId: 'd_2026-03-20', reason: 'scanned by mistake' })));
    const noReason = await attempt(() => H(FA).correctAttendanceHandler(req('admin_1', { membershipId: MID, attendanceId: 'd_2026-03-20', reason: '' }, { admin: true })));
    const c1 = await attempt(() => H(FA).correctAttendanceHandler(req('admin_1', { membershipId: MID, attendanceId: 'd_2026-03-20', reason: 'scanned by mistake' }, { admin: true })));
    const c2 = await attempt(() => H(FA).correctAttendanceHandler(req('admin_1', { membershipId: MID, attendanceId: 'd_2026-03-20', reason: 'again' }, { admin: true })));
    const after = h.get(P); const row = h.get(P + '/attendance/d_2026-03-20'); const corr = h.get(P + '/attendanceCorrections/d_2026-03-20');
    ck('A17 correction is ADMIN-only (gym owner refused), needs a reason, appends a record, voids the row (never deletes), idempotent',
      owner.reason === 'no_permission' && noReason.code === 'invalid-argument' && c1.ok && c2.ok && c2.r.duplicate === true && row && row.status === 'voided_by_admin' && corr && corr.previousStatus === 'checked_in' && corr.reason === 'scanned by mistake', { owner: owner.reason, row, corr });
    ck('A17b correction NEVER resets the refund lock: refundEligible false, firstAttendedAt and attendedSessions unchanged; MS.isUsed still true; refund still refused',
      after.refundEligible === false && after.firstAttendedAt === before.firstAttendedAt && after.attendedSessions === 1 && MS.isUsed(after) && MS.refundDecision(after, NOW).code === 'used', after);
    const again = await scan(FA, 'gym_A', tok, { sessionRef: 'make_up' });
    ck('A17c a voided session restores ENTITLEMENT only (voidedSessions 1): the 1-session member can be checked in again',
      again.ok && after.voidedSessions === 1 && h.get(P).attendedSessions === 2, again.r || again.reason); }

  /* A18 completion */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    await scan(FA, 'gym_A', tok);
    const mBefore = JSON.stringify(h.get(P));
    const row0 = h.get(P + '/attendance/d_2026-03-20');
    const other = await attempt(() => H(FA).completeSessionHandler(req('gym_B', { membershipId: MID, attendanceId: 'd_2026-03-20' })));
    const ok = await attempt(() => H(FA).completeSessionHandler(req('gym_A', { membershipId: MID, attendanceId: 'd_2026-03-20' })));
    const dup = await attempt(() => H(FA).completeSessionHandler(req('gym_A', { membershipId: MID, attendanceId: 'd_2026-03-20' })));
    const row = h.get(P + '/attendance/d_2026-03-20');
    await scan(FA, 'gym_A', tok, { sessionRef: 'v1' });
    await H(FA).correctAttendanceHandler(req('admin_1', { membershipId: MID, attendanceId: 's_v1', reason: 'mistake' }, { admin: true }));
    const voided = await attempt(() => H(FA).completeSessionHandler(req('gym_A', { membershipId: MID, attendanceId: 's_v1' })));
    ck('A18 completion is separate from check-in: checked_in/completedAt null until completed; completion touches only the ledger row; other gym refused; idempotent; a voided row cannot complete',
      row0.status === 'checked_in' && row0.completedAt === null && other.reason === 'other_gym' && ok.ok && row.status === 'completed' && /^TS#/.test(row.completedAt)
      && dup.ok && dup.r.duplicate === true && voided.reason === 'not_checked_in' && JSON.parse(mBefore).attendedSessions === 1, { other: other.reason, row, voided: voided.reason }); }

  /* A19b release failure */
  { const h = harness(FA, seedBase(), { release: async () => { throw new Error('settlement down'); } });
    const r = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    ck('A19b releaseDueSlices failure does NOT fail the check-in (attendance recorded; the 06:00 sweep is the fallback)',
      r.ok && r.r.firstCheckIn === true && h.get(P).attendedSessions === 1 && h.get(P).refundEligible === false, r.r || r.reason); }

  /* A19c real settlement integration: first check-in two months in releases the 2 passed months */
  { const emptyDb = { collection: () => ({ where () { return this; }, doc: () => ({ get: async () => ({ exists: false, data: () => null }) }), get: async () => ({ docs: [], empty: true }) }) };
    const deps = { calculateCommission: (_d, o) => FU.calculateCommission(emptyDb, o) };
    let h;
    h = harness(FA, seedBase(), { release: (id) => MS.releaseDueSlices(id, { now: NOW, deps }) });
    MS._test.use({ db: h.db, ts: () => 'MSTS', inc: h.db._inc, tsFromDate: (d) => d.toISOString() });
    const r = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    const m = h.get(P);
    ck('A19c with the REAL releaseDueSlices: first check-in releases both elapsed months (5% fitness lane), membership partially_released',
      r.ok && m.releasedPeriods === 2 && m.paymentStatus === 'partially_released' && h.db._docs.has('providerPayouts/mem_000001_m1') && (h.get('wallets/gym_A') || {}).balance === 3800, m); }

  /* A20 audit */
  { const h = harness(FA, seedBase());
    const tok = await qr(FA, 'member_1');
    await scan(FA, 'gym_B', tok);
    await scan(FA, 'gym_A', tok);
    await scan(FA, 'gym_A', tok);
    await H(FA).completeSessionHandler(req('gym_A', { membershipId: MID, attendanceId: 'd_2026-03-20' }));
    await H(FA).correctAttendanceHandler(req('admin_1', { membershipId: MID, attendanceId: 'd_2026-03-20', reason: 'test' }, { admin: true }));
    const audit = [...h.db._docs.entries()].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v);
    const acts = audit.map((a) => a.action + ':' + a.outcome);
    const noPii = audit.every((a) => !('memberUid' in a) && !('buyerUid' in a) && !('token' in a) && !/Gold|member_1/.test(JSON.stringify(a)));
    ck('A20 every refusal / check-in / duplicate / completion / correction lands in adminAudit with actor + correlationId; no member PII or token',
      ['fitness_checkin:refused', 'fitness_checkin:ok', 'fitness_checkin_duplicate:ok', 'fitness_session_completed:ok', 'fitness_attendance_corrected:ok'].every((x) => acts.includes(x))
      && audit.every((a) => a.performedBy && a.correlationId && a.hub === 'fitness') && noPii, { acts, sample: audit[0] }); }

  /* A21 race: check-in vs refund request on the same record — the competitor commits INSIDE the other's transaction */
  { const setup = () => { const h = harness(FA, seedBase()); MS._test.use({ db: h.db, ts: () => 'MSTS', inc: h.db._inc, tsFromDate: (d) => d.toISOString() }); return h; };
    /* (i) refund lands between the check-in transaction's reads and its commit → check-in re-runs and refuses */
    let h = setup(); let tok = await qr(FA, 'member_1'); let rf = null;
    h.db.beforeCommit = async () => { rf = await MS.requestRefund(MID, { by: 'member_1', now: NOW }); };
    const ci = await scan(FA, 'gym_A', tok);
    const m1 = h.get(P);
    const i = !ci.ok && ci.reason === 'not_covered' && rf && rf.ok && m1.status === 'refund_requested' && m1.attendedSessions === 0 && !m1.firstAttendedAt && !h.db._docs.has(P + '/attendance/d_2026-03-20');
    /* (ii) check-in lands between the refund transaction's reads and its commit → refund re-runs and refuses 'used' */
    h = setup(); tok = await qr(FA, 'member_1'); let ci2 = null;
    h.db.beforeCommit = async () => { ci2 = await scan(FA, 'gym_A', tok); };
    const rf2 = await MS.requestRefund(MID, { by: 'member_1', now: NOW });
    const m2 = h.get(P);
    const ii = ci2 && ci2.ok && rf2 && !rf2.ok && rf2.code === 'used' && m2.status === 'active' && m2.attendedSessions === 1 && m2.refundEligible === false && !(m2.refund && m2.refund.state);
    ck("A21 check-in vs refund request interleaved inside the other's transaction: exactly one wins in both orders (never attended AND refunded)",
      i && ii, { i: { ci: ci.reason, rf, m1 }, ii: { ci2: ci2 && (ci2.r || ci2.reason), rf2, m2 } }); }

  /* ── FINAL RELEASE: staff authorization matrix ── */
  { const h = harness(FA, seedLinked());
    const r = await scan(FA, 'desk_1', await qr(FA, 'member_1'));
    const row = h.get(P + '/attendance/d_2026-03-20');
    ck('S1 staff of the SAME business with explicit attendance permission (via workforce-identity) records attendance; ledger actor = staff',
      r.ok && r.r.firstCheckIn === true && row && row.actorUid === 'desk_1' && row.actorRole === 'staff' && h.get(P).attendedSessions === 1, r.r || r.reason); }
  { const h = harness(FA, seedLinked());
    const r = await scan(FA, 'cashier_1', await qr(FA, 'member_1'));
    const noMember = await scan(FA, 'stranger_1', await qr(FA, 'member_1'));
    ck('S2 staff WITHOUT the attendance permission refused (cashier role defaults never include it); a non-member refused; nothing written',
      r.reason === 'no_permission' && noMember.reason === 'no_permission' && h.get(P).attendedSessions === 0, [r.reason, noMember.reason]); }
  { const h = harness(FA, seedLinked());
    const r = await scan(FA, 'desk_B', await qr(FA, 'member_1'));
    ck('S3 staff of business B (attendance at gym B) scanning a gym A member → refused; nothing written',
      !r.ok && r.reason === 'no_permission' && h.get(P).attendedSessions === 0 && !h.db._docs.has(P + '/attendance/d_2026-03-20'), r.reason || r.r); }
  { const cases = {
      no_link: seedBase(),
      mislinked_other_owner: seedBase({}, { 'providers/gym_A': { uid: 'gym_A', status: 'active', linkedBusinessId: 'biz_gymB' } }),
      link_to_missing: seedBase({}, { 'providers/gym_A': { uid: 'gym_A', status: 'active', linkedBusinessId: 'biz_nowhere' } }),
      business_inactive: seedLinked({}, { 'businesses/biz_gymA': { ownerId: 'gym_A', merchantId: 'biz_gymA', status: 'suspended' } }),
      malformed: seedLinked({}, { 'businesses/biz_gymA': { ownerId: 'gym_A', merchantId: 'SOK-OTHER1' } }),
    };
    const got = {};
    for (const [k, seed] of Object.entries(cases)) {
      const h = harness(FA, seed);
      const r = await scan(FA, 'desk_1', await qr(FA, 'member_1'));
      got[k] = r.reason === 'business_link_missing' && h.get(P).attendedSessions === 0 ? 'ok' : (r.reason || 'ALLOWED');
    }
    const h = harness(FA, seedBase({}, { 'businesses/biz_gymA0': { ownerId: 'gym_A' } }));   /* an owned business exists, but NO link */
    const inferred = await scan(FA, 'desk_1', await qr(FA, 'member_1'));
    const res = await FA.resolveGymBusiness('gym_A');
    ck('S4 no canonical link → BUSINESS_LINK_MISSING (never inferred from businesses.where(ownerId)); mislinked / missing / inactive / malformed business refused the same way',
      Object.values(got).every((x) => x === 'ok') && inferred.reason === 'business_link_missing' && res.ok === false && res.reason === 'BUSINESS_LINK_MISSING' && h.get(P).attendedSessions === 0,
      { got, inferred: inferred.reason, res }); }
  { const h = harness(FA, seedLinked());
    const r = await scan(FA, 'former_1', await qr(FA, 'member_1'));
    ck('S5 a staff member whose workspace membership is no longer active (revoked) is refused, even with attendance in its permissions',
      r.reason === 'no_permission' && h.get(P).attendedSessions === 0, r.reason); }
  { const h = harness(FA, seedLinked({}, { 'providers/gym_A': { uid: 'gym_A', status: 'suspended', linkedBusinessId: 'biz_gymA' } }));
    const tok = await qr(FA, 'member_1');
    const o = await scan(FA, 'gym_A', tok);
    const st = await scan(FA, 'desk_1', tok);
    const real = await FA.moduleGate('gym_A');
    const h2 = harness(FA, seedLinked(), { moduleGate: async () => ({ ok: false, reason: 'MODULE_NOT_AVAILABLE' }) });
    const g = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    ck('S6 gym gate: a suspended gym cannot record attendance (owner or staff → not_approved); a closed memberships module → module_unavailable; on this tree the real module gate is PENDING (no memberships key yet)',
      o.reason === 'not_approved' && st.reason === 'not_approved' && g.reason === 'module_unavailable' && real.ok === true && real.state === 'pending'
      && h.get(P).attendedSessions === 0 && h2.get(P).attendedSessions === 0, { o: o.reason, st: st.reason, g: g.reason, real }); }
  { const ATT = WFI._assertBusinessPermission && require(path.join(FN, 'workforce-identity.js'));
    const src = fs.readFileSync(path.join(FN, 'workforce-identity.js'), 'utf8');
    const list = /const ALL_PERMISSIONS = \[([\s\S]*?)\];/.exec(src);
    const roles = /const ROLE_PERMISSIONS = \{([\s\S]*?)\n\};/.exec(src);
    ck('S7 workforce-identity: attendance is a canonical permission key and in NO role default (owner = ALL by definition)',
      !!ATT && list && /'attendance'/.test(list[1]) && roles && !/attendance/.test(roles[1]), { inList: !!(list && /'attendance'/.test(list[1])) }); }

  /* ── notifications ── */
  { const h = harness(FA, seedLinked({ sessionsIncluded: 12 }));
    const tok = await qr(FA, 'member_1');
    const r1 = await scan(FA, 'gym_A', tok);
    const dup = await scan(FA, 'gym_A', tok);
    const r2 = await scan(FA, 'gym_A', tok, { sessionRef: 'evening' });
    const n = h.notices;
    ck('N1 member notified via notify.js on EACH recorded check-in (first one says it is no longer refundable), never on a duplicate scan; one dedupeKey per ledger row; no other recipient',
      r1.ok && dup.ok && r2.ok && n.length === 2 && n.every((x) => x.uid === 'member_1' && x.type === 'booking_confirmed')
      && /no longer be refunded/.test(n[0].body) && !/refunded/.test(n[1].body) && /Session 1 of 12/.test(n[0].body) && /Session 2 of 12/.test(n[1].body)
      && n[0].dedupeKey === 'membership_checkin_mem_000001_d_2026-03-20' && n[1].dedupeKey === 'membership_checkin_mem_000001_s_evening', n); }
  { const h = harness(FA, seedLinked(), { notify: async () => { throw new Error('notify down'); } });
    const r = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    ck('N2 a notification failure never fails the check-in (attendance already committed)', r.ok && h.get(P).attendedSessions === 1 && h.get(P).refundEligible === false, r.r || r.reason); }
  { const h = harness(FA, seedLinked());
    const r = await scan(FA, 'gym_A', await qr(FA, 'member_1'));
    ck('N3 check-in response carries the server facts for the result card: member displayName (sanitised), title, checkedInAt, Unlimited (sessionsIncluded null) — no member uid/phone/email',
      r.ok && r.r.member && r.r.member.displayName === 'Alex bM/b' && r.r.title === 'Gold 3-month' && r.r.checkedInAt === NOW.toISOString() && r.r.sessionsIncluded === null
      && !/member_1|254700|example\.com/.test(JSON.stringify(r.r)), r.r || r.reason); }

  /* A22 — response contract: success AND duplicate carry the same key set, all server-derived */
  { const h = harness(FA, seedBase({ sessionsIncluded: 12 }));
    const tok = await qr(FA, 'member_1');
    const a = await scan(FA, 'gym_A', tok);
    const b = await scan(FA, 'gym_A', tok);
    const KEYS = 'attendanceId,attendedSessions,checkedInAt,correlationId,duplicate,firstCheckIn,member,membershipId,ok,sessionsIncluded,status,title';
    const shape = (x) => x && x.membershipId === MID && typeof x.attendanceId === 'string' && x.member && typeof x.member.displayName === 'string'
      && typeof x.title === 'string' && typeof x.checkedInAt === 'string' && !isNaN(Date.parse(x.checkedInAt)) && new Date(x.checkedInAt).toISOString() === x.checkedInAt
      && Number.isInteger(x.attendedSessions) && (x.sessionsIncluded === null || Number.isInteger(x.sessionsIncluded))
      && typeof x.duplicate === 'boolean' && typeof x.firstCheckIn === 'boolean' && Object.keys(x).sort().join() === KEYS;
    ck('A22 check-in response contract: success AND duplicate both carry membershipId, attendanceId, member.displayName, title, checkedInAt (ISO), attendedSessions (after), sessionsIncluded|null, duplicate, firstCheckIn — exact key set',
      a.ok && b.ok && shape(a.r) && shape(b.r) && a.r.duplicate === false && a.r.firstCheckIn === true && a.r.attendedSessions === 1 && a.r.sessionsIncluded === 12
      && b.r.duplicate === true && b.r.firstCheckIn === false && b.r.attendedSessions === 1 && b.r.attendanceId === a.r.attendanceId,
      { a: a.r || a.reason, b: b.r || b.reason }); }

  /* ── gym reads (fitnessGymMemberships / fitnessGymMembership / fitnessScannerStatus) ── */
  const FG = loadFG(FA, FG_SRC_UNDER_TEST, FA.__tag);
  const L = (uid, data) => attempt(() => FG._h.gymMembershipsHandler(req(uid, data || {})));
  const D = (uid, data) => attempt(() => FG._h.gymMembershipHandler(req(uid, data || {})));
  const SS = (uid) => attempt(() => FG._h.scannerStatusHandler(req(uid, {})));
  const gymSeed = (extra) => seedLinked({ createdAt: 'C002' }, Object.assign({
    [`providerMemberships/${MID2}`]: mem({ buyerUid: 'member_2', createdAt: 'C001' }),
    'providerMemberships/mem_B00001': mem({ providerId: 'gym_B', buyerUid: 'member_3', createdAt: 'C003' }),
  }, extra || {}));
  { const h = harness(FA, gymSeed());
    const own = await L('gym_A');
    const spoof = await L('gym_A', { providerId: 'gym_B', businessId: 'biz_gymB' });
    const b = await L('gym_B');
    ck('G1 owner sees ONLY its own gym (newest first); a client-supplied providerId / businessId is ignored; the other gym sees only its own',
      own.ok && own.r.rows.map((x) => x.membershipId).join() === 'mem_000001,mem_000002' && spoof.ok && spoof.r.rows.map((x) => x.membershipId).join() === 'mem_000001,mem_000002'
      && b.ok && b.r.rows.map((x) => x.membershipId).join() === 'mem_B00001' && own.r.nextCursor === null,
      { own: own.r || own.reason, spoof: spoof.r ? spoof.r.rows.map((x) => x.membershipId) : spoof.msg, b: b.r ? b.r.rows.map((x) => x.membershipId) : b.msg }); }
  { const h = harness(FA, gymSeed());
    const other = await D('gym_B', { membershipId: MID });
    const missing = await D('gym_A', { membershipId: 'mem_nothere' });
    const stranger = await L('stranger_1');
    const anon = await L(null);
    ck('G2 another gym reading gym A\'s membership → not_found (indistinguishable from missing); a non-gym caller → permission-denied; anonymous → unauthenticated',
      other.code === 'not-found' && missing.code === 'not-found' && stranger.code === 'permission-denied' && anon.code === 'unauthenticated', [other.code, missing.code, stranger.code, anon.code]); }
  { const extra = {};
    for (let i = 0; i < 60; i++) extra['providerMemberships/mem_p' + String(i).padStart(4, '0')] = mem({ buyerUid: 'member_x', createdAt: 'D' + String(i).padStart(3, '0') });
    const h = harness(FA, gymSeed(extra));
    h.db.queries = [];
    const big = await L('gym_A', { limit: 500 });
    const p1 = await L('gym_A', { limit: 2 });
    const p2 = await L('gym_A', { limit: 2, cursor: p1.r && p1.r.nextCursor });
    const badCursor = await L('gym_A', { cursor: 'mem_B00001' });
    const zero = await L('gym_A', { limit: 0 });
    const tab = await L('gym_A', { status: 'nope' });
    const q = h.db.queries.find((x) => x.c === 'providerMemberships' && x.q.lim != null);
    ck('G3 pagination bounded: limit capped at 50 (query asks ≤51); limit 2 pages newest-first with a cursor and no overlap; another gym\'s doc as cursor / limit 0 / unknown tab → invalid-argument',
      big.ok && big.r.rows.length === 50 && !!big.r.nextCursor && q && q.q.lim === 51
      && p1.ok && p1.r.rows.map((x) => x.membershipId).join() === 'mem_p0059,mem_p0058' && p2.ok && p2.r.rows.map((x) => x.membershipId).join() === 'mem_p0057,mem_p0056'
      && badCursor.code === 'invalid-argument' && zero.code === 'invalid-argument' && tab.code === 'invalid-argument',
      { big: big.r && big.r.rows.length, lim: q && q.q.lim, p1: p1.r && p1.r.rows.map((x) => x.membershipId), p2: p2.r && p2.r.rows.map((x) => x.membershipId), badCursor: badCursor.code, zero: zero.code }); }
  { const h = harness(FA, gymSeed({
      'providerMemberships/mem_cap001': mem({ buyerUid: 'member_1', sessionsIncluded: 12, attendedSessions: 3, voidedSessions: 1, createdAt: 'C010' }),
      'providerMemberships/mem_unk001': mem({ buyerUid: 'member_1', attendedSessions: undefined, firstAttendedAt: '2026-02-01T00:00:00.000Z', createdAt: 'C011' }),
      'providerMemberships/mem_pen001': mem({ buyerUid: 'member_1', status: 'pending_payment', paymentStatus: 'pending', attendedSessions: undefined, createdAt: 'C012' }),
    }));
    const r = await L('gym_A', { limit: 50 });
    const by = Object.fromEntries((r.r ? r.r.rows : []).map((x) => [x.membershipId, x]));
    const cap = by.mem_cap001 || {}; const unl = by[MID] || {}; const unk = by.mem_unk001 || {}; const pen = by.mem_pen001 || {};
    ck('G4 remaining = sessionsIncluded − (attended − voided) when capped (12−(3−1)=10); uncapped → null ("Unlimited"); unknown attendance → null, never 0; pending → no start/end, refund not decided',
      r.ok && cap.remaining === 10 && cap.sessionsIncluded === 12 && cap.attendedSessions === 3 && unl.remaining === null && unl.sessionsIncluded === null && unl.attendedSessions === 0
      && unk.attendedSessions === null && unk.remaining === null && unk.refundEligible === null && pen.startAt === null && pen.endsAt === null && pen.attendedSessions === 0 && pen.refundEligible === null && unl.refundEligible === true
      && typeof unl.endsAt === 'string' && unl.startAt === START, { cap, unl, unk, pen }); }
  { const h = harness(FA, gymSeed());
    const r = await L('gym_A');
    const j = JSON.stringify(r.r || {});
    const row = r.r && r.r.rows[0];
    ck('G5 member data minimised: displayName only (sanitised) — no member uid, phone or email anywhere in the response',
      r.ok && row.member.displayName === 'Alex bM/b' && Object.keys(row.member).join() === 'displayName' && !/member_1|member_2|254700|example\.com|buyerUid/.test(j), row); }
  { const hs = harness(FA, gymSeed());
    const desk = await L('desk_1');
    const cashier = await L('cashier_1');
    const hu = harness(FA, seedBase());
    const unlinked = await L('desk_1');
    const hm = harness(FA, gymSeed({ 'workspaceMemberships/wm6': { uid: 'desk_1', businessId: 'biz_gymB', status: 'active', permissions: ['attendance'] } }));
    const multi = await L('desk_1');
    ck('G6 staff reads: attendance staff sees ITS gym; cashier → NO_PERMISSION; unlinked gym → BUSINESS_LINK_MISSING; staff at two gyms → MULTIPLE_GYMS (no client selector)',
      desk.ok && desk.r.rows.map((x) => x.membershipId).join() === 'mem_000001,mem_000002' && cashier.reason === 'NO_PERMISSION' && unlinked.reason === 'BUSINESS_LINK_MISSING' && multi.reason === 'MULTIPLE_GYMS',
      { desk: desk.r ? desk.r.rows.length : desk.reason, cashier: cashier.reason, unlinked: unlinked.reason, multi: multi.reason }); }
  { const extra = {};
    for (let i = 0; i < 105; i++) extra[`providerMemberships/${MID}/attendance/s_x${String(i).padStart(3, '0')}`] = { status: 'checked_in', checkedInAt: '2026-03-' + String(1 + (i % 19)).padStart(2, '0') + 'T0' + (i % 10) + ':00:00.000Z', method: 'qr', actorRole: 'owner', actorUid: 'gym_A', memberUid: 'member_1' };
    extra['providerPayouts/mem_000001_m1'] = { providerId: 'gym_A', membershipId: MID, sourceType: 'membership', periodIndex: 1, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-03-20T07:30:00.000Z' };
    extra['providerPayouts/mem_000001_m2'] = { providerId: 'gym_A', membershipId: MID, sourceType: 'membership', periodIndex: 2, gross: 200000, commission: 10000, net: 190000, status: 'settled', settledAt: '2026-03-20T07:30:00.000Z' };
    extra['providerPayouts/forged_other'] = { providerId: 'gym_B', membershipId: MID, sourceType: 'membership', periodIndex: 3, gross: 1, commission: 0, net: 1, status: 'settled' };
    extra['providerPayouts/booking_x'] = { providerId: 'gym_A', membershipId: MID, sourceType: 'booking', net: 5 };
    const h = harness(FA, gymSeed(extra));
    const d = await D('gym_A', { membershipId: MID });
    const att = d.r ? d.r.attendance : [];
    const sorted = att.every((a, i) => i === 0 || att[i - 1].checkedInAt >= a.checkedInAt);
    ck('G7 detail: attendance ledger ≤100 newest-first (no actor/member uids), settlement = providerPayouts sourceType membership for THIS membership AND this gym only',
      d.ok && att.length === 100 && sorted && d.r.attendanceTruncated === true && !/actorUid|memberUid|gym_A|member_1/.test(JSON.stringify(att))
      && d.r.settlement.releases.map((x) => x.periodIndex).join() === '1,2' && d.r.settlement.netSettledCents === 380000 && d.r.membership.membershipId === MID,
      { n: att.length, sorted, settlement: d.r && d.r.settlement }); }
  { const results = {};
    harness(FA, seedLinked()); results.owner = await SS('gym_A'); results.staff = await SS('desk_1'); results.cashier = await SS('cashier_1'); results.nobody = await SS('stranger_1'); results.anon = await SS(null);
    harness(FA, seedBase()); results.unlinked = await SS('desk_1');
    harness(FA, seedLinked({}, { 'providers/gym_A': { uid: 'gym_A', status: 'pending', linkedBusinessId: 'biz_gymA' } })); results.pending = await SS('gym_A');
    harness(FA, seedLinked(), { moduleGate: async () => ({ ok: false, reason: 'MODULE_NOT_AVAILABLE' }) }); results.module = await SS('gym_A');
    const v = (k) => (results[k].ok ? results[k].r : { code: results[k].code });
    ck('SS1 scanner status from server facts: owner → canScan owner; attendance staff → canScan staff; NOT_APPROVED / BUSINESS_LINK_MISSING / NO_PERMISSION / MODULE_NOT_AVAILABLE with the real reason; anonymous refused',
      v('owner').canScan === true && v('owner').role === 'owner' && v('staff').canScan === true && v('staff').role === 'staff'
      && v('cashier').canScan === false && v('cashier').reason === 'NO_PERMISSION' && v('nobody').reason === 'NO_PERMISSION' && v('nobody').role === null
      && v('unlinked').reason === 'BUSINESS_LINK_MISSING' && v('pending').reason === 'NOT_APPROVED' && v('pending').role === 'owner' && v('module').reason === 'MODULE_NOT_AVAILABLE'
      && v('anon').code === 'unauthenticated', Object.fromEntries(Object.keys(results).map((k) => [k, v(k)]))); }

  return rows;
}

/* ── mutants (negative controls) ── */
let FG_SRC_UNDER_TEST = null;
const MUTANTS = [
  { tag: 'a', row: "A5 other gym's scanner refused other_gym — no membership data in the error, nothing written", what: 'gym-ownership check skipped',
    from: 'if (uid === m.providerId) {', to: 'if (true) {' },
  { tag: 'b', row: 'A9 first scan sets all three atomically: attendedSessions 1, firstAttendedAt, refundEligible false', what: 'refundEligible only on the 2nd scan',
    from: "if (first) { patch.firstAttendedAt = _ts(); patch.refundEligible = false; }\n      else if (m.refundEligible !== false) patch.refundEligible = false;",
    to: 'if (first) { patch.firstAttendedAt = _ts(); }\n      else { patch.refundEligible = false; }' },
  { tag: 'c', row: 'A16 client-supplied attendedSessions / refundEligible / timestamps / ownership / status ignored (first AND second scan)', what: 'client refundEligible accepted',
    from: 'const patch = { attendedSessions: prior + 1,', to: "const patch = { ...(d.refundEligible !== undefined ? { refundEligible: d.refundEligible } : {}), attendedSessions: prior + 1," },
  { tag: 'd', row: "A21 check-in vs refund request interleaved inside the other's transaction: exactly one wins in both orders (never attended AND refunded)", what: 'state decided on the pre-transaction read (TOCTOU)',
    from: 'const refusal = checkInRefusal(m, now);\n      if (refusal) _refuse(refusal);\n      const prior', to: 'const refusal = checkInRefusal(m0, now);\n      if (refusal) _refuse(refusal);\n      const prior' },
  { tag: 'e', row: 'S3 staff of business B (attendance at gym B) scanning a gym A member → refused; nothing written', what: 'staff business-match skipped',
    from: 'const businessId = link.businessId;', to: 'const businessId = ((await _staffGyms(uid)).gyms[0] || {}).businessId || link.businessId;' },
  { tag: 'f', row: 'S2 staff WITHOUT the attendance permission refused (cashier role defaults never include it); a non-member refused; nothing written', what: 'workforce permission check skipped',
    from: 'await _wfi()._assertBusinessPermission(uid, businessId, ATTENDANCE_PERMISSION);', to: '/* permission check skipped */' },
  { tag: 'g', row: 'G1 owner sees ONLY its own gym (newest first); a client-supplied providerId / businessId is ignored; the other gym sees only its own', what: 'client providerId accepted (fitness-gym-memberships.js)', file: 'fg',
    from: 'const providerId = scope.providerId;', to: 'const providerId = String(d.providerId || scope.providerId);' },
  { tag: 'h', row: 'A10 duplicate scan is idempotent: returns the existing result, attendedSessions unchanged, ledger and membership byte-identical', what: 'duplicate-scan idempotency dropped',
    from: 'if (as.exists) {', to: 'if (false && as.exists) {' },
  { tag: 'i', row: 'A22 check-in response contract: success AND duplicate both carry membershipId, attendanceId, member.displayName, title, checkedInAt (ISO), attendedSessions (after), sessionsIncluded|null, duplicate, firstCheckIn — exact key set', what: 'membershipId dropped from the check-in response',
    from: "out = { duplicate: false, membershipId, attendanceId: attId,", to: "out = { duplicate: false, attendanceId: attId," },
];

/* Module use (scripts/gen-fitness-api-fixtures.js): the suite's fake db, fixtures and loaders — nothing runs. */
module.exports = { fakeDb, harness, seedBase, seedLinked, mem, req, attempt, qr, scan, loadModule, loadFG, SRC, FG_SRC, NOW, START, MID, MID2, LINKED };
if (require.main === module)

(async () => {
  let fails = 0;
  FG_SRC_UNDER_TEST = FG_SRC;
  const real = await matrix(loadModule(SRC));
  const names = Object.keys(real);
  for (const n of names) { console.log(`  ${real[n].ok ? 'PASS' : 'FAIL'}  ${n}${real[n].ok ? '' : '  -> ' + JSON.stringify(real[n].detail).slice(0, 400)}`); if (!real[n].ok) fails++; }
  console.log(`\n${names.length - fails} passed, ${fails} failed\n\nNegative controls:`);
  let ctlBad = 0;
  for (const mu of MUTANTS) {
    const base = mu.file === 'fg' ? FG_SRC : SRC;
    if (!base.includes(mu.from)) { console.log(`  CONTROL BROKEN  NC-${mu.tag}: mutation anchor not found in source`); ctlBad++; continue; }
    FG_SRC_UNDER_TEST = mu.file === 'fg' ? FG_SRC.replace(mu.from, mu.to) : FG_SRC;
    const FAm = mu.file === 'fg' ? loadModule(SRC) : loadModule(SRC.replace(mu.from, mu.to), 'mutant_' + mu.tag);
    const rows = await matrix(FAm);
    const named = rows[mu.row];
    const failed = Object.keys(rows).filter((k) => !rows[k].ok);
    const ok = named && named.ok === false;
    if (!ok) ctlBad++;
    console.log(`  ${ok ? 'CAUGHT' : 'MISSED'}  NC-${mu.tag} (${mu.what}) → named row ${ok ? 'FAILED' : 'did not fail'}; failing rows: ${failed.map((k) => k.split(' ')[0]).join(', ') || 'none'}`);
  }
  console.log(`\n${MUTANTS.length - ctlBad}/${MUTANTS.length} negative controls caught`);
  process.exit(fails || ctlBad ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
