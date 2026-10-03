#!/usr/bin/env node
/* Jobs Board J1 — application state machine + vacancy hardening (functions/jobs.js), module-stubbed unit test.
   In-memory Firestore; the REAL jobs.js handlers run. No network, no emulator, no production.
   Run: node scripts/test-jobs-lifecycle.js        Mutants: JOBS_MUTANT=<name> node scripts/test-jobs-lifecycle.js */
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
  no_terminal_at:     ['...(APP_TERMINAL.includes(status) ? { terminalAt: Timestamp.now() } : {}),', ''],
  any_transition:     ['const allowed = EMPLOYER_TRANSITIONS[app.status] || [];', 'const allowed = VALID_APP_STATUSES;'],
  no_owner_check:     ["if (app.employerUid !== uid) throw new HttpsError('permission-denied', 'Not your job application');", ''],
  getjob_leaks:       ["if (!_isActive(data) && !isOwner && !isAdmin) throw new HttpsError('not-found', 'Job not found');", ''],
  raw_expiry:         ['update.expiresAt = _expiry(raw.expiresInDays, raw.expiresAt);', 'update.expiresAt = raw.expiresAt;'],
  no_event:           ["_eventInTxn(txn, appRef, app, { from: app.status, to: status, actorUid: uid, actorRole: 'employer', reason: cleanReason });", ''],
  hire_without_accept:["offer:          ['rejected'],", "offer:          ['rejected', 'hired'],"],
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

