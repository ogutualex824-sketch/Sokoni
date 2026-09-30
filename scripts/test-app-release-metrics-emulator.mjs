/* ══════════════════════════════════════════════════════════════════════════════
   App release metrics vs REAL FIRESTORE (emulator) — WRITTEN, NOT YET RUN
   ──────────────────────────────────────────────────────────────────────────────
     npx firebase emulators:exec --only firestore \
       "node scripts/test-app-release-metrics-emulator.mjs"

   The node suite (scripts/test-app-release-metrics.js) proves the logic against a
   fake Firestore. This proves what a fake cannot:
     1  create() on first sight really fails ALREADY_EXISTS under a concurrent
        first report — both callers succeed, ONE document, no overwrite
     2  the day key holds on the real transaction (one write per install per day)
     3  count() aggregation on the real engine, single-field only — the emulator
        does not enforce composite indexes, so this does NOT prove index-freedom;
        the node suite asserts every query is single-field
     4  default-deny: a CLIENT (any role, incl. an admin token) can neither read
        nor write appInstalls / appInstallMetrics under the repo firestore.rules
     5  adminGetAppInstallStats: absent -> not-computed-yet; present -> figures

   FAILS CLOSED: refuses to run unless FIRESTORE_EMULATOR_HOST points at localhost,
   so it can never write to production.
   ══════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) {
  console.log('\n  ENV — FIRESTORE_EMULATOR_HOST is unset or not local ("' + host + '"). Run through:');
  console.log('    npx firebase emulators:exec --only firestore "node scripts/test-app-release-metrics-emulator.mjs"\n');
  process.exit(2);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';

const fnRequire = createRequire(path.join(ROOT, 'functions', 'package.json'));
const admin = fnRequire('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const M = fnRequire('./app-release-metrics.js');
const I = M._internal;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);
async function wipe(col) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }

const UUID = '7d9e2a10-4b3c-4d5e-9f60-718293a4b5c6';
const CV = 'sokoni-20261001120000-v648';
const LIVE = 'sokoni-20261002120000-v649';
const rq = (data) => ({ data, rawRequest: { headers: { 'x-forwarded-for': '127.0.0.9' } } });
const ADMIN = { auth: { uid: 'a1', token: { admin: true } } };
I._deps.rateLimit = async () => ({ allowed: true });   /* Redis is not part of this proof */

await wipe(I.INSTALLS); await wipe(I.METRICS_COLL);

head('1 · concurrent first sight -> ONE document');
let t = Date.parse('2026-10-01T08:00:00Z');
I._deps.now = () => t;
const body = { installId: UUID, event: 'checkin', cacheVersion: CV, standalone: true, platform: 'android' };
const both = await Promise.all([M._h.appInstallReport(rq(body)), M._h.appInstallReport(rq(Object.assign({}, body, { event: 'install' })))]);
ck('both concurrent calls return ok', both.every((r) => r.ok === true), JSON.stringify(both));
const d1 = (await db.collection(I.INSTALLS).doc(UUID).get()).data();
ck('one document, installed after both land', d1 && d1.installed === true && !!d1.installedAt && d1.firstCacheVersion === CV);
ck('no uid / ip / user agent stored', !Object.keys(d1).some((k) => /uid|ip|agent/i.test(k)), Object.keys(d1).join(','));

head('2 · day key on a real transaction');
const before = d1.lastSeenAt.toMillis();
let r = await M._h.appInstallReport(rq(Object.assign({}, body, { cacheVersion: LIVE })));
ck('same-day check-in deduped', r.action === 'deduped');
ck('cacheVersion unchanged the same day', (await db.collection(I.INSTALLS).doc(UUID).get()).get('cacheVersion') === CV);
t = Date.parse('2026-10-02T08:00:00Z');
r = await M._h.appInstallReport(rq(Object.assign({}, body, { cacheVersion: LIVE })));
const d2 = (await db.collection(I.INSTALLS).doc(UUID).get()).data();
ck('next-day check-in updates the build and lastSeenAt', r.action === 'updated' && d2.cacheVersion === LIVE && d2.lastSeenAt.toMillis() >= before && d2.lastSeenDay === '2026-10-02');

