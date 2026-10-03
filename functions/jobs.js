'use strict';

/**
 * SOKONI Jobs Marketplace â€” Cloud Functions
 * Gen2 Firebase Functions, Node.js 22
 *
 * Collections:
 *   jobs/{jobId}
 *   jobApplications/{jobId}_{seekerUid}
 *   jobSeekerProfiles/{uid}
 *   savedJobs/{uid_jobId}
 *
 * Index policy: ONLY single-field where() clauses â€” NO composite indexes.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Login required');
}

function _requireAdmin(ctx) {
  if (!ctx.auth?.token?.admin && !ctx.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
}

/** Sanitise user-supplied text: strip HTML tags, trim, truncate. */
function _san(s, max = 500) {
  return s == null ? '' : String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/* 'freelance-gig' (owner 2026-10-03): freelance gigs moved from digital.html are a job TYPE on this one board — the
   same application → interview → offer → hired chain, 0% commission (commission-config RATES.jobs). */
const VALID_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'remote', 'freelance-gig'];

const VALID_CATEGORIES = [
  'technology', 'finance', 'healthcare', 'education', 'retail',
  'logistics', 'hospitality', 'marketing', 'legal', 'engineering',
  'admin', 'other',
];

/* ─── Application state machine (owner 2026-10-03) ─────────────────────────────────────────────────────────────
   Stored values (kept compatible with live data: 'pending' = Submitted, 'reviewing' = Under Review):
     pending → reviewing → shortlisted → interview → offer → offer_accepted → hired
   Terminal: rejected · withdrawn · offer_declined · closed · hired.
   The SERVER decides every transition; the UI is never the authorization layer. Each change is written in ONE
   transaction with: the new status, statusVersion+1, an audit event (jobApplications/{id}/events), and an in-app
   notification to the other party (same document shape notify.js writes to 'notifications'). A legacy document
   whose status the live free-form update left as 'hired' / 'rejected' is terminal here. */
const APP_TERMINAL = ['hired', 'rejected', 'withdrawn', 'offer_declined', 'closed'];
const EMPLOYER_TRANSITIONS = {
  pending:        ['reviewing', 'shortlisted', 'rejected'],
  reviewing:      ['shortlisted', 'rejected'],
  shortlisted:    ['interview', 'rejected'],
  interview:      ['offer', 'rejected'],
  offer:          ['rejected'],              /* the employer may withdraw an unanswered offer, with a reason */
  offer_accepted: ['hired'],
};
const APPLICANT_WITHDRAWABLE = ['pending', 'reviewing', 'shortlisted', 'interview', 'offer'];
/* Closing a vacancy closes only the early-stage applications; in-flight interviews / offers stay with the employer. */
const CLOSE_ON_JOB_CLOSE = ['pending', 'reviewing', 'shortlisted'];
const VALID_APP_STATUSES = Object.keys(EMPLOYER_TRANSITIONS).reduce((a, k) => a.concat(EMPLOYER_TRANSITIONS[k]), [])
  .filter((v, i, a) => a.indexOf(v) === i);
const REASON_REQUIRED = ['rejected'];
const STATUS_LABEL = {
  pending: 'Submitted', reviewing: 'Under review', shortlisted: 'Shortlisted', interview: 'Interview',
  offer: 'Offer made', offer_accepted: 'Offer accepted', hired: 'Hired', rejected: 'Not selected',
  withdrawn: 'Withdrawn', offer_declined: 'Offer declined', closed: 'Vacancy closed',
};
const MAX_EXPIRY_DAYS = 90;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function _err(code, msg) { return new HttpsError(code, msg); }

/** Salary: optional, whole KES 0..100,000,000, and min ≤ max when both are given. */
function _salary(min, max) {
  const conv = (v, name) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw _err('invalid-argument', name + ' must be a whole amount in KES between 0 and 100,000,000');
    return Math.round(n);
  };
  const lo = conv(min, 'salaryMin'), hi = conv(max, 'salaryMax');
  if (lo != null && hi != null && lo > hi) throw _err('invalid-argument', 'salaryMin cannot be greater than salaryMax');
  return { salaryMin: lo, salaryMax: hi };
}

