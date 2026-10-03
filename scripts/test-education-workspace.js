/* test-education-workspace.js — EDUCATION E2: teacher / institution modules on the ONE business workspace authority,
 * chosen ONLY by the server-stamped providers/{uid}.education.type. Harness = test-business-workspace.js (REAL
 * business-workspace.js on the transactional fake Firestore).
 *   node scripts/test-education-workspace.js      (against d377b28's business-workspace.js it must FAIL) */
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

(async () => {
  say('\neducation workspace (E2 capability authority)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const edu = (type, extra) => Object.assign(biz('education'), type === undefined ? {} : { education: { type } }, extra || {});
  await seed('teach1', edu('teacher'));
  await seed('inst1', edu('institution'));
  await seed('legacyEdu', edu(undefined));
  await seed('forged', edu('admin'));
  await seed('teachPend', Object.assign({ status: 'pending' }, edu('teacher')));
  await seed('plumber', biz('trades'));
  const W = {};
  for (const u of ['teach1', 'inst1', 'legacyEdu', 'forged', 'teachPend', 'plumber', 'enterpriseBuyer']) W[u] = await BW.workspaceFor(db, u);
  const T = ['eduCourses', 'eduLessons', 'eduLearners', 'eduClasses'];
  const I = ['eduProgrammes', 'eduTeachers', 'eduStudents', 'eduTimetable', 'eduAssessments', 'eduCertificates'];
  const listed = (w, keys) => keys.every((k) => st(w, k) === S.NOT_IMPLEMENTED || st(w, k) === S.AVAILABLE);
  const absent = (w, keys) => keys.every((k) => st(w, k) === S.NOT_APPLICABLE);

  const UNBUILT = ['eduLessons', 'eduLearners', 'eduClasses'];
  ck('E-1 a TEACHER (server type) lands on provider-dashboard: Courses AVAILABLE (built, E2 courses slice); the other teacher modules NOT_IMPLEMENTED (EDUCATION_E2_PENDING) until their screens ship — never faked',
    W.teach1.route === 'provider-dashboard.html' && st(W.teach1, 'eduCourses') === S.AVAILABLE && UNBUILT.every((k) => st(W.teach1, k) === S.NOT_IMPLEMENTED && (W.teach1.modules[k] || {}).reason === 'EDUCATION_E2_PENDING'), W.teach1.modules && T.map((k) => st(W.teach1, k)));
  ck('E-2 a teacher NEVER receives institution modules (programmes / teachers / students / timetable / assessments / certificates)', absent(W.teach1, I), I.map((k) => st(W.teach1, k)));
  ck('E-3 an INSTITUTION gets the institution modules (+ courses / classes) and staff', listed(W.inst1, I) && listed(W.inst1, ['eduCourses', 'eduClasses']) && st(W.inst1, 'staff') !== S.NOT_APPLICABLE, I.map((k) => st(W.inst1, k)));
  ck('E-4 an institution does not get the teacher-only lessons / learners modules', absent(W.inst1, ['eduLessons', 'eduLearners']));
  ck('E-5 the answer NAMES the server type (no screen infers it)', W.teach1.educationType === 'teacher' && W.inst1.educationType === 'institution', [W.teach1.educationType, W.inst1.educationType]);
  ck('E-6 a legacy education approval with NO type stays on the legacy learning profile — no teacher or institution modules', absent(W.legacyEdu, T.concat(I)) && W.legacyEdu.educationType === null, W.legacyEdu.educationType);
  ck('E-7 a forged / unknown type ("admin") selects NOTHING extra — same as no type', absent(W.forged, T.concat(I)) && W.forged.educationType === null, W.forged.educationType);
  ck('E-8 a PENDING teacher gets no education modules (the approval gate runs first)', T.every((k) => st(W.teachPend, k) !== S.AVAILABLE && st(W.teachPend, k) !== S.NOT_IMPLEMENTED) && W.teachPend.state !== S.AVAILABLE, [W.teachPend.state, st(W.teachPend, 'eduCourses')]);
  ck('E-9 an enterprise BUYER (no provider record) gets NO provider workspace at all', W.enterpriseBuyer.found === false && W.enterpriseBuyer.route === null, [W.enterpriseBuyer.found, W.enterpriseBuyer.route]);
  ck('E-10 CONTROL: a plumber is unchanged (no education modules, no educationType key)', absent(W.plumber, T.concat(I)) && !('educationType' in W.plumber) && st(W.plumber, 'quotes') === S.AVAILABLE);
  ck('E-11 the banner says the education modules are being built (honest notice, keyed to the type)', /Courses, lessons, learners and classes are being built/.test(W.teach1.message || '') && /Programmes, courses, teachers/.test(W.inst1.message || ''), [W.teach1.message, W.inst1.message]);
  const gate = await codeOf(BW.assertModule(db, 'teach1', 'eduLessons', HE));
  ck('E-12 the server gate refuses a NOT_IMPLEMENTED education module (no operation can run behind an unbuilt screen)', gate !== null, gate);
  const gate2 = await codeOf(BW.assertModule(db, 'teach1', 'eduTimetable', HE));
  ck('E-13 the server gate refuses an institution module to a teacher', gate2 !== null, gate2);

  ck('E-14 the server gate OPENS Courses for an approved teacher and institution (the courses slice is built)', (await codeOf(BW.assertModule(db, 'teach1', 'eduCourses', HE))) === null && (await codeOf(BW.assertModule(db, 'inst1', 'eduCourses', HE))) === null);
  ck('E-15 … and keeps Courses CLOSED for a pending teacher, a legacy untyped education provider and a forged type', (await codeOf(BW.assertModule(db, 'teachPend', 'eduCourses', HE))) !== null && (await codeOf(BW.assertModule(db, 'legacyEdu', 'eduCourses', HE))) !== null && (await codeOf(BW.assertModule(db, 'forged', 'eduCourses', HE))) !== null);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
