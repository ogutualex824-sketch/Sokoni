#!/usr/bin/env node
/* gen-jobs-workspace-fixtures.js — server-shaped fixtures for scripts/test-merchant-jobs-workspace.js.

   The employer workspace (sokoni-merchant-jobs.js) is a HOSTING change; its server is functions/jobs.js on the
   functions branch functions/jobs-on-ca55f8b. That file is NOT in this tree, so the fixtures are produced by running
   the REAL handlers of two server commits in memory and recording exactly what they returned:

     be4e1b7  J2 + jobsCapabilities / listMyJobs / getEmployerApplications / pausedByRole (the contract this page is built against)
     a515270  J2 moderation without those ops (old-server fallback: op-list hint, direct read, per-vacancy applications)
     ffa2c47  J1 application state machine (the J1 fallback)

   Method — the same module-stub harness the server's own suites use (a515270:scripts/test-jobs-moderation.js:11-60):
   `git show <sha>:functions/jobs.js` is written to a temp file, firebase-functions/v2/https and firebase-admin/firestore
   are replaced by an in-memory Firestore, and the handlers in `exports._h` are called directly. Nothing is invented by
   hand: every response, every error message and every stored job document below is what those handlers produced.

   Timestamps are recorded as { _seconds, _nanoseconds } — the wire shape a callable returns for an admin Timestamp —
   and the test rehydrates the stored job documents to { toMillis() } for the Firestore-read path.

   The dispatcher "Valid ops" message is composed from the SAME template as services-dispatch.js:68-72 (a515270)
   over the jobs handlers' keys. The page reads only the jobs ops out of it.

   Run (needs both commits in the local object store):  node scripts/gen-jobs-workspace-fixtures.js
   Output: scripts/fixtures/jobs-workspace-server.json */
