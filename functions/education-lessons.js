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
/* A material is stored as a STORAGE PATH in the owner's own folder — never a download URL. Firebase download URLs carry a
   token that opens the file for anyone holding the link, whatever storage.rules say, which would make paid materials
   shareable. Entitled learners get a short-lived SIGNED URL from 'content' instead (f3 storage review, 2026-10-03). */
const MATERIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}\.(pdf|png|jpg|jpeg|webp|docx|pptx|xlsx|txt)$/i;
function materialPath(v, ownerUid, courseId) {
  if (!v) return null;
  const s = String(v);
  const prefix = 'course-materials/' + ownerUid + '/' + courseId + '/';
  if (!s.startsWith(prefix) || s.includes('..') || !MATERIAL_NAME.test(s.slice(prefix.length))) {
    _deny('invalid-argument', 'Upload course materials through SOKONI.', 'MATERIAL_NOT_OWN');
  }
  return s;
}
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const MATERIAL_MAX_BYTES = 25 * 1024 * 1024;
/* The upload's contentType is CLIENT-declared (storage.rules can only check the claim). Before a signed URL is minted the
   server checks the object itself: size, the declared type is allowed, and the first bytes match that type (PDF, PNG,
   JPEG, WEBP; OOXML = a ZIP container; plain text must not look binary). A mismatch is refused, never served
   (f3 storage review, 2026-10-03). */
