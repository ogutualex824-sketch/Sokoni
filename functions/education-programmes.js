'use strict';
/* ══ EDUCATION E2 — INSTITUTION PROGRAMMES (owner brief 2026-10-03) ═══════════════════════════════════════════════════
   An institution owns: programmes → courses → teachers → classes. This module is the PROGRAMME layer.
     · Only an APPROVED INSTITUTION (business-workspace.assertModule 'eduProgrammes': approval gate + server-stamped
       providers/{uid}.education.type === 'institution') may list / create / edit / activate programmes. A teacher never
       gets this module, whatever a client sends.
     · The owner is ALWAYS the caller. No institutionId is read from the request.
     · A programme may include ONLY the institution's OWN courses (courses.instructorUid === caller), checked on the
       server on every write.
     · 'active' requires at least one PUBLISHED own course; a programme never makes an unreviewed course visible.
   Collection (server-only; rules: client write false): programmes/{id}. Mutations audited in educationAudit. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const LEVELS = Object.freeze(['certificate', 'diploma', 'degree', 'short_course', 'cbc', 'other']);
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();
const _str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const _deny = (code, msg, reason) => { throw new HttpsError(code, msg, reason ? { reason } : undefined); };

async function _assertInstitution(db, uid) {
  const BW = require('./business-workspace');
  try { await BW.assertModule(db, uid, 'eduProgrammes', HttpsError); }
  catch (_) { _deny('permission-denied', 'Only an approved SOKONI institution can manage programmes.', 'NOT_AN_APPROVED_INSTITUTION'); }
}

function _fields(d) {
  const title = _str(d.title, 120);
  if (title.length < 3) _deny('invalid-argument', 'Give the programme a title.', 'TITLE_REQUIRED');
  const level = LEVELS.includes(d.level) ? d.level : _deny('invalid-argument', 'Choose a programme level.', 'LEVEL_INVALID');
  const courseIds = Array.isArray(d.courseIds) ? [...new Set(d.courseIds.map((x) => _str(x, 128)).filter(Boolean))] : [];
  if (courseIds.length > 30) _deny('invalid-argument', 'A programme can include at most 30 courses.', 'TOO_MANY_COURSES');
  return { title, description: _str(d.description, 2000) || null, level, durationWeeks: Math.max(0, Math.min(520, Math.floor(Number(d.durationWeeks) || 0))) || null, courseIds };
}

/* every course must exist and be the caller's own → returns the courses (for the activation rule) */
async function _ownCourses(t, db, uid, ids) {
  const out = [];
  for (const id of ids) {
    const s = await t.get(db.collection('courses').doc(id));
    if (!s.exists || s.data().instructorUid !== uid) _deny('permission-denied', 'A programme can include only your own courses.', 'COURSE_NOT_OWN');
    out.push(s.data());
  }
  return out;
}

async function handle(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) _deny('unauthenticated', 'Sign in to continue.');
  const d = req.data || {};
  const db = _db();
  await _assertInstitution(db, uid);

  if (d.op === 'list') {
    const q = await db.collection('programmes').where('ownerUid', '==', uid).limit(100).get();
    return { ok: true, programmes: q.docs.map((x) => { const p = x.data(); return { programmeId: x.id, title: p.title, level: p.level, status: p.status, courseIds: p.courseIds || [], durationWeeks: p.durationWeeks || null }; }) };
  }
  if (d.op === 'create') {
    const f = _fields(d.programme || {});
    const ref = db.collection('programmes').doc();
    await db.runTransaction(async (t) => {
      await _ownCourses(t, db, uid, f.courseIds);
      t.set(ref, Object.assign({}, f, { ownerUid: uid, status: 'draft', _noIndex: true, createdAt: _ts(), updatedAt: _ts() }));
      t.set(db.collection('educationAudit').doc(), { action: 'programme_create', programmeId: ref.id, ownerUid: uid, at: _ts() });
    });
    return { ok: true, programmeId: ref.id };
  }
  if (d.op === 'update') {
    const f = _fields(d.programme || {});
    const ref = db.collection('programmes').doc(_str(d.programmeId, 128));
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().ownerUid !== uid) _deny('not-found', 'No such programme.', 'PROGRAMME_UNKNOWN');
      const courses = await _ownCourses(t, db, uid, f.courseIds);
      /* an ACTIVE programme must keep at least one published course after the edit */
      if (s.data().status === 'active' && !courses.some((c) => c.status === 'published')) _deny('failed-precondition', 'An active programme needs at least one published course.', 'NEEDS_PUBLISHED_COURSE');
      t.update(ref, Object.assign({}, f, { updatedAt: _ts() }));
      t.set(db.collection('educationAudit').doc(), { action: 'programme_update', programmeId: ref.id, ownerUid: uid, at: _ts() });
    });
    return { ok: true };
  }
  if (d.op === 'setStatus') {
    const to = d.status === 'active' ? 'active' : d.status === 'draft' ? 'draft' : _deny('invalid-argument', 'status must be active or draft.', 'STATUS_INVALID');
    const ref = db.collection('programmes').doc(_str(d.programmeId, 128));
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || s.data().ownerUid !== uid) _deny('not-found', 'No such programme.', 'PROGRAMME_UNKNOWN');
      if (to === 'active') {
        const courses = await _ownCourses(t, db, uid, s.data().courseIds || []);
        if (!courses.some((c) => c.status === 'published')) _deny('failed-precondition', 'Add at least one published course before activating.', 'NEEDS_PUBLISHED_COURSE');
      }
      t.update(ref, { status: to, updatedAt: _ts() });
      t.set(db.collection('educationAudit').doc(), { action: 'programme_' + to, programmeId: ref.id, ownerUid: uid, at: _ts() });
    });
    return { ok: true, status: to };
  }
  _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
}

exports.manageMyProgrammes = onCall({ region: 'us-central1', enforceAppCheck: true, maxInstances: 20 }, handle);
exports._internal = { handle, LEVELS };