'use strict';
const path = require('path'), Module = require('module'), fs = require('fs'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

function harness (sha) {
  const store = new Map(); let auto = 0;
  const SERVER_TS = { __serverTs: true };
  const ts = (ms) => ({ _ms: ms, toMillis () { return this._ms; } });
  const Timestamp = { now: () => ts(Date.now()), fromMillis: (ms) => ts(ms) };
  const FieldValue = { increment: (n) => ({ __inc: n }), serverTimestamp: () => SERVER_TS };
  const applyWrite = (prev, d) => { const o = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(d)) o[k] = v && v.__inc != null ? (Number(o[k]) || 0) + v.__inc : (v === SERVER_TS ? ts(Date.now()) : v); return o; };
  const ref = (p) => { const id = p.split('/').pop();
    return { id, path: p,
      get: async () => ({ exists: store.has(p), id, ref: ref(p), data: () => store.get(p) }),
      set: async (d, o) => { store.set(p, o && o.merge ? applyWrite(store.get(p), d) : applyWrite({}, d)); },
      update: async (d) => { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, applyWrite(store.get(p), d)); },
      collection: (sub) => col(p + '/' + sub) }; };
  const col = (cpath, f = [], lim = 0) => ({
    where: (a, op, v) => col(cpath, f.concat([[a, v]]), lim), limit: (n) => col(cpath, f, n),
    doc: (id) => ref(cpath + '/' + (id || ('auto' + (++auto)))),
    add: async (d) => { const r = ref(cpath + '/job' + (++auto)); await r.set(d); return r; },
    get: async () => { const depth = cpath.split('/').length + 1;
      let docs = [...store.entries()].filter(([k]) => k.startsWith(cpath + '/') && k.split('/').length === depth)
        .map(([k, d]) => ({ id: k.split('/').pop(), ref: ref(k), data: () => d }));
      for (const [a, v] of f) docs = docs.filter((x) => x.data()[a] === v);
      if (lim) docs = docs.slice(0, lim); return { docs, empty: !docs.length, size: docs.length }; } });
  const db = { collection: (c) => col(c), getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    runTransaction: async (fn) => { const writes = [];
      const out = await fn({ get: (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), update: (r, d) => writes.push(() => r.update(d)) });
      for (const w of writes) await w(); return out; } };
  class HttpsError extends Error { constructor (code, m) { super(m); this.code = code; } }
  const src = execFileSync('git', ['show', sha + ':functions/jobs.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(os.tmpdir(), 'jobs-fixture-' + sha + '-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
  const _load = Module._load;
  Module._load = function (req) {
    if (req === 'firebase-functions/v2/https') return { onCall: (o, fn) => fn, HttpsError };
    if (req === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue, Timestamp };
    return _load.apply(this, arguments);
  };
  let J; try { J = require(tmp); } finally { Module._load = _load; fs.unlinkSync(tmp); }
  const call = async (op, uid, data, token) => {
    if (!J._h[op]) return { ok: false, code: 'not-found', msg: 'Unknown services operation: "' + op + '". Valid ops: ' + Object.keys(J._h).sort().join(', ') };
    try { return { ok: true, r: await J._h[op]({ auth: uid ? { uid, token: token || {} } : null, data: data || {} }) }; }
    catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
  /* The server's OWN tables, lifted from the source text (not re-typed): the suite compares the page's buttons to these. */
  const lift = (name) => { const i = src.indexOf('const ' + name + ' = {'); if (i < 0) return null; let k = src.indexOf('{', i), d = 0, j = k; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return Function('return (' + src.slice(k, j + 1) + ')')(); };
  const tables = { EMPLOYER_TRANSITIONS: lift('EMPLOYER_TRANSITIONS'), STATUS_LABEL: lift('STATUS_LABEL'), JOB_LABEL: lift('JOB_LABEL') };
  return { J, db, store, call, ts, tables, opsMessage: '"op" field is required. Valid ops: ' + Object.keys(J._h).sort().join(', ') };
}

/* Wire encoding: any { toMillis } becomes { _seconds, _nanoseconds }. */
function wire (v) {
  if (v && typeof v === 'object') {
    if (typeof v.toMillis === 'function') { const ms = v.toMillis(); return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6 }; }
    if (Array.isArray(v)) return v.map(wire);
    const o = {}; for (const k of Object.keys(v)) o[k] = wire(v[k]); return o;
  }
  return v;
}

const DESC = 'We need a reliable cashier for our Nairobi shop, weekday shifts.';
const COVER = 'I have three years of retail experience and I am available immediately.';
const ADM = { admin: true };
const BASE = { title: 'Cashier', description: DESC, requirements: 'KCSE', category: 'retail', type: 'full-time', location: 'Nairobi', salaryMin: 20000, salaryMax: 30000, expiresInDays: 30 };

async function build (sha, j2) {
  const H = harness(sha); const { call, store } = H; const out = { sha, tables: H.tables, opsMessage: H.opsMessage, responses: {}, errors: {}, jobs: {}, applications: {} };
  const rec = (k, r) => { if (r.ok) out.responses[k] = wire(r.r); else out.errors[k] = { code: r.code, message: r.msg }; return r; };
  const post = async (k, extra) => rec(k, await call('createJob', 'emp', Object.assign({}, BASE, extra || {})));
  const jobDoc = (id) => Object.assign({ id }, wire(store.get('jobs/' + id)));

  /* A live vacancy (J2: submit + admin approve; J1: created active) that collects applications. */
  const live = (await post('createJob_submit', { submit: true, title: 'Cashier (live)' })).r.jobId;
  if (j2) rec('adminApprove', await call('adminModerateJob', 'adm', { jobId: live, action: 'approve' }, ADM));
  for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) rec('applyForJob_' + s, await call('applyForJob', s, { jobId: live, coverLetter: COVER + (s === 's2' ? ' <img src=x onerror=alert(1)>' : ''), cvUrl: 'https://cv.example/' + s }));
  const A = (s) => live + '_' + s;
  const step = async (k, s, status, v, reason) => rec(k, await call('updateApplicationStatus', 'emp', { applicationId: A(s), status, expectedVersion: v, reason }));
  /* s2 → reviewing → shortlisted → interview ; s3 → … → offer ; s4 → offer → accepted ; s5 rejected ; s6 stays pending */
  await step('move_reviewing', 's2', 'reviewing', 1); await step('move_shortlisted', 's2', 'shortlisted', 2); await step('move_interview', 's2', 'interview', 3);
  await step('m3a', 's3', 'shortlisted', 1); await step('m3b', 's3', 'interview', 2); await step('move_offer', 's3', 'offer', 3);
  await step('m4a', 's4', 'shortlisted', 1); await step('m4b', 's4', 'interview', 2); await step('m4c', 's4', 'offer', 3);
  rec('respondToJobOffer_accept', await call('respondToJobOffer', 's4', { applicationId: A('s4'), accept: true }));
  await step('move_rejected', 's5', 'rejected', 1, 'We chose a candidate with more till experience.');
  await step('err_reject_no_reason', 's6', 'rejected', 1, '');
  await step('err_stale_version', 's6', 'reviewing', 7);
  await step('err_illegal', 's6', 'hired', 1);
  rec('getJobApplications', await call('getJobApplications', 'emp', { jobId: live }));
  rec('getApplicationHistory', await call('getApplicationHistory', 'emp', { applicationId: A('s2') }));
  out.applications.liveJobId = live;

  /* updateJob: a live-field edit (no review) and a content edit (back to review on J2). */
  rec('updateJob_salary', await call('updateJob', 'emp', { jobId: live, salaryMin: 25000 }));
  rec('err_updateJob_salary', await call('updateJob', 'emp', { jobId: live, salaryMin: 50000, salaryMax: 40000 }));

  if (j2) {
    const draft = (await post('createJob_draft', { title: 'Shop assistant (draft)' })).r.jobId;
    const pend  = (await post('createJob_pending', { submit: true, title: 'Stock clerk (pending)' })).r.jobId;
    const chg   = (await post('x_chg', { submit: true, title: 'Delivery rider (changes requested)' })).r.jobId;
    rec('adminRequestChanges', await call('adminModerateJob', 'adm', { jobId: chg, action: 'request_changes', reason: 'Add the shift hours <b>please</b>.' }, ADM));
    const rej   = (await post('x_rej', { submit: true, title: 'Fee job (rejected)' })).r.jobId;
    rec('adminReject', await call('adminModerateJob', 'adm', { jobId: rej, action: 'reject', reason: 'Asks applicants to pay a fee.' }, ADM));
    const feat  = (await post('x_feat', { submit: true, title: 'Head cashier (featured)', type: 'freelance-gig' })).r.jobId;
    rec('x_feat_approve', await call('adminModerateJob', 'adm', { jobId: feat, action: 'approve' }, ADM));
    rec('adminFeature', await call('adminModerateJob', 'adm', { jobId: feat, action: 'feature' }, ADM));
    const paused = (await post('x_paused', { submit: true, title: 'Barista (paused)' })).r.jobId;
    rec('x_paused_approve', await call('adminModerateJob', 'adm', { jobId: paused, action: 'approve' }, ADM));
    rec('pauseJob', await call('pauseJob', 'emp', { jobId: paused }));
    const apaused = (await post('x_apaused', { submit: true, title: 'Guard (admin paused)' })).r.jobId;
    rec('x_apaused_approve', await call('adminModerateJob', 'adm', { jobId: apaused, action: 'approve' }, ADM));
    rec('adminPause', await call('adminModerateJob', 'adm', { jobId: apaused, action: 'pause', reason: 'Reported by applicants; under review.' }, ADM));
    const exp = (await post('x_exp', { submit: true, title: 'Cleaner (expired)', expiresInDays: 1 })).r.jobId;
    rec('x_exp_approve', await call('adminModerateJob', 'adm', { jobId: exp, action: 'approve' }, ADM));
    out.responses.sweep = await H.J.sweepExpiredJobs(H.db, Date.now() + 2 * 86400000);
    const arch = (await post('x_arch', { submit: true, title: 'Porter (archived)' })).r.jobId;
    rec('x_arch_reject', await call('adminModerateJob', 'adm', { jobId: arch, action: 'reject', reason: 'Duplicate of another vacancy.' }, ADM));
    rec('x_arch_archive', await call('adminModerateJob', 'adm', { jobId: arch, action: 'archive' }, ADM));

    rec('submitJob', await call('submitJob', 'emp', { jobId: draft }));
    /* the draft is now pending — re-create a draft for the fixture list */
    const draft2 = (await post('x_draft2', { title: 'Shop assistant (draft)' })).r.jobId;
    rec('err_pauseJob_draft', await call('pauseJob', 'emp', { jobId: draft2 }));
    rec('err_resumeJob_unapproved', await call('resumeJob', 'emp', { jobId: pend }));
    rec('updateJob_content_backToReview', await call('updateJob', 'emp', { jobId: feat, title: 'Head cashier (renamed)' }));
    rec('err_updateJob_rejected', await call('updateJob', 'emp', { jobId: rej, title: 'Try again' }));
    /* the featured job left Published on the content edit — record a still-featured live one for the badge */
    const feat2 = (await post('x_feat2', { submit: true, title: 'Senior cashier (featured)' })).r.jobId;
    rec('x_feat2_approve', await call('adminModerateJob', 'adm', { jobId: feat2, action: 'approve' }, ADM));
    rec('x_feat2_feature', await call('adminModerateJob', 'adm', { jobId: feat2, action: 'feature' }, ADM));
    const resume = (await post('x_resume', { submit: true, title: 'Baker (resumable)' })).r.jobId;
    rec('x_resume_approve', await call('adminModerateJob', 'adm', { jobId: resume, action: 'approve' }, ADM));
    rec('x_resume_pause', await call('pauseJob', 'emp', { jobId: resume }));
    rec('resumeJob', await call('resumeJob', 'emp', { jobId: resume }));
    /* be4e1b7: an employer resume of a SOKONI pause is refused (pausedByRole). Only where the server knows pausedByRole —
       on a515270 the same call SUCCEEDS (the defect the fix closed) and would un-pause the fixture. */
    if (H.J._h.jobsCapabilities) rec('err_resume_admin_paused', await call('resumeJob', 'emp', { jobId: apaused }));
    Object.assign(out.jobs, { draft: jobDoc(draft2), pending_review: jobDoc(pend), changes_requested: jobDoc(chg), rejected: jobDoc(rej),
      featured_active: jobDoc(feat2), paused: jobDoc(paused), admin_paused: jobDoc(apaused), closed_expired: jobDoc(exp),
      archived: jobDoc(arch), back_to_review: jobDoc(feat) });
  }

  /* closeJob last on the live vacancy: closes pending/reviewing/shortlisted, keeps interview/offer. */
  out.jobs.active = jobDoc(live);
  /* be4e1b7 ops (recorded as unknown-op errors on older servers, exactly as the dispatcher answers). */
  rec('jobsCapabilities', await call('jobsCapabilities', null, {}));
  rec('listMyJobs', await call('listMyJobs', 'emp', {}));
  rec('getEmployerApplications', await call('getEmployerApplications', 'emp', {}));
  rec('closeJob', await call('closeJob', 'emp', { jobId: live }));
  out.jobs.closed = jobDoc(live);
  rec('getJobApplications_afterClose', await call('getJobApplications', 'emp', { jobId: live }));
  return out;
}

(async () => {
  const fixtures = { generatedAtMs: Date.now(), generator: 'scripts/gen-jobs-workspace-fixtures.js', versions: {} };
  for (const [sha, j2] of [['be4e1b7', true], ['a515270', true], ['ffa2c47', false]]) {
    fixtures.versions[sha] = await build(sha, j2);
  }
  const dir = path.join(ROOT, 'scripts', 'fixtures'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs-workspace-server.json'), JSON.stringify(fixtures, null, 1) + '\n');
  console.log('wrote scripts/fixtures/jobs-workspace-server.json', Object.keys(fixtures.versions).map((k) => k + ':' + Object.keys(fixtures.versions[k].responses).length + 'r/' + Object.keys(fixtures.versions[k].errors).length + 'e').join(' '));
})().catch((e) => { console.error(e); process.exit(1); });