const MATERIAL_TYPES = Object.freeze({
  'application/pdf': (b) => b.slice(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'text/plain': (b) => !b.includes(0x00),
});
async function verifiedMaterial(file) {
  const [meta] = await file.getMetadata();
  const type = String((meta && meta.contentType) || '').toLowerCase();
  const size = Number(meta && meta.size);
  const check = MATERIAL_TYPES[type];
  if (!check || !(size > 0) || size > MATERIAL_MAX_BYTES) return false;
  const [head] = await file.download({ start: 0, end: 15 });
  return !!(head && head.length && check(Buffer.from(head)));
}
async function signedMaterialUrl(path) {
  if (!path) return null;
  const { getStorage } = require('firebase-admin/storage');
  const file = getStorage().bucket().file(path);
  if (!(await verifiedMaterial(file))) _deny('failed-precondition', 'This lesson file could not be verified. The teacher needs to upload it again.', 'MATERIAL_UNVERIFIED');
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS });
  return url;
}
function lessonFields(d, ownerUid, courseId) {
  const title = _str(d.title, 140);
  if (title.length < 2) _deny('invalid-argument', 'Give the lesson a title.', 'TITLE_REQUIRED');
  const kind = KINDS.includes(d.kind) ? d.kind : _deny('invalid-argument', 'Choose a lesson type.', 'KIND_INVALID');
  const out = { title, kind, description: _str(d.description, 600) || null, durationMinutes: Math.max(0, Math.min(1440, Math.floor(Number(d.durationMinutes) || 0))) || null,
    status: d.status === 'published' ? 'published' : 'draft',
    body: _str(d.body, 20000) || null, videoUrl: videoUrl(d.videoUrl), materialPath: materialPath(d.materialPath, ownerUid, courseId), freePreview: d.freePreview === true };
  if (kind === 'video' && !out.videoUrl) _deny('invalid-argument', 'A video lesson needs a video link.', 'VIDEO_REQUIRED');
  if (kind === 'file' && !out.materialPath) _deny('invalid-argument', 'A file lesson needs an uploaded file.', 'MATERIAL_REQUIRED');
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
const outlineOf = (l) => ({ lessonId: l.lessonId, title: l.title, kind: l.kind, order: l.order || 0, freePreview: l.freePreview === true,
  description: l.description || null, durationMinutes: l.durationMinutes || null });
/* a learner only ever sees / opens / completes PUBLISHED lessons (a draft lesson inside a published course stays hidden) */
const isLive = (l) => l.status === 'published';   /* draft / unpublished / staged lessons are never a learner's */
/* ENTITLEMENT = an ACTIVE enrolment: none of cancelled / refunded / expired, and not past expiresAtMs */
function entitled(e) {
  if (!e || !e.exists) return false;
  const x = e.data() || {};
  if (x.status && x.status !== 'active') return false;
  if (x.expiresAtMs && Number(x.expiresAtMs) <= Date.now()) return false;
  return true;
}

/* The ONE progress rule — also used by education.updateCourseProgress. Real lessons only; legacy courses with no real
   lessons accept only lesson_1 … lesson_{lessonCount} (the synthetic ids the old page used). */
async function recordProgress(db, uid, courseId, lessonId, completed) {
  const enrollRef = db.collection('courseEnrollments').doc(enrollId(uid, courseId));
  const progressRef = db.collection('courseProgress').doc(enrollId(uid, courseId));
  const certRef = db.collection('learnerCertificates').doc(enrollId(uid, courseId));
  const lessons = await _lessonsOf(db, courseId);
  return db.runTransaction(async (t) => {
    const [e, p, c, cert] = [await t.get(enrollRef), await t.get(progressRef), await t.get(db.collection('courses').doc(String(courseId))), await t.get(certRef)];
    /* ALL reads before any write (a Firestore transaction refuses a read after a write): the provider name for a possible certificate */
    const prov = c.exists && c.data().instructorUid ? await t.get(db.collection('providers').doc(String(c.data().instructorUid))) : null;
    if (!entitled(e)) _deny('permission-denied', 'Not enrolled in this course', 'NOT_ENROLLED');
    if (!c.exists) _deny('not-found', 'Course not found');
    const legacyN = Math.max(1, Number(c.data().lessonCount) || 1);
    const live = lessons.filter(isLive);
    const valid = lessons.length ? live.map((l) => l.lessonId) : Array.from({ length: legacyN }, (_, i) => 'lesson_' + (i + 1));
    if (!valid.includes(String(lessonId))) _deny('invalid-argument', 'That lesson is not part of this course.', 'LESSON_NOT_IN_COURSE');
    const prev = (p.exists && Array.isArray(p.data().completedLessons) ? p.data().completedLessons : []).filter((x) => valid.includes(x));
    const done = completed ? [...new Set(prev.concat([String(lessonId)]))] : prev.filter((x) => x !== String(lessonId));
    const progress = Math.min(100, Math.round((done.length / valid.length) * 100));
    const stateKey = 'lessonStates.' + String(lessonId).replace(/[.~*/[\]]/g, '_');
    const prevState = (p.exists && p.data().lessonStates && p.data().lessonStates[String(lessonId).replace(/[.~*/[\]]/g, '_')]) || {};
    t.set(progressRef, { uid, courseId: String(courseId), completedLessons: done, currentLesson: String(lessonId), lastAccessedAt: _ts(), lastAccessedAtMs: Date.now() }, { merge: true });
    t.update(progressRef, { [stateKey]: { state: completed ? 'completed' : 'in_progress', startedAtMs: prevState.startedAtMs || Date.now(), completedAtMs: completed ? Date.now() : null } });
    t.update(enrollRef, Object.assign({ progress, lastAccessedAt: _ts() }, progress >= 100 ? { completedAt: _ts() } : {}));
    let certificateId = cert.exists ? cert.id : null;
    if (progress >= 100 && !cert.exists) {
      t.create(certRef, { uid, courseId: String(courseId), courseTitle: c.data().title || null, ownerUid: c.data().instructorUid || null,
        providerName: prov && prov.exists ? (prov.data().name || prov.data().businessName || null) : null,
        issuer: 'SOKONI Education', kind: 'self_paced_completion', status: 'issued',
        serial: 'SOK-EDU-' + crypto.randomBytes(5).toString('hex').toUpperCase(), issuedAt: _ts(), issuedAtMs: Date.now(), _noIndex: true });
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
    return { ok: true, lessons: (await _lessonsOf(db, courseId)).filter(isLive).map(outlineOf) };
  }
  if (d.op === 'content') {
    const [c, l, e] = await Promise.all([courseRef.get(), db.collection('courseLessons').doc(_str(d.lessonId, 128)).get(), db.collection('courseEnrollments').doc(enrollId(uid, courseId)).get()]);
    if (!c.exists || !l.exists || l.data().courseId !== courseId) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    const owner = c.data().instructorUid === uid;
    if (!owner && c.data().status !== 'published') _deny('not-found', 'Course not available');
    if (!owner && !isLive(l.data())) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    const isEntitled = entitled(e);
    if (!owner && !isEntitled && l.data().freePreview !== true) _deny('permission-denied', 'Enrol in this course to open this lesson.', 'NOT_ENROLLED');
    /* an entitled learner opening a lesson marks it in progress (server-owned; never a browser "completed") */
    if (!owner && isEntitled) {
      const key = 'lessonStates.' + l.id.replace(/[.~*/[\]]/g, '_');
      const pRef = db.collection('courseProgress').doc(enrollId(uid, courseId));
      await db.runTransaction(async (t) => {
        const p = await t.get(pRef);
        const cur = (p.exists && p.data().lessonStates && p.data().lessonStates[l.id.replace(/[.~*/[\]]/g, '_')]) || null;
        if (!cur) {
          if (p.exists) t.update(pRef, { [key]: { state: 'in_progress', startedAtMs: Date.now(), completedAtMs: null }, lastAccessedAtMs: Date.now() });
          else t.set(pRef, { uid, courseId, completedLessons: [], lessonStates: { [l.id.replace(/[.~*/[\]]/g, '_')]: { state: 'in_progress', startedAtMs: Date.now(), completedAtMs: null } }, lastAccessedAtMs: Date.now() });
        }
      });
    }
    const x = l.data();
    /* minted ONLY after the entitlement check above; expires in 15 minutes */
    const materialUrl = x.materialPath ? await signedMaterialUrl(x.materialPath) : null;
    return { ok: true, lesson: { lessonId: l.id, title: x.title, kind: x.kind, body: x.body || null, videoUrl: x.videoUrl || null, materialUrl, materialExpiresInMinutes: materialUrl ? 15 : null, freePreview: x.freePreview === true },
      /* the OWNER also previews a change waiting for review; a learner never receives it */
      ...(owner && x.pendingRevision ? { pendingRevision: Object.assign({}, x.pendingRevision, { materialPath: undefined }) } : {}) };
  }
  if (d.op === 'complete') return Object.assign({ ok: true }, await recordProgress(db, uid, courseId, _str(d.lessonId, 128), d.completed !== false));
  if (d.op === 'myCertificates') {
    const q = await db.collection('learnerCertificates').where('uid', '==', uid).limit(100).get();
    return { ok: true, certificates: q.docs.map((x) => ({ certificateId: x.id, courseTitle: x.data().courseTitle || null, serial: x.data().serial, kind: x.data().kind,
      status: x.data().status || 'issued', providerName: x.data().providerName || null, issuer: x.data().issuer || 'SOKONI Education', issuedAtMs: x.data().issuedAtMs || null })) };
  }
  /* VERIFY by serial — server-authoritative. Returns what a verifier needs and nothing about the learner beyond initials
     (learners may be minors). An unknown serial is "not found", never "valid". */
  if (d.op === 'verifyCertificate') {
    const serial = _str(d.serial, 20).toUpperCase();
    if (!/^SOK-EDU-[0-9A-F]{10}$/.test(serial)) _deny('invalid-argument', 'Enter a certificate number like SOK-EDU-XXXXXXXXXX.', 'SERIAL_FORMAT');
    const q = await db.collection('learnerCertificates').where('serial', '==', serial).limit(1).get();
    if (q.empty) return { ok: true, found: false };
    const x = q.docs[0].data();
    const lp = await db.collection('learnerProfiles').doc(String(x.uid)).get();
    const name = lp.exists ? String(lp.data().displayName || '') : '';
    const initials = name ? name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join(' ') : null;
    return { ok: true, found: true, status: x.status || 'issued', courseTitle: x.courseTitle || null, providerName: x.providerName || null,
      issuer: x.issuer || 'SOKONI Education', kind: x.kind, issuedAtMs: x.issuedAtMs || null, holderInitials: initials,
      revokedReason: x.status === 'revoked' ? (x.revokedReason || null) : null };
  }
  if (d.op === 'revokeCertificate') {
    const isAdmin = !!(req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));
    if (!isAdmin) _deny('permission-denied', 'Administrator access required.', 'ADMIN_REQUIRED');
    const reason = _str(d.reason, 300);
    if (reason.length < 5) _deny('invalid-argument', 'Give a reason for revoking.', 'REASON_REQUIRED');
    const ref = db.collection('learnerCertificates').doc(_str(d.certificateId, 300));
    await db.runTransaction(async (t) => {
      const c = await t.get(ref);
      if (!c.exists) _deny('not-found', 'Certificate not found', 'CERT_UNKNOWN');
      if (c.data().status === 'revoked') _deny('failed-precondition', 'Already revoked.', 'ALREADY_REVOKED');
      t.update(ref, { status: 'revoked', revokedReason: reason, revokedBy: uid, revokedAt: _ts() });
      t.set(db.collection('educationAudit').doc(), { action: 'certificate_revoked', certificateId: ref.id, by: uid, reason, at: _ts() });
    });
    return { ok: true, status: 'revoked' };
  }

  /* ── course revision review (admin) — owner decision 2026-10-03: changes to a PUBLISHED course are re-reviewed ── */
  if (d.op === 'reviewRevision') {
    const isAdmin = !!(req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));
    if (!isAdmin) _deny('permission-denied', 'Administrator access required.', 'ADMIN_REQUIRED');
    const decision = d.decision === 'approve' ? 'approve' : d.decision === 'reject' ? 'reject' : _deny('invalid-argument', 'decision must be approve or reject.', 'DECISION_INVALID');
    const note = _str(d.note, 500) || null;
    if (decision === 'reject' && !note) _deny('invalid-argument', 'Give the teacher a reason.', 'NOTE_REQUIRED');
    const lessons = await _lessonsOf(db, courseId);
    const staged = lessons.filter((l) => l.stagedForReview === true);
    await db.runTransaction(async (t) => {
      const c = await t.get(courseRef);
      if (!c.exists || c.data().revisionPending !== true) _deny('failed-precondition', 'This course has no changes waiting for review.', 'NO_REVISION');
      const curs = [];
      for (const l of staged) curs.push([l, await t.get(db.collection('courseLessons').doc(l.lessonId))]);
      for (const [l, snap] of curs) {
        const ref = db.collection('courseLessons').doc(l.lessonId);
        const x = snap.data() || {};
        if (decision === 'approve') {
          const live = x.pendingRevision ? Object.assign({}, x.pendingRevision, { status: 'published' }) : { status: 'published' };
          t.update(ref, Object.assign(live, { stagedForReview: false, pendingRevision: FieldValue.delete(), reviewedAt: _ts(), reviewedBy: uid, updatedAt: _ts() }));
        } else {
          t.update(ref, { stagedForReview: false, pendingRevision: FieldValue.delete(), reviewNote: note, updatedAt: _ts() });
        }
      }
      t.update(courseRef, { revisionPending: false, revisionReviewedAt: _ts(), revisionReviewedBy: uid, ...(decision === 'reject' ? { revisionNote: note } : { revisionNote: FieldValue.delete() }) });
      t.set(db.collection('educationAudit').doc(), { action: 'course_revision_' + decision, courseId, by: uid, lessons: staged.map((l) => l.lessonId), note, at: _ts() });
    });
    return { ok: true, decision, lessons: staged.length };
  }

  /* ── authoring (own course; DRAFT freely, PUBLISHED through re-review) ── */
  if (!['list', 'save', 'remove', 'reorder', 'setLessonStatus', 'submitRevision'].includes(d.op)) _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
  await _assertEducator(db, uid);
  const c0 = await courseRef.get();
  if (!c0.exists || c0.data().instructorUid !== uid) _deny('permission-denied', 'not course owner', 'NOT_COURSE_OWNER');
  if (d.op === 'list') return { ok: true, revisionPending: c0.data().revisionPending === true, revisionNote: c0.data().revisionNote || null,
    lessons: (await _lessonsOf(db, courseId)).map((l) => Object.assign(outlineOf(l), { status: l.status, version: l.version || 1, stagedForReview: l.stagedForReview === true,
      hasPendingRevision: !!l.pendingRevision, reviewNote: l.reviewNote || null, body: l.body || null, videoUrl: l.videoUrl || null, materialPath: l.materialPath || null })) };
  const cs = c0.data().status;
  if (cs !== 'draft' && cs !== 'published') _deny('failed-precondition', 'This course is waiting for SOKONI review; lessons can be changed once it is reviewed.', 'COURSE_IN_REVIEW');
  const liveCourse = cs === 'published';
  if (liveCourse && c0.data().revisionPending === true) _deny('failed-precondition', 'Your changes are waiting for SOKONI review.', 'REVISION_IN_REVIEW');
  const lessons = await _lessonsOf(db, courseId);
  const find = (id) => lessons.find((l) => l.lessonId === id);
  /* the course must still be in the state this request was decided on */
  const sameCourseState = (cur) => cur.exists && cur.data().instructorUid === uid && cur.data().status === cs && cur.data().revisionPending !== true;
  const STALE = () => _deny('failed-precondition', 'The course changed — reload and try again.', 'COURSE_CHANGED');

  if (d.op === 'save') {
    const f = lessonFields(d.lesson || {}, uid, courseId);
    const wantsPublish = f.status === 'published';
    const existingId = _str(d.lessonId, 128);
    const prev = existingId ? find(existingId) : null;
    if (existingId && !prev) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    if (!existingId && lessons.length >= MAX_LESSONS) _deny('failed-precondition', 'A course can have at most ' + MAX_LESSONS + ' lessons.', 'TOO_MANY_LESSONS');
    const ref = existingId ? db.collection('courseLessons').doc(existingId) : db.collection('courseLessons').doc();
    const version = (prev ? Number(prev.version || 0) : 0) + 1;
    await db.runTransaction(async (t) => {
      if (!sameCourseState(await t.get(courseRef))) STALE();
      let mode;
      if (!liveCourse) {
        /* DRAFT course: the lesson is written as given (the whole course is reviewed on submit) */
        mode = 'live';
        if (prev) t.update(ref, Object.assign({}, f, { version, updatedAt: _ts() }));
        else t.set(ref, Object.assign({}, f, { courseId, ownerUid: uid, order: lessons.length + 1, version, createdAt: _ts(), updatedAt: _ts() }));
      } else if (prev && prev.status === 'published') {
        /* PUBLISHED lesson of a PUBLISHED course: learners keep the reviewed version; the change is a pending revision */
        mode = 'proposal';
        const proposal = Object.assign({}, f); delete proposal.status;
        t.update(ref, { pendingRevision: proposal, stagedForReview: true, version, updatedAt: _ts() });
      } else {
        /* new / draft / unpublished lesson of a PUBLISHED course: saved as a DRAFT; "publish" stages it for review */
        mode = 'staged';
        const live = Object.assign({}, f, { status: prev && prev.status === 'unpublished' ? 'unpublished' : 'draft', stagedForReview: wantsPublish, version, updatedAt: _ts() });
        if (prev) t.update(ref, live);
        else t.set(ref, Object.assign(live, { courseId, ownerUid: uid, order: lessons.length + 1, createdAt: _ts() }));
      }
      t.create(db.collection('courseLessonHistory').doc(ref.id + '_v' + version), Object.assign({}, f, { lessonId: ref.id, courseId, ownerUid: uid, version, mode, savedAt: _ts() }));
      t.update(courseRef, { lessonCount: prev ? lessons.length : lessons.length + 1, updatedAt: _ts() });
    });
    return { ok: true, lessonId: ref.id, reviewRequired: liveCourse };
  }
  if (d.op === 'setLessonStatus') {
    const id = _str(d.lessonId, 128); const l = find(id);
    if (!l) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    const to = d.status;
    if (!['published', 'unpublished', 'draft'].includes(to)) _deny('invalid-argument', 'status must be published, unpublished or draft.', 'STATUS_INVALID');
    await db.runTransaction(async (t) => {
      if (!sameCourseState(await t.get(courseRef))) STALE();
      const ref = db.collection('courseLessons').doc(id);
      if (!liveCourse) t.update(ref, { status: to === 'unpublished' ? 'draft' : to, updatedAt: _ts() });
      else if (to === 'unpublished') {
        /* hiding content from learners is never risky: immediate */
        if (l.status !== 'published') _deny('failed-precondition', 'Only a published lesson can be unpublished.', 'NOT_PUBLISHED');
        t.update(ref, { status: 'unpublished', updatedAt: _ts() });
      } else if (to === 'published') {
        /* (re)publishing in a live course goes through review */
        t.update(ref, { stagedForReview: true, updatedAt: _ts() });
      } else t.update(ref, { stagedForReview: false, updatedAt: _ts() });
      t.set(db.collection('educationAudit').doc(), { action: 'lesson_status_' + to, courseId, lessonId: id, by: uid, live: liveCourse, at: _ts() });
    });
    return { ok: true, reviewRequired: liveCourse && to === 'published' };
  }
  if (d.op === 'submitRevision') {
    if (!liveCourse) _deny('failed-precondition', 'Submit a draft course with "Submit for review" instead.', 'NOT_PUBLISHED');
    if (!lessons.some((l) => l.stagedForReview === true)) _deny('failed-precondition', 'There are no lesson changes to submit.', 'NOTHING_STAGED');
    await db.runTransaction(async (t) => {
      if (!sameCourseState(await t.get(courseRef))) STALE();
      t.update(courseRef, { revisionPending: true, revisionSubmittedAt: _ts(), revisionNote: FieldValue.delete() });
      t.set(db.collection('educationAudit').doc(), { action: 'course_revision_submit', courseId, by: uid, at: _ts() });
    });
    return { ok: true, revisionPending: true };
  }
  if (d.op === 'remove') {
    const id = _str(d.lessonId, 128); const l = find(id);
    if (!l) _deny('not-found', 'Lesson not found', 'LESSON_UNKNOWN');
    if (liveCourse && l.status === 'published') _deny('failed-precondition', 'Unpublish this lesson before removing it.', 'UNPUBLISH_FIRST');
    await db.runTransaction(async (t) => {
      if (!sameCourseState(await t.get(courseRef))) STALE();
      t.delete(db.collection('courseLessons').doc(id));
      t.update(courseRef, { lessonCount: Math.max(1, lessons.length - 1), updatedAt: _ts() });
    });
    return { ok: true };
  }
  /* reorder: exactly the course's own lesson ids, each once (order only — never content) */
  const order = Array.isArray(d.order) ? d.order.map((x) => _str(x, 128)) : [];
  const own = lessons.map((l) => l.lessonId);
  if (order.length !== own.length || new Set(order).size !== order.length || !order.every((x) => own.includes(x))) _deny('invalid-argument', 'The new order must list each lesson of this course once.', 'ORDER_INVALID');
  const batch = db.batch();
  order.forEach((id, i) => batch.update(db.collection('courseLessons').doc(id), { order: i + 1, updatedAt: _ts() }));
  await batch.commit();
  return { ok: true };
}

exports.courseLessons = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 40 }, handle);
exports._internal = { handle, recordProgress, lessonFields, materialPath, verifiedMaterial, MATERIAL_TYPES, MAX_LESSONS, SIGNED_URL_TTL_MS };
