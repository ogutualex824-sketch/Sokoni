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
/* the ONE notify entry point, recorded (Messages → Notifications) */
const NOTES = [];
stub('./notify', { notify: async (n) => { NOTES.push(n); return { ok: true }; } });
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
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Intro', kind: 'text', body: 'Welcome', freePreview: true, status: 'published', description: 'Start here', durationMinutes: 10, ownerUid: 'teach2', courseId: 'c2' } });
  const L1 = r.lessonId;
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Video', kind: 'video', status: 'published', videoUrl: 'https://www.youtube.com/watch?v=abc' } });
  const L2 = r.lessonId;
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Notes', kind: 'file', status: 'published', materialPath: OWNMAT('teach1', 'c1') } });
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
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Draft extra', kind: 'text', body: 'hidden' } });
  const LD = r.lessonId;
  r = await call('teach1', { op: 'save', courseId: 'c1', lessonId: L1, lesson: { title: 'Intro v2', kind: 'text', body: 'Welcome', freePreview: true, status: 'published', description: 'Start here', durationMinutes: 10 } });
  const hist = Object.values(await all('courseLessonHistory')).filter((h) => h.lessonId === L1).map((h) => h.version).sort();
  ck('V-1 every save bumps the lesson version and appends an immutable history row', (await all('courseLessons'))[L1].version === 2 && hist.join() === '1,2', hist);
  r = await call('teach1', { op: 'remove', courseId: 'c1', lessonId: LD });
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Draft extra', kind: 'text', body: 'hidden' } });
  const LDRAFT = r.lessonId;
  ck('A-4b a lesson saved WITHOUT a status is a DRAFT (never published by default)', (await all('courseLessons'))[LDRAFT].status === 'draft');
  r = await call('teach1', { op: 'reorder', courseId: 'c1', order: [L3, L1] });
  ck('A-7 a reorder must list every lesson exactly once', r.reason === 'ORDER_INVALID', r);
  r = await call('teach1', { op: 'reorder', courseId: 'c1', order: [L3, L1, L2, LDRAFT] });
  ck('A-8 a valid reorder applies', r.ok === true && (await all('courseLessons'))[L3].order === 1, r);

  /* publish, then learner access */
  await db.doc('courses/c1').set({ status: 'published' }, { merge: true });
  r = await call('teach1', { op: 'save', courseId: 'c1', lesson: { title: 'Late', kind: 'text', status: 'published' } });
  const LLATE = r.lessonId;
  ck('A-9 OWNER RULE: a lesson added to a PUBLISHED course is saved as a DRAFT staged for review (publish is not immediate)',
    r.ok && r.reviewRequired === true && (await all('courseLessons'))[LLATE].status === 'draft' && (await all('courseLessons'))[LLATE].stagedForReview === true, [r, (await all('courseLessons'))[LLATE]]);
  r = await call('learner1', { op: 'outline', courseId: 'c1' });
  ck('L-1 anyone sees a published course\'s outline (titles / kinds / preview flags / description / duration) — PUBLISHED lessons only, never bodies or links',
    r.ok && r.lessons.length === 3 && !r.lessons.some((x) => x.lessonId === LDRAFT) && !JSON.stringify(r).includes('Welcome') && !JSON.stringify(r).includes('youtube') && r.lessons.some((x) => x.durationMinutes === 10), r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: LDRAFT });
  ck('L-1b a DRAFT lesson inside a published course cannot be opened by a learner', r.reason === 'LESSON_UNKNOWN', r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('L-2 a NOT-enrolled learner cannot open a paid / gated lesson', r.reason === 'NOT_ENROLLED', r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L1 });
  ck('L-3 … but can open a free-preview lesson', r.ok && r.lesson.body === 'Welcome', r);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: (await (async () => { await db.doc('courseLessons/foreign').set({ courseId: 'c2', title: 'F', kind: 'text', freePreview: true }); return 'foreign'; })()) });
  ck('L-4 a lesson of ANOTHER course cannot be fetched through this course', r.reason === 'LESSON_UNKNOWN', r);
  await db.doc('courseEnrollments/learner1_c1').set({ uid: 'learner1', courseId: 'c1', progress: 0 });
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('L-5 an ENROLLED learner opens the lesson', r.ok && /youtube/.test(r.lesson.videoUrl), r);
  const st = ((await all('courseProgress')).learner1_c1 || {}).lessonStates || {};
  ck('P-1 opening a lesson marks it IN PROGRESS on the server (started timestamp), not completed', st[L2] && st[L2].state === 'in_progress' && st[L2].startedAtMs > 0 && st[L2].completedAtMs === null, st);
  await call('learner1', { op: 'content', courseId: 'c1', lessonId: L1 });
  const st2 = ((await all('courseProgress')).learner1_c1 || {}).lessonStates || {};
  ck('P-1b a second lesson opened (progress record already exists) is also IN PROGRESS — opening never completes', st2[L1] && st2[L1].state === 'in_progress' && st2[L1].completedAtMs === null && (((await all('courseProgress')).learner1_c1 || {}).completedLessons || []).length === 0, st2);
  for (const [status, extra, id] of [['cancelled', {}, 'P-2'], ['refunded', {}, 'P-3'], ['active', { expiresAtMs: Date.now() - 1 }, 'P-4']]) {
    await db.doc('courseEnrollments/learner9_c1').set(Object.assign({ uid: 'learner9', courseId: 'c1', status }, extra));
    const rr = await call('learner9', { op: 'content', courseId: 'c1', lessonId: L2 });
    const rc = await call('learner9', { op: 'complete', courseId: 'c1', lessonId: L2 });
    ck(id + ' a ' + (extra.expiresAtMs ? 'EXPIRED' : status.toUpperCase()) + ' enrolment opens nothing and records no progress', rr.reason === 'NOT_ENROLLED' && rc.reason === 'NOT_ENROLLED', [rr, rc]);
  }
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
  ck('G-5 completing every PUBLISHED lesson → 100 % and exactly ONE certificate (self-paced completion, server serial, issued, issuer + provider)',
    r.progress === 100 && !!r.certificateId && Object.keys(certs).length === 1 && certs.learner1_c1.kind === 'self_paced_completion' && /^SOK-EDU-[0-9A-F]{10}$/.test(certs.learner1_c1.serial)
      && certs.learner1_c1.status === 'issued' && certs.learner1_c1.issuer === 'SOKONI Education' && certs.learner1_c1.providerName === 'teach1', [r, certs]);
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: LDRAFT });
  ck('G-5b a draft lesson cannot be completed (it is not part of the learner\'s course)', r.reason === 'LESSON_NOT_IN_COURSE', r);
  await db.doc('learnerProfiles/learner1').set({ displayName: 'Wanjiru Achieng' });
  const serial = (certs.learner1_c1 || {}).serial || 'SOK-EDU-FFFFFFFFFF';
  r = await call('anyone', { op: 'verifyCertificate', serial });
  ck('C-1 a certificate is VERIFIED by its serial on the server: status, course, provider, issuer, date — holder as INITIALS only (learners may be minors)',
    r.found === true && r.status === 'issued' && r.courseTitle === 'Algebra' && r.holderInitials === 'W. A.' && !JSON.stringify(r).includes('learner1') && !JSON.stringify(r).includes('Wanjiru'), r);
  r = await call('anyone', { op: 'verifyCertificate', serial: 'SOK-EDU-0000000000' });
  ck('C-2 an unknown serial is NOT FOUND (never "valid")', r.found === false, r);
  r = await call('learner1', { op: 'revokeCertificate', certificateId: 'learner1_c1', reason: 'self revoke' });
  ck('C-3 a non-admin cannot revoke', r.reason === 'ADMIN_REQUIRED', r);
  r = await call('admin1', { op: 'revokeCertificate', certificateId: 'learner1_c1', reason: 'Academic misconduct confirmed' }, { admin: true });
  const rv = await call('anyone', { op: 'verifyCertificate', serial });
  ck('C-4 an admin revokes with a reason (audited); verification then says REVOKED', r.status === 'revoked' && rv.status === 'revoked' && /misconduct/.test(rv.revokedReason || '')
    && Object.values(await all('educationAudit')).some((x) => x.action === 'certificate_revoked'), rv);
  r = await call('learner1', { op: 'complete', courseId: 'c1', lessonId: L3 });
  ck('N-1 issuing the certificate sends ONE education_certificate_issued notification (the ONE notify feed)', NOTES.filter((n) => n.type === 'education_certificate_issued' && n.uid === 'learner1').length === 1, NOTES);
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
  /* ── OWNER RULE 2026-10-03: changes to a PUBLISHED course are re-reviewed ── */
  r = await call('teach1', { op: 'save', courseId: 'c1', lessonId: L2, lesson: { title: 'Video (edited)', kind: 'video', status: 'published', videoUrl: 'https://www.youtube.com/watch?v=NEW' } });
  let lv = (await all('courseLessons'))[L2];
  const lr = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('R-1 editing a PUBLISHED lesson stores a pending revision — learners keep the REVIEWED version', r.ok && lv.title === 'Video' && /v=abc/.test(lv.videoUrl) && lv.pendingRevision && lv.pendingRevision.title === 'Video (edited)'
    && lr.ok && /v=abc/.test(lr.lesson.videoUrl) && !lr.pendingRevision, [lv, lr]);
  const op = await call('teach1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('R-2 the OWNER previews the pending change; a learner never receives it', op.ok && op.pendingRevision && op.pendingRevision.title === 'Video (edited)', op);
  r = await call('learner1', { op: 'outline', courseId: 'c1' });
  ck('R-3 the staged new lesson is NOT in the learner outline before review', !r.lessons.some((x) => x.lessonId === LLATE), r);
  r = await call('teach1', { op: 'remove', courseId: 'c1', lessonId: L1 });
  ck('R-4 a PUBLISHED lesson of a live course cannot be deleted (unpublish first)', r.reason === 'UNPUBLISH_FIRST', r);
  const prePreview = await call('teach1', { op: 'content', courseId: 'c1', lessonId: L2, version: 'pending' });
  ck('S-0 the OWNER previews the PENDING version, clearly labelled', prePreview.ok && prePreview.preview === 'pending' && /learners cannot see these changes yet/.test(prePreview.notice) && prePreview.lesson.title === 'Video (edited)', prePreview);
  r = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2, version: 'pending' });
  ck('S-0b a learner asking for the pending version is refused (the preview is never a learner-access route)', r.reason === 'NOT_COURSE_OWNER', r);
  r = await call('teach1', { op: 'reorder', courseId: 'c1', order: [L2, L1, L3, LDRAFT, LLATE] });
  const out0 = await call('learner1', { op: 'outline', courseId: 'c1' });
  ck('S-1 a LIVE-course reorder is a pending change — learners keep the approved order', r.reviewRequired === true && Array.isArray((await all('courses')).c1.pendingLessonOrder) && out0.lessons[0].lessonId === L3, [r, out0.lessons.map((x) => x.title)]);
  r = await call('teach1', { op: 'revisionSummary', courseId: 'c1' });
  ck('S-2 the teacher sees the change summary before submitting (1 new, 1 edited, reordered)', r.ok && r.summary.newLessons === 1 && r.summary.editedLessons === 1 && r.summary.reordered === true, r);
  NOTES.length = 0;
  r = await call('teach1', { op: 'submitRevision', courseId: 'c1' });
  const rev = (await all('courseReviews'))[r.reviewId] || {};
  ck('R-5 the teacher submits: the course is frozen, ONE review item is created for AdminOS (submitter + summary), the teacher is notified',
    r.ok && (await all('courses')).c1.revisionPending === true && rev.status === 'pending' && rev.submittedBy === 'teach1' && rev.summary && rev.summary.editedLessons === 1
      && NOTES.some((n) => n.type === 'education_review_submitted' && n.uid === 'teach1'), [r, rev, NOTES]);
  const REVIEW_ID = r.reviewId;
  r = await call('teach1', { op: 'reviewQueue' });
  ck('S-3 the review queue is admin-only', r.reason === 'ADMIN_REQUIRED', r);
  r = await call('admin1', { op: 'reviewQueue' }, { admin: true });
  ck('S-4 AdminOS lists the pending course review', r.ok && r.reviews.some((x) => x.reviewId === REVIEW_ID && x.courseId === 'c1'), r);
  r = await call('admin1', { op: 'reviewDetail', courseId: 'c1' }, { admin: true });
  const dl = (r.lessons || []).find((x) => x.lessonId === L2) || {};
  ck('S-5 the reviewer sees ORIGINAL vs PROPOSED (lesson fields and the order)', r.ok && dl.published && /v=abc/.test(dl.published.videoUrl) && dl.proposed && /v=NEW/.test(dl.proposed.videoUrl)
    && r.course.proposedOrder && r.course.proposedOrder[0] === L2 && r.course.approvedOrder[0] === L3, [dl, r.course]);
  r = await call('teach1', { op: 'save', courseId: 'c1', lessonId: L2, lesson: { title: 'Sneaky', kind: 'text', body: 'x' } });
  ck('R-6 while in review, no further changes are accepted', r.reason === 'REVISION_IN_REVIEW', r);
  r = await call('teach1', { op: 'reviewRevision', courseId: 'c1', decision: 'approve' });
  ck('R-7 a teacher cannot approve their own revision', r.reason === 'ADMIN_REQUIRED', r);
  r = await call('admin1', { op: 'reviewRevision', courseId: 'c1', decision: 'reject' }, { admin: true });
  ck('R-8 a rejection needs a reason', r.reason === 'NOTE_REQUIRED', r);
  r = await call('admin1', { op: 'reviewRevision', courseId: 'c1', decision: 'approve' }, { admin: true });
  lv = (await all('courseLessons'))[L2];
  const late = (await all('courseLessons'))[LLATE];
  const out = await call('learner1', { op: 'outline', courseId: 'c1' });
  const lr2 = await call('learner1', { op: 'content', courseId: 'c1', lessonId: L2 });
  ck('S-6 approval applies the reviewed ORDER, closes the review item and notifies the teacher', (await all('courseLessons'))[L2].order === 1 && (await all('courseReviews'))[REVIEW_ID].status === 'approved'
    && NOTES.some((n) => n.type === 'education_review_approved' && n.uid === 'teach1'), [(await all('courseReviews'))[REVIEW_ID]]);
  ck('R-9 admin APPROVES: the edit goes live, the staged lesson is published, the course leaves review (audited)',
    r.ok && lv.title === 'Video (edited)' && !lv.pendingRevision && late.status === 'published' && !late.stagedForReview && (await all('courses')).c1.revisionPending === false
      && out.lessons.some((x) => x.lessonId === LLATE) && /v=NEW/.test(lr2.lesson.videoUrl) && Object.values(await all('educationAudit')).some((x) => x.action === 'course_revision_approve'), [r, lv, late]);
  r = await call('teach1', { op: 'setLessonStatus', courseId: 'c1', lessonId: LLATE, status: 'unpublished' });
  const hidden = await call('learner1', { op: 'content', courseId: 'c1', lessonId: LLATE });
  ck('R-10 UNPUBLISHING is immediate — learners lose the lesson at once', r.ok && (await all('courseLessons'))[LLATE].status === 'unpublished' && hidden.reason === 'LESSON_UNKNOWN', [r, hidden]);
  r = await call('teach1', { op: 'setLessonStatus', courseId: 'c1', lessonId: LLATE, status: 'published' });
  ck('R-11 REPUBLISHING goes through review (staged, still hidden)', r.reviewRequired === true && (await all('courseLessons'))[LLATE].status === 'unpublished' && (await all('courseLessons'))[LLATE].stagedForReview === true, r);
  await call('teach1', { op: 'submitRevision', courseId: 'c1' });
  r = await call('admin1', { op: 'reviewRevision', courseId: 'c1', decision: 'reject', note: 'Add an outline first' }, { admin: true });
  ck('S-7 a rejection notifies the teacher WITH the reason', NOTES.some((n) => n.type === 'education_review_rejected' && /Add an outline first/.test(n.body)), NOTES.map((n) => n.type));
  ck('R-12 a REJECTED revision changes nothing for learners and returns the note', r.ok && (await all('courseLessons'))[LLATE].status === 'unpublished' && !(await all('courseLessons'))[LLATE].stagedForReview
    && (await all('courses')).c1.revisionNote === 'Add an outline first' && (await all('courses')).c1.revisionPending === false, (await all('courses')).c1);
  r = await call('teach2', { op: 'submitRevision', courseId: 'c1' });
  ck('R-13 another teacher cannot submit / stage this course\'s revision', r.reason === 'NOT_COURSE_OWNER', r);
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
