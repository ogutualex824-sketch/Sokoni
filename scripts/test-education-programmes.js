/* test-education-programmes.js — EDUCATION E2: institution programmes (approved institution only; own courses only;
 * active needs a published course). REAL education-programmes.js + business-workspace on the transactional fake. */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-business-workspace';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub); AF.autoApproveOnWrite(db); /* shell gate: approvedAt fixtures carry their admin decision */
const PLANS = {};
stub('./subscription-core', { resolveSubscription: async (uid) => (PLANS[uid] ? Object.assign({ found: true }, PLANS[uid]) : { found: false }) });

const BW = require(Path.join(FN, 'business-workspace.js'));
const BC = require(Path.join(FN, 'business-category.js'));
const S = BW.STATE;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const HE = class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } };
const seed = (uid, doc) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active', approvedAt: 1 /* the producer (projectProvider) always stamps approvedAt; a status alone is client-writable */ }, doc));
const biz = (category) => ({ business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const st = (w, m) => (w.modules[m] || {}).state;

const PR = require(Path.join(FN, 'education-programmes.js'));
const call = async (uid, data) => { try { return await PR.manageMyProgrammes.run({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const all = async (c) => { const q = await db.collection(c).get(); const o = {}; q.docs.forEach((d) => { o[d.id] = d.data(); }); return o; };
(async () => {
  say('\nEducation programmes — institution only, own courses only\n');
  const edu = (type, extra) => Object.assign(biz('education'), type === undefined ? {} : { education: { type } }, extra || {});
  await seed('inst1', edu('institution')); await seed('inst2', edu('institution')); await seed('teach1', edu('teacher'));
  await seed('instPend', Object.assign({ status: 'pending' }, edu('institution')));
  await db.doc('courses/c1').set({ instructorUid: 'inst1', status: 'published', title: 'A' });
  await db.doc('courses/c2').set({ instructorUid: 'inst1', status: 'draft', title: 'B' });
  await db.doc('courses/x9').set({ instructorUid: 'inst2', status: 'published', title: 'Other' });
  const P = (o) => Object.assign({ title: 'Diploma in ICT', level: 'diploma', durationWeeks: 52, courseIds: ['c1', 'c2'] }, o || {});

  for (const u of ['teach1', 'instPend', 'stranger']) {
    const r = await call(u, { op: 'create', programme: P() });
    ck('P-1 ' + u + ' cannot manage programmes (teacher / pending institution / plain account)', r.reason === 'NOT_AN_APPROVED_INSTITUTION', r);
  }
  ck('P-1b nothing was written by any refusal', !Object.keys(await all('programmes')).length);
  let r = await call('inst1', { op: 'create', programme: P({ ownerUid: 'inst2', status: 'active' }) });
  const p1 = (await all('programmes'))[r.programmeId] || {};
  ck('P-2 an approved institution creates a programme: owner = the caller, status draft (client owner / status ignored)', !!r.programmeId && p1.ownerUid === 'inst1' && p1.status === 'draft' && p1.courseIds.join() === 'c1,c2', p1);
  const pid = r.programmeId;
  r = await call('inst1', { op: 'create', programme: P({ courseIds: ['c1', 'x9'] }) });
  ck('P-3 a programme cannot include ANOTHER institution\'s course', r.reason === 'COURSE_NOT_OWN', r);
  r = await call('inst1', { op: 'create', programme: P({ courseIds: ['nope'] }) });
  ck('P-4 … or a course that does not exist', r.reason === 'COURSE_NOT_OWN', r);
  r = await call('inst2', { op: 'update', programmeId: pid, programme: P({ title: 'Hijack' }) });
  ck('P-5 another institution cannot edit this programme', r.reason === 'PROGRAMME_UNKNOWN' && (await all('programmes'))[pid].title === 'Diploma in ICT', r);
  r = await call('inst2', { op: 'setStatus', programmeId: pid, status: 'active' });
  ck('P-6 … or activate it', r.reason === 'PROGRAMME_UNKNOWN' && (await all('programmes'))[pid].status === 'draft', r);
  r = await call('inst1', { op: 'create', programme: P({ courseIds: ['c2'] }) });
  const onlyDraft = r.programmeId;
  r = await call('inst1', { op: 'setStatus', programmeId: onlyDraft, status: 'active' });
  ck('P-7 a programme with NO published course cannot be activated (a programme never shows an unreviewed course)', r.reason === 'NEEDS_PUBLISHED_COURSE', r);
  r = await call('inst1', { op: 'setStatus', programmeId: pid, status: 'active' });
  ck('P-8 with a published own course it activates', r.status === 'active' && (await all('programmes'))[pid].status === 'active', r);
  r = await call('inst1', { op: 'update', programmeId: pid, programme: P({ courseIds: ['c2'] }) });
  ck('P-9 an ACTIVE programme cannot be edited down to no published course', r.reason === 'NEEDS_PUBLISHED_COURSE' && (await all('programmes'))[pid].courseIds.join() === 'c1,c2', r);
  r = await call('inst2', { op: 'list' });
  ck('P-10 list returns ONLY the caller\'s programmes', r.programmes.length === 0, r);
  r = await call('inst1', { op: 'list' });
  ck('P-10b … the owner sees theirs', r.programmes.length === 2, r);
  r = await call('inst1', { op: 'create', programme: P({ level: 'phd-from-a-browser' }) });
  ck('P-11 an unknown level is refused', r.reason === 'LEVEL_INVALID', r);
  const audit = Object.values(await all('educationAudit')).map((x) => x.action);
  ck('P-12 programme changes are audited', ['programme_create', 'programme_active'].every((a) => audit.includes(a)), audit);
  ck('P-13 programmes are never indexed for search directly', (await all('programmes'))[pid]._noIndex === true);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
