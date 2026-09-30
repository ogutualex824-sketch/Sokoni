#!/usr/bin/env node
/* ============================================================================
   App release metrics — node unit suite (NO emulator, NO network, NO Firebase)
   scripts/test-app-release-metrics.js

   Covers functions/app-release-metrics.js through its _deps seam:
     1. appInstallReport payload validation (UUID v4, event enum, cacheVersion
        shape, standalone bool, platform enum)
     2. admin refusal on BOTH admin callables (unauthenticated / permission-denied)
        via the shared assertAdmin (functions/shared/errors.js)
     3. the idempotent Nairobi day key (UTC+3 boundary)
     4. create()-NOT-set() on first sight; one write per install per day; the
        install flag set at most once; nothing identifying stored
     5. rate-limit key = installId + a 16-hex IP hash (never the raw IP); a
        throttled call writes nothing
     6. aggregate math with a fake count() provider; single-field queries only
        (no composite index); unknown live build -> onLive/behind null, never 0
     7. adminGetAppInstallStats -> { state:'not-computed-yet' } when absent;
        a malformed figure -> null, never 0
     8. adminReleaseLog paging (limit cap 100, cursor, filters, live status)
        against a fixture AND the bundled functions/data/release-log.json
     9. functions/index.js re-exports all four BY NAME

   Run:  node scripts/test-app-release-metrics.js     Exit: 0 pass · 1 fail
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'functions', 'app-release-metrics.js'));
const I = M._internal;
const D = I._deps;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const head = (t) => console.log('\n[' + t + ']');
async function rejects(fn, code) {
  try { await fn(); return 'resolved'; } catch (e) { return e && e.code === code ? true : (e && e.code) || String(e); }
}

/* ── fake Firestore ──────────────────────────────────────────────────────── */
const ST = { __serverTimestamp: true };
function fakeDb(seed) {
  const store = new Map(Object.entries(seed || {}));   /* path -> data */
  const ops = [];
  const queries = [];
  const ref = (coll, id) => ({ path: coll + '/' + id, id });
  function snapOf(p) { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : Object.assign({}, d)), get: (f) => (d || {})[f] }; }
  function query(coll, filters, order, lim) {
    return {
      where: (f, op, v) => query(coll, filters.concat([{ f, op, v }]), order, lim),
      orderBy: (f, dir) => query(coll, filters, { f, dir }, lim),
      limit: (n) => query(coll, filters, order, n),
      doc: (id) => Object.assign(ref(coll, id), {
        get: async () => snapOf(coll + '/' + id),
        set: async (data) => { ops.push({ op: 'set', path: coll + '/' + id, data }); store.set(coll + '/' + id, data); },
      }),
      _rows() {
        let rows = [...store.entries()].filter(([p]) => p.startsWith(coll + '/') && p.split('/').length === 2).map(([, d]) => d);
        for (const { f, op, v } of filters) {
          rows = rows.filter((d) => (op === '==' ? d[f] === v : op === '>=' ? d[f] >= v : false));
        }
        if (order) rows.sort((a, b) => (a[order.f] > b[order.f] ? 1 : -1));
        if (lim != null) rows = rows.slice(0, lim);
        return rows;
      },
      count() { const q = this; return { get: async () => { queries.push({ coll, filters, order }); return { data: () => ({ count: q._rows().length }) }; } }; },
      async get() { queries.push({ coll, filters, order }); const rows = this._rows(); return { docs: rows.map((d) => ({ get: (f) => d[f] })) }; },
    };
  }
  return {
    store, ops, queries,
    collection: (c) => query(c, [], null, null),
    async runTransaction(fn) {
      const tx = {
        get: async (r) => snapOf(r.path),
        create: (r, data) => { if (store.has(r.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); ops.push({ op: 'create', path: r.path, data }); store.set(r.path, data); },
        update: (r, data) => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); ops.push({ op: 'update', path: r.path, data }); store.set(r.path, Object.assign({}, store.get(r.path), data)); },
        set: (r, data) => { ops.push({ op: 'set', path: r.path, data }); store.set(r.path, data); },
      };
      return fn(tx);
    },
  };
}

/* production deps are replaced for the whole run; nothing below reaches Firebase */
D.serverTimestamp = () => ST;
D.timestampFromMillis = (ms) => ms;