/** Expiry: 1..MAX_EXPIRY_DAYS days from now. Accepts expiresInDays (preferred) or an expiresAt date (ms / ISO). */
function _expiry(expiresInDays, expiresAt) {
  let ms;
  if (expiresInDays != null && expiresInDays !== '') {
    const d = Math.floor(Number(expiresInDays));
    if (!Number.isFinite(d) || d < 1 || d > MAX_EXPIRY_DAYS) throw _err('invalid-argument', 'A vacancy can stay open for 1 to ' + MAX_EXPIRY_DAYS + ' days');
    ms = Date.now() + d * 86_400_000;
  } else {
    ms = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt || ''));
    if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + MAX_EXPIRY_DAYS * 86_400_000) {
      throw _err('invalid-argument', 'The closing date must be in the future and within ' + MAX_EXPIRY_DAYS + ' days');
    }
  }
  return Timestamp.fromMillis(ms);
}

/** A CV link must be https (never javascript:/data:). */
function _httpsUrl(v, max = 500) {
  if (v == null || v === '') return null;
  const s = _san(v, max);
  let u; try { u = new URL(s); } catch (_) { throw _err('invalid-argument', 'The CV link must be a full https:// address'); }
  if (u.protocol !== 'https:') throw _err('invalid-argument', 'The CV link must be a full https:// address');
  return u.toString();
}

/** In-app notification in the notify.js document shape, written inside the caller's transaction. Deterministic id:
    a retried transition re-writes the same document instead of notifying twice. */
