/* AdminOS › Jobs (sokoni-f3, 2026-10-03) — the Jobs moderation workspace inside the ONE canonical admin-os.html.
   Server authority: functions/jobs.js J2 (servicesDispatch ops adminListJobs / adminGetJob / adminModerateJob,
   functions/jobs-on-ca55f8b @ a515270). This module never writes Firestore; every decision is an audited callable,
   and the server re-checks admin claims, legal transitions and required reasons.
   Ships ATOMICALLY with J2: before J2 is deployed these ops do not exist, so the panel shows an honest error, not data. */
(function (global) {
  'use strict';
  var STATUSES = [
    ['pending_review', 'Review queue'], ['changes_requested', 'Changes requested'], ['active', 'Published'],
    ['paused', 'Paused'], ['closed', 'Closed'], ['rejected', 'Rejected'], ['archived', 'Archived'], ['draft', 'Drafts'],
  ];
  /* Mirrors ADMIN_ACTIONS in functions/jobs.js — only to decide which buttons to SHOW; the server decides. */
  var ACTIONS = {
    draft:             ['close'],
    pending_review:    ['approve', 'request_changes', 'reject', 'close'],
    changes_requested: ['reject', 'close', 'unfeature'],
    active:            ['feature', 'unfeature', 'request_changes', 'pause', 'close'],
    paused:            ['restore', 'request_changes', 'close', 'unfeature'],
    closed:            ['restore', 'archive', 'unfeature'],
    rejected:          ['archive', 'unfeature'],
    archived:          ['unfeature'],
  };
  var NEEDS_REASON = { request_changes: 1, reject: 1, pause: 1, close: 1 };
  var LABEL = { approve: 'Approve', request_changes: 'Request changes', reject: 'Reject', pause: 'Pause', restore: 'Restore',
    close: 'Close', archive: 'Archive', feature: 'Feature', unfeature: 'Unfeature' };
  var state = { status: 'pending_review', open: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(t) { var ms = t && (t._seconds ? t._seconds * 1000 : t.seconds ? t.seconds * 1000 : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : 0);
    return ms ? new Date(ms).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function kes(n) { var v = Number(n); return n != null && isFinite(v) ? 'KES ' + v.toLocaleString('en-KE') : '—'; }
  function body() { return document.getElementById('jobsAdminBody'); }
  function call(op, data) {
    return global.firebase.functions().httpsCallable('servicesDispatch')(Object.assign({ op: op }, data || {})).then(function (r) { return r.data; });
  }
  function errText(e) { return (e && e.message ? String(e.message) : 'Something went wrong').replace(/^.*?:\s*/, '').slice(0, 300); }
  function toast(msg, kind) { if (global.SokoniAOS && typeof global.SokoniAOS.toast === 'function') global.SokoniAOS.toast(msg, kind); }

  function tabs() {
    return '<div class="aos-tabs" role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + STATUSES.map(function (s) {
      return '<button type="button" class="aos-btn-sm" role="tab" data-jobs-tab="' + s[0] + '"' + (state.status === s[0] ? ' aria-current="true" style="font-weight:800"' : '') + '>' + esc(s[1]) + '</button>';
    }).join('') + '</div>';
  }

  function load(status) {
    if (status) state.status = status;
    state.open = null;
    var b = body(); if (!b) return;
    b.innerHTML = tabs() + '<div class="aos-spinner"><div></div></div>';
    call('adminListJobs', { status: state.status, limit: 100 }).then(function (d) {
      var jobs = (d && d.jobs) || [];
      var rows = jobs.map(function (j) {
        return '<tr><td><b>' + esc(j.title) + '</b>' + (j.featured ? ' <span class="status-badge">Featured</span>' : '') + '<div class="aos-muted">' + esc(j.companyName || '—') + '</div></td>'
          + '<td class="aos-muted">' + esc(j.type || '—') + ' · ' + esc(j.category || '—') + '</td>'
          + '<td class="aos-muted">' + esc(j.location || '—') + '</td>'
          + '<td>' + (j.salaryMin != null || j.salaryMax != null ? esc(kes(j.salaryMin)) + ' – ' + esc(kes(j.salaryMax)) : '—') + '</td>'
          + '<td class="aos-muted">' + esc(when(j.submittedAt || j.postedAt)) + '</td>'
          + '<td><button type="button" class="aos-btn-sm" data-jobs-open="' + esc(j.jobId) + '">Open</button> '
          + '<button type="button" class="aos-btn-sm" data-jobs-employer="' + esc(j.employerUid || '') + '">Employer</button></td></tr>';
      });
      b.innerHTML = tabs() + (rows.length
        ? '<table class="aos-table"><thead><tr><th>Vacancy</th><th>Type</th><th>Location</th><th>Salary</th><th>Submitted</th><th></th></tr></thead><tbody>' + rows.join('') + '</tbody></table>'
        : '<div class="aos-empty">No vacancies in "' + esc((STATUSES.filter(function (s) { return s[0] === state.status; })[0] || [0, state.status])[1]) + '".</div>');
    }).catch(function (e) {
      b.innerHTML = tabs() + '<div class="aos-empty">Couldn\'t load vacancies — ' + esc(errText(e)) + ' This is not an empty list.</div>'
        + '<div style="text-align:center;margin-top:8px"><button type="button" class="aos-btn-sm" data-jobs-retry>Try again</button></div>';
    });
  }

  function open(jobId) {
    state.open = jobId;
    var b = body(); if (!b) return;
    b.innerHTML = '<div class="aos-spinner"><div></div></div>';
    call('adminGetJob', { jobId: jobId }).then(function (d) {
      var j = d.job || {}, counts = d.applicationCounts || {};
      var acts = (ACTIONS[j.status] || []).filter(function (a) { return !((a === 'feature' && j.featured) || (a === 'unfeature' && !j.featured)); });
      var countTxt = Object.keys(counts).length ? Object.keys(counts).map(function (k) { return esc(k) + ': ' + esc(counts[k]); }).join(' · ') : 'No applications';
      var apps = (d.applications || []).map(function (a) {
        return '<tr><td class="aos-muted">' + esc(a.id) + '</td><td>' + esc(a.statusLabel || a.status) + '</td><td class="aos-muted">' + esc(when(a.appliedAt)) + '</td>'
          + '<td><button type="button" class="aos-btn-sm" data-jobs-employer="' + esc(a.seekerUid) + '">Applicant</button></td></tr>';
      }).join('');
      var trail = (d.trail || []).map(function (t) {
        return '<li><b>' + esc(t.action) + '</b> ' + esc(t.from || '—') + ' → ' + esc(t.to || '—') + ' <span class="aos-muted">by ' + esc(t.actorRole) + ' · ' + esc(when(t.at)) + '</span>' + (t.reason ? '<div class="aos-muted">“' + esc(t.reason) + '”</div>' : '') + '</li>';
      }).join('');
      b.innerHTML = '<button type="button" class="aos-btn-sm" data-jobs-back>&larr; Back</button>'
        + '<h3 style="margin:10px 0 4px">' + esc(j.title) + (j.featured ? ' <span class="status-badge">Featured</span>' : '') + '</h3>'
        + '<div class="aos-muted">' + esc(j.companyName || '—') + ' · ' + esc(j.type || '—') + ' · ' + esc(j.location || '—') + ' · <b>' + esc(j.statusLabel || j.status) + '</b> · closes ' + esc(when(j.expiresAt)) + '</div>'
        + (j.moderationReason ? '<div style="margin-top:6px">Last reason given: “' + esc(j.moderationReason) + '”</div>' : '')
        + '<div style="margin-top:10px;white-space:pre-wrap">' + esc(j.description) + '</div>'
        + (j.requirements ? '<div style="margin-top:8px;white-space:pre-wrap"><b>Requirements</b>\n' + esc(j.requirements) + '</div>' : '')
        + '<div style="margin-top:8px">Salary: ' + (j.salaryMin != null || j.salaryMax != null ? esc(kes(j.salaryMin)) + ' – ' + esc(kes(j.salaryMax)) : '—') + '</div>'
        + (acts.length ? '<div style="margin-top:12px"><label for="jobsReason" class="aos-muted">Reason (required for request changes, reject, pause, close — the employer sees it)</label>'
          + '<textarea id="jobsReason" class="aos-input" rows="2" maxlength="500" style="width:100%"></textarea>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' + acts.map(function (a) { return '<button type="button" class="aos-btn-sm" data-jobs-act="' + a + '">' + esc(LABEL[a]) + '</button>'; }).join('') + '</div>'
          + '<div id="jobsActMsg" class="aos-muted" role="status" aria-live="polite" style="margin-top:6px"></div></div>' : '')
        + '<h4 style="margin:14px 0 4px">Applications</h4><div class="aos-muted">' + countTxt + '</div>'
        + (apps ? '<table class="aos-table"><thead><tr><th>Application</th><th>Status</th><th>Applied</th><th></th></tr></thead><tbody>' + apps + '</tbody></table>' : '')
        + '<h4 style="margin:14px 0 4px">Moderation trail</h4>' + (trail ? '<ul>' + trail + '</ul>' : '<div class="aos-muted">—</div>');
    }).catch(function (e) {
      b.innerHTML = '<button type="button" class="aos-btn-sm" data-jobs-back>&larr; Back</button><div class="aos-empty">Couldn\'t open this vacancy — ' + esc(errText(e)) + '</div>';
    });
  }

  function act(action, btn) {
    var reasonEl = document.getElementById('jobsReason'), msg = document.getElementById('jobsActMsg');
    var reason = reasonEl ? reasonEl.value.trim() : '';
    if (NEEDS_REASON[action] && reason.length < 3) { if (msg) msg.textContent = 'Give the employer a reason first (at least 3 characters).'; if (reasonEl) reasonEl.focus(); return; }
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'Working…';
    call('adminModerateJob', { jobId: state.open, action: action, reason: reason }).then(function (r) {
      /* success is shown only after the server confirmed the transition */
      toast('Vacancy ' + (LABEL[action] || action).toLowerCase() + (r && r.unchanged ? ' (no change)' : 'd'), 'success');
      open(state.open);
    }).catch(function (e) { if (btn) btn.disabled = false; if (msg) msg.textContent = errText(e); });
  }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var panel = t.closest('#panel-jobs'); if (!panel) return;
    var b;
    if ((b = t.closest('[data-jobs-tab]'))) { load(b.getAttribute('data-jobs-tab')); return; }
    if (t.closest('[data-jobs-retry]')) { load(); return; }
    if (t.closest('[data-jobs-back]')) { load(); return; }
    if ((b = t.closest('[data-jobs-open]'))) { open(b.getAttribute('data-jobs-open')); return; }
    if ((b = t.closest('[data-jobs-employer]'))) { var u = b.getAttribute('data-jobs-employer'); if (u && global.SokoniAOS && global.SokoniAOS.viewUser) global.SokoniAOS.viewUser(u); return; }
    if ((b = t.closest('[data-jobs-act]'))) { act(b.getAttribute('data-jobs-act'), b); return; }
  }
  if (typeof document !== 'undefined') document.addEventListener('click', onClick);

  global.SokoniAOSJobs = { load: load, open: open, ACTIONS: ACTIONS, NEEDS_REASON: NEEDS_REASON };
})(typeof window !== 'undefined' ? window : this);