const UUID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const CV = 'sokoni-20261001120000-v648';
const good = { installId: UUID, event: 'checkin', cacheVersion: CV, standalone: true, platform: 'android' };
const req = (data, extra) => Object.assign({ data, rawRequest: { headers: { 'x-forwarded-for': '41.90.1.2, 10.0.0.1' } } }, extra || {});
const ADMIN = { auth: { uid: 'a1', token: { admin: true } } };
const SUPER = { auth: { uid: 's1', token: { superAdmin: true } } };
const USER = { auth: { uid: 'u1', token: { seller: true } } };

(async () => {
  head('1 · payload validation');
  ok('a valid check-in is accepted', (() => { try { return I.validateReport(good).installId === UUID; } catch (_) { return false; } })());
  ok('upper-case UUID is normalised to lower case', (() => { try { return I.validateReport(Object.assign({}, good, { installId: UUID.toUpperCase() })).installId === UUID; } catch (_) { return false; } })());
  const bad = [
    ['missing payload', null],
    ['array payload', [good]],
    ['UUID v1 (not random)', Object.assign({}, good, { installId: '3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b' })],
    ['not a UUID', Object.assign({}, good, { installId: 'abc' })],
    ['event outside the enum', Object.assign({}, good, { event: 'launch' })],
    ['cacheVersion wrong shape', Object.assign({}, good, { cacheVersion: 'sokoni-2026-v1' })],
    ['cacheVersion with a suffix', Object.assign({}, good, { cacheVersion: CV + 'x' })],
    ['standalone as a string', Object.assign({}, good, { standalone: 'true' })],
    ['platform outside the enum', Object.assign({}, good, { platform: 'Mozilla/5.0' })],
  ];
  for (const [label, p] of bad) {
    ok('refused: ' + label, (await rejects(() => M._h.appInstallReport(req(p)), 'invalid-argument')) === true);
  }

  head('2 · admin refusal (shared assertAdmin)');
  D.releaseLog = () => ({ schema: 1, entries: [] });
  D.db = () => fakeDb();
  for (const name of ['adminReleaseLog', 'adminGetAppInstallStats']) {
    ok(name + ': no auth -> unauthenticated', (await rejects(() => M._h[name]({ data: {} }), 'unauthenticated')) === true);
    ok(name + ': signed-in non-admin -> permission-denied', (await rejects(() => M._h[name](Object.assign({ data: {} }, USER)), 'permission-denied')) === true);
    ok(name + ': admin claim -> allowed', (await rejects(() => M._h[name](Object.assign({ data: {} }, ADMIN)), 'x')) === 'resolved');
    ok(name + ': superAdmin claim -> allowed', (await rejects(() => M._h[name](Object.assign({ data: {} }, SUPER)), 'x')) === 'resolved');
  }
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'app-release-metrics.js'), 'utf8');
  ok('reuses assertAdmin from ./shared/errors (no new admin helper)', /require\('\.\/shared\/errors'\)/.test(src) && !/function\s+(assert|require)Admin/.test(src));
  ok('all three callables enforce App Check', (src.match(/onCall\(\{[^}]*enforceAppCheck: true/g) || []).length === 3);

  head('3 · idempotent day key (Africa/Nairobi)');
  ok('20:59Z is still the same Nairobi day', I.dayKey(Date.parse('2026-10-01T20:59:59Z')) === '2026-10-01');
  ok('21:00Z is the next Nairobi day', I.dayKey(Date.parse('2026-10-01T21:00:00Z')) === '2026-10-02');

  head('4 · create() on first sight, one write per day');
  let db = fakeDb();
  let t = Date.parse('2026-10-01T08:00:00Z');
  D.db = () => db; D.now = () => t;
  let rlKeys = [];
  D.rateLimit = async (id) => { rlKeys.push(id); return { allowed: true }; };
  let r = await M._h.appInstallReport(req(good));
  ok('first sight -> created', r && r.action === 'created', r);
  ok('first sight used create(), never set()', db.ops.length === 1 && db.ops[0].op === 'create', db.ops.map((o) => o.op));
  const doc = db.store.get('appInstalls/' + UUID);
  ok('doc: firstSeenAt/lastSeenAt/firstCacheVersion/platform/standalone recorded', doc && doc.firstSeenAt === ST && doc.lastSeenAt === ST && doc.firstCacheVersion === CV && doc.cacheVersion === CV && doc.platform === 'android' && doc.standalone === true && doc.lastSeenDay === '2026-10-01');
  ok('check-in first sight: installed=false and NO installedAt', doc.installed === false && !('installedAt' in doc));
  ok('nothing identifying stored (no uid, ip, userAgent, ipHash)', !Object.keys(doc).some((k) => /uid|ip|agent|ua$/i.test(k)), Object.keys(doc));
  r = await M._h.appInstallReport(req(Object.assign({}, good, { cacheVersion: 'sokoni-20261001130000-v649' })));
  ok('second check-in the same day -> deduped, NO write', r.action === 'deduped' && db.ops.length === 1);
  r = await M._h.appInstallReport(req(good, { auth: { uid: 'u9', token: {} } }));
  ok('a signed-in caller changes nothing (uid never read or stored)', r.action === 'deduped' && !JSON.stringify([...db.store.values()]).includes('u9'));
  r = await M._h.appInstallReport(req(Object.assign({}, good, { event: 'install' })));
  ok('install on an existing device the same day -> one update setting installed + installedAt', r.action === 'updated' && db.ops.length === 2 && db.ops[1].op === 'update' && db.ops[1].data.installed === true && db.ops[1].data.installedAt === ST && !('lastSeenAt' in db.ops[1].data));
  r = await M._h.appInstallReport(req(Object.assign({}, good, { event: 'install' })));
  ok('a repeated install the same day -> deduped (install flag set at most once)', r.action === 'deduped' && db.ops.length === 2);
  t = Date.parse('2026-10-02T08:00:00Z');
  r = await M._h.appInstallReport(req(Object.assign({}, good, { cacheVersion: 'sokoni-20261002010000-v650', standalone: false })));
  ok('next day -> one update (lastSeenAt, lastSeenDay, cacheVersion, standalone)', r.action === 'updated' && db.ops.length === 3 && db.ops[2].op === 'update' && db.ops[2].data.lastSeenDay === '2026-10-02' && db.ops[2].data.cacheVersion === 'sokoni-20261002010000-v650' && db.ops[2].data.standalone === false);
  ok('firstCacheVersion is never rewritten', db.store.get('appInstalls/' + UUID).firstCacheVersion === CV);
  ok('no set() was ever issued on appInstalls', !db.ops.some((o) => o.op === 'set'));
  db = fakeDb();
  r = await M._h.appInstallReport(req(Object.assign({}, good, { event: 'install' })));
  ok('install as first sight -> create with installed=true + installedAt', r.action === 'created' && db.ops[0].op === 'create' && db.ops[0].data.installed === true && db.ops[0].data.installedAt === ST);

  head('5 · rate limit key + throttling');
  ok('limiter keyed on installId + 16-hex IP hash', rlKeys.length > 0 && rlKeys.every((k) => new RegExp('^appInstall:' + UUID + ':[0-9a-f]{16}$').test(k)), rlKeys[0]);
  ok('the raw IP never appears in the key', rlKeys.every((k) => !k.includes('41.90')));
  ok('a different IP gives a different key', I.ipHash(req(good)) !== I.ipHash({ rawRequest: { headers: { 'x-forwarded-for': '41.90.1.3' } } }));
  db = fakeDb();
  D.rateLimit = async () => ({ allowed: false });
  r = await M._h.appInstallReport(req(good));
  ok('throttled -> { ok:false, throttled:true } and nothing written', r.ok === false && r.throttled === true && db.ops.length === 0);
  D.rateLimit = async () => { throw new Error('redis down'); };
  r = await M._h.appInstallReport(req(good));
  ok('a limiter fault does not drop the report (day key still bounds writes)', r.action === 'created');
  D.db = () => ({ runTransaction: async () => { throw new Error('boom'); }, collection: () => ({ doc: () => ({}) }) });
  r = await M._h.appInstallReport(req(good));
  ok('a write failure returns { ok:false } — no internal detail leaks', r.ok === false && Object.keys(r).length === 1);

  head('6 · aggregate math (fake count provider)');
  const now = Date.parse('2026-10-10T00:00:00Z');
  const DAY = 86400000;
  const LIVE = 'sokoni-20261009000000-v660';
  const seed = {};
  const mk = (i, o) => { seed['appInstalls/id' + i] = Object.assign({ firstSeenAt: now - 40 * DAY + i, lastSeenAt: now - DAY, installed: false, standalone: false, cacheVersion: 'sokoni-20260901000000-v600' }, o); };
  mk(1, { installed: true, standalone: true, cacheVersion: LIVE, lastSeenAt: now - 1 * DAY });
  mk(2, { installed: true, standalone: true, cacheVersion: LIVE, lastSeenAt: now - 3 * DAY });
  mk(3, { installed: true, standalone: false, lastSeenAt: now - 10 * DAY });
  mk(4, { cacheVersion: LIVE, lastSeenAt: now - 2 * DAY });
  mk(5, { lastSeenAt: now - 20 * DAY });
  mk(6, { lastSeenAt: now - 45 * DAY, firstSeenAt: now - 50 * DAY });
  db = fakeDb(seed);
  seed['platformMetrics/x'] = { devices: 999 };   /* another collection must not be counted */
  let s = await I.computeStats(db, { liveCacheVersion: LIVE, liveError: null }, now);
  ok('devices = 6', s.devices === 6, s.devices);
  ok('total installs (installed == true) = 3', s.total === 3, s.total);
  ok('standalone = 2', s.standalone === 2, s.standalone);
  ok('active7 = 3 (ids 1,2,4)', s.active7 === 3, s.active7);
  ok('active30 = 5 (all but id 6)', s.active30 === 5, s.active30);
  ok('onLive = 3', s.onLive === 3, s.onLive);
  ok('behind = devices − onLive = 3', s.behind === 3, s.behind);
  ok('since = the earliest firstSeenAt (measurement start, nothing back-filled)', s.since === now - 50 * DAY, s.since);
  ok('computedAt is a server timestamp', s.computedAt === ST);
  ok('every query is single-field (no composite index needed)', db.queries.every((q) => q.coll === 'appInstalls' && q.filters.length <= 1 && !(q.filters.length && q.order)), db.queries);
  s = await I.computeStats(fakeDb(seed), { liveCacheVersion: null, liveError: 'version.json HTTP 503' }, now);
  ok('live build unknown -> onLive null, behind null (never 0), reason kept', s.onLive === null && s.behind === null && s.liveError === 'version.json HTTP 503' && s.devices === 6);
  s = await I.computeStats(fakeDb(), { liveCacheVersion: LIVE, liveError: null }, now);
  ok('empty collection -> real canonical zeros, since null', s.devices === 0 && s.total === 0 && s.onLive === 0 && s.behind === 0 && s.since === null);

  head('6b · live cacheVersion from hosting /version.json');
  D.now = () => now;
  D.fetch = async () => ({ ok: true, json: async () => ({ cacheVersion: LIVE }) });
  ok('ok -> the live cacheVersion', (await I.readLiveCacheVersion()).liveCacheVersion === LIVE);
  D.fetch = async () => ({ ok: false, status: 503 });
  ok('HTTP error -> null + reason', (await I.readLiveCacheVersion()).liveCacheVersion === null);
  D.fetch = async () => ({ ok: true, json: async () => ({ cacheVersion: 'garbage' }) });
  ok('malformed cacheVersion -> null', (await I.readLiveCacheVersion()).liveCacheVersion === null);
  D.fetch = async (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  const tr = await I.readLiveCacheVersion();
  ok('a hung fetch is aborted by the timeout -> null + AbortError reason', tr.liveCacheVersion === null && /AbortError/.test(tr.liveError) && Date.now() - t0 < 8000, tr);
  D.fetch = async () => ({ ok: true, json: async () => ({ cacheVersion: LIVE }) });
  db = fakeDb(seed);
  D.db = () => db;
  await I.runScheduledStats();
  ok('scheduled run writes appInstallMetrics/summary with set() (whole replace)', db.ops.length === 1 && db.ops[0].op === 'set' && db.ops[0].path === 'appInstallMetrics/summary' && db.ops[0].data.devices === 6);
  ok('the aggregate is NOT written to platformMetrics (client-writable by admins in firestore.rules)', !db.ops.some((o) => o.path.startsWith('platformMetrics/')));

  head('7 · adminGetAppInstallStats');
  D.db = () => fakeDb();
  r = await M._h.adminGetAppInstallStats(Object.assign({ data: {} }, ADMIN));
  ok('absent aggregate -> { state: not-computed-yet } (no zeros)', JSON.stringify(r) === '{"state":"not-computed-yet"}', r);
  const tsObj = (ms) => ({ toDate: () => new Date(ms) });
  D.db = () => fakeDb({ 'appInstallMetrics/summary': { computedAt: tsObj(now), since: tsObj(now - 50 * DAY), devices: 6, total: 3, standalone: 2, active7: 3, active30: 5, onLive: null, behind: 'x', liveCacheVersion: null, liveError: 'version.json HTTP 503' } });
  r = await M._h.adminGetAppInstallStats(Object.assign({ data: {} }, ADMIN));
  ok('computed -> ISO computedAt + since, counts passed through', r.state === 'computed' && r.computedAt === new Date(now).toISOString() && r.since === new Date(now - 50 * DAY).toISOString() && r.devices === 6 && r.total === 3 && r.active30 === 5);
  ok('unknown / malformed figures -> null, never 0', r.onLive === null && r.behind === null && r.liveError === 'version.json HTTP 503');

  head('8 · adminReleaseLog paging');
  const fixture = { schema: 1, source: 'CHANGELOG.md', sourceSha256: 'abc', entries: [] };
  for (let i = 0; i < 250; i++) fixture.entries.push({ id: 'e' + i, date: '2026-09-' + String(30 - (i % 30)).padStart(2, '0'), title: (i % 5 === 0 ? 'fix: thing ' : 'feat: other ') + i, type: i % 5 === 0 ? 'fix' : 'feat', claim: i === 7 ? 'deployed' : i % 2 ? 'not-deployed' : null, commits: i === 7 ? ['abc1234'] : [], summary: '', files: ['f' + i + '.js'] });
  D.releaseLog = () => fixture;
  const call = (d) => M._h.adminReleaseLog(Object.assign({ data: d }, ADMIN));
  r = await call({});
  ok('default page 40, nextCursor o:40, total 250', r.entries.length === 40 && r.nextCursor === 'o:40' && r.total === 250 && r.entryCount === 250);
  r = await call({ limit: 500 });
  ok('limit is capped at 100', r.entries.length === 100 && r.nextCursor === 'o:100');
  r = await call({ limit: 100, cursor: 'o:200' });
  ok('last page: 50 entries, nextCursor null', r.entries.length === 50 && r.nextCursor === null && r.entries[0].id === 'e200');
  ok('limit 0 refused', (await rejects(() => call({ limit: 0 }), 'invalid-argument')) === true);
  ok('forged cursor refused', (await rejects(() => call({ cursor: 'o:-1' }), 'invalid-argument')) === true);
  ok('unknown type refused', (await rejects(() => call({ type: 'secret' }), 'invalid-argument')) === true);
  ok('non-hex liveCommit refused', (await rejects(() => call({ liveCommit: 'zz' }), 'invalid-argument')) === true);
  r = await call({ type: 'fix', limit: 100 });
  ok('type filter', r.total === 50 && r.entries.every((e) => e.type === 'fix'));
  r = await call({ q: 'F13.JS' });
  ok('search is case-insensitive over files', r.total === 1 && r.entries[0].id === 'e13');
  r = await call({ status: 'live', liveCommit: 'ABC1234' });
  ok('status live = deployed claim naming the live commit', r.total === 1 && r.entries[0].id === 'e7');
  r = await call({ status: 'live' });
  ok('status live without a liveCommit matches nothing (not proven)', r.total === 0);
  r = await call({ status: 'committed', limit: 100 });
  ok('status committed = no claim', r.entries.every((e) => e.claim == null));
  D.releaseLog = () => null;
  ok('no bundled log -> unavailable (not an empty list)', (await rejects(() => call({}), 'unavailable')) === true);
  D.releaseLog = () => require(path.join(ROOT, 'functions', 'data', 'release-log.json'));
  r = await call({ limit: 100 });
  ok('the bundled functions/data/release-log.json pages (' + r.entryCount + ' entries)', r.entryCount > 700 && r.entries.length === 100 && r.nextCursor === 'o:100');

  head('9 · index.js exports BY NAME');
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  for (const n of ['adminReleaseLog', 'appInstallReport', 'scheduledAppInstallStats', 'adminGetAppInstallStats']) {
    ok('exports.' + n + ' = _appRelease.' + n, new RegExp('^exports\\.' + n + '\\s*=\\s*_appRelease\\.' + n + ';', 'm').test(idx));
    ok(n + ' is a deployable function object', M[n] && typeof M[n] === 'function' && !!M[n].__endpoint);
  }
  ok('the release log require is a static local path (closure gate can resolve it)', /require\('\.\/data\/release-log\.json'\)/.test(src));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(2); });