function _notifyInTxn(txn, db, { uid, id, type, title, body, deepLink }) {
  if (!uid) return;
  txn.set(db.collection('notifications').doc(id), {
    userId: uid, targetUid: uid, type, category: 'jobs', priority: 'commerce',
    title, body, image: null, deepLink: deepLink || null, group: 'jobs', read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function _eventInTxn(txn, appRef, app, { from, to, actorUid, actorRole, reason }) {
  txn.set(appRef.collection('events').doc(), {
    from: from || null, to, actorUid, actorRole, reason: reason || null,
    jobId: app.jobId, employerUid: app.employerUid, seekerUid: app.seekerUid,
    at: FieldValue.serverTimestamp(),
  });
}

/** Fields safe to return in public job listings (no employerUid). */
function _publicJobFields(id, data) {
  return {
    jobId:            id,
    title:            data.title,
    companyName:      data.companyName,
    category:         data.category,
    type:             data.type,
    location:         data.location,
    salaryMin:        data.salaryMin  ?? null,
    salaryMax:        data.salaryMax  ?? null,
    salaryCurrency:   data.salaryCurrency,
    postedAt:         data.postedAt,
    expiresAt:        data.expiresAt,
    applicationCount: data.applicationCount,
    viewCount:        data.viewCount,
    featured:         data.featured,
    status:           data.status,
  };
}

/** Returns true if the job has not yet expired. */
function _isActive(data) {
  if (data.status !== 'active') return false;
  if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return false;
  return true;
}

// â”€â”€â”€ 1. createJob â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports._h = {};

const CF_OPTS = { cors: true, enforceAppCheck: true };

exports.createJob = onCall(CF_OPTS, exports._h.createJob = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const {
    title,
    description,
    requirements,
    category,
    type,
    location,
    salaryMin,
    salaryMax,
    expiresInDays,
  } = req.data || {};

  // â”€â”€ Validation â”€â”€
  const cleanTitle = _san(title, 100);
  if (!cleanTitle || cleanTitle.length < 3) {
    throw new HttpsError('invalid-argument', 'title must be 3-100 characters');
  }

  const cleanDescription = _san(description, 5000);
  if (!cleanDescription || cleanDescription.length < 20) {
    throw new HttpsError('invalid-argument', 'description must be 20-5000 characters');
  }

  if (!VALID_TYPES.includes(type)) {
    throw new HttpsError('invalid-argument', 'type must be one of: ' + VALID_TYPES.join(', '));
  }

  if (!VALID_CATEGORIES.includes(category)) {
    throw new HttpsError('invalid-argument', 'category must be one of: ' + VALID_CATEGORIES.join(', '));
  }

  const cleanLocation     = _san(location, 200);
  const cleanRequirements = _san(requirements, 3000);
  const salary            = _salary(salaryMin, salaryMax);
  const expiresAt         = _expiry(expiresInDays == null || expiresInDays === '' ? 30 : expiresInDays);

  // â”€â”€ Resolve company name â”€â”€
  let companyName = 'Company';
  try {
    const shopSnap = await db.collection('shops').doc(uid).get();
    if (shopSnap.exists) {
      companyName = _san(shopSnap.data().name || shopSnap.data().shopName || 'Company', 200) || 'Company';
    }
  } catch (_) { /* non-fatal */ }

  const job = {
    employerUid:      uid,
    companyName,
    title:            cleanTitle,
    description:      cleanDescription,
    requirements:     cleanRequirements,
    category,
    type,
    location:         cleanLocation,
    salaryMin:        salary.salaryMin,
    salaryMax:        salary.salaryMax,
    salaryCurrency:   'KES',
    status:           'active',
    featured:         false,
    postedAt:         Timestamp.now(),
    expiresAt,
    viewCount:        0,
    applicationCount: 0,
  };

  const ref = await db.collection('jobs').add(job);

  return { jobId: ref.id, job: { ..._publicJobFields(ref.id, job), employerUid: uid } };
});

// â”€â”€â”€ 2. updateJob â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.updateJob = onCall(CF_OPTS, exports._h.updateJob = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId, ...raw } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
  if (jobSnap.data().employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job');

  const ALLOWED = ['title', 'description', 'requirements', 'category', 'type', 'location', 'salaryMin', 'salaryMax', 'expiresAt', 'expiresInDays'];
  const update  = {};
  const current = jobSnap.data();

  for (const key of ALLOWED) {
    if (!(key in raw)) continue;

    if (key === 'title') {
      const v = _san(raw.title, 100);
      if (!v || v.length < 3) throw new HttpsError('invalid-argument', 'title must be 3-100 characters');
      update.title = v;
    } else if (key === 'description') {
      const v = _san(raw.description, 5000);
      if (!v || v.length < 20) throw new HttpsError('invalid-argument', 'description must be 20-5000 characters');
      update.description = v;
    } else if (key === 'requirements') {
      update.requirements = _san(raw.requirements, 3000);
    } else if (key === 'category') {
      if (!VALID_CATEGORIES.includes(raw.category)) {
        throw new HttpsError('invalid-argument', 'category must be one of: ' + VALID_CATEGORIES.join(', '));
      }
      update.category = raw.category;
    } else if (key === 'type') {
      if (!VALID_TYPES.includes(raw.type)) {
        throw new HttpsError('invalid-argument', 'type must be one of: ' + VALID_TYPES.join(', '));
      }
      update.type = raw.type;
    } else if (key === 'location') {
      update.location = _san(raw.location, 200);
    } else if (key === 'expiresAt' || key === 'expiresInDays') {
      /* Was stored RAW from the client — any type, any date (a vacancy could be kept open for ever). */
      update.expiresAt = _expiry(raw.expiresInDays, raw.expiresAt);
    }
  }
  if ('salaryMin' in raw || 'salaryMax' in raw) {
    /* Validated together against the stored counterpart, so min ≤ max always holds. */
    const s = _salary('salaryMin' in raw ? raw.salaryMin : current.salaryMin, 'salaryMax' in raw ? raw.salaryMax : current.salaryMax);
    update.salaryMin = s.salaryMin; update.salaryMax = s.salaryMax;
  }
  if (current.status === 'closed' && update.expiresAt) {
    throw new HttpsError('failed-precondition', 'This vacancy is closed. Post a new vacancy instead of re-opening it.');
  }

  if (Object.keys(update).length === 0) throw new HttpsError('invalid-argument', 'No valid fields to update');

  await jobRef.update(update);
  return { success: true };
});

// â”€â”€â”€ 3. closeJob â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.closeJob = onCall(CF_OPTS, exports._h.closeJob = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
  if (jobSnap.data().employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job');

  await jobRef.update({ status: 'closed', closedAt: Timestamp.now() });

  /* Close the early-stage applications (owner state 'Closed') so applicants are told, each in its own transaction that
     re-reads the status — a concurrent employer transition is never overwritten. Idempotent: a re-run finds them closed. */
  const appsSnap = await db.collection('jobApplications').where('jobId', '==', jobId).limit(300).get();
  const title = _san(jobSnap.data().title, 100);
  let closedApplications = 0;
  for (const d of appsSnap.docs) {
    if (!CLOSE_ON_JOB_CLOSE.includes((d.data() || {}).status)) continue;
    const done = await db.runTransaction(async (txn) => {
      const s = await txn.get(d.ref);
      const app = s.exists ? s.data() : null;
      if (!app || !CLOSE_ON_JOB_CLOSE.includes(app.status)) return false;
      const version = (Number(app.statusVersion) || 0) + 1;
      txn.update(d.ref, { status: 'closed', statusVersion: version, updatedAt: Timestamp.now() });
      _eventInTxn(txn, d.ref, app, { from: app.status, to: 'closed', actorUid: uid, actorRole: 'employer', reason: 'vacancy closed' });
      _notifyInTxn(txn, db, { uid: app.seekerUid, id: 'jobapp_' + d.id + '_v' + version, type: 'job_application_status',
        title: 'Vacancy closed', body: 'The vacancy "' + title + '" has closed. Thank you for applying.', deepLink: '/jobs.html#applications' });
      return true;
    });
    if (done) closedApplications++;
  }
  return { success: true, closedApplications };
});

