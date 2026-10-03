'use strict';
/* ══ EDUCATION E2 — LESSONS, MATERIALS, PROGRESS, CERTIFICATES (owner brief 2026-10-03) ═══════════════════════════════
   Programme → Course → Lessons → Materials, owned by the course's owner; learners reach content by entitlement.

   AUTHORING (owner = courses/{id}.instructorUid = caller; an approved educator — business-workspace 'eduCourses'):
     list / save / remove / reorder lessons of an OWN course, and only while that course is a DRAFT (a published or
     in-review course is changed by unpublishing / rejection first — the same rule as course edits). The server keeps
     courses/{id}.lessonCount equal to the real lessons.
     Media: video = https YouTube / Vimeo only; material = a file in the owner's OWN storage folder
     (course-materials/{ownerUid}/{courseId}/…) — never another account's file, never an arbitrary URL.
   LEARNING:
     outline — a PUBLISHED course's lesson titles (anyone);
     content — the full lesson only for an ENROLLED learner, a free-preview lesson, or the owner;
     complete — only an enrolled learner, only a REAL lesson of that course. Progress = completed real lessons / real
                lessons (the live updateCourseProgress accepted ANY lesson id, so made-up ids reached 100%);
     on 100 % the server issues ONE certificate (create() claim) — "self-paced completion", never an assessed award.
   Collections (server-only; rules: client write false): courseLessons/{id}, learnerCertificates/{uid_courseId}. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const MAX_LESSONS = 200;
const KINDS = Object.freeze(['text', 'video', 'file']);
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const _deny = (code, msg, reason) => { throw new HttpsError(code, msg, reason ? { reason } : undefined); };
const enrollId = (uid, courseId) => `${uid}_${courseId}`;

function videoUrl(v) {
  if (!v) return null;
  let u; try { u = new URL(String(v).trim()); } catch (_) { _deny('invalid-argument', 'The video link is not a valid URL.', 'VIDEO_URL_INVALID'); }
  const host = u.hostname.replace(/^www\./, '');
  if (u.protocol !== 'https:' || !['youtube.com', 'youtu.be', 'm.youtube.com', 'vimeo.com', 'player.vimeo.com'].includes(host)) {
    _deny('invalid-argument', 'Videos must be an https YouTube or Vimeo link.', 'VIDEO_HOST_NOT_ALLOWED');
  }
  return u.href;
}
function materialUrl(v, ownerUid, courseId) {
  if (!v) return null;
  const s = String(v);
  const prefix = '/o/' + encodeURIComponent('course-materials/' + ownerUid + '/' + courseId + '/');
  if (!s.startsWith('https://firebasestorage.googleapis.com/v0/b/') || !s.includes(prefix) || s.length > 800) {
    _deny('invalid-argument', 'Upload course materials through SOKONI.', 'MATERIAL_NOT_OWN');
  }
  return s;
}
function lessonFields(d, ownerUid, courseId) {
  const title = _str(d.title, 140);
  if (title.length < 2) _deny('invalid-argument', 'Give the lesson a title.', 'TITLE_REQUIRED');
  const kind = KINDS.includes(d.kind) ? d.kind : _deny('invalid-argument', 'Choose a lesson type.', 'KIND_INVALID');
  const out = { title, kind, body: _str(d.body, 20000) || null, videoUrl: videoUrl(d.videoUrl), materialUrl: materialUrl(d.materialUrl, ownerUid, courseId), freePreview: d.freePreview === true };
  if (kind === 'video' && !out.videoUrl) _deny('invalid-argument', 'A video lesson needs a video link.', 'VIDEO_REQUIRED');
  if (kind === 'file' && !out.materialUrl) _deny('invalid-argument', 'A file lesson needs an uploaded file.', 'MATERIAL_REQUIRED');
  return out;
}

async function _assertEducator(db, uid) {
  const BW = require('./business-workspace');
  try { await BW.assertModule(db, uid, 'eduCourses', HttpsError); }
  catch (_) { _deny('permission-denied', 'Only an approved SOKONI teacher or institution can manage lessons.', 'NOT_AN_APPROVED_EDUCATOR'); }
}
async function _lessonsOf(db, courseId) {
  const q = await db.collection('courseLessons').where('courseId', '==', String(courseId)).limit(MAX_LESSONS + 1).get();
  return q.docs.map((x) => Object.assign({ lessonId: x.id }, x.data())).sort((a, b) => (a.order || 0) - (b.order || 0));
}
const outlineOf = (l) => ({ lessonId: l.lessonId, title: l.title, kind: l.kind, order: l.order || 0, freePreview: l.freePreview === true });

/* The ONE progress rule — also used by education.updateCourseProgress. Real lessons only; legacy courses with no real
   lessons accept only lesson_1 … lesson_{lessonCount} (the synthetic ids the old page used). */
