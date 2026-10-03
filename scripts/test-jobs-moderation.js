#!/usr/bin/env node
/* Jobs Board J2 — moderation (functions/jobs.js): employer draft/submit/pause/resume, audited admin actions, featured as
   its own attribute, bait-and-switch re-review, expiry sweep, AdminOS reads. Module-stubbed; the REAL handlers run.
   Run: node scripts/test-jobs-moderation.js        Mutants: JOBS_MUTANT=<name> node scripts/test-jobs-moderation.js */
'use strict';
const path = require('path'), Module = require('module'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── in-memory Firestore ── */
const store = new Map(); let auto = 0;
const SERVER_TS = { __serverTs: true };
const INC = (n) => ({ __inc: n });
const ts = (ms) => ({ _ms: ms, toMillis() { return this._ms; } });
const Timestamp = { now: () => ts(Date.now()), fromMillis: (ms) => ts(ms) };
const FieldValue = { increment: INC, serverTimestamp: () => SERVER_TS };
const applyWrite = (prev, d) => { const o = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(d)) o[k] = v && v.__inc != null ? (Number(o[k]) || 0) + v.__inc : v; return o; };
const ref = (p) => { const parts = p.split('/'); const id = parts[parts.length - 1];
  return { id, path: p,
    get: async () => ({ exists: store.has(p), id, ref: ref(p), data: () => store.get(p) }),
    set: async (d, o) => { store.set(p, o && o.merge ? applyWrite(store.get(p), d) : applyWrite({}, d)); },
    update: async (d) => { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, applyWrite(store.get(p), d)); },
    collection: (sub) => col(p + '/' + sub) }; };
const col = (cpath, f = [], lim = 0) => ({
  where: (a, op, v) => col(cpath, f.concat([[a, v]]), lim), limit: (n) => col(cpath, f, n),
  doc: (id) => ref(cpath + '/' + (id || ('auto' + (++auto)))),
  add: async (d) => { const r = ref(cpath + '/auto' + (++auto)); await r.set(d); return r; },
  get: async () => { const depth = cpath.split('/').length + 1;
    let docs = [...store.entries()].filter(([k]) => k.startsWith(cpath + '/') && k.split('/').length === depth)
      .map(([k, d]) => ({ id: k.split('/').pop(), ref: ref(k), data: () => d }));
    for (const [a, v] of f) docs = docs.filter((x) => x.data()[a] === v);
    if (lim) docs = docs.slice(0, lim); return { docs, empty: !docs.length, size: docs.length }; } });
let txnCount = 0;
const db = { collection: (c) => col(c), getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  runTransaction: async (fn) => { txnCount++; const writes = [];
    const out = await fn({ get: (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), update: (r, d) => writes.push(() => r.update(d)) });
    for (const w of writes) await w(); return out; } };
class HttpsError extends Error { constructor(code, m) { super(m); this.code = code; } }