// â”€â”€â”€ 4. listJobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.listJobs = onCall(CF_OPTS, exports._h.listJobs = async (req) => {
  // Public â€” no auth required
  const db = getFirestore();

  const {
    category,
    type,
    location,
    featured,
    page = 0,
  } = req.data || {};

  // Single-field query only
  const snap = await db.collection('jobs')
    .where('status', '==', 'active')
    .limit(200) // over-fetch to allow JS filtering + pagination
    .get();

  const now = Date.now();

  let jobs = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    // JS-side expiry filter
    .filter(j => !j.expiresAt || j.expiresAt.toMillis() >= now);

  // JS-side filters (no composite indexes)
  if (category)         jobs = jobs.filter(j => j.category === category);
  if (type)             jobs = jobs.filter(j => j.type === type);
  if (location)         jobs = jobs.filter(j => j.location && j.location.toLowerCase().includes(String(location).toLowerCase()));
  if (featured === true || featured === 'true') jobs = jobs.filter(j => j.featured === true);

  // Sort newest first
  jobs.sort((a, b) => (b.postedAt?.toMillis() || 0) - (a.postedAt?.toMillis() || 0));

  const pageNum  = Math.max(0, Number(page) || 0);
  const pageSize = 20;
  const total    = jobs.length;
  const slice    = jobs.slice(pageNum * pageSize, pageNum * pageSize + pageSize);

  return {
    jobs:    slice.map(j => _publicJobFields(j.id, j)),
    total,
    page:    pageNum,
    hasMore: (pageNum + 1) * pageSize < total,
  };
});

// â”€â”€â”€ 5. getJob â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.getJob = onCall(CF_OPTS, exports._h.getJob = async (req) => {
  // Public â€” no auth required
  const db     = getFirestore();
  const uid    = req.auth?.uid || null;
  const { jobId } = req.data || {};

  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  if (!ID_RE.test(String(jobId))) throw new HttpsError('invalid-argument', 'jobId is not valid');
  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');

  const data    = jobSnap.data();
  const isOwner = !!uid && data.employerUid === uid;
  const isAdmin = !!(req.auth?.token?.admin || req.auth?.token?.superAdmin);
  /* A job that is not publicly open (closed / expired / any non-active state) is visible only to its employer and to
     admins; everyone else gets the same not-found as a missing job, so its existence is not disclosed either. */
  if (!_isActive(data) && !isOwner && !isAdmin) throw new HttpsError('not-found', 'Job not found');

  // Count public views only (the employer reloading their own vacancy is not a view).
  if (!isOwner && !isAdmin) jobRef.update({ viewCount: FieldValue.increment(1) }).catch(() => {});

  const result = {
    job: {
      ...{
        description:  data.description,
        requirements: data.requirements,
      },
      ..._publicJobFields(jobId, data),
    },
  };

  // Check if authenticated caller has already applied
  if (uid) {
    const appSnap = await db.collection('jobApplications').doc(`${jobId}_${uid}`).get();
    result.hasApplied = appSnap.exists;
  }

  return result;
});

