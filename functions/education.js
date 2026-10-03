/* ================================================================
   SOKONI Education Hub — Cloud Functions v1.0
   functions/education.js

   8 Gen2 callable Cloud Functions:
     1. listCourses        — public course catalog with filtering
     2. getCourse          — full course detail + enrolment check
     3. enrollCourse       — enrol (free) or payment gate (paid)
     4. getCourseProgress  — learner progress doc lookup
     5. updateCourseProgress — mark lesson complete, calc %
     6. reviewCourse       — post/update course review
     7. createCourse       — instructor creates draft course
     8. getMyEnrollments   — learner's enrolled courses

   Architecture:
     • All queries are single-field to respect the 200-index budget.
     • Doc-ID composite keys (`uid_courseId`) avoid extra indexes for
       per-user/per-course lookups.
     • No secrets required — wallets read through Admin SDK.

   Node.js 22 / firebase-functions v2 / firebase-admin v12
================================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/* Guard against double-init in monorepo index.js */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

/* ─── Shared constants ────────────────────────────────────────── */

const VALID_CATEGORIES = [
  'technology', 'business', 'design', 'marketing',
  'personal-development', 'language', 'arts', 'health',
  'cooking', 'music', 'other',
];

const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];

const PAGE_SIZE    = 12;
const CF_OPTS      = { region: 'us-central1', enforceAppCheck: true, maxInstances: 80 };

/* ─── Utility helpers ─────────────────────────────────────────── */