async function recordProgress(db, uid, courseId, lessonId, completed) {
  const enrollRef = db.collection('courseEnrollments').doc(enrollId(uid, courseId));
  const progressRef = db.collection('courseProgress').doc(enrollId(uid, courseId));
  const certRef = db.collection('learnerCertificates').doc(enrollId(uid, courseId));
  const lessons = await _lessonsOf(db, courseId);
  return db.runTransaction(async (t) => {
    const [e, p, c, cert] = [await t.get(enrollRef), await t.get(progressRef), await t.get(db.collection('courses').doc(String(courseId))), await t.get(certRef)];
    if (!e.exists) _deny('permission-denied', 'Not enrolled in this course', 'NOT_ENROLLED');
    if (!c.exists) _deny('not-found', 'Course not found');
    const legacyN = Math.max(1, Number(c.data().lessonCount) || 1);
    const valid = lessons.length ? lessons.map((l) => l.lessonId) : Array.from({ length: legacyN }, (_, i) => 'lesson_' + (i + 1));
    if (!valid.includes(String(lessonId))) _deny('invalid-argument', 'That lesson is not part of this course.', 'LESSON_NOT_IN_COURSE');
    const prev = (p.exists && Array.isArray(p.data().completedLessons) ? p.data().completedLessons : []).filter((x) => valid.includes(x));
    const done = completed ? [...new Set(prev.concat([String(lessonId)]))] : prev.filter((x) => x !== String(lessonId));
    const progress = Math.min(100, Math.round((done.length / valid.length) * 100));
    t.set(progressRef, { uid, courseId: String(courseId), completedLessons: done, currentLesson: String(lessonId), lastAccessedAt: _ts(), lastAccessedAtMs: Date.now() }, { merge: true });
    t.update(enrollRef, Object.assign({ progress, lastAccessedAt: _ts() }, progress >= 100 ? { completedAt: _ts() } : {}));
    let certificateId = cert.exists ? cert.id : null;
    if (progress >= 100 && !cert.exists) {
      t.create(certRef, { uid, courseId: String(courseId), courseTitle: c.data().title || null, ownerUid: c.data().instructorUid || null,
        kind: 'self_paced_completion', serial: 'SOK-EDU-' + crypto.randomBytes(5).toString('hex').toUpperCase(), issuedAt: _ts(), _noIndex: true });
      certificateId = certRef.id;
    }
    return { progress, certificateId, message: progress >= 100 ? 'Congratulations! You have completed this course.' : `Progress updated: ${progress}% complete` };
  });
}