// â”€â”€â”€ 6. applyForJob â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.applyForJob = onCall(CF_OPTS, exports._h.applyForJob = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId, coverLetter, cvUrl } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');
  if (!ID_RE.test(String(jobId))) throw new HttpsError('invalid-argument', 'jobId is not valid');

  const cleanCover = _san(coverLetter, 2000);
  if (!cleanCover || cleanCover.length < 20) {
    throw new HttpsError('invalid-argument', 'coverLetter must be 20-2000 characters');
  }
  const cleanCv = _httpsUrl(cvUrl);

  // Idempotency via deterministic doc ID
  const applicationId = `${jobId}_${uid}`;
  const appRef        = db.collection('jobApplications').doc(applicationId);
  const jobRef        = db.collection('jobs').doc(jobId);

  let isReplay = false;
  let jobData  = null;

  await db.runTransaction(async (txn) => {
    // Idempotency check must be the first read in the transaction
    const existing = await txn.get(appRef);
    if (existing.exists) { isReplay = true; return; }

    const jobSnap = await txn.get(jobRef);
    if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
    jobData = jobSnap.data();
    if (!_isActive(jobData)) throw new HttpsError('failed-precondition', 'This job is no longer accepting applications');
    if (jobData.employerUid === uid) throw new HttpsError('failed-precondition', 'You cannot apply to your own vacancy');

    const now = Timestamp.now();
    const application = {
      jobId,
      seekerUid:     uid,
      employerUid:   jobData.employerUid,
      /* Snapshot of the vacancy at the time of applying — the record stays meaningful if the job is edited later. */
      jobTitle:      _san(jobData.title, 100),
      companyName:   _san(jobData.companyName, 200),
      jobType:       jobData.type || null,
      coverLetter:   cleanCover,
      cvUrl:         cleanCv,
      status:        'pending',
      statusVersion: 1,
      appliedAt:     now,
      updatedAt:     now,
    };

    txn.set(appRef, application);
    txn.update(jobRef, { applicationCount: FieldValue.increment(1) });
    _eventInTxn(txn, appRef, application, { from: null, to: 'pending', actorUid: uid, actorRole: 'applicant' });
    _notifyInTxn(txn, db, { uid: jobData.employerUid, id: 'jobapp_' + applicationId + '_v1', type: 'job_application_received',
      title: 'New application', body: 'Someone applied for "' + application.jobTitle + '".', deepLink: '/jobs.html#employer' });
  });

  if (isReplay) return { alreadyApplied: true, applicationId };

  return { success: true, applicationId };
});

// â”€â”€â”€ 7. getJobApplications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.getJobApplications = onCall(CF_OPTS, exports._h.getJobApplications = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  // Employer ownership check
  const jobSnap = await db.collection('jobs').doc(jobId).get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
  if (jobSnap.data().employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job');

  // Single-field query
  const appsSnap = await db.collection('jobApplications')
    .where('jobId', '==', jobId)
    .limit(100)
    .get();

  const applications = appsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Batch fetch seeker profiles
  const seekerUids   = [...new Set(applications.map(a => a.seekerUid))];
  const profileMap   = {};

  if (seekerUids.length > 0) {
    // Firestore batch get â€” doc lookups, not queries
    const profileRefs = seekerUids.map(u => db.collection('jobSeekerProfiles').doc(u));
    const profileSnaps = await db.getAll(...profileRefs);
    profileSnaps.forEach(snap => {
      if (snap.exists) {
        const pd = snap.data();
        profileMap[snap.id] = {
          name:     pd.name     || null,
          headline: pd.headline || null,
          skills:   pd.skills   || [],
          location: pd.location || null,
        };
      }
    });
  }

  const enriched = applications.map(app => ({
    id:            app.id,
    jobId:         app.jobId,
    seekerUid:     app.seekerUid,
    coverLetter:   app.coverLetter,
    cvUrl:         app.cvUrl,
    status:        app.status,
    statusLabel:   STATUS_LABEL[app.status] || app.status,
    statusVersion: Number(app.statusVersion) || 1,
    appliedAt:     app.appliedAt,
    updatedAt:     app.updatedAt,
    seekerProfile: profileMap[app.seekerUid] || null,
  }));

  // Sort by appliedAt desc
  enriched.sort((a, b) => (b.appliedAt?.toMillis() || 0) - (a.appliedAt?.toMillis() || 0));

  return { applications: enriched };
});

