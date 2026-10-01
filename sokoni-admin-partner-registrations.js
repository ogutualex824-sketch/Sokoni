/* ============================================================================
   SOKONI — Partner registrations view (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-partner-registrations.js   ·   styles: reuses sokoni-admin-payout-approvals.css (sk-pa-*)

   Financial partners (banks, SACCOs, chamas, MFIs, insurers, forex, accountants, advisers, investment
   firms) submit their regulator registration from their workspace. It stays SELF-DECLARED until an
   administrator reviews it here. Only this review can mark it verified.

   Mounted by BOTH consoles with their own canonical transport (opts.call), same contract as
   Payout approvals:
     admin-os.html     #panel-partner-registrations  via SokoniAOS.navigate('partner-registrations')
     super-admin.html  #panel-partner-registrations  via SA.nav('partner-registrations')

   SOURCE: financialPartnerDispatch (App Check; admin claim checked server-side; NOT deployed yet)
     { op:'adminListRegistrations', status:'under_review'|'verified'|'rejected' }
       → { rows:[{ partnerUid, regulator, registeredName, registrationNumber, kraPin, validUntil,
                   status, submittedAt (ms|null), reviewNote }] }
     { op:'adminReviewRegistration', partnerUid, verdict:'verified'|'rejected', note }
       → { ok:true, status }   (note REQUIRED when rejecting)

   RENDERING: textContent / setAttribute only. "Verified" is shown ONLY after the server answers ok:true.
   EVIDENCE: not-attempted · observed · empty · unreadable — an unreadable list is never "none waiting".
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminPartnerRegistrations) return;

  var NEUTRAL = '—';
  var FN = 'financialPartnerDispatch';
  var NOTE_MAX = 500;
  var STATUSES = ['under_review', 'verified', 'rejected'];
  var STATUS_LABEL = { under_review: 'Waiting for review', verified: 'Reviewed — accepted', rejected: 'Not accepted' };
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
    var c = code(e).replace(/^functions\//, ''), m = str(e && e.message);
    if (c === 'permission-denied') return 'You do not have permission to review registrations';
    if (c === 'unauthenticated') return 'Your session has expired — sign in again';
    if (c === 'failed-precondition') return 'Already reviewed, or nothing waiting';
    if (c === 'invalid-argument') return /note/i.test(m) ? 'Add a note saying why it is not accepted' : 'The server rejected this request as invalid';
    if (c === 'unavailable' || c === 'internal' || c === 'not-found') return 'Partner registrations not available yet';
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
        h('p', { class: 'sk-pa-lede', text: 'Regulator registrations submitted by listed financial partners. Check the paperwork and the number against the regulator (CBK, SASRA, IRA, CMA, RBA, ICPAK…). Your review is SOKONI\'s paperwork check, not a licence confirmation: the public listing keeps calling these details self-declared.' }),
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
    if (str(r.status) !== 'under_review') return tr;
    var note = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'aria-label': 'Review note (required to reject)' });
    var ok = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-pr': 'verify', text: 'Accept' });
    var no = h('button', { type: 'button', class: 'sk-pa-btn', 'data-pr': 'reject', text: 'Not accepted' });
    cell.insertBefore(h('div', { class: 'sk-pa-confirm' }, [note, h('div', { class: 'sk-pa-confirm-actions' }, [ok, no])]), msg);
    var busy = false;
    function submit(verdict) {
      if (busy) return;
      var n = str(note.value).trim().slice(0, NOTE_MAX);
      if (verdict === 'rejected' && !n) { msg.textContent = 'Add a note saying why it is not accepted'; return; }
      busy = true; self.inflight++; ok.disabled = no.disabled = note.disabled = true;
      tr.setAttribute('data-pr-result', 'in-flight'); msg.textContent = 'Saving…';
      var payload = { op: 'adminReviewRegistration', partnerUid: uid, verdict: verdict };
      if (n) payload.note = n;
      Promise.resolve().then(function () { return self.call(FN, payload); }).then(function (res) {
        if (res && res.ok === true) {
          tr.setAttribute('data-pr-result', verdict); note.hidden = ok.hidden = no.hidden = true;
          msg.textContent = verdict === 'verified' ? 'Accepted' : 'Marked not accepted';
        } else fail('The server did not confirm the review');
      }, function (e) { fail(reviewErrorText(e || {})); }).then(function () { busy = false; self.inflight--; self.refreshBtn.disabled = self.inflight > 0; });
    }
    function fail(t) { tr.setAttribute('data-pr-result', 'error'); ok.disabled = no.disabled = note.disabled = false; msg.textContent = t; }
    ok.addEventListener('click', function () { submit('verified'); });
    no.addEventListener('click', function () { submit('rejected'); });
    return tr;
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
