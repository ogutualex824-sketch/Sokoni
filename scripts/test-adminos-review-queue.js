'use strict';
/* AdminOS review approval queue (functions/admin-os.js, live lineage 18cfe7f == adminosdispatch-00025-muh).
   adminGetReviews used to ignore `status` (listing every review) and filter a `flagged` boolean nobody writes.
     node scripts/test-adminos-review-queue.js        BASE=18cfe7f node scripts/test-adminos-review-queue.js (must FAIL) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths(); process.env.GCLOUD_PROJECT = 'demo-aos'; process.env.FUNCTIONS_EMULATOR = 'true';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const DOCS = new Map();
const DOCID = { __docId: true };
const q = (c, f, o, lim, after) => ({
  where: (a, op, v) => q(c, f.concat([[a, op, v]]), o, lim, after), orderBy: (k) => q(c, f, k, lim, after), limit: (n) => q(c, f, o, n, after),
  startAfter: (x) => q(c, f, o, lim, x), count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  get: async () => { let rows = [...DOCS.entries()].filter(([k]) => k.indexOf(c + '/') === 0).map(([k, v]) => ({ id: k.slice(c.length + 1), v }))
      .filter((r) => f.every(([a, op, val]) => op === '==' ? r.v[a] === val : true));
    if (o === DOCID) rows.sort((a, b) => a.id < b.id ? -1 : 1);
    if (after != null) rows = rows.filter((r) => r.id > after);
    rows = rows.slice(0, lim || 1e9);
    return { empty: !rows.length, size: rows.length, docs: rows.map((r) => ({ id: r.id, data: () => r.v })) }; } });
const fakeDb = { collection: (c) => Object.assign(q(c, [], null, 0, null), { doc: (id) => ({ get: async () => ({ exists: DOCS.has(c + '/' + id), data: () => DOCS.get(c + '/' + id) }) }) }) };
const fsPath = require.resolve('firebase-admin/firestore', { paths: [NM] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n },
  FieldPath: { documentId: () => DOCID }, Timestamp: { now: () => ({}), fromDate: (d) => d, fromMillis: (m) => m } } };
let dir = path.join(ROOT, 'functions');
if (process.env.BASE) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + dir.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' }); dir = path.join(dir, 'functions'); }
let AOS = null; try { AOS = require(path.join(dir, 'admin-os.js')); } catch (e) { console.log('  LOAD ERROR ' + e.message.split('\n')[0]); }
const TS = (ms) => ({ toDate: () => new Date(ms) });
for (let i = 0; i < 7; i++) DOCS.set('reviews/r' + i, { status: 'pending', rating: 4, createdAt: TS(1e12 + i), authorUid: 'u' + i, targetId: 'p1', targetType: 'product' });
DOCS.set('reviews/a1', { status: 'approved', createdAt: TS(2e12) });
DOCS.set('reviews/f1', { status: 'flagged', flags: 5, createdAt: TS(3e12) });
DOCS.set('reviewModerationLog/l2', { reviewId: 'r1', from: 'pending', to: 'approved', action: 'approve', actorUid: 'adm', at: TS(5) });
DOCS.set('reviewModerationLog/l1', { reviewId: 'r1', from: null, to: 'pending', action: 'submit', actorUid: 'u1', at: TS(1) });
const ADM = { auth: { uid: 'adm', token: { admin: true } } };
const call = async (fn, req) => { try { return { ok: true, r: await fn(req) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
(async () => {
  console.log('\nAdminOS review queue   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const H = AOS && AOS._h ? AOS._h : {};
  let r = await call(H.adminGetReviews, Object.assign({ data: {} }, ADM));
  ck('Q-1', r.ok && r.r.status === 'pending' && r.r.reviews.length === 7 && r.r.reviews.every((x) => x.status === 'pending'), 'the default queue is PENDING reviews only (not every status)', r.ok ? r.r.reviews.map((x) => x.status) : r);
  r = await call(H.adminGetReviews, Object.assign({ data: { status: 'pending', limit: 3 } }, ADM));
  const p1 = r.ok ? r.r : null;
  const r2 = p1 ? await call(H.adminGetReviews, Object.assign({ data: { status: 'pending', limit: 3, cursor: p1.nextCursor } }, ADM)) : { ok: false };
  const ids = (p1 ? p1.reviews.map((x) => x.id) : []).concat(r2.ok ? r2.r.reviews.map((x) => x.id) : []);
  ck('Q-2', p1 && p1.reviews.length === 3 && p1.nextCursor && r2.ok && r2.r.reviews.length === 3 && new Set(ids).size === 6, 'bounded pages with a cursor — no overlap, no unbounded read', { p1: p1 && p1.nextCursor, ids });
  r = await call(H.adminGetReviews, Object.assign({ data: { flagged: true } }, ADM));
  ck('Q-3', r.ok && r.r.reviews.length === 1 && r.r.reviews[0].id === 'f1', '"flagged" lists what flagReview actually writes (status flagged)', r.ok ? r.r.reviews : r);
  r = await call(H.adminGetReviews, Object.assign({ data: { status: 'DROP TABLE' } }, ADM));
  ck('Q-4', r.ok && r.r.status === 'pending', 'an unknown status falls back to pending (no arbitrary query field)', r.ok ? r.r.status : r);
  r = await call(H.adminGetReviews, { auth: { uid: 'u', token: {} }, data: {} });
  ck('Q-5', !r.ok, 'a non-admin cannot read the queue', r);
  r = await call(H.adminGetReviewHistory, Object.assign({ data: { reviewId: 'r1' } }, ADM));
  ck('H-1', r.ok && r.r.history.map((h) => h.action).join(',') === 'submit,approve', 'each review\'s moderation history is readable in order', r.ok ? r.r.history : r);
  r = await call(H.adminGetReviewHistory, { auth: { uid: 'u', token: {} }, data: { reviewId: 'r1' } });
  ck('H-2', !r.ok, 'history is admin-only', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