// â”€â”€â”€ 8. updateApplicationStatus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.updateApplicationStatus = onCall(CF_OPTS, exports._h.updateApplicationStatus = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { applicationId, status, reason, expectedVersion } = req.data || {};
  if (!applicationId || !ID_RE.test(String(applicationId))) throw new HttpsError('invalid-argument', 'applicationId required');
  if (!VALID_APP_STATUSES.includes(status)) {
    throw new HttpsError('invalid-argument', 'status must be one of: ' + VALID_APP_STATUSES.join(', '));
  }
  const cleanReason = _san(reason, 500);
  if (REASON_REQUIRED.includes(status) && cleanReason.length < 3) {
    throw new HttpsError('invalid-argument', 'Give the applicant a short reason (at least 3 characters).');
  }

  const appRef = db.collection('jobApplications').doc(applicationId);
  /* ONE transaction: re-read, ownership, legal transition from the CURRENT state, optimistic version, audit event,
     applicant notification. Two employer tabs cannot both move the same application. */
  const out = await db.runTransaction(async (txn) => {
    const appSnap = await txn.get(appRef);
    if (!appSnap.exists) throw new HttpsError('not-found', 'Application not found');
    const app = appSnap.data();
    if (app.employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job application');
    const version = Number(app.statusVersion) || 1;
    if (expectedVersion != null && Number(expectedVersion) !== version) {
      throw new HttpsError('aborted', 'This application was updated elsewhere. Reload and try again.');
    }
    if (app.status === status) return { unchanged: true, status, statusVersion: version };
    const allowed = EMPLOYER_TRANSITIONS[app.status] || [];
    if (!allowed.includes(status)) {
      throw new HttpsError('failed-precondition',
        'An application that is "' + (STATUS_LABEL[app.status] || app.status) + '" cannot move to "' + (STATUS_LABEL[status] || status) + '".');
    }
    const next = version + 1;
    txn.update(appRef, { status, statusVersion: next, updatedAt: Timestamp.now(),
      ...(status === 'rejected' ? { rejectionReason: cleanReason } : {}) });
    _eventInTxn(txn, appRef, app, { from: app.status, to: status, actorUid: uid, actorRole: 'employer', reason: cleanReason });
    const jt = _san(app.jobTitle, 100) || 'your application';
    const body = status === 'offer' ? 'You have an offer for "' + jt + '". Open your applications to accept or decline.'
      : status === 'rejected' ? 'Your application for "' + jt + '" was not selected.' + (cleanReason ? ' ' + cleanReason : '')
      : status === 'hired' ? 'Congratulations — you are hired for "' + jt + '".'
      : 'Your application for "' + jt + '" is now: ' + STATUS_LABEL[status] + '.';
    _notifyInTxn(txn, db, { uid: app.seekerUid, id: 'jobapp_' + applicationId + '_v' + next,
      type: status === 'offer' ? 'job_offer' : 'job_application_status', title: STATUS_LABEL[status], body, deepLink: '/jobs.html#applications' });
    return { status, statusVersion: next };
  });
  return { success: true, ...out };
});

// ─── 8b. withdrawApplication (applicant) ─────────────────────────────────────────────────────────────────────

exports._h.withdrawApplication = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();
  const { applicationId, reason } = req.data || {};
  if (!applicationId || !ID_RE.test(String(applicationId))) throw new HttpsError('invalid-argument', 'applicationId required');
  const appRef = db.collection('jobApplications').doc(applicationId);
  return db.runTransaction(async (txn) => {
    const s = await txn.get(appRef);
    if (!s.exists) throw new HttpsError('not-found', 'Application not found');
    const app = s.data();
    if (app.seekerUid !== uid) throw new HttpsError('permission-denied', 'Not your application');
    if (app.status === 'withdrawn') return { success: true, unchanged: true, status: 'withdrawn' };
    if (!APPLICANT_WITHDRAWABLE.includes(app.status)) {
      throw new HttpsError('failed-precondition', 'An application that is "' + (STATUS_LABEL[app.status] || app.status) + '" can no longer be withdrawn.');
    }
    const next = (Number(app.statusVersion) || 1) + 1;
    const r = _san(reason, 500);
    txn.update(appRef, { status: 'withdrawn', statusVersion: next, updatedAt: Timestamp.now() });
    _eventInTxn(txn, appRef, app, { from: app.status, to: 'withdrawn', actorUid: uid, actorRole: 'applicant', reason: r });
    _notifyInTxn(txn, db, { uid: app.employerUid, id: 'jobapp_' + applicationId + '_v' + next, type: 'job_application_status',
      title: 'Application withdrawn', body: 'An applicant withdrew from "' + (_san(app.jobTitle, 100) || 'your vacancy') + '".', deepLink: '/jobs.html#employer' });
    return { success: true, status: 'withdrawn', statusVersion: next };
  });
};

