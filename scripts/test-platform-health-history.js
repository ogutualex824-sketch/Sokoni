#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PLATFORM HEALTH — daily history (platformHealthSnapshot + getPlatformHealthScores.history)
   ------------------------------------------------------------------------------
   Hermetic: no firebase-admin, no emulator, no network. firebase-functions/v2/https,
   firebase-functions/v2/scheduler and firebase-admin/firestore are replaced with
   in-process fakes; Firestore is an in-memory map that records every read and write.
   Run under the block-admin preload so a stray real-SDK load fails loudly:

     NODE_OPTIONS=--require=<scratchpad>/block-admin.js node scripts/test-platform-health-history.js

   NEGATIVE CONTROLS (each must make a NAMED row fail on a source mutant):
     (a) overwrite on rerun  — exists() pre-check disabled and create() → set()
         ⇒ "snapshot: rerun the same day does not overwrite" FAILS
     (b) failed dimension recorded as 0
         ⇒ "snapshot: failed dimension recorded as null (never 0)" FAILS
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join(ROOT, 'functions');
const SRC_PATH = path.join(FN_DIR, 'platform-health.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail && !ok ? '   [' + String(detail).slice(0, 200) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); }
};

/* ── fakes ─────────────────────────────────────────────────────────────────── */
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  toMillis() { return this.ms; }
  valueOf() { return this.ms; }
}
const SERVER_TS = { __sentinel: 'serverTimestamp' };
let CURRENT_DB = null;

const STUBS = {
  'firebase-functions/v2/https': {
    HttpsError,
    onCall: (opts, fn) => Object.assign(fn, { __opts: opts, __kind: 'onCall' }),
  },
  'firebase-functions/v2/scheduler': {
    onSchedule: (opts, fn) => Object.assign(fn, { __opts: opts, __kind: 'onSchedule' }),
  },
  'firebase-admin/firestore': {
    getFirestore: () => CURRENT_DB,
    Timestamp: FakeTimestamp,
    FieldValue: { serverTimestamp: () => SERVER_TS },
  },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, req)) return STUBS[req];
  return origLoad.apply(this, arguments);
};

