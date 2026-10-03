/* ============================================================================
   SOKONI — Partner registrations view (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-partner-registrations.js   ·   styles: reuses sokoni-admin-payout-approvals.css (sk-pa-*)

   Financial partners (banks, SACCOs, chamas, MFIs, insurers, forex, accountants, advisers, investment
   firms) submit their regulator registration from their workspace. It stays SELF-DECLARED until an
   administrator reviews it here. Approve grants the public badge "Registration reviewed by SOKONI" —
   SOKONI's paperwork check, never a licence confirmation. A LICENCE CHECK is a separate record: the
   administrator states which regulator register they checked (URL, or register name + reference).

   Mounted by BOTH consoles with their own canonical transport (opts.call), same contract as
   Payout approvals:
     admin-os.html     #panel-partner-registrations  via SokoniAOS.navigate('partner-registrations')
     super-admin.html  #panel-partner-registrations  via SA.nav('partner-registrations')

   SOURCE: financialPartnerDispatch (App Check; admin claim checked server-side; NOT deployed yet)
     { op:'adminListRegistrations', status:'under_review'|'approved'|'needs_information'|'rejected' }
       → { rows:[{ partnerUid, regulator, registeredName, registrationNumber, kraPin, validUntil,
                   status, submittedAt (ms|null), reviewNote }] }
     { op:'adminReviewRegistration', partnerUid, verdict:'approved'|'needs_information'|'rejected', note }
       → { ok:true, status }   (note REQUIRED unless approving)
     { op:'adminRevokeReview', partnerUid, note }                       → { ok:true, status:'rejected' }
     { op:'adminRecordLicenceCheck', partnerUid, verificationStatus:'verified_against_register'|
       'not_found_on_register'|'mismatch'|'cleared', licenceType, licenceNumber, issuingAuthority,
       expiryDate?, verificationSource }                                → { ok:true, verificationStatus }

   RENDERING: textContent / setAttribute only. Every outcome is shown ONLY after the server answers ok:true.
   EVIDENCE: not-attempted · observed · empty · unreadable — an unreadable list is never "none waiting".
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminPartnerRegistrations) return;

  var NEUTRAL = '—';
  var FN = 'financialPartnerDispatch';
  var NOTE_MAX = 500;
  var STATUSES = ['under_review', 'approved', 'needs_information', 'rejected'];
  var BADGE = 'Registration reviewed by SOKONI';
  var STATUS_LABEL = { under_review: 'Waiting for review', approved: 'Approved — ' + BADGE, verified: 'Approved — ' + BADGE, needs_information: 'Needs information', rejected: 'Not accepted' };
  var VERDICTS = [
    { verdict: 'approved', key: 'approve', label: 'Approve', primary: true, done: 'Approved — badge “' + BADGE + '” granted' },
    { verdict: 'needs_information', key: 'needs_information', label: 'Needs information', done: 'Asked the partner for more information' },
    { verdict: 'rejected', key: 'reject', label: 'Reject', done: 'Marked not accepted' },
  ];
  var LICENCE_RESULTS = [
    ['verified_against_register', 'Found on the register — details match'],
    ['not_found_on_register', 'Not found on the register'],
    ['mismatch', 'On the register, but the details do not match'],
    ['cleared', 'Clear the recorded licence check'],
  ];
  var SOURCE_HELP = 'Register URL or register name + reference — not an uploaded document';
  var LICENCE_NUMBER_RE = /^[A-Za-z0-9\/.\- ]+$/;
  var DOCUMENT_RE = /upload|document|pdf|screenshot/i;
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  var DENIED = /^(functions\/)?(permission-denied|unauthenticated)$/;
  function str(v) { return v == null ? '' : String(v); }
  function code(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }

  function classifyError(e) {
    var c = code(e);
    if (NOT_DEPLOYED.test(c)) return { state: 'unavailable', code: c };
    if (DENIED.test(c)) return { state: 'denied', code: c };
    return { state: 'error', code: c };
  }
  function toViewModel(outcome, status) {
    var vm = { status: status };
    if (!outcome) { vm.state = 'loading'; return vm; }
    if (outcome.error !== undefined) { var c = classifyError(outcome.error); vm.state = c.state; vm.code = c.code; return vm; }
    var d = outcome.data;
    if (!d || !Array.isArray(d.rows)) { vm.state = 'error'; vm.code = 'unexpected response'; return vm; }
    vm.rows = d.rows; vm.state = d.rows.length ? 'observed' : 'empty';
    return vm;
  }
  function headline(vm) {
    var what = (STATUS_LABEL[vm.status] || vm.status).toLowerCase();
    switch (vm.state) {
      case 'loading': return { evidence: 'not-attempted', text: 'Reading partner registrations…' };
      case 'unavailable': return { evidence: 'unreadable', text: 'Partner registrations not available yet', detail: 'The server side (' + FN + ') is not deployed yet (' + vm.code + '). This is not “none waiting”.' };
      case 'denied': return { evidence: 'unreadable', text: 'You do not have access', detail: 'Restricted to administrators (' + vm.code + ').' };
      case 'error': return { evidence: 'unreadable', text: 'Could not read partner registrations', detail: 'The server did not return the list (' + vm.code + '). Nothing is shown in its place.' };
      case 'empty': return { evidence: 'empty', text: 'No registrations ' + (vm.status === 'under_review' ? 'waiting for review' : 'marked ' + what) };
      case 'observed': return { evidence: 'observed', text: vm.rows.length + ' registration' + (vm.rows.length === 1 ? '' : 's') + ' — ' + what + (vm.rows.length >= 100 ? ' (first 100)' : '') };
      default: return { evidence: 'not-attempted', text: 'Not read yet.' };
    }
  }
  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return NEUTRAL;
    try { return new Date(ms).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT'; }
    catch (_) { return new Date(ms).toISOString(); }
  }
  function reviewErrorText(e) {
    var c = code(e).replace(/^functions\//, ''), m = str(e && e.message).replace(/^functions\/[a-z-]+:?\s*/, '').trim().slice(0, 300);
    if (c === 'unavailable' || c === 'internal' || c === 'not-found') return 'Partner registrations not available yet';
    if (m && m !== c && /\s/.test(m) && c !== 'unauthenticated') return m;   /* the server's own sentence, as text */
    if (c === 'permission-denied') return 'You do not have permission to review registrations';
    if (c === 'unauthenticated') return 'Your session has expired — sign in again';
    if (c === 'failed-precondition') return 'Already reviewed, or nothing waiting';
    if (c === 'invalid-argument') return /note/i.test(m) ? 'Add a note saying why it is not accepted' : 'The server rejected this request as invalid';
    return 'Review failed (' + c + ')';
  }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function defaultCall(name, data) {
    if (!window.firebase || typeof window.firebase.functions !== 'function') return Promise.reject({ code: 'functions/unavailable' });
    return window.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r && r.data; });
  }

  function View(host, opts) {
    this.host = host;
    this.console = (opts && opts.console) || 'aos';
    this.call = (opts && typeof opts.call === 'function') ? opts.call : defaultCall;
    this.status = 'under_review';
    this.seq = 0; this.inflight = 0;
    this.vm = toViewModel(null, this.status);
    this.build(); this.refresh();
  }
  View.prototype.build = function () {
    var self = this, uid = 'skPr' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.host.textContent = '';
    this.statusEl = h('p', { class: 'sk-pa-status', role: 'status', 'aria-live': 'polite', 'data-pr': 'status' });
    this.detail = h('p', { class: 'sk-pa-detail', 'data-pr': 'detail', hidden: true });
    this.evidence = h('span', { class: 'sk-pa-evidence', 'data-pr': 'evidence' });
    this.tableWrap = h('div', { class: 'sk-pa-scroll', tabindex: '0', role: 'region', 'aria-label': 'Partner registrations (scrolls sideways on small screens)', hidden: true });
    var sel = h('select', { id: uid + 'St', class: 'sk-pa-input', 'data-pr': 'filter',
      onchange: function () { self.status = STATUSES.indexOf(this.value) >= 0 ? this.value : 'under_review'; self.refresh(); } },
      STATUSES.map(function (s) { return h('option', { value: s, text: STATUS_LABEL[s] }); }));
    this.refreshBtn = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { self.refresh(); } });
    this.host.appendChild(h('div', { class: 'sk-pa', 'data-console': this.console }, [
      h('header', { class: 'sk-pa-hero' }, [
        h('p', { class: 'sk-pa-eyebrow', text: 'Banking Hub · admin review' }),
        h('h2', { class: 'sk-pa-title', text: 'Partner registrations' }),
        h('p', { class: 'sk-pa-lede', text: 'Regulator registrations submitted by listed financial partners. Check the paperwork and the number against the regulator (CBK, SASRA, IRA, CMA, RBA, ICPAK…). Approve grants the public badge “' + BADGE + '” — SOKONI\'s paperwork check, not a licence confirmation.' }),
        h('p', { class: 'sk-pa-detail', 'data-pr': 'licence-note', text: 'Licence checks are separate: record which regulator register you checked and what it showed. A licence check never grants or removes the badge.' }),
      ]),
      h('div', { class: 'sk-pa-controls', role: 'group', 'aria-label': 'Registration filters' }, [
        h('label', { class: 'sk-pa-field', for: uid + 'St' }, [h('span', { text: 'Show' }), sel]), this.refreshBtn]),
      h('div', { class: 'sk-pa-summary' }, [this.evidence, this.statusEl]),
      this.detail, this.tableWrap,
    ]));
  };
  View.prototype.refresh = function () {
    if (this.inflight > 0) return Promise.resolve();
    var self = this, seq = ++this.seq, status = this.status;
    this.vm = toViewModel(null, status); this.render();
    return Promise.resolve().then(function () { return self.call(FN, { op: 'adminListRegistrations', status: status }); })
      .then(function (d) { return { data: d }; }, function (e) { return { error: e || {} }; })
      .then(function (o) { if (seq !== self.seq) return; self.vm = toViewModel(o, status); self.render(); });
  };
  View.prototype.render = function () {
    var vm = this.vm, hd = headline(vm);
    this.statusEl.textContent = hd.text;
    this.evidence.textContent = 'Evidence: ' + hd.evidence;
    this.evidence.className = 'sk-pa-evidence sk-pa-ev-' + hd.evidence;
    this.evidence.setAttribute('data-evidence', hd.evidence);
    this.host.setAttribute('data-pr-state', vm.state);
    this.detail.textContent = hd.detail || ''; this.detail.hidden = !hd.detail;
    this.tableWrap.textContent = ''; this.tableWrap.hidden = vm.state !== 'observed';
    if (vm.state === 'observed') this.tableWrap.appendChild(this.table(vm.rows));
    this.refreshBtn.disabled = vm.state === 'loading' || this.inflight > 0;
  };
  View.prototype.table = function (rows) {
    var self = this, cols = ['Registered name', 'Regulator', 'Number', 'KRA PIN', 'Valid until', 'Submitted', 'Status', 'Action'];
    return h('table', { class: 'sk-pa-table' }, [
      h('caption', { class: 'sk-pa-sr', text: 'Financial partner registrations' }),
      h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
      h('tbody', {}, rows.map(function (r) { return self.row(r || {}); })),
    ]);
  };
  View.prototype.row = function (r) {
    var self = this, uid = str(r.partnerUid);
    var msg = h('span', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-pr': 'row-msg' });
    var cell = h('td', { 'data-label': 'Action', class: 'sk-pa-action' }, [msg]);
    var tr = h('tr', { 'data-pr-row': uid, 'data-pr-result': 'pending' }, [
      h('td', { 'data-label': 'Registered name', text: str(r.registeredName) || NEUTRAL }),
      h('td', { 'data-label': 'Regulator', text: str(r.regulator) || NEUTRAL }),
      h('td', { 'data-label': 'Number', class: 'sk-pa-mono', text: str(r.registrationNumber) || NEUTRAL }),
      h('td', { 'data-label': 'KRA PIN', class: 'sk-pa-mono', text: str(r.kraPin) || NEUTRAL }),
      h('td', { 'data-label': 'Valid until', text: str(r.validUntil) || NEUTRAL }),
      h('td', { 'data-label': 'Submitted', text: fmtTime(r.submittedAt) }),
      h('td', { 'data-label': 'Status', text: (STATUS_LABEL[str(r.status)] || str(r.status) || NEUTRAL) + (r.reviewNote ? ' — ' + str(r.reviewNote) : '') }),
      cell,
    ]);
    var st = str(r.status), busy = false;
    /* One in-flight call per row; the outcome text appears only after the server's ok:true. */
    function send(payload, controls, onOk, resultAttr) {
      if (busy) return;
      busy = true; self.inflight++; controls.forEach(function (c) { c.disabled = true; });
      tr.setAttribute('data-pr-result', 'in-flight'); msg.textContent = 'Saving…';
      Promise.resolve().then(function () { return self.call(FN, payload); }).then(function (res) {
        if (res && res.ok === true) { tr.setAttribute('data-pr-result', resultAttr); onOk(res); }
        else fail('The server did not confirm this', controls);
      }, function (e) { fail(reviewErrorText(e || {}), controls); }).then(function () { busy = false; self.inflight--; self.refreshBtn.disabled = self.inflight > 0; });
    }
    function fail(t, controls) { tr.setAttribute('data-pr-result', 'error'); controls.forEach(function (c) { c.disabled = false; }); msg.textContent = t; }

    if (st === 'under_review') {
      var note = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'data-pr': 'note', 'aria-label': 'Review note (required for Needs information or Reject)' });
      var btns = VERDICTS.map(function (v) { return h('button', { type: 'button', class: 'sk-pa-btn' + (v.primary ? ' sk-pa-btn-primary' : ''), 'data-pr': v.key, text: v.label }); });
      var controls = [note].concat(btns);
      cell.insertBefore(h('div', { class: 'sk-pa-confirm' }, [note, h('div', { class: 'sk-pa-confirm-actions' }, btns)]), msg);
      VERDICTS.forEach(function (v, i) {
        btns[i].addEventListener('click', function () {
          var n = str(note.value).trim().slice(0, NOTE_MAX);
          if (v.verdict !== 'approved' && !n) { msg.textContent = 'Add a note for the partner — required unless you approve'; return; }
          var payload = { op: 'adminReviewRegistration', partnerUid: uid, verdict: v.verdict };
          if (n) payload.note = n;
          send(payload, controls, function () { controls.forEach(function (c) { c.hidden = true; }); msg.textContent = v.done; }, v.verdict);
        });
      });
    }
    if (st === 'approved' || st === 'verified') {
      var rnote = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'data-pr': 'revoke-note', 'aria-label': 'Reason for revoking the review (required)' });
      var rbtn = h('button', { type: 'button', class: 'sk-pa-btn', 'data-pr': 'revoke', text: 'Revoke review' });
      cell.insertBefore(h('div', { class: 'sk-pa-confirm' }, [rnote, h('div', { class: 'sk-pa-confirm-actions' }, [rbtn])]), msg);
      rbtn.addEventListener('click', function () {
        var n = str(rnote.value).trim().slice(0, NOTE_MAX);
        if (!n) { msg.textContent = 'Add the reason for revoking the review'; return; }
        send({ op: 'adminRevokeReview', partnerUid: uid, note: n }, [rnote, rbtn], function () { rnote.hidden = rbtn.hidden = true; msg.textContent = 'Review revoked — badge “' + BADGE + '” removed'; }, 'revoked');
      });
    }
    if (uid) cell.insertBefore(this.licenceForm(uid, send), msg);
    return tr;
  };
  /* "Record licence check": WHICH register was checked and what it showed. Separate from the badge. */
  View.prototype.licenceForm = function (uid, send) {
    var box = h('div', { class: 'sk-pa-confirm', 'data-pr': 'licence-form', hidden: true });
    var status = h('select', { class: 'sk-pa-input', 'data-pr': 'lc-status' }, LICENCE_RESULTS.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    status.value = LICENCE_RESULTS[0][0];
    function input(key, label, type) { var i = h('input', { type: type || 'text', class: 'sk-pa-input', 'data-pr': key, maxlength: key === 'lc-source' ? '300' : '80' }); return { i: i, el: h('label', { class: 'sk-pa-field' }, [h('span', { text: label }), i]) }; }
    var type = input('lc-type', 'Licence type'), num = input('lc-number', 'Licence number'), auth = input('lc-authority', 'Issuing authority (e.g. CBK, SASRA)');
    var exp = input('lc-expiry', 'Expiry date (optional)', 'date'), src = input('lc-source', 'Where you checked');
    var help = h('p', { class: 'sk-pa-detail', 'data-pr': 'lc-help', text: SOURCE_HELP });
    var lmsg = h('p', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-pr': 'lc-msg' });
    var submit = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-pr': 'lc-submit', text: 'Record licence check' });
    var open = h('button', { type: 'button', class: 'sk-pa-btn', 'data-pr': 'licence-open', text: 'Record licence check', 'aria-expanded': 'false', onclick: function () { box.hidden = !box.hidden; open.setAttribute('aria-expanded', box.hidden ? 'false' : 'true'); } });
    var controls = [status, type.i, num.i, auth.i, exp.i, src.i, submit];
    submit.addEventListener('click', function () {
      var v = status.value, p = { op: 'adminRecordLicenceCheck', partnerUid: uid, verificationStatus: v };
      if (!LICENCE_RESULTS.some(function (o) { return o[0] === v; })) { lmsg.textContent = 'Choose what the register showed'; return; }
      if (v !== 'cleared') {
        var t = str(type.i.value).trim(), n = str(num.i.value).trim(), a = str(auth.i.value).trim(), s = str(src.i.value).trim(), e = str(exp.i.value).trim();
        if (!t || !n || !a || !s) { lmsg.textContent = 'Fill in the licence type, number, issuing authority and where you checked'; return; }
        if (!LICENCE_NUMBER_RE.test(n)) { lmsg.textContent = 'The licence number may contain letters, digits, spaces and / . - only'; return; }
        if (DOCUMENT_RE.test(s) && !/https?:\/\//i.test(s)) { lmsg.textContent = 'Cite the register you checked (URL or register name + reference), not a document'; return; }
        if (e && !/^\d{4}-\d{2}-\d{2}$/.test(e)) { lmsg.textContent = 'Enter the expiry date as a date'; return; }
        p.licenceType = t; p.licenceNumber = n; p.issuingAuthority = a; p.verificationSource = s;
        if (e) p.expiryDate = e;
      }
      lmsg.textContent = '';
      send(p, controls, function (res) {
        var label = ''; LICENCE_RESULTS.forEach(function (o) { if (o[0] === str(res.verificationStatus || v)) label = o[1]; });
        controls.forEach(function (c) { c.hidden = true; });
        lmsg.textContent = 'Licence check recorded — ' + (label || str(res.verificationStatus || v));
      }, 'licence-recorded');
    });
    box.appendChild(h('div', { class: 'sk-pa-cols' }, [h('label', { class: 'sk-pa-field' }, [h('span', { text: 'What the register showed' }), status]), type.el, num.el, auth.el, exp.el, src.el]));
    box.appendChild(help);
    box.appendChild(h('div', { class: 'sk-pa-confirm-actions' }, [submit]));
    box.appendChild(lmsg);
    return h('div', { 'data-pr': 'licence' }, [open, box]);
  };

  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.SokoniAdminPartnerRegistrations = {
    mount: function (host, opts) {
      if (!host) return null;
      var v = mounted && mounted.get(host);
      if (v) { v.refresh(); return v; }
      v = new View(host, opts); if (mounted) mounted.set(host, v); return v;
    },
    _test: { classifyError: classifyError, toViewModel: toViewModel, headline: headline, reviewErrorText: reviewErrorText, fmtTime: fmtTime },
  };
})();