// ─── 8c. respondToJobOffer (applicant: accept | decline) ─────────────────────────────────────────────────────

exports._h.respondToJobOffer = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();
  const { applicationId, accept, reason } = req.data || {};
  if (!applicationId || !ID_RE.test(String(applicationId))) throw new HttpsError('invalid-argument', 'applicationId required');
  if (typeof accept !== 'boolean') throw new HttpsError('invalid-argument', 'accept must be true or false');
  const to = accept ? 'offer_accepted' : 'offer_declined';
  const appRef = db.collection('jobApplications').doc(applicationId);
  return db.runTransaction(async (txn) => {
    const s = await txn.get(appRef);
    if (!s.exists) throw new HttpsError('not-found', 'Application not found');
    const app = s.data();
    if (app.seekerUid !== uid) throw new HttpsError('permission-denied', 'Not your application');
    if (app.status === to) return { success: true, unchanged: true, status: to };
    if (app.status !== 'offer') throw new HttpsError('failed-precondition', 'There is no open offer on this application.');
    const next = (Number(app.statusVersion) || 1) + 1;
    const r = _san(reason, 500);
    txn.update(appRef, { status: to, statusVersion: next, updatedAt: Timestamp.now() });
    _eventInTxn(txn, appRef, app, { from: 'offer', to, actorUid: uid, actorRole: 'applicant', reason: r });
    _notifyInTxn(txn, db, { uid: app.employerUid, id: 'jobapp_' + applicationId + '_v' + next, type: 'job_offer_response',
      title: accept ? 'Offer accepted' : 'Offer declined',
      body: 'The applicant ' + (accept ? 'accepted' : 'declined') + ' your offer for "' + (_san(app.jobTitle, 100) || 'your vacancy') + '".' + (accept ? ' Mark them hired to complete it.' : ''),
      deepLink: '/jobs.html#employer' });
    return { success: true, status: to, statusVersion: next };
  });
};

// ─── 8d. getApplicationHistory (applicant, employer or admin) ────────────────────────────────────────────────

exports._h.getApplicationHistory = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();
  const { applicationId } = req.data || {};
  if (!applicationId || !ID_RE.test(String(applicationId))) throw new HttpsError('invalid-argument', 'applicationId required');
  const appRef = db.collection('jobApplications').doc(applicationId);
  const s = await appRef.get();
  if (!s.exists) throw new HttpsError('not-found', 'Application not found');
  const app = s.data();
  const isAdmin = !!(req.auth.token?.admin || req.auth.token?.superAdmin);
  if (app.seekerUid !== uid && app.employerUid !== uid && !isAdmin) throw new HttpsError('permission-denied', 'Not your application');
  const ev = await appRef.collection('events').limit(100).get();
  const events = ev.docs.map((d) => d.data())
    .map((e) => ({ from: e.from, to: e.to, label: STATUS_LABEL[e.to] || e.to, actorRole: e.actorRole, reason: e.reason || null,
      at: e.at && e.at.toMillis ? e.at.toMillis() : null }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  return { applicationId, status: app.status, label: STATUS_LABEL[app.status] || app.status, statusVersion: Number(app.statusVersion) || 1, events };
};

// â”€â”€â”€ 9. getMyApplications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.getMyApplications = onCall(CF_OPTS, exports._h.getMyApplications = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  // Single-field query
  const appsSnap = await db.collection('jobApplications')
    .where('seekerUid', '==', uid)
    .limit(50)
    .get();

  const applications = appsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Sort by appliedAt desc
  applications.sort((a, b) => (b.appliedAt?.toMillis() || 0) - (a.appliedAt?.toMillis() || 0));

  // Batch fetch job metadata
  const jobIds   = [...new Set(applications.map(a => a.jobId))];
  const jobMap   = {};

  if (jobIds.length > 0) {
    const jobRefs  = jobIds.map(jid => db.collection('jobs').doc(jid));
    const jobSnaps = await db.getAll(...jobRefs);
    jobSnaps.forEach(snap => {
      if (snap.exists) {
        const jd = snap.data();
        jobMap[snap.id] = {
          title:       jd.title,
          companyName: jd.companyName,
          status:      jd.status,
          location:    jd.location,
        };
      }
    });
  }

  const enriched = applications.map(app => ({
    id:          app.id,
    jobId:       app.jobId,
    coverLetter: app.coverLetter,
    cvUrl:       app.cvUrl,
    status:      app.status,
    statusLabel: STATUS_LABEL[app.status] || app.status,
    statusVersion: Number(app.statusVersion) || 1,
    /* what the applicant may do now (the server re-checks on the call) */
    canWithdraw: APPLICANT_WITHDRAWABLE.includes(app.status),
    canRespondToOffer: app.status === 'offer',
    appliedAt:   app.appliedAt,
    updatedAt:   app.updatedAt,
    job:         jobMap[app.jobId] || null,
  }));

  return { applications: enriched };
});

