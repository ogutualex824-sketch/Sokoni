/* test-education-courses.js — EDUCATION E2 courses: only an APPROVED teacher / institution (the ONE business workspace
 * authority) creates, edits and submits its OWN courses; admins review submitted courses only; every transition audited.
 * REAL functions/education.js + business-workspace.js on the transactional fake (harness: test-business-workspace.js). */
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

const EDU = require(Path.join(FN, 'education.js'));
const call = async (fn, uid, data, token) => { try { return await EDU[fn].run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const ADMIN = { admin: true };
const C = async () => { const q = await db.collection('courses').get(); const o = {}; q.docs.forEach((d) => { o[d.id] = d.data(); }); return o; };
const good = (o) => Object.assign({ title: 'Algebra basics', description: 'A friendly introduction to algebra for form one learners.', category: 'technology', level: 'beginner', price: 0, lessonCount: 4 }, o || {});
(async () => {
  say('\nEducation courses — ownership + review lifecycle\n');
  const edu = (type, extra) => Object.assign(biz('education'), type === undefined ? {} : { education: { type } }, extra || {});
  await seed('teach1', edu('teacher')); await seed('teach2', edu('teacher')); await seed('inst1', edu('institution'));
  await seed('teachPend', Object.assign({ status: 'pending' }, edu('teacher'))); await seed('forged', edu('admin')); await seed('plumber', biz('trades'));
  await db.doc('educationEnterprises/acme').set({ status: 'active', approved: true });

  let r = await call('createCourse', 'stranger', good());
  ck('C-1 a plain account cannot create a course (was: ANY signed-in user)', r.reason === 'NOT_AN_APPROVED_EDUCATOR' && !Object.keys(await C()).length, r);
  for (const u of ['teachPend', 'forged', 'plumber', 'acme']) {
    r = await call('createCourse', u, good());
    ck('C-2 ' + u + ' cannot create a course (pending / forged type / non-education provider / enterprise buyer)', r.reason === 'NOT_AN_APPROVED_EDUCATOR', r);
  }
  ck('C-2b nothing was written by any refusal', !Object.keys(await C()).length);
  r = await call('createCourse', 'teach1', good({ instructorUid: 'teach2', status: 'published', isFeatured: true, rating: 5, ownerType: 'institution' }));
  const c1 = (await C())[r.courseId] || {};
  ck('C-3 an APPROVED teacher creates a course: owner = the caller, ownerType from the server, status draft — client-sent owner / status / featured / rating / type ignored',
    !!r.courseId && c1.instructorUid === 'teach1' && c1.ownerType === 'teacher' && c1.status === 'draft' && c1.isFeatured === false && c1.rating === 0, c1);
  const cid = r.courseId;
  r = await call('createCourse', 'inst1', good({ title: 'Programme intro' }));
  ck('C-4 an approved institution creates a course typed institution', ((await C())[r.courseId] || {}).ownerType === 'institution', r);
  r = await call('createCourse', 'teach1', good({ videoUrl: 'http://example.com/v' }));
  ck('C-5 media URLs must be https', r.err === 'invalid-argument', r);

  r = await call('manageMyCourses', 'teach2', { op: 'update', courseId: cid, course: good({ title: 'Hijacked title' }) });
  ck('C-6 another teacher cannot edit this teacher\'s course', r.reason === 'NOT_COURSE_OWNER' && (await C())[cid].title === 'Algebra basics', r);
  r = await call('manageMyCourses', 'teach1', { op: 'update', courseId: cid, course: good({ title: 'Algebra basics II', status: 'published', instructorUid: 'x' }) });
  const c2 = (await C())[cid];
  ck('C-7 the owner edits their draft; status and owner cannot be changed through an edit', r.success === true && c2.title === 'Algebra basics II' && c2.status === 'draft' && c2.instructorUid === 'teach1', c2);
  r = await call('manageMyCourses', 'teach2', { op: 'list' });
  ck('C-8 list returns ONLY the caller\'s own courses', Array.isArray(r.courses) && r.courses.length === 0, r);
  r = await call('manageMyCourses', 'teach1', { op: 'list' });
  ck('C-8b … the owner sees theirs (any status)', Array.isArray(r.courses) && r.courses.length === 1 && r.courses[0].courseId === cid, r);

  r = await call('publishCourse', 'teach1', { courseId: cid, action: 'publish' });
  ck('C-9 a teacher cannot publish (admin only)', r.reason === 'ADMIN_REQUIRED' && (await C())[cid].status === 'draft', r);
  r = await call('publishCourse', 'admin1', { courseId: cid, action: 'publish' }, ADMIN);
  ck('C-10 an admin cannot publish a course that was never submitted (was: publish from ANY state)', r.reason === 'WRONG_STATUS' && (await C())[cid].status === 'draft', r);
  r = await call('publishCourse', 'teach2', { courseId: cid, action: 'submit' });
  ck('C-11 a non-owner cannot submit someone else\'s course', r.reason === 'NOT_COURSE_OWNER', r);
  r = await call('publishCourse', 'teach1', { courseId: cid, action: 'submit' });
  ck('C-12 the owner submits → pending_review', r.status === 'pending_review' && (await C())[cid].status === 'pending_review', r);
  r = await call('manageMyCourses', 'teach1', { op: 'update', courseId: cid, course: good({ title: 'Changed while in review' }) });
  ck('C-13 a course under review cannot be edited', r.reason === 'NOT_A_DRAFT', r);
  r = await call('publishCourse', 'admin1', { courseId: cid, action: 'reject', note: 'Add <b>lesson</b> outlines' }, ADMIN);
  const c3 = (await C())[cid];
  ck('C-14 an admin rejects with a note → back to draft (note sanitised)', r.status === 'draft' && c3.status === 'draft' && !/<b>/.test(c3.reviewNote || '') && /lesson/.test(c3.reviewNote || ''), c3.reviewNote);
  await call('publishCourse', 'teach1', { courseId: cid, action: 'submit' });
  r = await call('publishCourse', 'admin1', { courseId: cid, action: 'publish' }, ADMIN);
  ck('C-15 resubmitted + admin publish → published', r.status === 'published' && (await C())[cid].status === 'published', r);
  const audit = (await db.collection('educationAudit').get()).docs.map((d) => d.data().action);
  ck('C-16 every transition is audited', ['course_submit', 'course_reject', 'course_publish'].every((a) => audit.includes(a)), audit);
  r = await call('publishCourse', 'admin1', { courseId: cid, action: 'unpublish' }, ADMIN);
  ck('C-17 an admin unpublishes → draft', r.status === 'draft');

  /* the owner loses approval between submit and publish */
  await call('publishCourse', 'teach1', { courseId: cid, action: 'submit' });
  await db.doc('providers/teach1').set({ status: 'suspended' }, { merge: true });
  r = await call('publishCourse', 'admin1', { courseId: cid, action: 'publish' }, ADMIN);
  ck('C-18 a course is NOT published once its owner is no longer an approved educator', r.reason === 'OWNER_NOT_ELIGIBLE' && (await C())[cid].status === 'pending_review', r);
  r = await call('manageMyCourses', 'teach1', { op: 'list' });
  ck('C-19 a suspended educator loses the course workspace', r.reason === 'NOT_AN_APPROVED_EDUCATOR', r);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
