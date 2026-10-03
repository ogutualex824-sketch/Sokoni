/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT V2 · JOBS EMPLOYER WORKSPACE  (J5 hosting slice)
   ══════════════════════════════════════════════════════════════════════════════
   The employer side of the one Jobs board, inside the merchant shell. Eleven routes
   (Jobs group in sokoni-merchant-routes.js) mount THIS module with ctx.view naming
   the section; there is no separate dashboard and no second data path.

   SERVER (consumed as-is, owner sokoni-f3) — functions/jobs.js on functions/jobs-on-ca55f8b:
     a515270  J2 moderation   createJob {submit} → draft | pending_review (never active)
                              submitJob / pauseJob / resumeJob {jobId} → {success, status}
                              updateJob → {success, status, backToReview}
     ffa2c47  J1 applications getJobApplications → {applications:[{id, jobId, seekerUid, coverLetter, cvUrl,
                              status, statusLabel, statusVersion, appliedAt, updatedAt, seekerProfile}]}
                              updateApplicationStatus {applicationId, status, reason, expectedVersion}
                              → {success, status, statusVersion} · stale version → 'aborted'
                              closeJob → {success, closedApplications}
                              getApplicationHistory → {applicationId, status, label, statusVersion, events[]}
   Every WRITE is ctx.dispatch({op, ...}) = httpsCallable('servicesDispatch') through the shell's
   _callable (the App Check path every merchant callable uses). The ONE read that is not a
   callable is the employer's own vacancy list — jobs where employerUid == uid, which the rules
   allow in any status (sokoni-f3, 2026-10-03). This module never writes Firestore.

   FEATURE DETECTION (owner rule: fall back to ffa2c47 behaviour, never fake a status)
     be4e1b7+: `jobsCapabilities` (no auth) → {contract:'jobs-j2', moderation, applicationStates,
     jobStates, employerTransitions, jobTypes}. Its employerTransitions are the RUNTIME source for
     application buttons; the tables below are the fallback only. moderation:true ⇒ J2: "Save draft"
     + "Submit for review", never "Publish".
     jobsCapabilities UNKNOWN (older server: the dispatcher answers not-found) ⇒ the "Valid ops:" text
     in that refusal is read as a NON-contract hint: submitJob listed ⇒ J2 (a515270), otherwise J1
     (one "Post vacancy", which publishes on create, and the screen says so).
     Any other failure (network / internal) ⇒ the form is withheld with a retry; nothing is guessed.
   READS: listMyJobs → {jobs[]} and getEmployerApplications → {applications[]} (one scoped query each).
     Only when the server does not know those ops: the direct read of jobs where employerUid == uid
     and one getJobApplications per vacancy.

   DATA INTEGRITY: every figure is derived from what THIS page loaded from the server. Unknown is
   '—', never 0 and never an estimate. Featured is a badge only — set by SOKONI admins.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var VIEWS = ['overview', 'jobs', 'applications', 'candidates', 'interviews', 'offers',
               'messages', 'company', 'wallet', 'products', 'analytics'];
  var ROUTE_OF = {};
  VIEWS.forEach(function (v) { ROUTE_OF[v] = v === 'jobs' ? 'jobs' : 'jobs-' + v; });

  /* ── Server vocabularies, copied for DISPLAY ONLY (the server re-checks every call) ──
     ffa2c47/a515270 functions/jobs.js:38 (types), :40-44 (categories), :55-62 (transitions),
     :68 (reason required), :69-73 (labels). a515270 :329-330 (job labels). */
  var VALID_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'remote', 'freelance-gig'];
  var TYPE_LABEL = { 'full-time': 'Full-time', 'part-time': 'Part-time', contract: 'Contract',
    internship: 'Internship', remote: 'Remote', 'freelance-gig': 'Freelance gig' };
  var VALID_CATEGORIES = ['technology', 'finance', 'healthcare', 'education', 'retail', 'logistics',
    'hospitality', 'marketing', 'legal', 'engineering', 'admin', 'other'];
  var EMPLOYER_TRANSITIONS = {
    pending:        ['reviewing', 'shortlisted', 'rejected'],
    reviewing:      ['shortlisted', 'rejected'],
    shortlisted:    ['interview', 'rejected'],
    interview:      ['offer', 'rejected'],
    offer:          ['rejected'],
    offer_accepted: ['hired']
  };
  var REASON_REQUIRED = ['rejected'];
  var APP_LABEL = { pending: 'Submitted', reviewing: 'Under review', shortlisted: 'Shortlisted',
    interview: 'Interview', offer: 'Offer made', offer_accepted: 'Offer accepted', hired: 'Hired',
    rejected: 'Not selected', withdrawn: 'Withdrawn', offer_declined: 'Offer declined', closed: 'Vacancy closed' };
  var APP_STATUSES = Object.keys(APP_LABEL);
  var MOVE_LABEL = { reviewing: 'Mark under review', shortlisted: 'Shortlist', interview: 'Invite to interview',
    offer: 'Make offer', rejected: 'Reject', hired: 'Mark hired' };
  var JOB_LABEL = { draft: 'Draft', pending_review: 'Pending review', changes_requested: 'Changes requested',
    active: 'Published', paused: 'Paused', closed: 'Closed', archived: 'Archived', rejected: 'Rejected' };
  /* a515270 updateJob: these fields on an active/paused vacancy send it back to pending_review. */
  var REVIEWED_FIELDS = ['title', 'description', 'requirements', 'type', 'category'];
  var REVIEW_LIVE = ['active', 'paused'];
  var REASON_SHOWN = ['changes_requested', 'rejected', 'paused', 'closed'];
  var CLOSABLE = ['draft', 'pending_review', 'changes_requested', 'active', 'paused'];
  var EDITABLE = ['draft', 'pending_review', 'changes_requested', 'active', 'paused'];
  var INTERVIEW_VIEW = ['interview'];
  var OFFER_VIEW = ['offer', 'offer_accepted', 'offer_declined'];
  var JOBS_LIMIT = 50;      /* direct-read fallback limit (shell _q) */
  var LIST_LIMIT = 200;     /* listMyJobs server limit (be4e1b7) */
  var J2_OPS = ['createJob', 'updateJob', 'closeJob', 'submitJob', 'pauseJob', 'resumeJob'];
  var CONFLICT_MSG = 'This application changed — reload';
  /* J4 (sokoni-b2, server 8aaa868): a conversation exists per TRANSACTION and the server derives its parties
     (jobId + applicationId + employerUid + seekerUid) from the application. The page sends ONLY the application id —
     never a seekerUid, phone, email or name — and never hands the merchant off to an external chat app or mail client. */
  var TX_TYPE = 'job_application';
  function messageUrl (applicationId) {
    return '/messages.html?tx=' + TX_TYPE + '&txId=' + encodeURIComponent(String(applicationId));
  }
  function openApplicationChat (applicationId, win) {
    var w = win || global;
    if (!applicationId) return false;
    var inbox = w.SokoniInbox;
    if (inbox && typeof inbox.openForTransaction === 'function') { inbox.openForTransaction(TX_TYPE, String(applicationId)); return true; }
    w.location.href = messageUrl(applicationId);
    return true;
  }

  /* ── escaping: the canonical escapeHTML (security.js), identical fallback if not yet loaded ── */
  function esc (s) {
    if (typeof global.escapeHTML === 'function') return global.escapeHTML(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;');
  }

  /* ── pure helpers (exported as _pure for the suite) ─────────────────────── */
  function ms (t) {
    if (t == null) return null;
    if (typeof t.toMillis === 'function') { try { return t.toMillis(); } catch (_) { return null; } }
    if (typeof t === 'number') return t;
    if (typeof t._seconds === 'number') return t._seconds * 1000 + Math.round((t._nanoseconds || 0) / 1e6);
    if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.round((t.nanoseconds || 0) / 1e6);
    return null;
  }
  function fmtDate (t) {
    var m = ms(t); if (m == null) return '—';
    try { return new Date(m).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (_) { return new Date(m).toISOString().slice(0, 10); }
  }
  /* A count the page does not know is '—'. A real, loaded zero is '0'. */
  function fmtCount (n) { return (typeof n === 'number' && isFinite(n)) ? String(n) : '—'; }
  function fmtKes (n) { return (typeof n === 'number' && isFinite(n)) ? 'KES ' + n.toLocaleString('en-KE') : null; }
  function salaryText (j) {
    var lo = fmtKes(j.salaryMin), hi = fmtKes(j.salaryMax);
    if (lo && hi) return lo + ' – ' + hi.replace('KES ', '');
    return lo ? 'From ' + lo : hi ? 'Up to ' + hi : 'Salary not stated';
  }
  function expired (j, now) { var e = ms(j.expiresAt); return e != null && e < now; }
  function jobStatusLabel (j) {
    if (!j || !j.status) return '—';
    if (j.status === 'closed' && j.closedReason === 'expired') return 'Closed — expired';
    if (typeof j.statusLabel === 'string' && j.statusLabel) return j.statusLabel;   /* listMyJobs: the server's label */
    return JOB_LABEL[j.status] || String(j.status);   /* an unknown status is shown as stored, never relabelled */
  }
  /* The dispatcher's "unknown op" refusal (services-dispatch.js: not-found 'Unknown services operation'). */
  function isUnknownOp (e) {
    var c = String((e && e.code) || '');
    return (c === 'not-found' || c === 'functions/not-found') && /Unknown services operation/.test(String((e && e.message) || ''));
  }
  /* A capabilities answer is usable only with a contract and a transitions OBJECT whose values are arrays. */
  function validCaps (d) {
    if (!d || typeof d !== 'object' || typeof d.contract !== 'string') return false;
    var t = d.employerTransitions;
    if (!t || typeof t !== 'object') return false;
    return Object.keys(t).every(function (k) { return Array.isArray(t[k]); });
  }
  /* Op list from the dispatcher's own refusal message — NON-contract text, used only for an old server. */
  function parseOps (message) {
    var m = /Valid ops:\s*(.+)$/.exec(String(message || ''));
    if (!m) return null;
    return m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function modeOf (ops) {
    if (!Array.isArray(ops)) return 'unknown';
    return ops.indexOf('submitJob') >= 0 ? 'j2' : 'legacy';
  }
  /* The job actions the screen offers, by stored status. The server is authoritative; this only
     decides which buttons exist. Publish / feature are NEVER actions — admins own both. */
  function jobActions (j, ops, now) {
    var has = function (op) { return Array.isArray(ops) && ops.indexOf(op) >= 0; };
    var s = j && j.status, out = [];
    if (EDITABLE.indexOf(s) >= 0) out.push('edit');
    if ((s === 'draft' || s === 'changes_requested') && has('submitJob')) out.push('submit');
    if (s === 'active' && has('pauseJob')) out.push('pause');
    /* Resume: only a vacancy SOKONI approved before (approvedAt), not expired, and NOT paused by SOKONI
       (pausedByRole === 'admin', be4e1b7 — the server refuses that resume: "…Only SOKONI can restore it."). */
    if (s === 'paused' && has('resumeJob') && ms(j.approvedAt) != null && !expired(j, now) && j.pausedByRole !== 'admin') out.push('resume');
    if (CLOSABLE.indexOf(s) >= 0) out.push('close');
    if (['active', 'paused', 'closed'].indexOf(s) >= 0) out.push('applications');
    return out;
  }
  /* Legal application moves from the CURRENT status: the server's runtime table (jobsCapabilities) when
     known, else the source-copied fallback (functions/jobs.js :55-62). */
  function appActions (app, table) {
    var t = (table && typeof table === 'object') ? table : EMPLOYER_TRANSITIONS;
    return (app && Array.isArray(t[app.status])) ? t[app.status].slice() : [];
  }
  function needsReReview (job, changes) {
    if (!job || REVIEW_LIVE.indexOf(job.status) < 0) return false;
    return REVIEWED_FIELDS.some(function (k) { return Object.prototype.hasOwnProperty.call(changes || {}, k); });
  }
  function isConflict (e) { var c = String((e && e.code) || ''); return c === 'aborted' || c === 'functions/aborted'; }
  function errMsg (e) {
    var m = e && e.message ? String(e.message) : '';
    return m || 'The server did not complete this. Nothing was changed.';
  }
  /* Client checks mirror the server's messages; the server still decides. */
  function validateJob (f, isCreate) {
    if (isCreate || 'title' in f) { var t = String(f.title || '').trim(); if (t.length < 3 || t.length > 100) return 'title must be 3-100 characters'; }
    if (isCreate || 'description' in f) { var d = String(f.description || '').trim(); if (d.length < 20 || d.length > 5000) return 'description must be 20-5000 characters'; }
    if ((isCreate || 'type' in f) && VALID_TYPES.indexOf(f.type) < 0) return 'Choose a job type';
    if ((isCreate || 'category' in f) && VALID_CATEGORIES.indexOf(f.category) < 0) return 'Choose a category';
    var bad = function (v) { return v != null && (!isFinite(v) || v < 0 || v > 100000000 || Math.round(v) !== v); };
    if (bad(f.salaryMin) || bad(f.salaryMax)) return 'Salary must be a whole amount in KES between 0 and 100,000,000';
    if (f.salaryMin != null && f.salaryMax != null && f.salaryMin > f.salaryMax) return 'salaryMin cannot be greater than salaryMax';
    if (f.expiresInDays != null && (!isFinite(f.expiresInDays) || f.expiresInDays < 1 || f.expiresInDays > 90 || Math.floor(f.expiresInDays) !== f.expiresInDays)) return 'A vacancy can stay open for 1 to 90 days';
    return null;
  }

  /* Counts, from what was loaded. Every unknown is null → rendered '—'. */
  function counts (S, now) {
    var c = { jobs: null, open: null, draft: null, pending_review: null, changes_requested: null, paused: null,
              closed: null, featured: null, apps: null, byStatus: null, candidates: null,
              truncated: !!S.jobsTrunc, appsComplete: false };
    if (!Array.isArray(S.jobs) || S.jobsTrunc) return c;
    c.jobs = S.jobs.length;
    ['draft', 'pending_review', 'changes_requested', 'paused', 'closed'].forEach(function (k) {
      c[k] = S.jobs.filter(function (j) { return j.status === k; }).length;
    });
    c.open = S.jobs.filter(function (j) { return j.status === 'active' && !expired(j, now); }).length;
    c.featured = S.jobs.filter(function (j) { return j.featured === true; }).length;
    var complete = S.jobs.every(function (j) { var a = S.apps[j.id]; return a && Array.isArray(a.list) && !a.err; });
    if (!complete) return c;
    c.appsComplete = true;
    var all = allApps(S), by = {}, seekers = {};
    APP_STATUSES.forEach(function (k) { by[k] = 0; });
    all.forEach(function (a) { by[a.status] = (by[a.status] || 0) + 1; if (a.seekerUid) seekers[a.seekerUid] = 1; });
    c.apps = all.length; c.byStatus = by; c.candidates = Object.keys(seekers).length;
    return c;
  }
  function allApps (S) {
    var out = [];
    (S.jobs || []).forEach(function (j) { var a = S.apps[j.id]; if (a && Array.isArray(a.list)) out = out.concat(a.list); });
    return out;
  }

  /* ── shared store, one per signed-in uid, shared by all eleven mounts ── */
  var STORE = null;
  var SUBS = [];
  function store (uid) {
    if (!STORE || STORE.uid !== uid) {
      STORE = { uid: uid, caps: null, listOp: null, empAppsOp: null, jobsVia: null, jobsLimit: JOBS_LIMIT, jobs: null, jobsErr: null, jobsTrunc: false, jobsP: null,
                ops: null, opsErr: null, opsP: null, apps: {}, appsP: null, hist: {}, notes: {}, jobNotes: {}, jobFilter: '' };
    }
    return STORE;
  }
  function notify () { SUBS.slice().forEach(function (f) { try { f(); } catch (_) {} }); }

  /* ══ CSS — mobile-first (390px), nothing wider than its column ══ */
  var CSS = [
    '.jw{padding:14px 14px 90px;max-width:980px;margin:0 auto;color:var(--txt,#f4f4f4);overflow-wrap:anywhere;min-width:0}',
    '.jw *{box-sizing:border-box;min-width:0}',
    '.jw h2{font-size:18px;margin:0 0 4px}.jw .jw-sub{color:var(--txt2,#a8a8a8);font-size:13px;margin:0 0 12px}',
    '.jw-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 14px}',
    '@media(min-width:720px){.jw-tiles{grid-template-columns:repeat(4,minmax(0,1fr))}}',
    '.jw-tile{background:var(--surface-2,#141414);border:1px solid var(--line,rgba(255,255,255,.09));border-radius:12px;padding:10px}',
    '.jw-tile b{display:block;font-size:20px}.jw-tile small{color:var(--txt2,#a8a8a8);font-size:12px}',
    '.jw-card{background:var(--surface-2,#141414);border:1px solid var(--line,rgba(255,255,255,.09));border-radius:12px;padding:12px;margin:0 0 10px}',
    '.jw-row{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}',
    '.jw-chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line,rgba(255,255,255,.2));color:var(--txt2,#a8a8a8)}',
    '.jw-badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--acc-dim,rgba(113,255,0,.12));color:var(--acc,#71ff00)}',
    '.jw-meta{color:var(--txt2,#a8a8a8);font-size:13px;margin:4px 0}',
    '.jw-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.jw-btn{border:1px solid var(--line,rgba(255,255,255,.2));border-radius:10px;padding:8px 12px;min-height:40px;font-size:14px;background:transparent;color:inherit;cursor:pointer}',
    '.jw-btn.pri{background:var(--acc,#71ff00);color:#000;border-color:transparent}',
    '.jw-btn.dan{border-color:var(--danger,#ff5252);color:var(--danger,#ff5252)}',
    '.jw-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.jw-note{font-size:13px;margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.jw-note.err{border-color:var(--danger,#ff5252);color:var(--danger,#ff8a8a)}',
    '.jw-note.warn{border-color:#e0a800;color:#ffd666}',
    '.jw-form{display:grid;gap:8px;margin:0 0 14px}',
    '.jw-form label{display:grid;gap:4px;font-size:13px;color:var(--txt2,#a8a8a8)}',
    '.jw-form input,.jw-form select,.jw-form textarea,.jw-reason{width:100%;font:inherit;font-size:16px;padding:9px 10px;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.2));background:var(--surface,#0d0d0d);color:inherit}',
    '.jw-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}',
    '.jw-segs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}',
    '.jw-segs .jw-btn[aria-pressed="true"]{border-color:var(--acc,#71ff00);color:var(--acc,#71ff00)}',
    '.jw-tbl{width:100%;border-collapse:collapse;font-size:13px}.jw-tbl td,.jw-tbl th{padding:6px 4px;border-bottom:1px solid var(--line,rgba(255,255,255,.09));text-align:left;vertical-align:top}',
    '.jw-scroll{overflow-x:auto;max-width:100%}',
    '.jw details summary{cursor:pointer;color:var(--txt2,#a8a8a8);font-size:13px}',
    '.jw-hist{font-size:13px;margin:6px 0 0;padding-left:18px}'
  ].join('\n');
  function injectCss (doc) {
    if (!doc || !doc.getElementById || doc.getElementById('jw-css')) return;
    var st = doc.createElement('style'); st.id = 'jw-css'; st.textContent = CSS; doc.head.appendChild(st);
  }

  /* ══ MOUNT ══ */
  function mount (host, ctx) {
    var c = ctx || {};
    var view = VIEWS.indexOf(c.view) >= 0 ? c.view : 'overview';
    injectCss(host.ownerDocument || global.document);
    var ui = { form: null, editId: null, confirmReview: false, closeAsk: null, statusFilter: '', busy: false, formNote: null };
    var dead = false;
    var uid = function () { try { return typeof c.uid === 'function' ? c.uid() : (c.uid || null); } catch (_) { return null; } };
    var role = function () { try { return typeof c.role === 'function' ? c.role() : null; } catch (_) { return null; } };
    var now = function () { return Date.now(); };

    function call (op, payload) {
      if (typeof c.dispatch !== 'function') return Promise.reject(new Error('Jobs are not available in this shell.'));
      return Promise.resolve(c.dispatch(Object.assign({ op: op }, payload || {}))).then(function (r) {
        return (r && r.data !== undefined) ? r.data : r;
      });
    }
    function toast (m) { try { c.onToast && c.onToast(m); } catch (_) {} }

    /* ── loads ── */
    function loadOps (S, force) {
      if (S.opsP || (S.ops && !force)) return S.opsP;
      S.opsErr = null;
      S.opsP = call('jobsCapabilities', {}).then(function (d) {
        if (!validCaps(d)) { S.caps = null; S.ops = null; S.opsErr = 'The server answered without a Jobs contract.'; return; }
        S.caps = d; S.opsErr = null;
        S.ops = d.moderation === true ? J2_OPS.slice() : [];
      }, function (e) {
        S.caps = null;
        if (isUnknownOp(e)) { S.ops = parseOps(e && e.message) || []; S.opsErr = null; }   /* old server: hint, else J1 */
        else { S.ops = null; S.opsErr = errMsg(e); }
      }).then(function () { S.opsP = null; notify(); });
      return S.opsP;
    }
    function sortJobs (rows) { return rows.sort(function (a, b) { return (ms(b.postedAt) || 0) - (ms(a.postedAt) || 0); }); }
    function directRead (S) {
      if (typeof c.readMyJobs !== 'function') return Promise.reject(new Error('Your vacancies cannot be read in this shell.'));
      return Promise.resolve(c.readMyJobs()).then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        S.jobs = sortJobs(rows.filter(function (r) { return r && r.employerUid === S.uid; }));
        S.jobsTrunc = rows.length >= JOBS_LIMIT; S.jobsLimit = JOBS_LIMIT; S.jobsVia = 'direct';
      });
    }
    function loadJobs (S, force) {
      if (S.jobsP || (S.jobs && !force)) return S.jobsP;
      S.jobsErr = null;
      var p = S.listOp === 'unknown' ? directRead(S) : call('listMyJobs', {}).then(function (d) {
        if (!d || !Array.isArray(d.jobs)) throw new Error('The server returned no vacancy list.');
        /* listMyJobs carries jobId (the public field set); the screen keys on id. */
        S.jobs = sortJobs(d.jobs.filter(Boolean).map(function (j) { return Object.assign({}, j, { id: j.id || j.jobId }); }));
        S.jobsTrunc = d.jobs.length >= LIST_LIMIT; S.jobsLimit = LIST_LIMIT; S.jobsVia = 'listMyJobs'; S.listOp = 'known';
      }, function (e) {
        if (isUnknownOp(e)) { S.listOp = 'unknown'; return directRead(S); }   /* old server only */
        throw e;
      });
      S.jobsP = p.then(null, function (e) { S.jobs = null; S.jobsErr = errMsg(e); })
        .then(function () { S.jobsP = null; notify(); });
      return S.jobsP;
    }
    function loadAppsFor (S, jobId) {
      return call('getJobApplications', { jobId: jobId }).then(function (d) {
        var list = (d && Array.isArray(d.applications)) ? d.applications : null;
        S.apps[jobId] = list ? { list: list.map(function (a) { return Object.assign({ jobId: jobId }, a); }), err: null }
                             : { list: null, err: 'The server returned no application list.' };
      }, function (e) { S.apps[jobId] = { list: null, err: errMsg(e) }; });
    }
    /* ONE scoped query for every application to this employer (be4e1b7). Every loaded vacancy gets a list —
       an empty one when it has none — so "complete" is a real answer, not a guess. */
    function loadEmployerApps (S) {
      return call('getEmployerApplications', {}).then(function (d) {
        if (!d || !Array.isArray(d.applications)) throw new Error('The server returned no application list.');
        var by = {};
        (S.jobs || []).forEach(function (j) { by[j.id] = []; });
        d.applications.forEach(function (a) { if (a && a.jobId) (by[a.jobId] = by[a.jobId] || []).push(a); });
        S.apps = {}; Object.keys(by).forEach(function (k) { S.apps[k] = { list: by[k], err: null }; });
        S.empAppsOp = 'known';
      }).then(null, function (e) {
        if (isUnknownOp(e)) { S.empAppsOp = 'unknown'; return null; }
        (S.jobs || []).forEach(function (j) { S.apps[j.id] = { list: null, err: errMsg(e) }; });
      });
    }
    function refreshApps (S, jobId) {
      return S.empAppsOp === 'unknown' ? loadAppsFor(S, jobId) : loadEmployerApps(S);
    }
    function loadAllApps (S, force) {
      if (S.appsP) return S.appsP;
      if (!Array.isArray(S.jobs)) return null;
      if (S.empAppsOp !== 'unknown') {
        if (!force && S.jobs.every(function (j) { return S.apps[j.id] && !S.apps[j.id].err; })) return null;
        S.appsP = loadEmployerApps(S).then(function () {
          S.appsP = null;
          if (S.empAppsOp === 'unknown') return loadAllApps(S, force);   /* old server: per-vacancy fallback */
          notify();
        });
        return S.appsP;
      }
      var ids = S.jobs.filter(function (j) { return force || !S.apps[j.id] || S.apps[j.id].err; }).map(function (j) { return j.id; });
      if (!ids.length) return null;
      var i = 0;
      function worker () { if (i >= ids.length) return Promise.resolve(); var id = ids[i++]; return loadAppsFor(S, id).then(worker); }
      S.appsP = Promise.all([worker(), worker(), worker(), worker()]).then(function () { S.appsP = null; notify(); });
      return S.appsP;
    }
    function ensure (force) {
      var S = store(uid()), r = role();
      if (!S.uid) return;
      if (r && r !== 'owner') return;   /* a staff sign-in loads nothing (see render) */
      loadOps(S, force);
      var p = loadJobs(S, force);
      if (needsApps()) {
        if (p) p.then(function () { loadAllApps(S, force); }); else loadAllApps(S, force);
      }
    }
    function needsApps () { return ['overview', 'applications', 'candidates', 'interviews', 'offers', 'analytics'].indexOf(view) >= 0; }

    /* ── rendering ── */
    function head (title, sub) { return '<h2>' + esc(title) + '</h2>' + (sub ? '<p class="jw-sub">' + esc(sub) + '</p>' : ''); }
    function note (n) { return n ? '<div class="jw-note ' + esc(n.kind || '') + '" role="status">' + esc(n.text) + '</div>' : ''; }
    function tile (label, n) { return '<div class="jw-tile"><b>' + esc(fmtCount(n)) + '</b><small>' + esc(label) + '</small></div>'; }
    function loadingOr (S) {
      if (S.jobsErr) return '<div class="jw-note err">' + esc(S.jobsErr) + ' <button class="jw-btn" type="button" data-act="reload">Try again</button></div>';
      if (!Array.isArray(S.jobs)) return '<p class="jw-sub">Loading your vacancies…</p>';
      return null;
    }
    function jobTitle (S, id, fallback) { var j = (S.jobs || []).filter(function (x) { return x.id === id; })[0]; return j ? j.title : (fallback || null); }
    function transitions (S) { return (S.caps && validCaps(S.caps)) ? S.caps.employerTransitions : null; }

    function render () {
      if (dead) return;
      var u = uid(), r = role();
      if (!u) { host.innerHTML = '<div class="jw">' + head('Jobs', null) + '<p class="jw-sub">Sign in to manage your vacancies.</p></div>'; return; }
      if (r && r !== 'owner') {
        host.innerHTML = '<div class="jw">' + head('Jobs', null) +
          '<div class="jw-note">Hiring is run from the business owner\'s account. A vacancy belongs to the account that ' +
          'posts it, so a staff sign-in would post under its own name rather than the business\'s.</div></div>';
        return;
      }
      var S = store(u);
      var body = ({ overview: vOverview, jobs: vJobs, applications: vApps, interviews: vApps, offers: vApps,
        candidates: vCandidates, messages: vMessages, company: vCompany, wallet: vWallet, products: vProducts,
        analytics: vAnalytics })[view](S);
      host.innerHTML = '<div class="jw" data-view="' + esc(view) + '">' + body + '</div>';
    }

    function vOverview (S) {
      var w = loadingOr(S); var c0 = counts(S, now()); var b = c0.byStatus || {};
      var by = function (k) { return c0.appsComplete ? b[k] : null; };
      return head('Jobs overview', 'Your vacancies and the applications they have received. Counts come only from what this page loaded.') +
        (w || '') +
        (c0.truncated ? '<div class="jw-note">You have more than ' + JOBS_LIMIT + ' vacancies; totals are not shown rather than a partial count.</div>' : '') +
        '<div class="jw-tiles">' + tile('Published vacancies', c0.open) + tile('Pending review', c0.pending_review) +
          tile('Drafts', c0.draft) + tile('Changes requested', c0.changes_requested) + '</div>' +
        '<div class="jw-tiles">' + tile('Applications', c0.apps) + tile('New (submitted)', by('pending')) +
          tile('Interviews', by('interview')) + tile('Offers open', by('offer')) + '</div>' +
        (Array.isArray(S.jobs) && !c0.appsComplete && !c0.truncated ? '<p class="jw-sub">' + (S.appsP ? 'Loading applications…' : 'Some applications could not be loaded, so application counts are not shown.') + '</p>' : '') +
        '<div class="jw-acts"><button class="jw-btn pri" type="button" data-go="jobs">Manage vacancies</button>' +
        '<button class="jw-btn" type="button" data-go="applications">Review applications</button></div>';
    }

    function formHtml (S, job) {
      var mode = modeOf(S.ops), f = ui.form || {};
      var val = function (k) { return f[k] != null ? f[k] : (job && job[k] != null ? job[k] : ''); };
      var opt = function (list, cur, lab) { return '<option value="">Choose…</option>' + list.map(function (v) {
        return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(lab ? (lab[v] || v) : v) + '</option>'; }).join(''); };
      var buttons;
      if (job) {
        buttons = ui.confirmReview
          ? '<div class="jw-note warn" role="alert">Editing these fields sends the job back for review; it will be hidden until approved.</div>' +
            '<button class="jw-btn pri" type="button" data-act="save-edit">Save and send for review</button>'
          : '<button class="jw-btn pri" type="button" data-act="save-edit">Save changes</button>';
        buttons += '<button class="jw-btn" type="button" data-act="cancel-form">Cancel</button>';
      } else if (mode === 'j2') {
        buttons = '<button class="jw-btn" type="button" data-act="create" data-submit="0">Save draft</button>' +
                  '<button class="jw-btn pri" type="button" data-act="create" data-submit="1">Submit for review</button>' +
                  '<button class="jw-btn" type="button" data-act="cancel-form">Cancel</button>';
      } else if (mode === 'legacy') {
        buttons = '<p class="jw-sub">Vacancy review is not switched on yet: a vacancy you post goes live immediately.</p>' +
                  '<button class="jw-btn pri" type="button" data-act="create" data-submit="legacy">Post vacancy</button>' +
                  '<button class="jw-btn" type="button" data-act="cancel-form">Cancel</button>';
      } else {
        buttons = S.opsErr
          ? '<div class="jw-note err">Could not confirm how vacancies are published (' + esc(S.opsErr) + '). Nothing can be posted until it is.</div>' +
            '<button class="jw-btn" type="button" data-act="retry-ops">Try again</button>'
          : '<p class="jw-sub">Checking how vacancies are published…</p>';
      }
      return '<div class="jw-card"><div class="jw-form">' +
        '<b>' + (job ? 'Edit vacancy' : 'New vacancy') + '</b>' +
        (job && REVIEW_LIVE.indexOf(job.status) >= 0 && modeOf(S.ops) === 'j2' ? '<p class="jw-sub">Salary, location and closing date stay live. Title, description, requirements, type and category changes go back to review.</p>' : '') +
        '<label>Title<input data-f="title" maxlength="100" value="' + esc(val('title')) + '"></label>' +
        '<label>Description<textarea data-f="description" rows="5" maxlength="5000">' + esc(val('description')) + '</textarea></label>' +
        '<label>Requirements<textarea data-f="requirements" rows="3" maxlength="3000">' + esc(val('requirements')) + '</textarea></label>' +
        '<div class="jw-two"><label>Type<select data-f="type">' + opt(VALID_TYPES, val('type'), TYPE_LABEL) + '</select></label>' +
        '<label>Category<select data-f="category">' + opt(VALID_CATEGORIES, val('category')) + '</select></label></div>' +
        '<label>Location<input data-f="location" maxlength="200" value="' + esc(val('location')) + '"></label>' +
        '<div class="jw-two"><label>Salary from (KES)<input data-f="salaryMin" inputmode="numeric" value="' + esc(val('salaryMin')) + '"></label>' +
        '<label>Salary to (KES)<input data-f="salaryMax" inputmode="numeric" value="' + esc(val('salaryMax')) + '"></label></div>' +
        '<label>' + (job ? 'Close in (days from today, leave blank to keep ' + esc(fmtDate(job.expiresAt)) + ')' : 'Open for (days, 1–90; 30 if blank)') +
          '<input data-f="expiresInDays" inputmode="numeric" value="' + esc(f.expiresInDays != null ? f.expiresInDays : '') + '"></label>' +
        note(ui.formNote) +
        '<div class="jw-acts">' + buttons + '</div></div></div>';
    }

    function jobCard (S, j) {
      var acts = jobActions(j, S.ops, now()), n = S.jobNotes[j.id];
      var btn = function (a) {
        if (a === 'edit') return '<button class="jw-btn" type="button" data-act="edit" data-job="' + esc(j.id) + '">Edit</button>';
        if (a === 'submit') return '<button class="jw-btn pri" type="button" data-act="submit-job" data-job="' + esc(j.id) + '">Submit for review</button>';
        if (a === 'pause') return '<button class="jw-btn" type="button" data-act="pause-job" data-job="' + esc(j.id) + '">Pause</button>';
        if (a === 'resume') return '<button class="jw-btn" type="button" data-act="resume-job" data-job="' + esc(j.id) + '">Resume</button>';
        if (a === 'close') return '<button class="jw-btn dan" type="button" data-act="close-ask" data-job="' + esc(j.id) + '">Close vacancy</button>';
        if (a === 'applications') return '<button class="jw-btn" type="button" data-act="see-apps" data-job="' + esc(j.id) + '">Applications</button>';
        return '';
      };
      var reason = (REASON_SHOWN.indexOf(j.status) >= 0 && j.moderationReason)
        ? '<div class="jw-note warn">' + (j.status === 'paused' ? 'Paused by SOKONI: ' : j.status === 'closed' ? 'Closed by SOKONI: ' : 'SOKONI review: ') + esc(j.moderationReason) + '</div>' : '';
      var closeAsk = ui.closeAsk === j.id
        ? '<div class="jw-note warn" role="alert">Close this vacancy? Applicants who are submitted, under review or shortlisted are told it closed. ' +
          'Interviews and offers stay with you. A closed vacancy cannot be re-opened.' +
          '<div class="jw-acts"><button class="jw-btn dan" type="button" data-act="close-confirm" data-job="' + esc(j.id) + '">Yes, close it</button>' +
          '<button class="jw-btn" type="button" data-act="close-cancel">Keep it open</button></div></div>' : '';
      return '<div class="jw-card" data-jobcard="' + esc(j.id) + '">' +
        '<div class="jw-row"><b>' + esc(j.title || 'Untitled vacancy') + '</b>' +
          '<span class="jw-chip" data-status="' + esc(j.status) + '">' + esc(jobStatusLabel(j)) + '</span>' +
          (j.featured === true ? '<span class="jw-badge" data-badge="featured">Featured</span>' : '') + '</div>' +
        '<div class="jw-meta">' + esc(TYPE_LABEL[j.type] || j.type || '—') + ' · ' + esc(j.location || 'Location not stated') + ' · ' + esc(salaryText(j)) + '</div>' +
        '<div class="jw-meta">Closes ' + esc(fmtDate(j.expiresAt)) + (j.status === 'active' && expired(j, now()) ? ' (closing date passed)' : '') +
          ' · Applications ' + esc(fmtCount(j.applicationCount)) + ' · Views ' + esc(fmtCount(j.viewCount)) + '</div>' +
        reason + closeAsk + note(n) +
        '<div class="jw-acts">' + acts.map(btn).join('') + '</div></div>';
    }

    function vJobs (S) {
      var w = loadingOr(S);
      var editing = ui.editId ? (S.jobs || []).filter(function (j) { return j.id === ui.editId; })[0] : null;
      return head('Jobs', 'Your vacancies. SOKONI reviews each vacancy before it is published; featured placement is set by SOKONI.') +
        (ui.form ? formHtml(S, editing) : '<div class="jw-acts" style="margin-bottom:12px"><button class="jw-btn pri" type="button" data-act="new">New vacancy</button></div>') +
        (S.jobNotes.__new ? note(S.jobNotes.__new) : '') +
        (w || (S.jobs.length ? S.jobs.map(function (j) { return jobCard(S, j); }).join('') +
          (S.jobsTrunc ? '<p class="jw-sub">Showing your ' + JOBS_LIMIT + ' most recent vacancies.</p>' : '')
          : '<p class="jw-sub">No vacancies yet.</p>'));
    }

    function appCard (S, a) {
      var moves = appActions(a, transitions(S)), n = S.notes[a.id], h = S.hist[a.id];
      var p = a.seekerProfile || {};
      var cv = (typeof a.cvUrl === 'string' && /^https:\/\//i.test(a.cvUrl))
        ? '<a class="jw-btn" href="' + esc(a.cvUrl) + '" target="_blank" rel="noopener noreferrer">Open CV</a>' : '';
      var btns = moves.map(function (to) {
        if (REASON_REQUIRED.indexOf(to) >= 0) {
          return '<input class="jw-reason" data-reason="' + esc(a.id) + '" maxlength="500" placeholder="Reason (the applicant sees this)" aria-label="Reason for rejecting">' +
            '<button class="jw-btn dan" type="button" data-act="move" data-app="' + esc(a.id) + '" data-to="' + esc(to) + '">' + esc(MOVE_LABEL[to]) + '</button>';
        }
        return '<button class="jw-btn' + (to === 'offer' || to === 'hired' ? ' pri' : '') + '" type="button" data-act="move" data-app="' + esc(a.id) + '" data-to="' + esc(to) + '">' + esc(MOVE_LABEL[to] || to) + '</button>';
      }).join('');
      var hist = h ? (h.err ? '<div class="jw-note err">' + esc(h.err) + '</div>'
        : '<ol class="jw-hist">' + (h.events || []).map(function (e) {
            return '<li>' + esc(e.label || e.to) + ' · ' + esc(e.actorRole || '') + (e.at ? ' · ' + esc(fmtDate(e.at)) : '') + (e.reason ? ' — ' + esc(e.reason) : '') + '</li>';
          }).join('') + '</ol>') : '';
      return '<div class="jw-card" data-appcard="' + esc(a.id) + '">' +
        '<div class="jw-row"><b>' + esc(p.name || 'Applicant') + '</b><span class="jw-chip" data-status="' + esc(a.status) + '">' + esc(a.statusLabel || APP_LABEL[a.status] || a.status) + '</span></div>' +
        '<div class="jw-meta">' + (p.headline ? esc(p.headline) + ' · ' : '') + esc(jobTitle(S, a.jobId, a.jobTitle) || 'Vacancy') + ' · Applied ' + esc(fmtDate(a.appliedAt)) + '</div>' +
        (a.coverLetter ? '<details><summary>Cover letter</summary><p>' + esc(a.coverLetter) + '</p></details>' : '') +
        note(n) +
        '<div class="jw-acts">' + btns + cv +
          '<button class="jw-btn" type="button" data-act="history" data-app="' + esc(a.id) + '">History</button>' +
          '<button class="jw-btn" type="button" data-act="message" data-app="' + esc(a.id) + '">Message applicant</button></div>' +
        hist + '</div>';
    }

    function vApps (S) {
      var w = loadingOr(S);
      var title = view === 'interviews' ? 'Interviews' : view === 'offers' ? 'Offers' : 'Applications';
      var sub = view === 'interviews' ? 'Applications at the interview stage.' : view === 'offers' ? 'Offers made, accepted or declined. Mark an applicant hired once they accept.' : 'Move each application one step at a time. The applicant is told at every step.';
      if (w) return head(title, sub) + w;
      var list = allApps(S).filter(function (a) {
        if (view === 'interviews') return INTERVIEW_VIEW.indexOf(a.status) >= 0;
        if (view === 'offers') return OFFER_VIEW.indexOf(a.status) >= 0;
        return (!S.jobFilter || a.jobId === S.jobFilter) && (!ui.statusFilter || a.status === ui.statusFilter);
      }).sort(function (x, y) { return (ms(y.appliedAt) || 0) - (ms(x.appliedAt) || 0); });
      var failed = (S.jobs || []).filter(function (j) { return S.apps[j.id] && S.apps[j.id].err; });
      var pending = (S.jobs || []).some(function (j) { return !S.apps[j.id]; });
      var filters = view === 'applications'
        ? '<div class="jw-two" style="margin-bottom:10px"><label class="jw-sub">Vacancy<select class="jw-reason" data-filter="job"><option value="">All vacancies</option>' +
            (S.jobs || []).map(function (j) { return '<option value="' + esc(j.id) + '"' + (S.jobFilter === j.id ? ' selected' : '') + '>' + esc(j.title) + '</option>'; }).join('') + '</select></label>' +
          '<label class="jw-sub">Stage<select class="jw-reason" data-filter="status"><option value="">All stages</option>' +
            APP_STATUSES.map(function (s) { return '<option value="' + esc(s) + '"' + (ui.statusFilter === s ? ' selected' : '') + '>' + esc(APP_LABEL[s]) + '</option>'; }).join('') + '</select></label></div>' : '';
      return head(title, sub) + filters +
        (failed.length ? '<div class="jw-note err">Applications for ' + failed.length + ' vacanc' + (failed.length === 1 ? 'y' : 'ies') + ' could not be loaded (' + esc(S.apps[failed[0].id].err) + '). <button class="jw-btn" type="button" data-act="reload">Try again</button></div>' : '') +
        (pending ? '<p class="jw-sub">Loading applications…</p>' : '') +
        (list.length ? list.map(function (a) { return appCard(S, a); }).join('') : (pending ? '' : '<p class="jw-sub">Nothing here yet.</p>'));
    }

    function vCandidates (S) {
      var w = loadingOr(S); if (w) return head('Candidates', null) + w;
      var by = {};
      allApps(S).forEach(function (a) { var k = a.seekerUid || a.id; (by[k] = by[k] || { p: a.seekerProfile || {}, apps: [] }).apps.push(a); });
      var keys = Object.keys(by);
      return head('Candidates', 'People who applied to your vacancies, from their applications. There is no separate candidate database.') +
        (keys.length ? keys.map(function (k) {
          var x = by[k], p = x.p;
          return '<div class="jw-card"><div class="jw-row"><b>' + esc(p.name || 'Applicant') + '</b>' + (p.location ? '<span class="jw-chip">' + esc(p.location) + '</span>' : '') + '</div>' +
            (p.headline ? '<div class="jw-meta">' + esc(p.headline) + '</div>' : '') +
            (Array.isArray(p.skills) && p.skills.length ? '<div class="jw-meta">Skills: ' + esc(p.skills.slice(0, 12).join(', ')) + '</div>' : '') +
            '<div class="jw-meta">' + x.apps.map(function (a) { return esc(jobTitle(S, a.jobId, a.jobTitle) || 'Vacancy') + ' — ' + esc(a.statusLabel || APP_LABEL[a.status] || a.status); }).join('<br>') + '</div></div>';
        }).join('') : '<p class="jw-sub">' + ((S.jobs || []).some(function (j) { return !S.apps[j.id]; }) ? 'Loading applications…' : 'No applicants yet.') + '</p>');
    }

    function vMessages () {
      return head('Messages', 'Conversations with applicants, one per application, inside SOKONI.') +
        '<div class="jw-card"><p class="jw-sub">Open a conversation from any application with "Message applicant". SOKONI works out who ' +
        'is in the conversation from the application itself, so nothing about the applicant is sent from this page. ' +
        'Applicants are also told about every step of their application through SOKONI notifications.</p>' +
        '<div class="jw-acts"><button class="jw-btn" type="button" data-go="applications">Go to applications</button></div></div>';
    }
    function vCompany () {
      var name = null; try { name = typeof c.companyName === 'function' ? c.companyName() : null; } catch (_) { name = null; }
      return head('Company', 'How applicants see your business.') +
        '<div class="jw-card"><div class="jw-meta">Company name on new vacancies</div><b>' + esc(name || '—') + '</b>' +
        '<p class="jw-sub" style="margin-top:8px">Taken from your shop profile when a vacancy is created. Change it in Shop Details. ' +
        'Vacancies belong to your account today; business-level employer profiles come later.</p>' +
        '<div class="jw-acts"><button class="jw-btn" type="button" data-go-route="shop">Open Shop Details</button></div></div>';
    }
    function vWallet () {
      return head('Wallet', null) + '<div class="jw-card"><b>Not available yet</b><p class="jw-sub">Posting a vacancy is free and applying is always free. ' +
        'Paid hiring features are not priced and are switched off, so there is nothing to pay or to receive here.</p></div>';
    }
    function vProducts () {
      return head('Products', null) + '<div class="jw-card"><b>Not available yet</b><p class="jw-sub">Hiring add-ons (such as promoted vacancies) are not priced and are switched off. ' +
        'Featured placement is decided by SOKONI and cannot be bought or switched on here.</p></div>';
    }
    function vAnalytics (S) {
      var w = loadingOr(S); if (w) return head('Analytics', null) + w;
      var c0 = counts(S, now()), b = c0.byStatus || {};
      var rows = (S.jobs || []).map(function (j) {
        var a = S.apps[j.id], list = a && Array.isArray(a.list) ? a.list : null;
        var n = function (st) { return list ? list.filter(function (x) { return st.indexOf(x.status) >= 0; }).length : null; };
        return '<tr><td>' + esc(j.title) + '<br><span class="jw-meta">' + esc(jobStatusLabel(j)) + '</span></td><td>' + esc(fmtCount(j.viewCount)) + '</td><td>' + esc(fmtCount(j.applicationCount)) +
          '</td><td>' + esc(fmtCount(n(['interview']))) + '</td><td>' + esc(fmtCount(n(['offer', 'offer_accepted']))) + '</td><td>' + esc(fmtCount(n(['hired']))) + '</td></tr>';
      }).join('');
      var funnel = ['pending', 'reviewing', 'shortlisted', 'interview', 'offer', 'offer_accepted', 'hired', 'rejected', 'withdrawn', 'offer_declined', 'closed'];
      return head('Analytics', 'From your vacancies and the applications this page loaded. Views and application totals are the server\'s counters.') +
        '<div class="jw-tiles">' + funnel.map(function (k) { return tile(APP_LABEL[k], c0.appsComplete ? b[k] : null); }).join('') + '</div>' +
        (rows ? '<div class="jw-scroll"><table class="jw-tbl"><thead><tr><th>Vacancy</th><th>Views</th><th>Applications</th><th>Interview</th><th>Offer</th><th>Hired</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="jw-sub">No vacancies yet.</p>');
    }

    /* ── actions ── */
    function q (sel) { try { return host.querySelector(sel); } catch (_) { return null; } }
    function readForm () {
      var out = {}, els = [];
      try { els = host.querySelectorAll('[data-f]') || []; } catch (_) { els = []; }
      Array.prototype.forEach.call(els, function (el) { out[el.getAttribute ? el.getAttribute('data-f') : el.dataset.f] = el.value; });
      return out;
    }
    function num (v) { var s = String(v == null ? '' : v).replace(/[,\s]/g, ''); return s === '' ? null : Number(s); }
    function normalise (raw) {
      return { title: String(raw.title || '').trim(), description: String(raw.description || '').trim(),
        requirements: String(raw.requirements || '').trim(), type: raw.type || '', category: raw.category || '',
        location: String(raw.location || '').trim(), salaryMin: num(raw.salaryMin), salaryMax: num(raw.salaryMax),
        expiresInDays: num(raw.expiresInDays) };
    }
    function findJob (S, id) { return (S.jobs || []).filter(function (j) { return j.id === id; })[0] || null; }
    function findApp (S, id) { return allApps(S).filter(function (a) { return a.id === id; })[0] || null; }

    function create (S, submitAttr) {
      var mode = modeOf(S.ops);
      if (mode === 'unknown') { ui.formNote = { kind: 'err', text: 'Could not confirm how vacancies are published. Nothing was posted.' }; return render(); }
      var f = normalise(readForm()); ui.form = readForm();
      var bad = validateJob(f, true);
      if (bad) { ui.formNote = { kind: 'err', text: bad }; return render(); }
      var payload = { title: f.title, description: f.description, requirements: f.requirements, type: f.type, category: f.category,
        location: f.location, salaryMin: f.salaryMin, salaryMax: f.salaryMax };
      if (f.expiresInDays != null) payload.expiresInDays = f.expiresInDays;
      if (mode === 'j2') payload.submit = submitAttr === '1';
      ui.busy = true; ui.formNote = { text: 'Saving…' }; render();
      return call('createJob', payload).then(function (d) {
        var st = d && d.job && d.job.status;
        S.jobNotes.__new = { text: 'Saved. "' + ((d && d.job && d.job.title) || f.title) + '" is now: ' + jobStatusLabel({ status: st }) + '.' };
        ui.form = null; ui.formNote = null; toast('Vacancy saved');
        return loadJobs(S, true);
      }, function (e) { ui.formNote = { kind: 'err', text: errMsg(e) }; })
        .then(function () { ui.busy = false; render(); });
    }

    function saveEdit (S) {
      var job = findJob(S, ui.editId); if (!job) { ui.form = null; return render(); }
      var raw = readForm(); ui.form = raw;
      var f = normalise(raw), changes = {};
      ['title', 'description', 'requirements', 'type', 'category', 'location'].forEach(function (k) {
        if (String(f[k] || '') !== String(job[k] == null ? '' : job[k])) changes[k] = f[k];
      });
      ['salaryMin', 'salaryMax'].forEach(function (k) { if (f[k] !== (job[k] == null ? null : job[k])) changes[k] = f[k]; });
      if (f.expiresInDays != null) changes.expiresInDays = f.expiresInDays;
      if (!Object.keys(changes).length) { ui.formNote = { text: 'Nothing changed.' }; return render(); }
      var bad = validateJob(Object.assign({}, changes, {
        salaryMin: 'salaryMin' in changes ? changes.salaryMin : job.salaryMin, salaryMax: 'salaryMax' in changes ? changes.salaryMax : job.salaryMax }), false);
      if (bad) { ui.formNote = { kind: 'err', text: bad }; return render(); }
      /* The warning comes BEFORE the save, and only for the fields that send a live vacancy back to review. */
      if (modeOf(S.ops) === 'j2' && needsReReview(job, changes) && !ui.confirmReview) { ui.confirmReview = true; ui.formNote = null; return render(); }
      ui.busy = true; ui.formNote = { text: 'Saving…' }; render();
      return call('updateJob', Object.assign({ jobId: job.id }, changes)).then(function (d) {
        S.jobNotes[job.id] = (d && d.backToReview === true)
          ? { kind: 'warn', text: 'Saved. The vacancy went back to review and is hidden until SOKONI approves it.' }
          : { text: 'Saved.' + (d && d.status ? ' Status: ' + jobStatusLabel({ status: d.status }) + '.' : '') };
        ui.form = null; ui.editId = null; ui.confirmReview = false; ui.formNote = null;
        return loadJobs(S, true);
      }, function (e) { ui.formNote = { kind: 'err', text: errMsg(e) }; })
        .then(function () { ui.busy = false; render(); });
    }

    function jobOp (S, op, jobId) {
      S.jobNotes[jobId] = { text: 'Working…' }; render();
      return call(op, { jobId: jobId }).then(function (d) {
        S.jobNotes[jobId] = { text: 'Done. Status: ' + jobStatusLabel({ status: d && d.status }) + '.' };
        return loadJobs(S, true);
      }, function (e) { S.jobNotes[jobId] = { kind: 'err', text: errMsg(e) }; }).then(render);
    }

    function closeJob (S, jobId) {
      ui.closeAsk = null; S.jobNotes[jobId] = { text: 'Closing…' }; render();
      return call('closeJob', { jobId: jobId }).then(function (d) {
        var n = d && typeof d.closedApplications === 'number' ? d.closedApplications : null;
        S.jobNotes[jobId] = { text: 'Vacancy closed. Applications closed: ' + fmtCount(n) + ' (those applicants were told). Interviews and offers stay open.' };
        delete S.apps[jobId];
        return loadJobs(S, true).then(function () { return refreshApps(S, jobId); });
      }, function (e) { S.jobNotes[jobId] = { kind: 'err', text: errMsg(e) }; }).then(render);
    }

    function move (S, appId, to) {
      var a = findApp(S, appId); if (!a) return;
      if (appActions(a, transitions(S)).indexOf(to) < 0) { S.notes[appId] = { kind: 'err', text: 'That step is not available from "' + (a.statusLabel || a.status) + '".' }; return render(); }
      var v = Number(a.statusVersion);
      if (!(v >= 1)) { S.notes[appId] = { kind: 'err', text: CONFLICT_MSG }; return render(); }
      var payload = { applicationId: appId, status: to, expectedVersion: v };
      if (REASON_REQUIRED.indexOf(to) >= 0) {
        var el = q('[data-reason="' + appId + '"]'), r = el ? String(el.value || '').trim() : '';
        if (!r) { S.notes[appId] = { kind: 'err', text: 'Give the applicant a reason before rejecting.' }; return render(); }
        payload.reason = r;
      }
      S.notes[appId] = { text: 'Saving…' }; render();
      return call('updateApplicationStatus', payload).then(function (d) {
        S.notes[appId] = { text: 'Moved to ' + (APP_LABEL[(d && d.status) || to] || to) + '. The applicant was told.' };
        delete S.hist[appId];
        return refreshApps(S, a.jobId);
      }, function (e) {
        if (isConflict(e)) { S.notes[appId] = { kind: 'err', text: CONFLICT_MSG + '. The latest version is shown.' }; return refreshApps(S, a.jobId); }
        S.notes[appId] = { kind: 'err', text: errMsg(e) };
      }).then(render);
    }

    function history (S, appId) {
      if (S.hist[appId]) { delete S.hist[appId]; return render(); }
      return call('getApplicationHistory', { applicationId: appId }).then(function (d) {
        S.hist[appId] = { events: (d && Array.isArray(d.events)) ? d.events : [] };
      }, function (e) { S.hist[appId] = { err: errMsg(e) }; }).then(render);
    }

    function onClick (e) {
      var t = e && e.target; if (!t || typeof t.closest !== 'function') return;
      var S = store(uid());
      var g = t.closest('[data-go]');
      if (g) { var v = g.getAttribute('data-go'); if (typeof c.go === 'function') c.go(ROUTE_OF[v] || v); return; }
      var gr = t.closest('[data-go-route]');
      if (gr) { if (typeof c.go === 'function') c.go(gr.getAttribute('data-go-route')); return; }
      var b = t.closest('[data-act]'); if (!b || b.disabled) return;
      var act = b.getAttribute('data-act'), jobId = b.getAttribute('data-job'), appId = b.getAttribute('data-app');
      if (ui.busy && (act === 'create' || act === 'save-edit')) return;
      switch (act) {
        case 'new': ui.form = {}; ui.editId = null; ui.confirmReview = false; ui.formNote = null; return render();
        case 'cancel-form': ui.form = null; ui.editId = null; ui.confirmReview = false; ui.formNote = null; return render();
        case 'create': return create(S, b.getAttribute('data-submit'));
        case 'edit': ui.form = {}; ui.editId = jobId; ui.confirmReview = false; ui.formNote = null; return render();
        case 'save-edit': return saveEdit(S);
        case 'submit-job': return jobOp(S, 'submitJob', jobId);
        case 'pause-job': return jobOp(S, 'pauseJob', jobId);
        case 'resume-job': return jobOp(S, 'resumeJob', jobId);
        case 'close-ask': ui.closeAsk = jobId; return render();
        case 'close-cancel': ui.closeAsk = null; return render();
        case 'close-confirm': return closeJob(S, jobId);
        case 'see-apps': S.jobFilter = jobId; if (typeof c.go === 'function') c.go('jobs-applications'); return;
        case 'move': return move(S, appId, b.getAttribute('data-to'));
        case 'history': return history(S, appId);
        case 'message': openApplicationChat(appId, c.window); return;
        case 'retry-ops': loadOps(S, true); return render();
        case 'reload': S.apps = {}; ensure(true); return render();
      }
    }
    function onChange (e) {
      var t = e && e.target; if (!t || !t.getAttribute) return;
      var f = t.getAttribute('data-filter'); if (!f) return;
      if (f === 'job') store(uid()).jobFilter = t.value || ''; else if (f === 'status') ui.statusFilter = t.value || '';
      render();
    }
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    SUBS.push(render);
    ensure(false);
    render();

    return {
      view: view,
      refresh: function () {
        /* the applications filter set by "Applications" on a vacancy is shared through the store */
        ensure(false); render();
      },
      destroy: function () {
        dead = true;
        var i = SUBS.indexOf(render); if (i >= 0) SUBS.splice(i, 1);
        try { host.removeEventListener('click', onClick); host.removeEventListener('change', onChange); } catch (_) {}
      },
      _act: { create: function (s) { return create(store(uid()), s); }, saveEdit: function () { return saveEdit(store(uid())); },
              move: function (id, to) { return move(store(uid()), id, to); }, closeJob: function (id) { return closeJob(store(uid()), id); },
              jobOp: function (op, id) { return jobOp(store(uid()), op, id); }, ui: ui, render: render }
    };
  }

  global.SokoniMerchantJobs = {
    mount: mount, VIEWS: VIEWS, ROUTE_OF: ROUTE_OF,
    _reset: function () { STORE = null; SUBS.length = 0; },
    _pure: { jobActions: jobActions, appActions: appActions, needsReReview: needsReReview, counts: counts, fmtCount: fmtCount,
             parseOps: parseOps, modeOf: modeOf, isUnknownOp: isUnknownOp, validCaps: validCaps, jobStatusLabel: jobStatusLabel, validateJob: validateJob, isConflict: isConflict,
             esc: esc, ms: ms, EMPLOYER_TRANSITIONS: EMPLOYER_TRANSITIONS, JOB_LABEL: JOB_LABEL, CONFLICT_MSG: CONFLICT_MSG,
             TX_TYPE: TX_TYPE, messageUrl: messageUrl, openApplicationChat: openApplicationChat }
  };
})(typeof window !== 'undefined' ? window : globalThis);