function fakeDb(seed, opts = {}) {
  const data = {};                      /* coll -> id -> doc */
  const log = { reads: [], writes: [], queries: [], getAllCalls: [] };
  Object.keys(seed || {}).forEach((c) => { data[c] = Object.assign({}, seed[c]); });
  const col = (c) => (data[c] = data[c] || {});
  const failOn = opts.failOn || {};     /* coll -> Error thrown by any read of it */
  const snap = (c, id) => {
    const v = col(c)[id];
    return { id, exists: v !== undefined, data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
      ref: docRef(c, id) };
  };
  function docRef(c, id) {
    return {
      __coll: c, id,
      async get() {
        if (failOn[c]) throw failOn[c];
        log.reads.push(c + '/' + id);
        if (opts.hideOnce && opts.hideOnce === c + '/' + id) { opts.hideOnce = null; return { id, exists: false, data: () => undefined }; }
        return snap(c, id);
      },
      async create(v) {
        log.writes.push({ op: 'create', path: c + '/' + id, v });
        if (col(c)[id] !== undefined) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; }
        col(c)[id] = v;
      },
      async set(v) { log.writes.push({ op: 'set', path: c + '/' + id, v }); col(c)[id] = v; },
      async update(v) { log.writes.push({ op: 'update', path: c + '/' + id, v }); col(c)[id] = Object.assign({}, col(c)[id], v); },
    };
  }
  function query(c, filters, lim) {
    return {
      where(f, op, v) { return query(c, filters.concat([[f, op, v]]), lim); },
      orderBy() { log.queries.push(c + ':orderBy'); return query(c, filters, lim); },
      limit(n) { return query(c, filters, n); },
      async get() {
        if (failOn[c]) throw failOn[c];
        log.queries.push(c);
        let docs = Object.keys(col(c)).map((id) => snap(c, id));
        filters.forEach(([f, op, v]) => {
          docs = docs.filter((d) => {
            const x = d.data()[f];
            const xv = x && typeof x === 'object' && 'ms' in x ? x.ms : x;
            const vv = v && typeof v === 'object' && 'ms' in v ? v.ms : v;
            if (op === '==') return xv === vv;
            if (op === '>=') return xv >= vv;
            if (op === '<=') return xv <= vv;
            throw new Error('fake: op ' + op);
          });
        });
        if (lim != null) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  return {
    data, log,
    collection(c) { return Object.assign(query(c, [], null), { doc: (id) => docRef(c, id) }); },
    async getAll(...refs) {
      log.getAllCalls.push(refs.map((r) => r.__coll + '/' + r.id));
      for (const r of refs) if (failOn[r.__coll]) throw failOn[r.__coll];
      return refs.map((r) => { log.reads.push(r.__coll + '/' + r.id); return snap(r.__coll, r.id); });
    },
  };
}

/* Seed with real-shaped inputs for all four data-driven dimensions. */
const NOW = Date.parse('2026-10-04T00:05:00.000Z');          /* 03:05 EAT, 2026-10-04 */
const TODAY = '2026-10-04';
function baseSeed() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    ops_reports: { [iso(Date.now())]: { paymentSuccessRate: 90 } },
    products: { p1: { status: 'active', images: ['a'] }, p2: { status: 'active', images: [] } },
    sellerPerformance: {
      s1: { totalOrders: 4, successfulOrders: 3, fulfillmentRate: 80, cancellationRate: 10, avgDispatchHours: 20 },
      s2: { totalOrders: 0, successfulOrders: 0, fulfillmentRate: 60, cancellationRate: 20 },
    },
    feedback: { f1: { type: 'page_rating', rating: 4 }, f2: { type: 'bug', status: 'new', priority: 'high' } },
    healthSnapshots: { h1: { timestamp: new FakeTimestamp(Date.now() - 3600e3), status: 'ok' } },
  };
}
const precondition = () => Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 });

function loadModule(src) {
  const m = new Module(SRC_PATH, null);
  m.filename = SRC_PATH;
  m.paths = Module._nodeModulePaths(FN_DIR);
  m._compile(src, SRC_PATH);
  return m.exports;
}

const ADMIN = { auth: { uid: 'u1', token: { admin: true } }, data: {} };
const LEGACY_KEYS = ['overall', 'marketplace', 'seller', 'buyer', 'operational', 'cost', 'alerts', 'computedAt', 'indexBudget'];
const quiet = async (fn) => {
  const l = console.log, e = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = l; console.error = e; }
};

