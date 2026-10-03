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
const INERT_ADMIN = {
  apps: [1], initializeApp () {},
  firestore: Object.assign(function () { throw new Error('[suite] real admin.firestore() called'); }, {
    FieldValue: { serverTimestamp: () => 'SERVER_TS', increment: (n) => ({ __inc: n }) },
    Timestamp: { now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }), fromDate: (d) => ({ toDate: () => d, toMillis: () => d.getTime() }) },
  }),
  auth () { throw new Error('[suite] real admin.auth() called'); },
};
Module._load = function (req) { if (req === 'firebase-admin') return INERT_ADMIN; return _prevLoad.apply(this, arguments); };
if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) { console.error('refusing to run inside a Cloud Functions runtime'); process.exit(2); }

const MS = require(path.join(FN, 'membership-settlement.js'));
const FU = require(path.join(FN, 'finos-utils.js'));
const EO = require(path.join(FN, 'event-ops.js'));
const SRC_FILE = path.join(FN, 'fitness-attendance.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');

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
    where: (f, op, v) => ({ limit: () => ({ get: async () => {
      const hits = [...docs.entries()].filter(([k, d]) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && d[f] != null && (op === '<=' ? d[f] <= v : d[f] === v));
      return { size: hits.length, empty: !hits.length, docs: hits.map(([k]) => snap(k)) };
    } }) }),
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
  'providers/gym_A': { uid: 'gym_A' }, 'providers/gym_B': { uid: 'gym_B' },
  'businesses/biz_A': { ownerId: 'gym_A' },
  'workspaceMemberships/wm1': { uid: 'cashier_1', businessId: 'biz_A', status: 'active', role: 'cashier', permissions: ['pos', 'view_products', 'customers', 'refunds'] },
  'workspaceMemberships/wm2': { uid: 'trainer_1', businessId: 'biz_A', status: 'active', role: 'trainer', permissions: ['bookings', 'customers'] },
}, extra || {});
const AUTH = (uid, token) => ({ uid, token: Object.assign({ uid }, token || {}) });
const req = (uid, data, token) => ({ auth: uid ? AUTH(uid, token) : null, data });

function harness (FA, seed, opts) {
  const o = opts || {};
  const db = fakeDb(seed);
  let tsN = 0; let now = o.now || NOW;
  const releases = [];
  FA._test.use({
    db, ts: () => 'TS#' + (++tsN), now: () => now, correlationId: () => 'cid-' + (tsN + 1),
    release: o.release || (async (id) => { releases.push(id); }), staffAuthority: o.staffAuthority || null,
  });
  return { db, releases, setNow: (d) => { now = d; }, get: (p) => db._docs.get(p) };
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
    ck('A7 unpermitted staff: cashier and trainer (active workspace members, no attendance permission) refused no_permission',
      c.reason === 'no_permission' && t.reason === 'no_permission' && h.get(P).attendedSessions === 0, [c.reason, t.reason]); }
  { const h = harness(FA, seedBase(), { staffAuthority: async () => ({ allowed: false }) });
    const tok = await qr(FA, 'member_1');
    const c = await scan(FA, 'cashier_1', tok);
    ck('A7b the staff seam is consulted and its denial holds (default: BLOCKED until a provider business identity exists)', c.reason === 'no_permission' && h.get(P).attendedSessions === 0, c.reason); }

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

  return rows;
}

/* ── mutants (negative controls) ── */
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
];

(async () => {
  let fails = 0;
  const real = await matrix(loadModule(SRC));
  const names = Object.keys(real);
  for (const n of names) { console.log(`  ${real[n].ok ? 'PASS' : 'FAIL'}  ${n}${real[n].ok ? '' : '  -> ' + JSON.stringify(real[n].detail).slice(0, 400)}`); if (!real[n].ok) fails++; }
  console.log(`\n${names.length - fails} passed, ${fails} failed\n\nNegative controls:`);
  let ctlBad = 0;
  for (const mu of MUTANTS) {
    if (!SRC.includes(mu.from)) { console.log(`  CONTROL BROKEN  NC-${mu.tag}: mutation anchor not found in source`); ctlBad++; continue; }
    const rows = await matrix(loadModule(SRC.replace(mu.from, mu.to), 'mutant_' + mu.tag));
    const named = rows[mu.row];
    const failed = Object.keys(rows).filter((k) => !rows[k].ok);
    const ok = named && named.ok === false;
    if (!ok) ctlBad++;
    console.log(`  ${ok ? 'CAUGHT' : 'MISSED'}  NC-${mu.tag} (${mu.what}) → named row ${ok ? 'FAILED' : 'did not fail'}; failing rows: ${failed.map((k) => k.split(' ')[0]).join(', ') || 'none'}`);
  }
  console.log(`\n${MUTANTS.length - ctlBad}/${MUTANTS.length} negative controls caught`);
  process.exit(fails || ctlBad ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