/* ── mutants: copy jobs.js, apply a textual sabotage, load the copy ── */
let src = fs.readFileSync(path.join(ROOT, 'functions', 'jobs.js'), 'utf8');
const MUTANTS = {
  employer_publishes:   ["status:           req.data && req.data.submit === true ? 'pending_review' : 'draft',", "status:           'active',"],
  no_admin_check:       ["exports._h.adminModerateJob = async (req) => {\n  _requireAuth(req);\n  _requireAdmin(req);", "exports._h.adminModerateJob = async (req) => {\n  _requireAuth(req);"],
  reason_optional:      ["if (spec.reason && cleanReason.length < 3)", "if (false && cleanReason.length < 3)"],
  no_rereview:          ["if (['active', 'paused'].includes(current.status) && REVIEWED.some((k) => k in update)) {", "if (false) {"],
  restore_unapproved:   ["if (!job.approvedAt) throw new HttpsError('failed-precondition', 'This vacancy was never approved; review it instead.');", ""],
  feature_anything:     ["feature:         { from: ['active'], featured: true },", "feature:         { from: Object.keys(JOB_LABEL), featured: true },"],
  employer_resumes_admin_pause: ["if (job.pausedByRole === 'admin') throw", "if (false) throw"],
  employer_list_leak:   ["db.collection('jobs').where('employerUid', '==', req.auth.uid).limit(200)", "db.collection('jobs').limit(200)"],
  sweep_noop:           ["if (!(j.expiresAt && j.expiresAt.toMillis() < now)) continue;", "continue;"],
};
const M = process.env.JOBS_MUTANT;
if (M) { const m = MUTANTS[M]; if (!m || src.split(m[0]).length !== 2) { console.error('mutant anchor missing: ' + M); process.exit(2); } src = src.replace(m[0], m[1]); console.log('MUTANT ' + M); }
const tmp = path.join(os.tmpdir(), 'jobs-under-test-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, f) => f, HttpsError };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue, Timestamp };
  return _load.apply(this, arguments);
};
const J = require(tmp); fs.unlinkSync(tmp);
const call = async (op, uid, data, token) => { try { return { ok: true, r: await J._h[op]({ auth: uid ? { uid, token: token || {} } : null, data: data || {} }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const app = (id) => store.get('jobApplications/' + id);
const events = (id) => [...store.keys()].filter((k) => k.startsWith('jobApplications/' + id + '/events/')).map((k) => store.get(k));
const notes = (uid) => [...store.entries()].filter(([k, v]) => k.startsWith('notifications/') && v.targetUid === uid).map(([, v]) => v);
const DESC = 'We need a reliable cashier for our Nairobi shop, weekday shifts.';
const ADM = { admin: true };
const mod = (jobId) => [...store.keys()].filter((k) => k.startsWith('jobs/' + jobId + '/moderation/')).map((k) => store.get(k));
const audit = () => [...store.entries()].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v);
const job = (id) => store.get('jobs/' + id);
const post = async (extra) => (await call('createJob', 'emp', Object.assign({ title: 'Cashier', description: DESC, category: 'retail', type: 'full-time', location: 'Nairobi' }, extra || {}))).r.jobId;

(async () => {
  console.log('\nJobs J2 — moderation' + (M ? '  [' + M + ']' : '') + '\n');
  /* ── E: employer lifecycle ── */
  const j1 = await post();
  ck('E1 createJob → draft (never active)', job(j1).status === 'draft', job(j1));
  const j2 = await post({ submit: true });
  ck('E2 createJob {submit:true} → pending_review', job(j2).status === 'pending_review', job(j2));
  let r = await call('submitJob', 'stranger', { jobId: j1 });
  ck('E3 another user cannot submit the vacancy', !r.ok && r.code === 'permission-denied', r);
  r = await call('submitJob', 'emp', { jobId: j1 });
  ck('E4 draft → pending_review on submit; moderation trail row', r.ok && job(j1).status === 'pending_review' && mod(j1).some((e) => e.action === 'submitted' && e.actorRole === 'employer'), r);
  r = await call('resumeJob', 'emp', { jobId: j1 });
  ck('E5 the employer cannot publish (resume from pending_review refused)', !r.ok && r.code === 'failed-precondition' && job(j1).status === 'pending_review', r);
  r = await call('applyForJob', 'seek', { jobId: j1, coverLetter: 'Applying before the vacancy is approved.' });
  ck('E6 nobody can apply to an unapproved vacancy', !r.ok && r.code === 'failed-precondition', r);
  r = await call('getJob', 'stranger', { jobId: j1 });
  ck('E7 an unapproved vacancy is not-found to the public', !r.ok && r.code === 'not-found', r);
  r = await call('listJobs', null, {});
  ck('E8 listJobs never returns an unapproved vacancy', r.ok && !r.r.jobs.some((x) => x.jobId === j1 || x.jobId === j2), r);

  /* ── A: admin moderation ── */
  r = await call('adminModerateJob', 'emp', { jobId: j1, action: 'approve' });
  ck('A1 a non-admin cannot approve (not even the employer)', !r.ok && r.code === 'permission-denied', r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'request_changes' }, ADM);
  ck('A2 request_changes needs a reason', !r.ok && /reason/.test(r.msg), r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'request_changes', reason: 'Add the salary range and shift hours.' }, ADM);
  ck('A3 → changes_requested; reason stored; employer notified; audited', r.ok && job(j1).status === 'changes_requested' && /salary range/.test(job(j1).moderationReason)
    && notes('emp').some((n) => n.type === 'job_moderation' && /Changes requested/.test(n.body)) && audit().some((a) => a.action === 'job_request_changes' && a.jobId === j1), r);
  r = await call('submitJob', 'emp', { jobId: j1 });
  ck('A4 the employer resubmits after changes → pending_review, reason cleared', r.ok && job(j1).status === 'pending_review' && job(j1).moderationReason === null, job(j1));
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'approve' }, ADM);
  ck('A5 approve → active (Published), approvedAt set, employer notified', r.ok && job(j1).status === 'active' && !!job(j1).approvedAt && notes('emp').some((n) => /now published/.test(n.body)), r);
  r = await call('listJobs', null, {});
  ck('A6 the approved vacancy is now listed publicly', r.ok && r.r.jobs.some((x) => x.jobId === j1), r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'approve' }, ADM);
  ck('A7 approving a Published vacancy again is refused (no illegal transition)', !r.ok && r.code === 'failed-precondition', r);
  r = await call('adminModerateJob', 'adm', { jobId: j2, action: 'reject' }, ADM);
  ck('A8 reject needs a reason', !r.ok && /reason/.test(r.msg), r);
  r = await call('adminModerateJob', 'adm', { jobId: j2, action: 'reject', reason: 'Asks applicants to pay a fee.' }, ADM);
  ck('A9 reject → rejected (terminal for editing)', r.ok && job(j2).status === 'rejected', r);
  r = await call('updateJob', 'emp', { jobId: j2, title: 'Cashier (no fee)' });
  ck('A10 a rejected vacancy cannot be edited back into review', !r.ok && r.code === 'failed-precondition', r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'bogus' }, ADM);
  ck('A11 unknown admin action refused', !r.ok && r.code === 'invalid-argument', r);

  /* ── F: featured is a separate attribute ── */
  r = await call('adminModerateJob', 'adm', { jobId: j2, action: 'feature' }, ADM);
  ck('F1 a non-published vacancy cannot be featured', !r.ok && r.code === 'failed-precondition', r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'feature' }, ADM);
  ck('F2 a Published vacancy can be featured; status unchanged; audited', r.ok && job(j1).featured === true && job(j1).status === 'active' && audit().some((a) => a.action === 'job_feature'), r);
  r = await call('getFeaturedJobs', null, {});
  ck('F3 getFeaturedJobs returns it', r.ok && r.r.jobs.some((x) => x.jobId === j1), r);

  /* ── P: pause / restore / bait-and-switch ── */
  r = await call('pauseJob', 'emp', { jobId: j1 });
  ck('P1 employer pauses a Published vacancy', r.ok && job(j1).status === 'paused', r);
  r = await call('resumeJob', 'emp', { jobId: j1 });
  ck('P2 employer resumes an approved, unexpired vacancy → active', r.ok && job(j1).status === 'active', r);
  r = await call('updateJob', 'emp', { jobId: j1, salaryMin: 25000 });
  ck('P3 a salary edit on a Published vacancy stays live (no re-review)', r.ok && job(j1).status === 'active' && r.r.backToReview === false, r);
  r = await call('updateJob', 'emp', { jobId: j1, description: 'Totally different job now: pay KES 500 registration to apply.' });
  ck('P4 a content edit on a Published vacancy goes back to review (bait-and-switch blocked)', r.ok && job(j1).status === 'pending_review' && r.r.backToReview === true, r);
  r = await call('listJobs', null, {});
  ck('P5 the edited vacancy is off the public list until re-approved', r.ok && !r.r.jobs.some((x) => x.jobId === j1), r);
  await call('adminModerateJob', 'adm', { jobId: j1, action: 'approve' }, ADM);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'pause' }, ADM);
  ck('P6 admin pause needs a reason', !r.ok && /reason/.test(r.msg), r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'pause', reason: 'Reported by candidates; under investigation.' }, ADM);
  ck('P7 admin pause → paused AND unfeatured (never left featured off Published)', r.ok && job(j1).status === 'paused' && job(j1).featured === false, job(j1));
  r = await call('resumeJob', 'emp', { jobId: j1 });
  ck('P7b the employer cannot resume a vacancy SOKONI paused (sokoni-e3 finding)', !r.ok && r.code === 'failed-precondition' && /Only SOKONI/.test(r.msg) && job(j1).status === 'paused', r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'restore' }, ADM);
  ck('P8 admin restore of an approved vacancy → active, pausedByRole cleared', r.ok && job(j1).status === 'active' && !job(j1).pausedByRole, r);
  const j3 = await post({ submit: true });
  store.set('jobs/' + j3, Object.assign({}, job(j3), { status: 'paused' }));   /* paused without ever being approved */
  r = await call('adminModerateJob', 'adm', { jobId: j3, action: 'restore' }, ADM);
  ck('P9 restore refuses a vacancy that was never approved', !r.ok && /never approved/.test(r.msg), r);
  r = await call('resumeJob', 'emp', { jobId: j3 });
  ck('P10 employer resume refuses a never-approved vacancy', !r.ok && /not been approved/.test(r.msg), r);

  /* ── X: expiry sweep + close + archive ── */
  const j4 = await post({ submit: true }); await call('adminModerateJob', 'adm', { jobId: j4, action: 'approve' }, ADM);
  await call('adminModerateJob', 'adm', { jobId: j4, action: 'feature' }, ADM);
  store.set('jobs/' + j4, Object.assign({}, job(j4), { expiresAt: ts(Date.now() - 1000) }));
  r = { ok: true, r: await J.sweepExpiredJobs(db, Date.now()) };
  ck('X1 the sweep closes an expired Published vacancy (reason expired, unfeatured, trail row)', job(j4).status === 'closed' && job(j4).closedReason === 'expired' && job(j4).featured === false
    && mod(j4).some((e) => e.action === 'expired' && e.actorRole === 'system'), job(j4));
  ck('X2 the sweep leaves an unexpired Published vacancy alone', job(j1).status === 'active', job(j1));
  r = { ok: true, r: await J.sweepExpiredJobs(db, Date.now()) };
  ck('X3 the sweep is idempotent (closes 0 on a re-run)', r.r.closed === 0, r);
  r = await call('adminModerateJob', 'adm', { jobId: j4, action: 'restore' }, ADM);
  ck('X4 an expired vacancy cannot be restored', !r.ok && /expired/.test(r.msg), r);
  r = await call('adminModerateJob', 'adm', { jobId: j4, action: 'archive' }, ADM);
  ck('X5 a closed vacancy can be archived', r.ok && job(j4).status === 'archived', r);
  r = await call('adminModerateJob', 'adm', { jobId: j1, action: 'close' }, ADM);
  ck('X6 admin close needs a reason', !r.ok && /reason/.test(r.msg), r);

  /* ── Q: AdminOS reads ── */
  r = await call('adminListJobs', 'emp', { status: 'pending_review' });
  ck('Q1 a non-admin cannot read the moderation queue', !r.ok && r.code === 'permission-denied', r);
  const j5 = await post({ submit: true });
  r = await call('adminListJobs', 'adm', { status: 'pending_review' }, ADM);
  ck('Q2 the queue lists pending vacancies with employer + description', r.ok && r.r.jobs.some((x) => x.jobId === j5 && x.employerUid === 'emp' && x.description), r);
  await call('applyForJob', 'seek', { jobId: j1, coverLetter: 'I have three years of cashier experience.' });
  r = await call('adminGetJob', 'adm', { jobId: j1 }, ADM);
  ck('Q3 opening a vacancy shows its applications + counts + moderation trail', r.ok && r.r.applications.length === 1 && r.r.applicationCounts.pending === 1 && r.r.trail.length >= 5, r);
  r = await call('adminGetJob', 'emp', { jobId: j1 });
  ck('Q4 a non-admin cannot use adminGetJob', !r.ok && r.code === 'permission-denied', r);

  /* ── L: employer list ops + capability probe (sokoni-e3 asks) ── */
  store.set('jobs/otherEmpJob', { employerUid: 'emp2', title: 'Not yours', status: 'active', postedAt: ts(1), expiresAt: ts(Date.now() + 86400000) });
  store.set('jobApplications/otherEmpJob_x', { jobId: 'otherEmpJob', seekerUid: 'x', employerUid: 'emp2', status: 'pending', statusVersion: 1 });
  r = await call('listMyJobs', 'emp', {});
  ck('L1 listMyJobs returns the caller\'s vacancies in every state, none of anyone else\'s', r.ok && r.r.jobs.length >= 5 && r.r.jobs.every((j) => j.jobId !== 'otherEmpJob') && r.r.jobs.some((j) => j.status === 'pending_review'), r.ok ? r.r.jobs.map((j) => j.status) : r);
  r = await call('getEmployerApplications', 'emp', {});
  ck('L2 getEmployerApplications returns only applications to the caller\'s vacancies (with jobId, statusVersion)', r.ok && r.r.applications.length >= 1 && r.r.applications.every((a) => a.id !== 'otherEmpJob_x' && a.jobId && a.statusVersion), r);
  r = await call('getEmployerApplications', 'seek', {});
  ck('L3 a non-employer gets an empty list (scoped to the caller)', r.ok && r.r.applications.length === 0, r);
  r = await call('jobsCapabilities', null, {});
  ck('L4 jobsCapabilities reports contract jobs-j2 with the transition table', r.ok && r.r.contract === 'jobs-j2' && r.r.employerTransitions && r.r.employerTransitions.offer_accepted[0] === 'hired', r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.stack); process.exit(2); });