async function suite(PH, tag) {
  const rows = {};
  const row = (name, ok, detail) => { rows[name] = !!ok; if (tag === 'real') ck(name, ok, detail); };
  const I = PH._internals;

  /* ── schedule + export ── */
  const o = PH.platformHealthSnapshot && PH.platformHealthSnapshot.__opts;
  row('schedule: onSchedule 03:00 Africa/Nairobi, us-central1', !!o && PH.platformHealthSnapshot.__kind === 'onSchedule'
    && o.schedule === '0 3 * * *' && o.timeZone === 'Africa/Nairobi' && o.region === 'us-central1', JSON.stringify(o));

  /* ── date keys ── */
  row('date key: Nairobi day, not UTC (21:30Z → next day)', I.nairobiDateKey(Date.parse('2026-10-03T21:30:00Z')) === '2026-10-04'
    && I.nairobiDateKey(Date.parse('2026-10-03T20:59:59Z')) === '2026-10-03');
  const keys = I.historyDateKeys(NOW);
  row('date keys: 90 distinct, oldest first, ends today', keys.length === 90 && new Set(keys).size === 90
    && keys[89] === TODAY && keys[0] === '2026-07-07' && keys.every((k, i) => i === 0 || k > keys[i - 1]), keys[0] + '..' + keys[89]);

  /* ── snapshot: first write ── */
  let db = fakeDb(baseSeed());
  CURRENT_DB = db;
  const r1 = await quiet(() => I.runSnapshot(db, NOW));
  const stored = db.data.platformHealthHistory && db.data.platformHealthHistory[TODAY];
  row('snapshot: first run writes platformHealthHistory/{Nairobi date}', r1.status === 'written' && !!stored
    && db.log.writes.length === 1 && db.log.writes[0].path === 'platformHealthHistory/' + TODAY && db.log.writes[0].op === 'create',
    JSON.stringify(db.log.writes.map((w) => w.op + ' ' + w.path)));
  row('snapshot: document shape {date, overall, dimensions{5}, failed, computedAt, version}', !!stored && stored.date === TODAY
    && typeof stored.overall === 'number' && Object.keys(stored.dimensions).sort().join() === 'buyer,cost,marketplace,operational,seller'
    && Object.values(stored.dimensions).every((v) => typeof v === 'number') && Array.isArray(stored.failed) && stored.failed.length === 0
    && stored.computedAt === SERVER_TS && stored.version === I.SNAPSHOT_VERSION, JSON.stringify(stored));

  /* one formula: the snapshot equals what the callable returns for the same data */
  const live = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  row('one formula: snapshot scores == callable scores on the same data', !!stored && stored.overall === live.overall.score
    && I.DIMENSION_NAMES.every((n) => stored.dimensions[n] === live[n].score),
    JSON.stringify({ snap: stored && stored.dimensions, live: I.DIMENSION_NAMES.map((n) => live[n].score) }));

  /* ── rerun same day: no overwrite ── */
  const before = JSON.stringify(stored);
  db.data.sellerPerformance.s1.fulfillmentRate = 5;          /* a recomputation would now differ */
  db.data.feedback.f3 = { type: 'bug', status: 'new', priority: 'critical' };
  const writesBefore = db.log.writes.length;
  const r2 = await quiet(() => I.runSnapshot(db, NOW + 6 * 3600e3));   /* 09:05 EAT, same day */
  row('snapshot: rerun the same day does not overwrite', r2.status === 'skipped' && JSON.stringify(db.data.platformHealthHistory[TODAY]) === before
    && db.log.writes.length === writesBefore, r2.status + ' writes+' + (db.log.writes.length - writesBefore));
  /* race: the doc appears between the pre-check and create() */
  const raceDb = fakeDb(Object.assign(baseSeed(), { platformHealthHistory: { [TODAY]: { date: TODAY, overall: 41, marker: 'first' } } }),
    { hideOnce: 'platformHealthHistory/' + TODAY });
  const r3 = await quiet(() => I.runSnapshot(raceDb, NOW));
  row('snapshot: concurrent create (ALREADY_EXISTS) is a skip, original kept', r3.status === 'skipped'
    && raceDb.data.platformHealthHistory[TODAY].marker === 'first' && raceDb.log.writes.every((w) => w.op === 'create'));
  /* next day writes a new doc */
  const r4 = await quiet(() => I.runSnapshot(db, NOW + 86400e3));
  row('snapshot: next Nairobi day writes its own document', r4.status === 'written' && !!db.data.platformHealthHistory['2026-10-05']
    && JSON.stringify(db.data.platformHealthHistory[TODAY]) === before);

  /* ── failed dimension → null, overall withheld ── */
  const fdb = fakeDb(baseSeed(), { failOn: { healthSnapshots: precondition() } });
  CURRENT_DB = fdb;
  await quiet(() => I.runSnapshot(fdb, NOW));
  const fdoc = fdb.data.platformHealthHistory && fdb.data.platformHealthHistory[TODAY];
  row('snapshot: failed dimension recorded as null (never 0)', !!fdoc && fdoc.dimensions.operational === null
    && fdoc.failed.join() === 'operational', JSON.stringify(fdoc && fdoc.dimensions));
  row('snapshot: withheld overall recorded as null', !!fdoc && fdoc.overall === null, fdoc && fdoc.overall);
  row('snapshot: the other four dimensions still recorded', !!fdoc && ['marketplace', 'seller', 'buyer', 'cost']
    .every((n) => typeof fdoc.dimensions[n] === 'number'));

  /* ── history ── */
  /* the callable reads history relative to the real clock */
  const RNOW = Date.now(), RTODAY = I.nairobiDateKey(RNOW), FUTURE = I.nairobiDateKey(RNOW + 86400e3);
  const hseed = baseSeed();
  hseed.platformHealthHistory = {};
  const all = I.historyDateKeys(RNOW, 95);                     /* 95 consecutive days */
  all.forEach((k, i) => {
    hseed.platformHealthHistory[k] = { date: k, overall: 50 + (i % 7),
      dimensions: { marketplace: 60, seller: i === 94 ? null : 61, buyer: 62, operational: 'bad', cost: 70 } };
  });
  hseed.platformHealthHistory[FUTURE] = { date: FUTURE, overall: 99, dimensions: {} };   /* future */
  const hdb = fakeDb(hseed);
  CURRENT_DB = hdb;
  const res = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  const h = res.history;
  row('history: ≤90 entries, the newest 90, oldest first', Array.isArray(h) && h.length === 90 && h[0].date === all[5]
    && h[89].date === RTODAY && h.every((e, i) => i === 0 || e.date > h[i - 1].date), Array.isArray(h) && (h.length + ' ' + h[0].date + '..' + h[h.length - 1].date));
  row('history: no future/out-of-window day leaks in', Array.isArray(h) && !h.some((e) => e.date === FUTURE || e.date < all[5]));
  row('history: entry shape {date, overall, dimensions{5}} only', Array.isArray(h) && h.every((e) => Object.keys(e).sort().join() === 'date,dimensions,overall'
    && Object.keys(e.dimensions).sort().join() === 'buyer,cost,marketplace,operational,seller'));
  row('history: recorded null stays null (not 0)', Array.isArray(h) && h[89].dimensions.seller === null);
  row('history: non-numeric stored value reads as null (not 0, not the string)', Array.isArray(h) && h.every((e) => e.dimensions.operational === null));
  row('history: values are the stored numbers', Array.isArray(h) && h[89].overall === hseed.platformHealthHistory[RTODAY].overall && h[89].dimensions.cost === 70);
  const hCalls = hdb.log.getAllCalls.filter((c) => c.some((p) => p.indexOf('platformHealthHistory/') === 0));
  row('history: ONE getAll of exactly 90 computed keys, no query on the collection', hCalls.length === 1
    && hCalls[0].length === 90 && hCalls[0].every((p) => p.indexOf('platformHealthHistory/') === 0) && !hdb.log.queries.some((q) => q.indexOf('platformHealthHistory') === 0));
  row('history: ordered queries absent (no orderBy anywhere)', !hdb.log.queries.some((q) => /orderBy/.test(q)));

  const edb = fakeDb(baseSeed());
  CURRENT_DB = edb;
  const empty = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  row('history: no snapshots yet → [] (not null, not invented)', Array.isArray(empty.history) && empty.history.length === 0 && !('historyError' in empty));

  const xdb = fakeDb(baseSeed(), { failOn: { platformHealthHistory: Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }) } });
  CURRENT_DB = xdb;
  const xr = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  row('history read failure → history:null + historyError; live scores intact', xr.history === null && xr.historyError
    && xr.historyError.code === '14' && typeof xr.overall.score === 'number');

  /* ── back-compat + gate ── */
  CURRENT_DB = fakeDb(baseSeed());
  const bc = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  row('callable: legacy keys unchanged, history added', LEGACY_KEYS.every((k) => k in bc) && 'history' in bc
    && Object.keys(bc).filter((k) => !LEGACY_KEYS.includes(k)).join() === 'history'
    && Object.keys(bc.overall).sort().join() === 'grade,score' && bc.indexBudget.used === 192 && Array.isArray(bc.alerts));
  const pdb = fakeDb(baseSeed(), { failOn: { healthSnapshots: precondition() } });
  CURRENT_DB = pdb;
  const pr = await quiet(() => PH.getPlatformHealthScores(ADMIN));
  row('callable: withheld overall shape unchanged', pr.overall.score === null && pr.overall.unavailable === true
    && pr.overall.failedDimensions.join() === 'operational' && pr.operational.failed === true && pr.operational.score === null);

  const gate = async (req) => {
    const g = fakeDb(baseSeed()); CURRENT_DB = g;
    try { await quiet(() => PH.getPlatformHealthScores(req)); return { code: 'ok', reads: g.log.reads.length + g.log.queries.length }; }
    catch (e) { return { code: e.code, reads: g.log.reads.length + g.log.queries.length, https: e instanceof HttpsError }; }
  };
  const g1 = await gate({ data: {} });
  const g2 = await gate({ auth: { uid: 'x', token: { admin: 'true' } }, data: {} });
  const g3 = await gate({ auth: { uid: 'x', token: { superAdmin: true } }, data: {} });
  const g4 = await gate({ auth: { uid: 'x', token: {} }, data: {} });
  row('gate: unauthenticated refused before any read', g1.code === 'unauthenticated' && g1.https && g1.reads === 0);
  row('gate: non-admin (incl. admin:"true") refused before any read', g2.code === 'permission-denied' && g4.code === 'permission-denied' && g2.reads === 0 && g4.reads === 0);
  row('gate: superAdmin admitted', g3.code === 'ok');

  /* snapshot never touches anything but its own day document */
  const wdb = fakeDb(baseSeed());
  await quiet(() => I.runSnapshot(wdb, NOW));
  row('snapshot: writes ONLY platformHealthHistory/{today}', wdb.log.writes.length === 1 && wdb.log.writes[0].path === 'platformHealthHistory/' + TODAY);
  return rows;
}