async function handle(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) _deny('unauthenticated', 'Sign in to continue.');
  const d = req.data || {};
  const db = _db();
  const courseId = _str(d.courseId, 128);
  const courseRef = courseId ? db.collection('courses').doc(courseId) : null;

  /* ── learner side ── */
  if (d.op === 'outline') {
    const c = await courseRef.get();
    if (!c.exists || (c.data().status !== 'published' && c.data().instructorUid !== uid)) _deny('not-found', 'Course not available');
    return { ok: true, lessons: (await _lessonsOf(db, courseId)).map(outlineOf) };
  }
  if (d.op === 'content') {
    const [c, l, e] = await Promise.all([courseRef.get(), db.collection('courseLessons').doc(_str(d.lessonId, 128)).get(), db.collection('courseEnrollments').doc(enrollId(uid, courseId)).get()]);
    if (!c.exists || !l.exists || l.data().courseId !== courseId) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    const owner = c.data().instructorUid === uid;
    if (!owner && c.data().status !== 'published') _deny('not-found', 'Course not available');
    if (!owner && !e.exists && l.data().freePreview !== true) _deny('permission-denied', 'Enrol in this course to open this lesson.', 'NOT_ENROLLED');
    const x = l.data();
    return { ok: true, lesson: { lessonId: l.id, title: x.title, kind: x.kind, body: x.body || null, videoUrl: x.videoUrl || null, materialUrl: x.materialUrl || null, freePreview: x.freePreview === true } };
  }
  if (d.op === 'complete') return Object.assign({ ok: true }, await recordProgress(db, uid, courseId, _str(d.lessonId, 128), d.completed !== false));
  if (d.op === 'myCertificates') {
    const q = await db.collection('learnerCertificates').where('uid', '==', uid).limit(100).get();
    return { ok: true, certificates: q.docs.map((x) => ({ certificateId: x.id, courseTitle: x.data().courseTitle || null, serial: x.data().serial, kind: x.data().kind })) };
  }

  /* ── authoring (own DRAFT courses only) ── */
  if (!['list', 'save', 'remove', 'reorder'].includes(d.op)) _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
  await _assertEducator(db, uid);
  const c0 = await courseRef.get();
  if (!c0.exists || c0.data().instructorUid !== uid) _deny('permission-denied', 'not course owner', 'NOT_COURSE_OWNER');
  if (d.op === 'list') return { ok: true, lessons: (await _lessonsOf(db, courseId)).map((l) => Object.assign(outlineOf(l), { body: l.body || null, videoUrl: l.videoUrl || null, materialUrl: l.materialUrl || null })) };
  if (c0.data().status !== 'draft') _deny('failed-precondition', 'Lessons can be changed only while the course is a draft.', 'NOT_A_DRAFT');
  const lessons = await _lessonsOf(db, courseId);

  if (d.op === 'save') {
    const f = lessonFields(d.lesson || {}, uid, courseId);
    const existingId = _str(d.lessonId, 128);
    if (existingId && !lessons.some((l) => l.lessonId === existingId)) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    if (!existingId && lessons.length >= MAX_LESSONS) _deny('failed-precondition', 'A course can have at most ' + MAX_LESSONS + ' lessons.', 'TOO_MANY_LESSONS');
    const ref = existingId ? db.collection('courseLessons').doc(existingId) : db.collection('courseLessons').doc();
    await db.runTransaction(async (t) => {
      const cur = await t.get(courseRef);
      if (!cur.exists || cur.data().instructorUid !== uid || cur.data().status !== 'draft') _deny('failed-precondition', 'Lessons can be changed only while the course is a draft.', 'NOT_A_DRAFT');
      if (existingId) t.update(ref, Object.assign({}, f, { updatedAt: _ts() }));
      else t.set(ref, Object.assign({}, f, { courseId, ownerUid: uid, order: lessons.length + 1, createdAt: _ts(), updatedAt: _ts() }));
      t.update(courseRef, { lessonCount: existingId ? lessons.length : lessons.length + 1, updatedAt: _ts() });
    });
    return { ok: true, lessonId: ref.id };
  }
  if (d.op === 'remove') {
    const id = _str(d.lessonId, 128);
    if (!lessons.some((l) => l.lessonId === id)) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    await db.runTransaction(async (t) => {
      const cur = await t.get(courseRef);
      if (!cur.exists || cur.data().status !== 'draft') _deny('failed-precondition', 'Lessons can be changed only while the course is a draft.', 'NOT_A_DRAFT');
      t.delete(db.collection('courseLessons').doc(id));
      t.update(courseRef, { lessonCount: Math.max(1, lessons.length - 1), updatedAt: _ts() });
    });
    return { ok: true };
  }
  /* reorder: exactly the course's own lesson ids, each once */
  const order = Array.isArray(d.order) ? d.order.map((x) => _str(x, 128)) : [];
  const own = lessons.map((l) => l.lessonId);
  if (order.length !== own.length || new Set(order).size !== order.length || !order.every((x) => own.includes(x))) _deny('invalid-argument', 'The new order must list each lesson of this course once.', 'ORDER_INVALID');
  const batch = db.batch();
  order.forEach((id, i) => batch.update(db.collection('courseLessons').doc(id), { order: i + 1, updatedAt: _ts() }));
  await batch.commit();
  return { ok: true };
}

exports.courseLessons = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 40 }, handle);
exports._internal = { handle, recordProgress, lessonFields, MAX_LESSONS };
