/* test-education-lessons.js — EDUCATION E2 lessons / materials / progress / certificates. REAL education-lessons.js +
 * education.js updateCourseProgress + business-workspace on the transactional fake (harness: test-business-workspace.js). */
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

/* signed URLs: firebase-admin/storage replaced — records which paths were signed, so "minted only when entitled" is observable */
const SIGNED = [];
/* the stored objects: path → { contentType (client-declared), size, head (first bytes) } */
const OBJ = {};
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({ file: (p) => ({
  getMetadata: async () => [OBJ[p] ? { contentType: OBJ[p].contentType, size: String(OBJ[p].size) } : {}],
  download: async () => [OBJ[p] ? OBJ[p].head : Buffer.alloc(0)],
  getSignedUrl: async (o) => { SIGNED.push({ p, o }); return ['https://signed.example/' + encodeURIComponent(p) + '?exp=' + o.expires]; } }) }) }) });
const LS = require(Path.join(FN, 'education-lessons.js'));
const EDU = require(Path.join(FN, 'education.js'));
const call = async (uid, data, token) => { try { return await LS.courseLessons.run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const legacy = async (uid, data) => { try { return await EDU.updateCourseProgress.run({ auth: { uid, token: {} }, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const all = async (c) => { const q = await db.collection(c).get(); const o = {}; q.docs.forEach((d) => { o[d.id] = d.data(); }); return o; };
const OWNMAT = (u, c) => 'course-materials/' + u + '/' + c + '/notes.pdf';
(async () => {
  say('\nEducation lessons — ownership, entitlement, real progress, one certificate\n');
  const edu = (type) => Object.assign(biz('education'), { education: { type } });
  await seed('teach1', edu('teacher')); await seed('teach2', edu('teacher'));
  await db.doc('courses/c1').set({ instructorUid: 'teach1', status: 'draft', title: 'Algebra', lessonCount: 1 });
  await db.doc('courses/c2').set({ instructorUid: 'teach2', status: 'draft', title: 'Other' });
  await db.doc('courses/legacy').set({ instructorUid: 'teach1', status: 'published', title: 'Legacy', lessonCount: 2 });

  let r = await call('teach2', { op: 'save', courseId: 'c1', lesson: { title: 'Hijack', kind: 'text', body: 'x' } });
  ck('A-1 another teacher cannot add a lesson to this course', r.reason === 'NOT_COURSE_OWNER' && !Object.keys(await all('courseLessons')).length, r);
  r = await call('stranger', { op: 'save', courseId: 'c1', lesson: { title: 'x', kind: 'text' } });
  ck('A-2 a non-educator cannot author lessons', r.reason === 'NOT_AN_APPROVED_EDUCATOR', r);
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Intro', kind: 'text', body: 'Welcome', freePreview: true, ownerUid: 'teach2', courseId: 'c2' } });
  const L1 = r.lessonId;
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Video', kind: 'video', videoUrl: 'https://www.youtube.com/watch?v=abc' } });
  const L2 = r.lessonId;
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Notes', kind: 'file', materialPath: OWNMAT('teach1', 'c1') } });
  const L3 = r.lessonId;
  const LL = await all('courseLessons');
  ck('A-3 the owner adds text / video / file lessons to their DRAFT course; courseId / owner come from the server', !!(L1 && L2 && L3) && LL[L1].courseId === 'c1' && LL[L1].ownerUid === 'teach1', LL[L1]);
  ck('A-4 the server keeps lessonCount = real lessons', (await all('courses')).c1.lessonCount === 3);
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Bad', kind: 'video', videoUrl: 'https://evil.example/v.mp4' } });
  ck('A-5 video links must be https YouTube / Vimeo', r.reason === 'VIDEO_HOST_NOT_ALLOWED', r);
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Bad', kind: 'file', materialPath: OWNMAT('teach2', 'c2') } });
  ck('A-6 a material from ANOTHER account\'s folder is refused', r.reason === 'MATERIAL_NOT_OWN', r);
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Bad', kind: 'file', materialPath: 'https://firebasestorage.googleapis.com/v0/b/x/o/' + encodeURIComponent(OWNMAT('teach1', 'c1')) + '?alt=media&token=abc' } });
  ck('A-6b a DOWNLOAD URL is refused (a token URL opens the file for anyone, whatever storage.rules say)', r.reason === 'MATERIAL_NOT_OWN', r);
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Bad', kind: 'file', materialPath: 'course-materials/teach1/c1/../../teach2/c2/x.pdf' } });
  ck('A-6c path traversal is refused', r.reason === 'MATERIAL_NOT_OWN', r);
  r = await call('teach1', { op: 'reorder', courseId: 'c1', order: [L3, L1] });
  ck('A-7 a reorder must list every lesson exactly once', r.reason === 'ORDER_INVALID', r);
  r = await call('teach1', { op: 'reorder', courseId: 'c1', order: [L3, L1, L2] });
  ck('A-8 a valid reorder applies', r.ok === true && (await all('courseLessons'))[L3].order === 1, r);

  /* publish, then learner access */
  await db.doc('courses/c1').set({ status: 'published' }, { merge: true });
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Late', kind: 'text' } });
  ck('A-9 lessons of a PUBLISHED course cannot be changed (unpublish / review first)', r.reason === 'NOT_A_DRAFT', r);
  r = await call('learner1', { op: 'outline', courseId: 'c1' });
  ck('L-1 anyone sees a published course\'s outline (titles / kinds / preview flags only)', r.ok && r.lessons.length === 3 && !JSON.stringify(r).includes('Welcome') && !JSON.stringify(r).includes('youtube'), r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('L-2 a NOT-enrolled learner cannot open a paid / gated lesson', r.reason === 'NOT_ENROLLED', r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L1 });
  ck('L-3 … but can open a free-preview lesson', r.ok && r.lesson.body === 'Welcome', r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: (await (async () => { await db.doc('courseLessons/foreign').set({ courseId: 'c2', title: 'F', kind: 'text', freePreview: true }); return 'foreign'; })()) });
  ck('L-4 a lesson of ANOTHER course cannot be fetched through this course', r.reason === 'LESSON_UNKNOWN', r);
  await db.doc('courseEnrollments/learner1_c1').set({ uid: 'learner1', courseId: 'c1', progress: 0 });
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('L-5 an ENROLLED learner opens the lesson', r.ok && /youtube/.test(r.lesson.videoUrl), r);
  ck('L-6 no signed URL was minted for anyone NOT entitled (L-2 refused before signing)', SIGNED.length === 0, SIGNED);
  OBJ[OWNMAT('teach1', 'c1')] = { contentType: 'application/pdf', size: 1000, head: Buffer.from('%PDF-1.7\n%xxxxxx') };
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L3 });
  const stored = (await all('courseLessons'))[L3];
  ck('L-7 the material reaches an entitled learner as a SHORT-LIVED signed URL (15 min, read-only); the lesson stores only the path',
    r.ok && /^https:\/\/signed\.example\//.test(r.lesson.materialUrl) && r.lesson.materialExpiresInMinutes === 15 && SIGNED.length === 1 && SIGNED[0].o.action === 'read'
      && SIGNED[0].o.expires - Date.now() <= 15 * 60 * 1000 && stored.materialPath === OWNMAT('teach1', 'c1') && !('materialUrl' in stored), [r, SIGNED, stored]);

  /* the object's bytes must match its declared type (contentType is client-declared) */
  OBJ[OWNMAT('teach1', 'c1')] = { contentType: 'application/pdf', size: 1000, head: Buffer.from('<html><script>x') };
  SIGNED.length = 0;
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L3 });
  ck('M-1 a file DECLARED pdf whose bytes are not a PDF gets NO signed URL', r.reason === 'MATERIAL_UNVERIFIED' && SIGNED.length === 0, r);
  OBJ[OWNMAT('teach1', 'c1')] = { contentType: 'text/html', size: 100, head: Buffer.from('<html>') };
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L3 });
  ck('M-2 a disallowed type (text/html) is never served', r.reason === 'MATERIAL_UNVERIFIED' && SIGNED.length === 0, r);
  OBJ[OWNMAT('teach1', 'c1')] = { contentType: 'application/pdf', size: 30 * 1024 * 1024, head: Buffer.from('%PDF-1.7') };
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L3 });
  ck('M-3 an oversized object (> 25 MB) is never served', r.reason === 'MATERIAL_UNVERIFIED' && SIGNED.length === 0, r);
  delete OBJ[OWNMAT('teach1', 'c1')];
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L3 });
  ck('M-4 a missing object is never signed', r.reason === 'MATERIAL_UNVERIFIED' && SIGNED.length === 0, r);
  const V = LS._internal.MATERIAL_TYPES;
  ck('M-5 the signatures: PNG / JPEG / WEBP / OOXML(zip) accepted, a mislabelled one refused',
    V['image/png'](Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && V['image/jpeg'](Buffer.from([0xff, 0xd8, 0xff, 0xe0])) && V['image/webp'](Buffer.from('RIFF\0\0\0\0WEBP'))
      && V['application/vnd.openxmlformats-officedocument.wordprocessingml.document'](Buffer.from([0x50, 0x4b, 0x03, 0x04])) && !V['image/png'](Buffer.from('%PDF-')) && !V['text/plain'](Buffer.from([0x41, 0x00])));

  /* progress + certificate */
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: 'lesson_999' });
  ck('G-1 a made-up lesson id cannot add progress (live: ANY id counted)', r.reason === 'LESSON_NOT_IN_COURSE', r);
  r = await legacy('learner1', { courseId: 'c1', lessonId: 'fake' });
  ck('G-2 the legacy updateCourseProgress applies the SAME rule', r.reason === 'LESSON_NOT_IN_COURSE', r);
  r = await call('learner2', { op: 'complete', courseId: 'c1', lessonId: L1 });
  ck('G-3 a non-enrolled learner records no progress', r.reason === 'NOT_ENROLLED', r);
  await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L1 });
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L1 });
  ck('G-4 completing the same lesson twice counts once (33 %)', r.progress === 33, r);
  await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L2 });
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L3 });
  const certs = await all('learnerCertificates');
  ck('G-5 completing every REAL lesson → 100 % and exactly ONE certificate (self-paced completion, server serial)', r.progress === 100 && !!r.certificateId && Object.keys(certs).length === 1 && certs.learner1_c1.kind === 'self_paced_completion' && /^SOK-EDU-[0-9A-F]{10}$/.test(certs.learner1_c1.serial), [r, certs]);
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L3 });
  ck('G-6 a replayed completion issues no second certificate', Object.keys(await all('learnerCertificates')).length === 1 && r.certificateId === 'learner1_c1', r);
  r = await call('learner1', { op: 'myCertificates' });
  ck('G-7 the learner lists their certificates', r.certificates.length === 1 && r.certificates[0].courseTitle === 'Algebra', r);
  r = await call('learner2', { op: 'myCertificates' });
  ck('G-8 … and nobody else sees them', r.certificates.length === 0, r);
  /* legacy course with no real lessons keeps working with the synthetic ids only */
  await db.doc('courseEnrollments/learner1_legacy').set({ uid: 'learner1', courseId: 'legacy', progress: 0 });
  r = await legacy('learner1', { courseId: 'legacy', lessonId: 'lesson_1' });
  const r2 = await legacy('learner1', { courseId: 'legacy', lessonId: 'lesson_3' });
  ck('G-9 a legacy course (no real lessons) accepts only lesson_1…lesson_{lessonCount}', r.progress === 50 && r2.reason === 'LESSON_NOT_IN_COURSE', [r, r2]);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