(async () => {
  console.log('\nPlatform Health history — functions (hermetic)');
  const PH = loadModule(SRC);
  await suite(PH, 'real');

  console.log('\nWiring (static)');
  const idx = fs.readFileSync(path.join(FN_DIR, 'index.js'), 'utf8');
  ck('index.js: platformHealthSnapshot re-exported by name', /\nexports\.platformHealthSnapshot\s*=\s*platformHealth\.platformHealthSnapshot;/.test(idx));
  ck('index.js: getPlatformHealthScores export unchanged', /\nexports\.getPlatformHealthScores\s*=\s*platformHealth\.getPlatformHealthScores;/.test(idx));
  ck('no second formula: weights appear once in the module', (SRC.match(/\* 0\.30/g) || []).length === 1);

  console.log('\nNegative control (a) — overwrite on rerun');
  const A1 = 'if (existing.exists) {', A2 = 'await ref.create(doc);';
  ck('control (a): anchors present once', SRC.split(A1).length === 2 && SRC.split(A2).length === 2);
  const mutA = loadModule(SRC.replace(A1, 'if (false && existing.exists) {').replace(A2, 'await ref.set(doc);'));
  const ar = await suite(mutA, 'mutant');
  ck('control (a): row "snapshot: rerun the same day does not overwrite" FAILS', ar['snapshot: rerun the same day does not overwrite'] === false);
  ck('control (a): unrelated row still passes (targeted)', ar['snapshot: failed dimension recorded as null (never 0)'] === true);

  console.log('\nNegative control (b) — failed dimension written as 0');
  const B = 'computed.failedDimensions.includes(n) ? null : scoreOrNull(computed[n])';
  ck('control (b): anchor present once', SRC.split(B).length === 2);
  const mutB = loadModule(SRC.replace(B, 'computed.failedDimensions.includes(n) ? 0 : scoreOrNull(computed[n])'));
  const br = await suite(mutB, 'mutant');
  ck('control (b): row "snapshot: failed dimension recorded as null (never 0)" FAILS', br['snapshot: failed dimension recorded as null (never 0)'] === false);
  ck('control (b): unrelated row still passes (targeted)', br['snapshot: rerun the same day does not overwrite'] === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
