/**
 * SOKONI Jobs Board — J3 public-search eligibility (one predicate, every engine)
 *
 * The canonical job document lives in `jobs/{jobId}` and is written only by
 * functions/jobs.js (served via servicesDispatch). Public search — Typesense
 * `sokoni_jobs`, Algolia `sokoni_jobs` (+ replicas, + the global_search shadow)
 * and the KASS `search_jobs` tool — may show a job ONLY when:
 *
 *   1. status === 'active'           (closed / draft / pending_review / paused /
 *                                     archived / suspended are never public)
 *   2. expiresAt is absent or in the future
 *                                    (mirrors jobs.js _isPublicJob: a job with no
 *                                     expiresAt is treated as not expired; an
 *                                     expiresAt that cannot be read FAILS CLOSED)
 *   3. _noIndex !== true             (platform-wide opt-out flag)
 *
 * Eventual consistency: this predicate is evaluated when a job is WRITTEN (the
 * triggers) and when a queue item is PROCESSED (the transformers). A job that
 * simply passes its expiresAt with no write stays in the index until something
 * touches it. Removing those is the job of the J2 expiry sweep — deliberately
 * NOT built here.
 *
 * Never indexed, by construction (the record builders are allow-lists):
 *   employerUid — the employer's identity is private to jobs.js callers.
 */

'use strict';

const PUBLIC_JOB_STATUS = 'active';

/** Canonical job types (functions/jobs.js). Anything else is indexed as given. */
const JOB_TYPES = Object.freeze([
  'full-time', 'part-time', 'contract', 'internship', 'remote', 'freelance-gig',
]);

/**
 * Timestamp | Date | millis | seconds | ISO string → epoch millis.
 * Returns null when absent, NaN when present but unreadable.
 */
function toMillis(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  const d = v instanceof Date ? v : new Date(v);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {object} data   canonical jobs/{id} document data
 * @param {number} [nowMs]
 * @returns {boolean} true only when the job may appear in public search
 */
function isPubliclySearchableJob(data, nowMs = Date.now()) {
  if (!data || typeof data !== 'object') return false;
  if (data._noIndex === true) return false;
  if (data.status !== PUBLIC_JOB_STATUS) return false;
  const exp = toMillis(data.expiresAt);
  if (exp === null) return true;            /* no expiry set — same as jobs.js */
  if (!Number.isFinite(exp)) return false;  /* unreadable expiry — fail closed */
  return exp > nowMs;
}

/**
 * Free-text job type (KASS tool input) → canonical type, or null when it is not
 * recognisable. null means "do not filter by type" — a filter on a value no job
 * carries would silently return nothing.
 */
function normalizeJobTypeInput(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return null;
  if (s === 'freelance' || s === 'gig' || s === 'freelance-gig') return 'freelance-gig';
  if (s === 'fulltime') return 'full-time';
  if (s === 'parttime') return 'part-time';
  return JOB_TYPES.includes(s) ? s : null;
}

/** Display salary from canonical salaryMin / salaryMax / salaryCurrency. */
function formatJobSalary(data) {
  const cur = (data && typeof data.salaryCurrency === 'string' && data.salaryCurrency.trim()) || 'KES';
  const min = Number(data && data.salaryMin);
  const max = Number(data && data.salaryMax);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  const fmt = n => Math.round(n).toLocaleString('en-KE');
  if (hasMin && hasMax) return min === max ? `${cur} ${fmt(min)}` : `${cur} ${fmt(min)} – ${fmt(max)}`;
  if (hasMin) return `From ${cur} ${fmt(min)}`;
  if (hasMax) return `Up to ${cur} ${fmt(max)}`;
  return 'Negotiable';
}

/**
 * The public projection KASS may show for a job — canonical names, allow-list.
 * Never includes employerUid.
 */
function publicJobSummary(id, data) {
  const d = data || {};
  return {
    id,
    title:       typeof d.title === 'string' ? d.title : '',
    companyName: typeof d.companyName === 'string' ? d.companyName : '',
    location:    typeof d.location === 'string' ? d.location : '',
    type:        typeof d.type === 'string' ? d.type : '',
    salary:      formatJobSalary(d),
    featured:    d.featured === true,
  };
}

/**
 * KASS `search_jobs` tool handler (called from functions/index.js).
 * Same query shape as before J3; differences: canonical field reads, the
 * public predicate (drops expired 'active' jobs), and a normalised type filter.
 *
 * @param {{ db: FirebaseFirestore.Firestore, input: object, ctx: { addResult: Function, addAction: Function }, nowMs?: number }} args
 */
async function kassSearchJobs({ db, input, ctx, nowMs = Date.now() }) {
  const { query = '', location } = input || {};
  const jobType = normalizeJobTypeInput(input && input.type);
  let q = db.collection('jobs').where('status', '==', PUBLIC_JOB_STATUS).limit(10);
  if (location && location !== 'remote') q = q.where('location', '==', location);
  if (jobType) q = q.where('type', '==', jobType);
  const snap = await q.get().catch(() => ({ docs: [] }));
  const ql = String(query || '').toLowerCase();
  const rows = snap.docs
    .filter(d => isPubliclySearchableJob(d.data(), nowMs))
    .filter(d => {
      if (!ql) return true;
      const r = d.data();
      return String(r.title || '').toLowerCase().includes(ql) ||
             String(r.description || '').toLowerCase().includes(ql);
    })
    .slice(0, 6);
  if (!rows.length) {
    ctx.addAction({ label: 'Browse Jobs', url: 'jobs.html' });
    return { found: 0, message: 'No jobs found. Browse all listings on SOKONI Jobs.' };
  }
  const jobs = rows.map(d => publicJobSummary(d.id, d.data()));
  jobs.forEach(j => ctx.addResult({
    type: 'job', id: j.id, name: j.title, company: j.companyName, location: j.location,
    salary: j.salary, jobType: j.type, url: `jobs.html?id=${encodeURIComponent(j.id)}`,
  }));
  ctx.addAction({ label: 'Browse all Jobs', url: 'jobs.html' });
  return {
    found: jobs.length,
    jobs: jobs.map(j => ({ title: j.title, company: j.companyName, location: j.location, salary: j.salary, type: j.type })),
  };
}

module.exports = {
  isPubliclySearchableJob, toMillis, PUBLIC_JOB_STATUS, JOB_TYPES,
  normalizeJobTypeInput, formatJobSalary, publicJobSummary, kassSearchJobs,
};
