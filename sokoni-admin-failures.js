/* ============================================================================
   SOKONI — Failures view (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-failures.js   ·   styles: sokoni-admin-failures.css

   Mounted by BOTH consoles into their own panel, each handing in its OWN
   canonical callable transport (opts.call):
     admin-os.html     #panel-failures  via SokoniAOS.navigate('failures')  (deep link #failures)
                       call = sokoni-aos.js _call()
     super-admin.html  #panel-failures  via SA.nav('failures')
                       call = SA._fns.httpsCallable(name)(data)

   SOURCE: the admin-only callable getErrorLog (App Check enforced):
     getErrorLog({ hours 1-168, limit 1-200, severity? })
       → { errors:[{ id, at, severity, surface, code, message, context, uid,
                     email (masked), anonymous, merchantId, orderId, appVersion,
                     online, url }], count, truncated, bySeverity, since,
           source:'errorLog' }

   EVERY FIELD IS CLIENT-WRITTEN (a browser reported it), so every field is
   untrusted. Everything is rendered with textContent / setAttribute — nothing
   from the server reaches innerHTML, and URLs are shown as text, never links.

   EVIDENCE VOCABULARY (never collapsed):
     not-attempted  nothing asked yet
     observed       the server returned failures
     empty          the server answered and reported none in the window
     unreadable     the server could not be read (not deployed, denied, error)
   Unknown is never green and never 0: an unreadable log renders "—".
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminFailures) return;

  var NEUTRAL = '—';
  var SEVERITIES = ['critical', 'error', 'warning', 'info'];
  var SEV_LABEL = { critical: 'Critical', error: 'Error', warning: 'Warning', info: 'Info' };
  var HOURS = [24, 72, 168];
  var LIMIT = 100;

  /* A callable that is not deployed surfaces as not-found / unavailable — or as
     'internal' when the 404 carries no CORS headers. All three mean "the server
     side of this is not there yet" (same rule as the Updates centre). */
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  var DENIED = /^(functions\/)?(permission-denied|unauthenticated)$/;
  function errCode(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }

  /* ── pure helpers (exported for scripts/test-admin-failures.js) ─────────── */
  function str(v) { return v == null ? '' : String(v); }

  function classifyError(e) {
    var code = errCode(e);
    if (NOT_DEPLOYED.test(code)) return { state: 'unavailable', code: code };
    if (DENIED.test(code)) return { state: 'denied', code: code };
    return { state: 'error', code: code };
  }

  /* Token-free page reference. The server already strips query and hash; this
     strips them again because the value was written by a client. */
  function safeUrl(u) {
    var s = str(u).trim();
    if (!s) return '';
    s = s.split('#')[0].split('?')[0];
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }

  function shortUid(r) {
    if (r && r.anonymous === true && !r.uid) return 'anonymous';
    var u = str(r && r.uid);
    if (!u) return NEUTRAL;
    return u.length > 8 ? u.slice(0, 6) + '…' : u;
  }

  function fmtTime(iso) {
    var d = new Date(str(iso));
    if (!iso || isNaN(d.getTime())) return NEUTRAL;
    try {
      return d.toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT';
    } catch (_) { return d.toISOString(); }
  }

  function sevOf(r) {
    var s = str(r && r.severity).toLowerCase();
    return SEV_LABEL[s] ? s : 'unknown';
  }

  /* Severity counts. A figure is shown ONLY when the server reported it:
     - an unreadable / not-yet-asked log → "—" for every severity;
     - a severity filtered out of the query → "—" (not measured by this query);
     - a severity absent from bySeverity is a canonical 0 only when bySeverity's
       reported figures add up to the server's own count (the server provably
       listed every severity it saw); otherwise "—". Never computed from rows. */
  function severityCounts(vm) {
    var data = vm.state === 'observed' || vm.state === 'empty' ? vm.data : null;
    var by = data && data.bySeverity && typeof data.bySeverity === 'object' ? data.bySeverity : null;
    var count = data && typeof data.count === 'number' ? data.count : null;
    var complete = false;
    if (by && count != null) {
      var sum = 0, ok = true;
      Object.keys(by).forEach(function (k) { if (typeof by[k] === 'number' && isFinite(by[k])) sum += by[k]; else ok = false; });
      complete = ok && sum === count;
    }
    return SEVERITIES.map(function (s) {
      var out = { severity: s, label: SEV_LABEL[s], value: NEUTRAL, measured: false, note: 'Not read' };
      if (!data) { out.note = vm.state === 'loading' ? 'Checking…' : 'Not read'; return out; }
      if (vm.filter && vm.filter.severity && vm.filter.severity !== s) { out.note = 'Filtered out'; return out; }
      var v = by ? by[s] : undefined;
      if (typeof v === 'number' && isFinite(v)) { out.value = String(v); out.measured = true; out.note = 'Reported'; }
      else if (by && v === undefined && complete) { out.value = '0'; out.measured = true; out.note = 'Reported'; }
      else out.note = 'Not reported';
      return out;
    });
  }

  /* The words for each state. One place, so the consoles cannot disagree. */
  function headline(vm) {
    var hrs = vm.filter && vm.filter.hours || 24;
    switch (vm.state) {
      case 'loading': return { evidence: 'not-attempted', text: 'Reading the failure log…' };
      case 'unavailable': return { evidence: 'unreadable', text: 'Failure log not available yet',
        detail: 'The server side of this view (getErrorLog) is not deployed yet (' + vm.code + '). Nothing is shown in its place — this is not “no failures”.' };
      case 'denied': return { evidence: 'unreadable', text: 'You do not have access',
        detail: 'The failure log is restricted to administrators (' + vm.code + ').' };
      case 'error': return { evidence: 'unreadable', text: 'Could not read the failure log',
        detail: 'The server did not return the log (' + vm.code + '). Nothing is shown in its place.' };
      case 'empty': return { evidence: 'empty', text: 'No client failures reported in the last ' + hrs + ' hours' + (vm.filter && vm.filter.severity ? ' at severity ' + vm.filter.severity : '') + '.' };
      case 'observed': return { evidence: 'observed', text: (vm.data.errors.length) + ' client failure' + (vm.data.errors.length === 1 ? '' : 's') + ' in the last ' + hrs + ' hours.' };
      default: return { evidence: 'not-attempted', text: 'Not read yet.' };
    }
  }

  /* Result (or thrown error) → view model. */
  function toViewModel(outcome, filter) {
    var vm = { filter: filter || { hours: 24, severity: '' } };
    if (!outcome) { vm.state = 'loading'; return vm; }
    if (outcome.error !== undefined) { var c = classifyError(outcome.error); vm.state = c.state; vm.code = c.code; return vm; }
    var d = outcome.data;
    if (!d || !Array.isArray(d.errors)) { vm.state = 'error'; vm.code = 'unexpected response'; return vm; }
    vm.data = d;
    vm.state = d.errors.length ? 'observed' : 'empty';
    return vm;
  }

  /* ── tiny DOM helper: textContent only ─────────────────────────────────── */
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

  /* Fallback transport when a console hands none in. */
  function defaultCall(name, data) {
    if (!window.firebase || typeof window.firebase.functions !== 'function') {
      return Promise.reject({ code: 'functions/unavailable', message: 'Firebase Functions is not loaded on this page' });
    }
    return window.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r && r.data; });
  }

  /* ── instance ──────────────────────────────────────────────────────────── */
  function View(host, opts) {
    this.host = host;
    this.console = (opts && opts.console) || 'aos';
    this.call = (opts && typeof opts.call === 'function') ? opts.call : defaultCall;
    this.filter = { hours: 24, severity: '' };
    this.seq = 0;
    this.vm = toViewModel(null, this.filter);
    this.build();
    this.refresh();
  }

  View.prototype.build = function () {
    var self = this;
    var uid = 'skFail' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.host.textContent = '';
    this.status = h('p', { class: 'sk-fail-status', role: 'status', 'aria-live': 'polite', 'data-fail': 'status' });
    this.detail = h('p', { class: 'sk-fail-detail', 'data-fail': 'detail', hidden: true });
    this.evidence = h('span', { class: 'sk-fail-evidence', 'data-fail': 'evidence' });
    this.counts = h('div', { class: 'sk-fail-counts', 'data-fail': 'counts', role: 'list', 'aria-label': 'Failures by severity' });
    this.note = h('p', { class: 'sk-fail-note', 'data-fail': 'truncated', hidden: true });
    this.tableWrap = h('div', { class: 'sk-fail-scroll', 'data-fail': 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Failure rows (scrolls sideways on small screens)', hidden: true });

    var sevSel = h('select', { id: uid + 'Sev', class: 'sk-fail-input', 'data-fail': 'severity',
      onchange: function () { self.filter.severity = this.value; self.refresh(); } },
      [h('option', { value: '', text: 'All severities' })].concat(SEVERITIES.map(function (s) { return h('option', { value: s, text: SEV_LABEL[s] }); })));
    var hrsSel = h('select', { id: uid + 'Hrs', class: 'sk-fail-input', 'data-fail': 'hours',
      onchange: function () { self.filter.hours = parseInt(this.value, 10) || 24; self.refresh(); } },
      HOURS.map(function (n) { return h('option', { value: String(n), text: n === 24 ? 'Last 24 hours' : n === 72 ? 'Last 3 days' : 'Last 7 days' }); }));
    this.refreshBtn = h('button', { type: 'button', class: 'sk-fail-btn sk-fail-btn-primary', 'data-fail': 'refresh', text: 'Refresh', onclick: function () { self.refresh(); } });

    this.host.appendChild(h('div', { class: 'sk-fail', 'data-console': this.console }, [
      h('header', { class: 'sk-fail-hero' }, [
        h('div', { class: 'sk-fail-hero-text' }, [
          h('p', { class: 'sk-fail-eyebrow', text: 'Client reliability' }),
          h('h2', { class: 'sk-fail-title', text: 'Failures' }),
          h('p', { class: 'sk-fail-lede', text: 'Errors that SOKONI’s pages reported from users’ browsers, newest first. Messages are written by the client and shown as plain text. If the log cannot be read, that is said — it is never shown as “no failures”.' }),
        ]),
      ]),
      h('div', { class: 'sk-fail-controls', role: 'group', 'aria-label': 'Failure filters' }, [
        h('label', { class: 'sk-fail-field', for: uid + 'Sev' }, [h('span', { text: 'Severity' }), sevSel]),
        h('label', { class: 'sk-fail-field', for: uid + 'Hrs' }, [h('span', { text: 'Window' }), hrsSel]),
        this.refreshBtn,
      ]),
      h('div', { class: 'sk-fail-summary' }, [this.evidence, this.status]),
      this.detail,
      this.counts,
      this.note,
      this.tableWrap,
    ]));
  };

  View.prototype.refresh = function () {
    var self = this, seq = ++this.seq;   /* a newer request wins; late answers are dropped */
    var filter = { hours: this.filter.hours, severity: this.filter.severity };
    var q = { hours: filter.hours, limit: LIMIT };
    if (filter.severity) q.severity = filter.severity;
    this.vm = toViewModel(null, filter);
    this.refreshBtn.disabled = true;
    this.render();
    return Promise.resolve().then(function () { return self.call('getErrorLog', q); }).then(
      function (d) { return { data: d }; },
      function (e) { return { error: e || {} }; }
    ).then(function (outcome) {
      if (seq !== self.seq) return;
      self.vm = toViewModel(outcome, filter);
      self.refreshBtn.disabled = false;
      self.render();
    });
  };

  View.prototype.render = function () {
    var vm = this.vm, hd = headline(vm);
    this.status.textContent = hd.text;
    this.evidence.textContent = 'Evidence: ' + hd.evidence;
    this.evidence.className = 'sk-fail-evidence sk-fail-ev-' + hd.evidence;
    this.evidence.setAttribute('data-evidence', hd.evidence);
    this.host.setAttribute('data-fail-state', vm.state);
    this.detail.textContent = hd.detail || '';
    this.detail.hidden = !hd.detail;

    this.counts.textContent = '';
    var self = this;
    severityCounts(vm).forEach(function (c) {
      self.counts.appendChild(h('div', { class: 'sk-fail-count sk-fail-sev-' + c.severity, role: 'listitem', 'data-sev': c.severity, 'data-measured': c.measured ? 'true' : 'false' }, [
        h('span', { class: 'sk-fail-count-label', text: c.label }),
        h('span', { class: 'sk-fail-count-value', 'data-fail': 'count-' + c.severity, text: c.value }),
        h('span', { class: 'sk-fail-count-note', text: c.note }),
      ]));
    });

    var d = vm.state === 'observed' || vm.state === 'empty' ? vm.data : null;
    var noteText = '';
    if (d && d.truncated) noteText = 'The server returned only the newest ' + d.errors.length + ' rows; there are more failures in this window than are shown. Narrow the window or filter by severity.';
    if (d && d.since) noteText += (noteText ? ' ' : '') + 'Window starts ' + fmtTime(d.since) + '.';
    this.note.textContent = noteText;
    this.note.hidden = !noteText;

    this.tableWrap.textContent = '';
    this.tableWrap.hidden = vm.state !== 'observed';
    if (vm.state === 'observed') this.tableWrap.appendChild(this.table(d.errors));
  };

  View.prototype.table = function (rows) {
    var cols = ['Time', 'Severity', 'Surface', 'Code', 'Message', 'Reference', 'User', 'Page'];
    return h('table', { class: 'sk-fail-table', 'data-fail': 'table' }, [
      h('caption', { class: 'sk-fail-sr', text: 'Client failures, newest first' }),
      h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
      h('tbody', {}, rows.map(function (r) {
        r = r || {};
        var sev = sevOf(r);
        var refs = [h('span', { class: 'sk-fail-mono', text: str(r.id) || NEUTRAL })];
        if (r.orderId) refs.push(h('span', { class: 'sk-fail-sub', text: 'order ' + str(r.orderId) }));
        if (r.merchantId) refs.push(h('span', { class: 'sk-fail-sub', text: 'merchant ' + str(r.merchantId) }));
        var user = [h('span', { class: 'sk-fail-mono', title: str(r.uid) || null, text: shortUid(r) })];
        if (r.email) user.push(h('span', { class: 'sk-fail-sub', text: str(r.email) }));
        var msg = [h('span', { class: 'sk-fail-msg', text: str(r.message) || NEUTRAL })];
        if (r.context) msg.push(h('details', { class: 'sk-fail-ctx' }, [h('summary', { text: 'Context' }), h('pre', { text: str(r.context).slice(0, 500) })]));
        var page = [h('span', { class: 'sk-fail-mono', text: safeUrl(r.url) || NEUTRAL })];
        var meta = [r.appVersion ? 'build ' + str(r.appVersion) : null, r.online === false ? 'offline' : r.online === true ? 'online' : null].filter(Boolean).join(' · ');
        if (meta) page.push(h('span', { class: 'sk-fail-sub', text: meta }));
        return h('tr', { 'data-sev': sev }, [
          h('td', { 'data-label': 'Time' }, [h('time', { datetime: str(r.at) || null, text: fmtTime(r.at) })]),
          h('td', { 'data-label': 'Severity' }, [h('span', { class: 'sk-fail-badge sk-fail-sev-' + sev, text: SEV_LABEL[sev] || 'Unknown' })]),
          h('td', { 'data-label': 'Surface', text: str(r.surface) || NEUTRAL }),
          h('td', { 'data-label': 'Code', class: 'sk-fail-mono', text: str(r.code) || NEUTRAL }),
          h('td', { 'data-label': 'Message' }, msg),
          h('td', { 'data-label': 'Reference' }, refs),
          h('td', { 'data-label': 'User' }, user),
          h('td', { 'data-label': 'Page' }, page),
        ]);
      })),
    ]);
  };

  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.SokoniAdminFailures = {
    /* Idempotent: a second mount on the same host refreshes instead of rebuilding. */
    mount: function (host, opts) {
      if (!host) return null;
      var v = mounted && mounted.get(host);
      if (v) { v.refresh(); return v; }
      v = new View(host, opts);
      if (mounted) mounted.set(host, v);
      return v;
    },
    SEVERITIES: SEVERITIES,
    /* Pure functions, exported for scripts/test-admin-failures.js. */
    _test: { classifyError: classifyError, toViewModel: toViewModel, headline: headline, severityCounts: severityCounts, safeUrl: safeUrl, shortUid: shortUid },
  };
})();