/** XSS-safe string sanitisation */
function _sanitize(s) {
  if (s == null) return '';
  return String(s).replace(/[<>"'`]/g, '');
}

/** Composite doc-ID: uid + _ + courseId */
function _enrollId(uid, courseId) {
  return `${uid}_${courseId}`;
}

/** Throw a typed HttpsError */
function _deny(code, msg, reason) {
  throw new HttpsError(code, msg, reason ? { reason } : undefined);
}

/* ══ EDUCATION E2 — COURSE OWNERSHIP (owner brief 2026-10-03) ══════════════════════════════════════════════════════
   Only an APPROVED teacher or institution may create, edit or submit a course, and only its own. "Approved" is the ONE
   business workspace authority's answer (business-workspace.assertModule 'eduCourses': approval gate + server-stamped
   providers/{uid}.education.type) — never a client field, never a second implementation. The owner is always the
   caller (instructorUid = request.auth.uid); no teacherId / institutionId is ever read from the request. */
async function _assertCourseOwnerCapability(uid) {
  const BW = require('./business-workspace');
  try {
    await BW.assertModule(db, uid, 'eduCourses', HttpsError);
  } catch (e) {
    throw new HttpsError('permission-denied', 'Only an approved SOKONI teacher or institution can manage courses.',
      { reason: 'NOT_AN_APPROVED_EDUCATOR', detail: (e && e.details && (e.details.code || e.details.reason)) || null });
  }
  const p = await db.collection('providers').doc(String(uid)).get();
  return { educationType: BW.educationTypeOf(p.exists ? p.data() : null) };
}

/* Shared create / update validation → the clean course fields (no status, owner, counters or flags — server-owned). */
function _courseFields(d) {
  const out = {};
  out.title = _req(d.title, 'title', 5, 100);
  out.description = _req(d.description, 'description', 20, 3000);
  if (!VALID_CATEGORIES.includes(d.category)) _deny('invalid-argument', `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  if (!VALID_LEVELS.includes(d.level)) _deny('invalid-argument', `level must be one of: ${VALID_LEVELS.join(', ')}`);
  out.category = d.category; out.level = d.level;
  const priceNum = Number(d.price === undefined ? 0 : d.price);
  if (!Number.isFinite(priceNum) || priceNum < 0) _deny('invalid-argument', 'price must be a non-negative number');
  out.price = priceNum; out.currency = 'KES';
  const url = (v, name) => {
    if (!v) return '';
    let u; try { u = new URL(String(v).trim()); } catch (_) { _deny('invalid-argument', name + ' is not a valid URL'); }
    if (u.protocol !== 'https:') _deny('invalid-argument', name + ' must be an https URL');
    return u.href;
  };
  out.videoUrl = url(d.videoUrl, 'videoUrl');
  out.thumbnail = url(d.thumbnail, 'thumbnail');
  out.lessonCount = Math.max(1, Math.min(500, Math.floor(Number(d.lessonCount) || 1)));
  out.durationMinutes = Math.max(0, Math.min(100000, Math.floor(Number(d.durationMinutes) || 0)));
  out.tags = Array.isArray(d.tags) ? d.tags.slice(0, 10).map((t) => _sanitize(String(t).trim()).slice(0, 40)).filter(Boolean) : [];
  return out;
}

async function _audit(action, fields) {
  await db.collection('educationAudit').add(Object.assign({ action, at: FieldValue.serverTimestamp() }, fields)).catch(() => {});
}

/** Validate required string param */
function _req(val, name, minLen = 1, maxLen = 5000) {
  if (!val || typeof val !== 'string' || val.trim().length < minLen) {
    _deny('invalid-argument', `${name} is required (min ${minLen} chars)`);
  }
  if (val.trim().length > maxLen) {
    _deny('invalid-argument', `${name} exceeds ${maxLen} chars`);
  }
  return val.trim();
}

/** Structured logger */
function createLogger(label) {
  const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  return {
    info:  (msg, d = {}) => console.log(JSON.stringify({ severity: 'INFO',    fn: label, id, message: msg, ...d })),
    warn:  (msg, d = {}) => console.warn(JSON.stringify({ severity: 'WARNING', fn: label, id, message: msg, ...d })),
    error: (msg, d = {}) => console.error(JSON.stringify({ severity: 'ERROR',  fn: label, id, message: msg, ...d })),
  };
}

/* ══════════════════════════════════════════════════════════════
   1. LIST COURSES  (public)

   Input:  { category?, level?, maxPrice?, search?, page? }
   Output: { courses: [...], hasMore: boolean, total: number }

   Strategy:
     – Query published courses with single-field where clause.
     – JS-side filtering for category / level / price / search
       to avoid composite indexes.
     – Sort by enrollmentCount desc in JS.
     – Paginate: return PAGE_SIZE items at offset page * PAGE_SIZE.
══════════════════════════════════════════════════════════════ */
exports.listCourses = onCall(CF_OPTS, async (request) => {
  const log = createLogger('listCourses');

  const {
    category  = null,
    level     = null,
    maxPrice  = null,
    search    = null,
    page      = 0,
  } = request.data || {};

  /* ── Fetch all published courses (single-field query ✓) ──── */
  const snap = await db.collection('courses')
    .where('status', '==', 'published')
    .limit(500) /* safety cap; real catalog rarely hits this */
    .get();

  let courses = snap.docs.map(d => {
    const data = d.data();
    /* Strip instructorUid from public results */
    const { instructorUid, ...pub } = data;
    void instructorUid; /* suppress unused-var */
    return { courseId: d.id, ...pub };
  });

  /* ── JS-side filters ────────────────────────────────────── */
  if (category && category !== 'all') {
    courses = courses.filter(c => c.category === category);
  }
  if (level && level !== 'all') {
    courses = courses.filter(c => c.level === level);
  }
  if (maxPrice != null && !isNaN(Number(maxPrice))) {
    courses = courses.filter(c => (c.price || 0) <= Number(maxPrice));
  }
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    courses = courses.filter(c =>
      (c.title        || '').toLowerCase().includes(q) ||
      (c.description  || '').toLowerCase().includes(q) ||
      (c.category     || '').toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  /* ── Sort by popularity ─────────────────────────────────── */
  courses.sort((a, b) => (b.enrollmentCount || 0) - (a.enrollmentCount || 0));

  const total   = courses.length;
  const offset  = Number(page || 0) * PAGE_SIZE;
  const slice   = courses.slice(offset, offset + PAGE_SIZE);
  const hasMore = offset + PAGE_SIZE < total;

  log.info('listCourses', { total, page, returned: slice.length });
  return { courses: slice, hasMore, total };
});


/* ══════════════════════════════════════════════════════════════
   2. GET COURSE  (public; enrolment info when authed)

   Input:  { courseId }
   Output: { course, isEnrolled: boolean, reviews: [...] }

   – Atomically increments viewCount via FieldValue.increment.
   – Returns isEnrolled=false for unauthenticated callers.
   – Fetches first 5 reviews (single-field query ✓).
══════════════════════════════════════════════════════════════ */
exports.getCourse = onCall(CF_OPTS, async (request) => {
  const log = createLogger('getCourse');

  const { courseId } = request.data || {};
  _req(courseId, 'courseId');

  /* ── Fetch course doc ────────────────────────────────────── */
  const courseRef  = db.collection('courses').doc(courseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) _deny('not-found', 'Course not found');

  const courseData = courseSnap.data();
  if (courseData.status !== 'published') {
    /* Allow instructors to preview their own drafts */
    const uid = request.auth?.uid;
    if (!uid || courseData.instructorUid !== uid) {
      _deny('not-found', 'Course not available');
    }
  }

  /* ── Increment viewCount (fire-and-forget, no await) ─────── */
  courseRef.update({ viewCount: FieldValue.increment(1) }).catch(() => {});

  /* ── Enrolment check ─────────────────────────────────────── */
  let isEnrolled = false;
  const uid = request.auth?.uid;
  if (uid) {
    const enrollSnap = await db.collection('courseEnrollments')
      .doc(_enrollId(uid, courseId))
      .get();
    isEnrolled = enrollSnap.exists;
  }

  /* ── Reviews (single-field query ✓) ─────────────────────── */
  const reviewsSnap = await db.collection('courseReviews')
    .where('courseId', '==', courseId)
    .limit(5)
    .get();

  const reviews = reviewsSnap.docs.map(d => ({
    reviewId: d.id,
    rating:   d.data().rating,
    comment:  d.data().comment,
    createdAt: d.data().createdAt,
  }));

  /* Strip instructorUid from public response */
  const { instructorUid, ...pub } = courseData;
  void instructorUid;

  log.info('getCourse', { courseId, isEnrolled });
  return { course: { courseId, ...pub }, isEnrolled, reviews };
});


/* ══════════════════════════════════════════════════════════════
   3. ENROL COURSE  (auth required)

   Input:  { courseId }
   Output: { enrolled: true, courseId }
         | { paymentRequired: true, price, courseId }

   – Validates course exists and is published.
   – Idempotency: returns enrolled:true if already enrolled.
   – Free (price=0): creates enrolment + increments count.
   – Paid (price>0): checks wallet balance; deducts if sufficient,
     otherwise returns paymentRequired:true.
   – Uses Firestore transaction to prevent double-enrolment race.
══════════════════════════════════════════════════════════════ */
exports.enrollCourse = onCall(CF_OPTS, async (request) => {
  const log = createLogger('enrollCourse');

  if (!request.auth) _deny('unauthenticated', 'Sign in to enrol in courses');
  const uid = request.auth.uid;

  const { courseId } = request.data || {};
  _req(courseId, 'courseId');

  const courseRef  = db.collection('courses').doc(courseId);
  const enrollRef  = db.collection('courseEnrollments').doc(_enrollId(uid, courseId));
  const progressRef = db.collection('courseProgress').doc(_enrollId(uid, courseId));

  return await db.runTransaction(async (tx) => {
    const [courseSnap, enrollSnap] = await Promise.all([
      tx.get(courseRef),
      tx.get(enrollRef),
    ]);

    if (!courseSnap.exists) _deny('not-found', 'Course not found');

    const course = courseSnap.data();
    if (course.status !== 'published') _deny('failed-precondition', 'Course is not available');

    /* Already enrolled — idempotent */
    if (enrollSnap.exists) {
      return { enrolled: true, courseId, alreadyEnrolled: true };
    }

    const price = Number(course.price || 0);
    const now   = admin.firestore.Timestamp.now();

    if (price > 0) {
      /* ── Paid course: check wallet balance ──────────────── */
      const walletSnap = await tx.get(db.collection('wallets').doc(uid));
      const balance    = walletSnap.exists ? Number(walletSnap.data().balance || 0) : 0;

      if (balance < price) {
        /* Signal to client that payment is required */
        return { paymentRequired: true, price, courseId };
      }

      /* Sufficient balance — deduct and enrol */
      tx.update(db.collection('wallets').doc(uid), {
        balance: FieldValue.increment(-price),
        updatedAt: now,
      });
    }

    /* ── Create enrolment ─────────────────────────────────── */
    tx.set(enrollRef, {
      uid,
      courseId,
      enrolledAt:     now,
      progress:       0,
      lastAccessedAt: now,
    });

    /* ── Initialise progress doc ──────────────────────────── */
    tx.set(progressRef, {
      uid,
      courseId,
      completedLessons: [],
      currentLesson:    null,
      lastAccessedAt:   now,
    });

    /* ── Increment enrolment count ────────────────────────── */
    tx.update(courseRef, { enrollmentCount: FieldValue.increment(1) });

    log.info('enrolled', { uid, courseId, price });
    return { enrolled: true, courseId };
  });
});


/* ══════════════════════════════════════════════════════════════
   4. GET COURSE PROGRESS  (auth required)

   Input:  { courseId }
   Output: { progress, completedLessons, currentLesson, lastAccessedAt }
══════════════════════════════════════════════════════════════ */
exports.getCourseProgress = onCall(CF_OPTS, async (request) => {
  if (!request.auth) _deny('unauthenticated', 'Sign in to view progress');
  const uid = request.auth.uid;

  const { courseId } = request.data || {};
  _req(courseId, 'courseId');

  /* ── Verify enrolment ───────────────────────────────────── */
  const enrollSnap = await db.collection('courseEnrollments')
    .doc(_enrollId(uid, courseId))
    .get();
  if (!enrollSnap.exists) _deny('permission-denied', 'Not enrolled in this course');

  /* ── Doc-ID lookup — no index required ─────────────────── */
  const progressSnap = await db.collection('courseProgress')
    .doc(_enrollId(uid, courseId))
    .get();

  if (!progressSnap.exists) {
    return { progress: 0, completedLessons: [], currentLesson: null, lastAccessedAt: null };
  }

  const d = progressSnap.data();
  return {
    progress:         d.progress || 0,
    completedLessons: d.completedLessons || [],
    currentLesson:    d.currentLesson || null,
    lastAccessedAt:   d.lastAccessedAt || null,
  };
});


/* ══════════════════════════════════════════════════════════════
   5. UPDATE COURSE PROGRESS  (auth required)

   Input:  { courseId, lessonId, completed?: boolean }
   Output: { progress, message }

   – Verifies enrolment before any write.
   – Uses arrayUnion so concurrent calls don't race.
   – Recalculates progress % from course.lessonCount.
   – Sets completedAt on enrolment when 100% reached.
══════════════════════════════════════════════════════════════ */
exports.updateCourseProgress = onCall(CF_OPTS, async (request) => {
  const log = createLogger('updateCourseProgress');

  if (!request.auth) _deny('unauthenticated', 'Sign in to update progress');
  const uid = request.auth.uid;

  const { courseId, lessonId, completed = true } = request.data || {};
  _req(courseId, 'courseId');
  _req(lessonId, 'lessonId');

  const enrollRef   = db.collection('courseEnrollments').doc(_enrollId(uid, courseId));
  const progressRef = db.collection('courseProgress').doc(_enrollId(uid, courseId));
  const courseRef   = db.collection('courses').doc(courseId);

  /* ── Parallel reads ─────────────────────────────────────── */
  const [enrollSnap, progressSnap, courseSnap] = await Promise.all([
    enrollRef.get(),
    progressRef.get(),
    courseRef.get(),
  ]);

  if (!enrollSnap.exists)  _deny('permission-denied', 'Not enrolled in this course');
  if (!courseSnap.exists)  _deny('not-found', 'Course not found');

  const lessonCount = Number(courseSnap.data().lessonCount || 1);
  const now         = admin.firestore.Timestamp.now();

  /* ── Build completed lessons array ─────────────────────── */
  const existing = progressSnap.exists ? (progressSnap.data().completedLessons || []) : [];
  let updatedLessons;
  if (completed) {
    updatedLessons = existing.includes(lessonId) ? existing : [...existing, lessonId];
  } else {
    updatedLessons = existing.filter(l => l !== lessonId);
  }

  const progress = Math.min(100, Math.round((updatedLessons.length / lessonCount) * 100));

  /* ── Write progress doc ─────────────────────────────────── */
  const progressUpdate = {
    uid,
    courseId,
    currentLesson:    lessonId,
    lastAccessedAt:   now,
    lastAccessedAtMs: Date.now(),
  };

  if (completed) {
    progressUpdate.completedLessons = FieldValue.arrayUnion(lessonId);
  } else {
    progressUpdate.completedLessons = FieldValue.arrayRemove(lessonId);
  }

  await progressRef.set(progressUpdate, { merge: true });

  /* ── Update enrolment progress % ────────────────────────── */
  const enrollUpdate = { progress, lastAccessedAt: now };
  if (progress >= 100) {
    enrollUpdate.completedAt = now;
  }
  await enrollRef.update(enrollUpdate);

  const message = progress >= 100
    ? 'Congratulations! You have completed this course.'
    : `Progress updated: ${progress}% complete`;

  log.info('progressUpdated', { uid, courseId, lessonId, progress });
  return { progress, message };
});


/* ══════════════════════════════════════════════════════════════
   6. REVIEW COURSE  (auth required)

   Input:  { courseId, rating: 1-5, comment }
   Output: { success: true }

   – Idempotency: doc-ID = uid_courseId so one review per user.
   – Recalculates course average rating from existing docs.
   – Validates rating is integer 1–5.
══════════════════════════════════════════════════════════════ */
exports.reviewCourse = onCall(CF_OPTS, async (request) => {
  const log = createLogger('reviewCourse');

  if (!request.auth) _deny('unauthenticated', 'Sign in to leave a review');
  const uid = request.auth.uid;

  const { courseId, rating, comment } = request.data || {};
  _req(courseId, 'courseId');
  _req(String(comment || ''), 'comment', 5, 2000);

  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    _deny('invalid-argument', 'Rating must be an integer between 1 and 5');
  }

  /* ── Verify enrolment ───────────────────────────────────── */
  const enrollSnap = await db.collection('courseEnrollments')
    .doc(_enrollId(uid, courseId))
    .get();
  if (!enrollSnap.exists) _deny('permission-denied', 'You must be enrolled to review this course');

  const reviewRef  = db.collection('courseReviews').doc(_enrollId(uid, courseId));
  const courseRef  = db.collection('courses').doc(courseId);
  const now        = admin.firestore.Timestamp.now();

  await db.runTransaction(async (tx) => {
    /* Read both docs inside the transaction for consistency */
    const [courseSnap, existingReviewSnap] = await Promise.all([
      tx.get(courseRef),
      tx.get(reviewRef),
    ]);

    if (!courseSnap.exists) _deny('not-found', 'Course not found');

    const courseData  = courseSnap.data();
    const isUpdate    = existingReviewSnap.exists;
    const oldRating   = isUpdate ? Number(existingReviewSnap.data().rating || 0) : 0;
    const oldCount    = Number(courseData.reviewCount || 0);
    const oldAvg      = Number(courseData.rating || 0);

    /* Incremental average — O(1) reads, no collection scan */
    let newCount, newAvg;
    if (isUpdate) {
      newCount = Math.max(1, oldCount);
      newAvg   = oldCount > 0
        ? ((oldAvg * oldCount) - oldRating + ratingNum) / oldCount
        : ratingNum;
    } else {
      newCount = oldCount + 1;
      newAvg   = ((oldAvg * oldCount) + ratingNum) / newCount;
    }
    newAvg = Math.round(newAvg * 10) / 10;

    /* Upsert review */
    tx.set(reviewRef, {
      uid,
      courseId,
      rating:    ratingNum,
      comment:   _sanitize(String(comment).trim()),
      createdAt: isUpdate ? existingReviewSnap.data().createdAt : now,
      updatedAt: now,
    });

    tx.update(courseRef, { rating: newAvg, reviewCount: newCount });
  });

  log.info('reviewPosted', { uid, courseId, rating: ratingNum });
  return { success: true };
});


/* ══════════════════════════════════════════════════════════════
   7. CREATE COURSE  (auth required — instructor)

   Input:  { title, description, category, level, price,
             videoUrl?, thumbnail?, lessonCount?,
             durationMinutes?, tags? }
   Output: { courseId, course }

   – Creates with status: 'draft'.
   – Instructor must publish via a separate admin action.
   – Tags limited to 10 items.
══════════════════════════════════════════════════════════════ */
exports.createCourse = onCall(CF_OPTS, async (request) => {
  const log = createLogger('createCourse');

  if (!request.auth) _deny('unauthenticated', 'Sign in to create a course');
  const uid = request.auth.uid;
  /* EDUCATION E2: approved teacher / institution only (was: ANY signed-in account) */
  const { educationType } = await _assertCourseOwnerCapability(uid);
  const fields = _courseFields(request.data || {});
  const now = admin.firestore.Timestamp.now();

  const course = Object.assign({}, fields, {
    instructorUid:   uid,
    ownerType:       educationType,          /* server-derived: 'teacher' | 'institution' */
    enrollmentCount: 0,
    viewCount:       0,
    rating:          0,
    reviewCount:     0,
    status:          'draft',
    isFeatured:      false,
    createdAt:       now,
    updatedAt:       now,
  });

  const ref = await db.collection('courses').add(course);

  log.info('courseCreated', { uid, courseId: ref.id, category: course.category, level: course.level });
  return { courseId: ref.id, course: { courseId: ref.id, ...course } };
});


/* ══════════════════════════════════════════════════════════════
   8. GET MY ENROLLMENTS  (auth required)

   Input:  {}
   Output: { enrollments: [{...enrolment, course: {...}}] }

   – Single-field query on uid (✓ no composite index).
   – Batch-fetches course docs for title/thumbnail/category/lessonCount.
══════════════════════════════════════════════════════════════ */
exports.getMyEnrollments = onCall(CF_OPTS, async (request) => {
  const log = createLogger('getMyEnrollments');

  if (!request.auth) _deny('unauthenticated', 'Sign in to view your courses');
  const uid = request.auth.uid;

  /* Single-field query ✓ */
  const snap = await db.collection('courseEnrollments')
    .where('uid', '==', uid)
    .limit(50)
    .get();

  if (snap.empty) return { enrollments: [] };

  /* Batch-fetch course docs */
  const courseIds = [...new Set(snap.docs.map(d => d.data().courseId).filter(Boolean))];
  const courseRefs = courseIds.map(id => db.collection('courses').doc(id));
  const courseSnaps = courseRefs.length ? await db.getAll(...courseRefs) : [];

  const courseMap = {};
  courseSnaps.forEach(cs => {
    if (cs.exists) {
      const d = cs.data();
      courseMap[cs.id] = {
        title:       d.title || '',
        thumbnail:   d.thumbnail || '',
        category:    d.category || '',
        lessonCount: d.lessonCount || 0,
        level:       d.level || '',
        durationMinutes: d.durationMinutes || 0,
      };
    }
  });

  const enrollments = snap.docs.map(d => ({
    enrollmentId: d.id,
    ...d.data(),
    course: courseMap[d.data().courseId] || null,
  }));

  /* Sort: most recently accessed first */
  enrollments.sort((a, b) => {
    const ta = a.lastAccessedAt?.seconds || 0;
    const tb = b.lastAccessedAt?.seconds || 0;
    return tb - ta;
  });

  log.info('myEnrollments', { uid, count: enrollments.length });
  return { enrollments };
});

/* EDUCATION E2 — the course review lifecycle (was: an admin could publish ANY course from ANY state, with no audit):
     owner:  draft ──submit──▶ pending_review          (approved educator, own course only)
     admin:  pending_review ──publish──▶ published      (the owner must STILL be an approved educator)
             pending_review ──reject──▶ draft (+ reviewNote)
             published ──unpublish──▶ draft
   Every transition is transactional on the course's current status and audited (educationAudit). */
exports.publishCourse = onCall(CF_OPTS, async (request) => {
  if (!request.auth) _deny('unauthenticated', 'Login required');
  const { courseId, action, note } = request.data || {};
  if (!courseId || !action) _deny('invalid-argument', 'courseId and action required');
  if (!['submit', 'publish', 'reject', 'unpublish'].includes(action)) _deny('invalid-argument', 'invalid action');
  const uid = request.auth.uid;
  const isAdmin = request.auth.token.admin === true || request.auth.token.superAdmin === true;
  const courseRef = db.collection('courses').doc(String(courseId));
  const pre = await courseRef.get();
  if (!pre.exists) _deny('not-found', 'course not found');
  const owner = pre.data().instructorUid;

  if (action === 'submit') {
    if (owner !== uid) _deny('permission-denied', 'not course owner', 'NOT_COURSE_OWNER');
    await _assertCourseOwnerCapability(uid);
  } else {
    if (!isAdmin) _deny('permission-denied', 'admin required', 'ADMIN_REQUIRED');
    if (action === 'publish') {
      /* the OWNER must still be an approved educator at the moment of publication */
      try { await _assertCourseOwnerCapability(owner); }
      catch (_) { _deny('failed-precondition', 'The course owner is no longer an approved educator.', 'OWNER_NOT_ELIGIBLE'); }
    }
  }
  const FROM = { submit: 'draft', publish: 'pending_review', reject: 'pending_review', unpublish: 'published' };
  const TO = { submit: 'pending_review', publish: 'published', reject: 'draft', unpublish: 'draft' };
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(courseRef);
    const cur = snap.data() || {};
    if (cur.status !== FROM[action]) _deny('failed-precondition', `only a ${FROM[action]} course can be ${action === 'submit' ? 'submitted' : action + 'ed'}`, 'WRONG_STATUS');
    const patch = { status: TO[action], updatedAt: FieldValue.serverTimestamp() };
    if (action === 'submit') patch.submittedAt = FieldValue.serverTimestamp();
    else { patch.reviewedAt = FieldValue.serverTimestamp(); patch.reviewedBy = uid; }
    if (action === 'reject') patch.reviewNote = _sanitize(String(note || '')).slice(0, 500) || null;
    t.update(courseRef, patch);
    return TO[action];
  });
  await _audit('course_' + action, { courseId: String(courseId), ownerUid: owner, by: uid, admin: isAdmin, note: action === 'reject' ? (_sanitize(String(note || '')).slice(0, 500) || null) : null });
  return { success: true, status: result };
});

/* EDUCATION E2 — the owner's course workspace: list OWN courses (any status) and edit a draft. The caller is the owner;
   there is no owner / teacher / institution parameter. A published or pending course is not editable (unpublish or
   reject returns it to draft first). */
exports.manageMyCourses = onCall(CF_OPTS, async (request) => {
  if (!request.auth) _deny('unauthenticated', 'Sign in to continue');
  const uid = request.auth.uid;
  await _assertCourseOwnerCapability(uid);
  const d = request.data || {};
  if (d.op === 'list') {
    const snap = await db.collection('courses').where('instructorUid', '==', uid).limit(100).get();
    return { courses: snap.docs.map((x) => { const c = x.data(); return { courseId: x.id, title: c.title, status: c.status, price: c.price, level: c.level,
      category: c.category, lessonCount: c.lessonCount, enrollmentCount: c.enrollmentCount || 0, reviewNote: c.reviewNote || null }; }) };
  }
  if (d.op === 'update') {
    const fields = _courseFields(d.course || {});
    const ref = db.collection('courses').doc(String(d.courseId || ''));
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) _deny('not-found', 'course not found');
      const c = snap.data();
      if (c.instructorUid !== uid) _deny('permission-denied', 'not course owner', 'NOT_COURSE_OWNER');
      if (c.status !== 'draft') _deny('failed-precondition', 'Only a draft can be edited.', 'NOT_A_DRAFT');
      t.update(ref, Object.assign({}, fields, { updatedAt: FieldValue.serverTimestamp() }));
    });
    return { success: true };
  }
  _deny('invalid-argument', 'Unknown operation.', 'OP_UNKNOWN');
});