// â”€â”€â”€ 10. saveJobSeekerProfile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.saveJobSeekerProfile = onCall(CF_OPTS, exports._h.saveJobSeekerProfile = async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const {
    name,
    headline,
    bio,
    skills,
    experience,
    education,
    cvUrl,
    linkedIn,
    location,
    availability,
  } = req.data || {};

  // â”€â”€ Validation â”€â”€
  const cleanName = _san(name, 100);
  if (!cleanName || cleanName.length < 2) {
    throw new HttpsError('invalid-argument', 'name must be 2-100 characters');
  }

  let cleanSkills = [];
  if (Array.isArray(skills)) {
    if (skills.length > 20) throw new HttpsError('invalid-argument', 'skills array must not exceed 20 items');
    cleanSkills = skills.map(s => _san(s, 100)).filter(Boolean);
  }

  const profile = {
    uid,
    name:         cleanName,
    headline:     _san(headline, 200),
    bio:          _san(bio, 2000),
    skills:       cleanSkills,
    experience:   Array.isArray(experience) ? experience.slice(0, 20) : [],
    education:    Array.isArray(education)  ? education.slice(0, 10)  : [],
    cvUrl:        cvUrl       ? _san(cvUrl, 500)       : null,
    linkedIn:     linkedIn    ? _san(linkedIn, 300)    : null,
    location:     location    ? _san(location, 200)    : null,
    availability: availability ? _san(availability, 100) : null,
    updatedAt:    Timestamp.now(),
  };

  await db.collection('jobSeekerProfiles').doc(uid).set(profile, { merge: true });
  return { success: true };
});

// â”€â”€â”€ 11. getJobSeekerProfile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.getJobSeekerProfile = onCall(CF_OPTS, exports._h.getJobSeekerProfile = async (req) => {
  _requireAuth(req);
  const callerUid = req.auth.uid;
  const db        = getFirestore();

  // uid param: view another person's profile; omit for own profile
  const targetUid = req.data?.uid ? String(req.data.uid) : callerUid;

  // Seeker profiles are semi-public for any authenticated user.
  // (Composite index would be required to verify employer relationship â€” avoided.)
  const snap = await db.collection('jobSeekerProfiles').doc(targetUid).get();
  if (!snap.exists) return { profile: null };

  const pd = snap.data();

  // If caller is viewing someone else's profile, redact cvUrl (link only shared
  // through the formal application flow to avoid cold-contact harvesting).
  const isSelf = callerUid === targetUid;

  return {
    profile: {
      uid:          pd.uid,
      name:         pd.name,
      headline:     pd.headline,
      bio:          pd.bio,
      skills:       pd.skills,
      experience:   pd.experience,
      education:    pd.education,
      cvUrl:        isSelf ? pd.cvUrl : undefined,
      linkedIn:     pd.linkedIn,
      location:     pd.location,
      availability: pd.availability,
      updatedAt:    pd.updatedAt,
    },
  };
});

// â”€â”€â”€ 12. getFeaturedJobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.getFeaturedJobs = onCall(CF_OPTS, exports._h.getFeaturedJobs = async (req) => {
  // Public â€” no auth required
  const db  = getFirestore();
  const now = Date.now();

  // Single-field query
  const snap = await db.collection('jobs')
    .where('featured', '==', true)
    .limit(30) // over-fetch; filter active in JS
    .get();

  const jobs = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(_isActive)
    .sort((a, b) => (b.postedAt?.toMillis() || 0) - (a.postedAt?.toMillis() || 0))
    .slice(0, 10)
    .map(j => _publicJobFields(j.id, j));

  return { jobs };
});