head('3 · count() aggregate on the real engine');
const now = Date.now();
const TS = admin.firestore.Timestamp;
const put = (id, o) => db.collection(I.INSTALLS).doc(id).set(Object.assign({ firstSeenAt: TS.fromMillis(now - 40 * 864e5), lastSeenAt: TS.fromMillis(now - 864e5), installed: false, standalone: false, cacheVersion: CV }, o));
await wipe(I.INSTALLS);
await Promise.all([
  put('a', { installed: true, standalone: true, cacheVersion: LIVE }),
  put('b', { lastSeenAt: TS.fromMillis(now - 10 * 864e5) }),
  put('c', { lastSeenAt: TS.fromMillis(now - 45 * 864e5), firstSeenAt: TS.fromMillis(now - 50 * 864e5) }),
]);
I._deps.now = () => now;
I._deps.fetch = async () => ({ ok: true, json: async () => ({ cacheVersion: LIVE }) });
await I.runScheduledStats();
const agg = (await db.collection(I.METRICS_COLL).doc(I.METRICS_DOC).get()).data();
ck('devices 3 · installs 1 · standalone 1', agg.devices === 3 && agg.total === 1 && agg.standalone === 1, JSON.stringify(agg));
ck('active7 1 · active30 2', agg.active7 === 1 && agg.active30 === 2);
ck('onLive 1 · behind 2 · liveCacheVersion recorded', agg.onLive === 1 && agg.behind === 2 && agg.liveCacheVersion === LIVE);
ck('since = earliest firstSeenAt', agg.since.toMillis() === now - 50 * 864e5);

head('4 · client default-deny (repo firestore.rules)');
let rut = null;
try { rut = createRequire(path.join(ROOT, 'package.json'))('@firebase/rules-unit-testing'); } catch (_) {}
if (!rut) {
  ck('rules-unit-testing available (BLOCKED, not PASS)', false, 'install @firebase/rules-unit-testing');
} else {
  const [h, p] = host.replace(/^\[|\]/g, '').split(/:(?=\d+$)/);
  const env = await rut.initializeTestEnvironment({ projectId: 'sokoni-rules-' + Date.now(), firestore: { host: h, port: Number(p), rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8') } });
  const who = { anon: env.unauthenticatedContext(), user: env.authenticatedContext('u1', {}), admin: env.authenticatedContext('adm', { admin: true }), superAdmin: env.authenticatedContext('sa', { superAdmin: true }) };
  for (const [name, ctx] of Object.entries(who)) {
    const c = ctx.firestore();
    ck(name + ': read appInstalls denied', !!(await rut.assertFails(c.collection('appInstalls').doc(UUID).get()).catch(() => null)));
    ck(name + ': write appInstalls denied', !!(await rut.assertFails(c.collection('appInstalls').doc(UUID).set({ installed: true })).catch(() => null)));
    ck(name + ': read appInstallMetrics denied', !!(await rut.assertFails(c.collection('appInstallMetrics').doc('summary').get()).catch(() => null)));
    ck(name + ': write appInstallMetrics denied', !!(await rut.assertFails(c.collection('appInstallMetrics').doc('summary').set({ total: 1e6 })).catch(() => null)));
  }
  await env.cleanup();
}

head('5 · adminGetAppInstallStats');
r = await M._h.adminGetAppInstallStats(Object.assign({ data: {} }, ADMIN));
ck('present -> computed with figures', r.state === 'computed' && r.devices === 3 && typeof r.computedAt === 'string');
await wipe(I.METRICS_COLL);
r = await M._h.adminGetAppInstallStats(Object.assign({ data: {} }, ADMIN));
ck('absent -> not-computed-yet', r.state === 'not-computed-yet');

await wipe(I.INSTALLS);
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