(async () => {
  console.log('\nJobs J1 — lifecycle + hardening' + (M ? '  [' + M + ']' : '') + '\n');
  /* ── V: vacancy validation ── */
  let r = await call('createJob', 'emp', { title: 'Cashier', description: DESC, category: 'retail', type: 'full-time', location: 'Nairobi', salaryMin: 20000, salaryMax: 30000 });
  ck('V1 employer posts a vacancy (J2: a DRAFT, featured false, server counters)', r.ok && store.get('jobs/' + r.r.jobId).status === 'draft' && store.get('jobs/' + r.r.jobId).featured === false, r);
  const jobId = r.ok ? r.r.jobId : 'x';
  /* J2: published only through submit + admin approval */
  await call('submitJob', 'emp', { jobId }); await call('adminModerateJob', 'adm', { jobId, action: 'approve' }, { admin: true });
  ck('V1b submitted + admin-approved vacancy is Published (active)', store.get('jobs/' + jobId).status === 'active', store.get('jobs/' + jobId));
  r = await call('createJob', 'emp', { title: 'Cashier', description: DESC, category: 'retail', type: 'nonsense' });
  ck('V2 bad type refused WITH a message (was an empty HttpsError)', !r.ok && r.code === 'invalid-argument' && /type must be one of/.test(r.msg), r);
  r = await call('createJob', 'emp', { title: 'Gig', description: DESC, category: 'technology', type: 'freelance-gig' });
  ck('V3 freelance-gig is a valid job type (owner 10-03)', r.ok, r);
  r = await call('createJob', 'emp', { title: 'Cashier', description: DESC, category: 'retail', type: 'full-time', salaryMin: 50000, salaryMax: 10000 });
  ck('V4 salaryMin > salaryMax refused', !r.ok && /salaryMin cannot be greater/.test(r.msg), r);
  r = await call('createJob', 'emp', { title: 'Cashier', description: DESC, category: 'retail', type: 'full-time', salaryMin: -5 });
  ck('V5 negative salary refused', !r.ok && r.code === 'invalid-argument', r);
  r = await call('createJob', 'emp', { title: 'Cashier', description: DESC, category: 'retail', type: 'full-time', expiresInDays: 400 });
  ck('V6 vacancy open > 90 days refused', !r.ok && /1 to 90 days/.test(r.msg), r);
  r = await call('updateJob', 'emp', { jobId, expiresAt: Date.now() + 10 * 365 * 86400000 });
  ck('V7 update cannot push the closing date years out (was stored RAW)', !r.ok && r.code === 'invalid-argument', r);
  r = await call('updateJob', 'emp', { jobId, expiresAt: 'not a date' });
  ck('V8 update cannot store a non-date closing date', !r.ok && r.code === 'invalid-argument', r);
  r = await call('updateJob', 'emp', { jobId, salaryMax: 15000 });
  ck('V9 update keeps min ≤ max against the STORED salaryMin (20000)', !r.ok && /salaryMin cannot be greater/.test(r.msg), r);
  r = await call('updateJob', 'stranger', { jobId, title: 'Hijacked' });
  ck('V10 another user cannot edit the vacancy', !r.ok && r.code === 'permission-denied', r);

  /* ── G: getJob visibility ── */
  store.set('jobs/closedJob', { employerUid: 'emp', title: 'Old', status: 'closed', postedAt: ts(1), expiresAt: ts(Date.now() + 86400000) });
  r = await call('getJob', 'stranger', { jobId: 'closedJob' });
  ck('G1 a closed vacancy is not-found to the public (no existence leak)', !r.ok && r.code === 'not-found', r);
  r = await call('getJob', 'emp', { jobId: 'closedJob' });
  ck('G2 the employer still opens its closed vacancy', r.ok && r.r.job.title === 'Old', r);
  r = await call('getJob', 'adm', { jobId: 'closedJob' }, { admin: true });
  ck('G3 an admin opens a closed vacancy', r.ok, r);
  const v0 = store.get('jobs/' + jobId).viewCount;
  await call('getJob', 'emp', { jobId }); await new Promise((s) => setTimeout(s, 5));
  ck('G4 the employer viewing its own vacancy is not counted as a view', store.get('jobs/' + jobId).viewCount === v0, store.get('jobs/' + jobId).viewCount);

  /* ── A: apply ── */
  r = await call('applyForJob', 'seek', { jobId, coverLetter: 'I have three years of cashier experience in Nairobi.', cvUrl: 'javascript:alert(1)' });
  ck('A1 a javascript: CV link is refused', !r.ok && /https/.test(r.msg), r);
  r = await call('applyForJob', 'emp', { jobId, coverLetter: 'Applying to my own vacancy to inflate the count.' });
  ck('A2 an employer cannot apply to its own vacancy', !r.ok && r.code === 'failed-precondition', r);
  r = await call('applyForJob', 'seek', { jobId, coverLetter: 'I have three years of cashier experience in Nairobi.', cvUrl: 'https://cv.example.com/seek.pdf' });
  const appId = jobId + '_seek';
  ck('A3 apply: status pending, statusVersion 1, job title snapshot', r.ok && app(appId).status === 'pending' && app(appId).statusVersion === 1 && app(appId).jobTitle === 'Cashier', app(appId));
  ck('A4 apply writes an audit event and notifies the EMPLOYER', events(appId).length === 1 && events(appId)[0].to === 'pending' && notes('emp').some((n) => n.type === 'job_application_received'), { ev: events(appId), n: notes('emp') });
  r = await call('applyForJob', 'seek', { jobId, coverLetter: 'I have three years of cashier experience in Nairobi.' });
  ck('A5 a repeat apply is a replay (alreadyApplied), count unchanged', r.ok && r.r.alreadyApplied === true && store.get('jobs/' + jobId).applicationCount === 1, r);

  /* ── S: state machine ── */
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'hired' });
  ck('S1 pending → hired is refused (no jumping)', !r.ok && r.code === 'failed-precondition', r);
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'offer' });
  ck('S2 pending → offer is refused', !r.ok && r.code === 'failed-precondition', r);
  r = await call('updateApplicationStatus', 'stranger', { applicationId: appId, status: 'reviewing' });
  ck('S3 another employer cannot move the application', !r.ok && r.code === 'permission-denied', r);
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'reviewing' });
  ck('S4 pending → reviewing; version 2', r.ok && app(appId).status === 'reviewing' && app(appId).statusVersion === 2, app(appId));
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'shortlisted', expectedVersion: 1 });
  ck('S5 a stale expectedVersion is refused (two tabs cannot both move it)', !r.ok && r.code === 'aborted', r);
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'shortlisted', expectedVersion: 2 });
  ck('S6 reviewing → shortlisted with the right version', r.ok && app(appId).statusVersion === 3, r);
  await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'interview' });
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'offer' });
  ck('S7 shortlisted → interview → offer', r.ok && app(appId).status === 'offer', app(appId));
  ck('S8 the applicant was notified of the offer (type job_offer)', notes('seek').some((n) => n.type === 'job_offer' && n.deepLink === '/jobs.html#applications'), notes('seek'));
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'hired' });
  ck('S9 offer → hired is refused until the applicant ACCEPTS', !r.ok && r.code === 'failed-precondition', r);
  r = await call('respondToJobOffer', 'stranger', { applicationId: appId, accept: true });
  ck('S10 nobody but the applicant can accept the offer', !r.ok && r.code === 'permission-denied', r);
  r = await call('respondToJobOffer', 'seek', { applicationId: appId, accept: true });
  ck('S11 applicant accepts → offer_accepted; employer notified', r.ok && app(appId).status === 'offer_accepted' && notes('emp').some((n) => n.type === 'job_offer_response'), r);
  r = await call('respondToJobOffer', 'seek', { applicationId: appId, accept: false });
  ck('S12 an accepted offer cannot then be declined', !r.ok && r.code === 'failed-precondition', r);
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'hired' });
  ck('S13 offer_accepted → hired', r.ok && app(appId).status === 'hired', app(appId));
  r = await call('updateApplicationStatus', 'emp', { applicationId: appId, status: 'rejected', reason: 'changed mind' });
  ck('S14 hired is terminal (cannot be rejected afterwards)', !r.ok && r.code === 'failed-precondition', r);
  r = await call('withdrawApplication', 'seek', { applicationId: appId });
  ck('S15 a hired application cannot be withdrawn', !r.ok && r.code === 'failed-precondition', r);
  const ev = events(appId).map((e) => e.to).join('>');
  ck('S16 the audit trail records every step with actor roles', ev === 'pending>reviewing>shortlisted>interview>offer>offer_accepted>hired'
    && events(appId).every((e) => e.jobId === jobId && e.employerUid === 'emp' && e.seekerUid === 'seek' && ['employer', 'applicant'].includes(e.actorRole)), ev);
  r = await call('getApplicationHistory', 'seek', { applicationId: appId });
  ck('S17 the applicant reads the history (ordered, labelled)', r.ok && r.r.events.length === 7 && r.r.label === 'Hired', r);
  r = await call('getApplicationHistory', 'stranger', { applicationId: appId });
  ck('S18 a third party cannot read the history', !r.ok && r.code === 'permission-denied', r);

  /* ── R: rejection, withdrawal, decline ── */
  await call('applyForJob', 'seek2', { jobId, coverLetter: 'Five years in retail, available immediately.' });
  const a2 = jobId + '_seek2';
  r = await call('updateApplicationStatus', 'emp', { applicationId: a2, status: 'rejected' });
  ck('R1 a rejection needs a reason', !r.ok && /reason/.test(r.msg), r);
  r = await call('updateApplicationStatus', 'emp', { applicationId: a2, status: 'rejected', reason: 'We chose a candidate with POS experience.' });
  ck('R2 rejected with reason; applicant notified with it', r.ok && app(a2).rejectionReason && notes('seek2').some((n) => /POS experience/.test(n.body)), r);
  await call('applyForJob', 'seek3', { jobId, coverLetter: 'Experienced cashier, references available.' });
  const a3 = jobId + '_seek3';
  r = await call('withdrawApplication', 'emp', { applicationId: a3 });
  ck('R3 the employer cannot withdraw on the applicant\'s behalf', !r.ok && r.code === 'permission-denied', r);
  r = await call('withdrawApplication', 'seek3', { applicationId: a3, reason: 'Took another job' });
  ck('R4 applicant withdraws; employer notified', r.ok && app(a3).status === 'withdrawn' && notes('emp').some((n) => /withdrew/.test(n.body)), r);
  r = await call('withdrawApplication', 'seek3', { applicationId: a3 });
  ck('R5 a repeat withdraw is idempotent (unchanged)', r.ok && r.r.unchanged === true, r);
  await call('applyForJob', 'seek4', { jobId, coverLetter: 'Cashier with mobile money experience.' });
  const a4 = jobId + '_seek4';
  for (const s of ['shortlisted', 'interview', 'offer']) await call('updateApplicationStatus', 'emp', { applicationId: a4, status: s });
  r = await call('respondToJobOffer', 'seek4', { applicationId: a4, accept: false });
  ck('R6 applicant declines the offer → offer_declined (terminal)', r.ok && app(a4).status === 'offer_declined', r);
  r = await call('respondToJobOffer', 'seek4', { applicationId: a4, accept: 'yes' });
  ck('R7 accept must be a boolean', !r.ok && r.code === 'invalid-argument', r);

  /* ── C: closing the vacancy ── */
  await call('applyForJob', 'seek5', { jobId, coverLetter: 'Applying for the cashier role, weekdays.' });
  await call('applyForJob', 'seek6', { jobId, coverLetter: 'Applying for the cashier role, weekends too.' });
  await call('updateApplicationStatus', 'emp', { applicationId: jobId + '_seek6', status: 'shortlisted' });
  await call('applyForJob', 'seek7', { jobId, coverLetter: 'Applying for the cashier role, any shift.' });
  for (const s of ['shortlisted', 'interview']) await call('updateApplicationStatus', 'emp', { applicationId: jobId + '_seek7', status: s });
  r = await call('closeJob', 'emp', { jobId });
  ck('C1 closing closes pending + shortlisted applications (2), not terminal ones', r.ok && r.r.closedApplications === 2
    && app(jobId + '_seek5').status === 'closed' && app(jobId + '_seek6').status === 'closed' && app(jobId + '_seek').status === 'hired', r);
  ck('C2 an in-flight interview stays with the employer (not auto-closed)', app(jobId + '_seek7').status === 'interview', app(jobId + '_seek7'));
  ck('C3 closed applicants are notified', notes('seek5').some((n) => n.title === 'Vacancy closed'), notes('seek5'));
  r = await call('closeJob', 'emp', { jobId });
  ck('C4 closing again is idempotent (closes 0 more)', r.ok && r.r.closedApplications === 0, r);
  r = await call('updateJob', 'emp', { jobId, expiresInDays: 30 });
  ck('C5 a closed vacancy cannot be re-opened by extending its date', !r.ok && r.code === 'failed-precondition', r);
  r = await call('applyForJob', 'seek8', { jobId, coverLetter: 'Late application for the cashier job.' });
  ck('C6 nobody can apply to a closed vacancy', !r.ok && r.code === 'failed-precondition', r);

  /* ── T: terminalAt (sokoni-b2 J4: messages stay open 30 days after it) ── */
  ck('T1 terminalAt stamped on hired / rejected / withdrawn / offer_declined / closed', [appId, a2, a3, a4, jobId + '_seek5'].every((id) => app(id).terminalAt && app(id).terminalAt._ms > 0),
    [appId, a2, a3, a4, jobId + '_seek5'].map((id) => [app(id).status, !!app(id).terminalAt]));
  ck('T2 no terminalAt on a non-terminal application (interview in flight)', !app(jobId + '_seek7').terminalAt, app(jobId + '_seek7'));

  /* ── N: notification shape (what the in-app feed reads) ── */
  const n = notes('seek')[0] || {};
  ck('N1 notifications carry targetUid + userId + read:false + category jobs (sokoni-notif-engine contract)', n.targetUid === 'seek' && n.userId === 'seek' && n.read === false && n.category === 'jobs', n);
  const ids = [...store.keys()].filter((k) => k.startsWith('notifications/jobapp_' + appId + '_v'));
  ck('N2 notification ids are deterministic per (application, version) — a retry cannot double-notify', ids.length === new Set(ids).size && ids.length >= 6, ids);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.stack); process.exit(2); });
