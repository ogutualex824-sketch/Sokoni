'use strict';

/**
 * SOKONI Jobs Marketplace — Cloud Functions
 * Gen2 Firebase Functions, Node.js 22
 *
 * Collections:
 *   jobs/{jobId}
 *   jobApplications/{jobId}_{seekerUid}
 *   jobSeekerProfiles/{uid}
 *   savedJobs/{uid_jobId}
 *
 * Index policy: ONLY single-field where() clauses — NO composite indexes.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const VALID_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'remote'];

const VALID_CATEGORIES = [
  'technology', 'finance', 'healthcare', 'education', 'retail',
  'logistics', 'hospitality', 'marketing', 'legal', 'engineering',
  'admin', 'other',
];

const VALID_APP_STATUSES = ['reviewing', 'shortlisted', 'rejected', 'hired'];

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

// ─── 1. createJob ────────────────────────────────────────────────────────────

exports.createJob = onCall({ cors: true }, async (req) => {
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

  // ── Validation ──
  const cleanTitle = _san(title, 100);
  if (!cleanTitle || cleanTitle.length < 3) {
    throw new HttpsError('invalid-argument', 'title must be 3-100 characters');
  }

  const cleanDescription = _san(description, 5000);
  if (!cleanDescription || cleanDescription.length < 20) {
    throw new HttpsError('invalid-argument', 'description must be 20-5000 characters');
  }

  if (!VALID_TYPES.includes(type)) {
    throw new HttpsError('invalid-argument', );
  }

  if (!VALID_CATEGORIES.includes(category)) {
    throw new HttpsError('invalid-argument', );
  }

  const cleanLocation     = _san(location, 200);
  const cleanRequirements = _san(requirements, 3000);
  const days              = Number(expiresInDays) || 30;

  // ── Resolve company name ──
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
    salaryMin:        salaryMin != null ? Number(salaryMin) : null,
    salaryMax:        salaryMax != null ? Number(salaryMax) : null,
    salaryCurrency:   'KES',
    status:           'active',
    featured:         false,
    postedAt:         Timestamp.now(),
    expiresAt:        Timestamp.fromMillis(Date.now() + days * 86_400_000),
    viewCount:        0,
    applicationCount: 0,
  };

  const ref = await db.collection('jobs').add(job);

  return { jobId: ref.id, job: { ..._publicJobFields(ref.id, job), employerUid: uid } };
});

// ─── 2. updateJob ────────────────────────────────────────────────────────────

exports.updateJob = onCall({ cors: true }, async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId, ...raw } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
  if (jobSnap.data().employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job');

  const ALLOWED = ['title', 'description', 'requirements', 'category', 'type', 'location', 'salaryMin', 'salaryMax', 'expiresAt'];
  const update  = {};

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
        throw new HttpsError('invalid-argument', );
      }
      update.category = raw.category;
    } else if (key === 'type') {
      if (!VALID_TYPES.includes(raw.type)) {
        throw new HttpsError('invalid-argument', );
      }
      update.type = raw.type;
    } else if (key === 'location') {
      update.location = _san(raw.location, 200);
    } else if (key === 'salaryMin') {
      update.salaryMin = raw.salaryMin != null ? Number(raw.salaryMin) : null;
    } else if (key === 'salaryMax') {
      update.salaryMax = raw.salaryMax != null ? Number(raw.salaryMax) : null;
    } else if (key === 'expiresAt') {
      update.expiresAt = raw.expiresAt;
    }
  }

  if (Object.keys(update).length === 0) throw new HttpsError('invalid-argument', 'No valid fields to update');

  await jobRef.update(update);
  return { success: true };
});

// ─── 3. closeJob ─────────────────────────────────────────────────────────────

exports.closeJob = onCall({ cors: true }, async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');
  if (jobSnap.data().employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job');

  await jobRef.update({ status: 'closed' });
  return { success: true };
});

// ─── 4. listJobs ─────────────────────────────────────────────────────────────

exports.listJobs = onCall({ cors: true }, async (req) => {
  // Public — no auth required
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

// ─── 5. getJob ───────────────────────────────────────────────────────────────

exports.getJob = onCall({ cors: true }, async (req) => {
  // Public — no auth required
  const db     = getFirestore();
  const uid    = req.auth?.uid || null;
  const { jobId } = req.data || {};

  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');

  // Increment viewCount atomically (fire-and-forget is fine)
  jobRef.update({ viewCount: FieldValue.increment(1) }).catch(() => {});

  const data   = jobSnap.data();
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

// ─── 6. applyForJob ──────────────────────────────────────────────────────────

exports.applyForJob = onCall({ cors: true }, async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { jobId, coverLetter, cvUrl } = req.data || {};
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId required');

  const cleanCover = _san(coverLetter, 2000);
  if (!cleanCover || cleanCover.length < 20) {
    throw new HttpsError('invalid-argument', 'coverLetter must be 20-2000 characters');
  }

  // Idempotency via deterministic doc ID
  const applicationId = `${jobId}_${uid}`;
  const appRef        = db.collection('jobApplications').doc(applicationId);
  const existing      = await appRef.get();

  if (existing.exists) return { alreadyApplied: true, applicationId };

  // Fetch job to validate it is still active
  const jobRef  = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError('not-found', 'Job not found');

  const jobData = jobSnap.data();
  if (!_isActive(jobData)) throw new HttpsError('failed-precondition', 'This job is no longer accepting applications');

  const now = Timestamp.now();
  const application = {
    jobId,
    seekerUid:   uid,
    employerUid: jobData.employerUid,
    coverLetter: cleanCover,
    cvUrl:       cvUrl ? _san(cvUrl, 500) : null,
    status:      'pending',
    appliedAt:   now,
    updatedAt:   now,
  };

  // Atomic write: create application + increment counter
  const batch = db.batch();
  batch.set(appRef, application);
  batch.update(jobRef, { applicationCount: FieldValue.increment(1) });
  await batch.commit();

  return { success: true, applicationId };
});

// ─── 7. getJobApplications ───────────────────────────────────────────────────

exports.getJobApplications = onCall({ cors: true }, async (req) => {
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
    // Firestore batch get — doc lookups, not queries
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
    appliedAt:     app.appliedAt,
    updatedAt:     app.updatedAt,
    seekerProfile: profileMap[app.seekerUid] || null,
  }));

  // Sort by appliedAt desc
  enriched.sort((a, b) => (b.appliedAt?.toMillis() || 0) - (a.appliedAt?.toMillis() || 0));

  return { applications: enriched };
});

// ─── 8. updateApplicationStatus ──────────────────────────────────────────────

exports.updateApplicationStatus = onCall({ cors: true }, async (req) => {
  _requireAuth(req);
  const uid = req.auth.uid;
  const db  = getFirestore();

  const { applicationId, status } = req.data || {};
  if (!applicationId) throw new HttpsError('invalid-argument', 'applicationId required');
  if (!VALID_APP_STATUSES.includes(status)) {
    throw new HttpsError('invalid-argument', );
  }

  const appRef  = db.collection('jobApplications').doc(applicationId);
  const appSnap = await appRef.get();
  if (!appSnap.exists) throw new HttpsError('not-found', 'Application not found');

  const appData = appSnap.data();
  if (appData.employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job application');

  await appRef.update({ status, updatedAt: Timestamp.now() });
  return { success: true };
});

// ─── 9. getMyApplications ────────────────────────────────────────────────────

exports.getMyApplications = onCall({ cors: true }, async (req) => {
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
    appliedAt:   app.appliedAt,
    updatedAt:   app.updatedAt,
    job:         jobMap[app.jobId] || null,
  }));

  return { applications: enriched };
});

// ─── 10. saveJobSeekerProfile ─────────────────────────────────────────────────

exports.saveJobSeekerProfile = onCall({ cors: true }, async (req) => {
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

  // ── Validation ──
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

// ─── 11. getJobSeekerProfile ──────────────────────────────────────────────────

exports.getJobSeekerProfile = onCall({ cors: true }, async (req) => {
  _requireAuth(req);
  const callerUid = req.auth.uid;
  const db        = getFirestore();

  // uid param: view another person's profile; omit for own profile
  const targetUid = req.data?.uid ? String(req.data.uid) : callerUid;

  // Seeker profiles are semi-public for any authenticated user.
  // (Composite index would be required to verify employer relationship — avoided.)
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

// ─── 12. getFeaturedJobs ─────────────────────────────────────────────────────

exports.getFeaturedJobs = onCall({ cors: true }, async (req) => {
  // Public — no auth required
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
