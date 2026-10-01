/* ============================================================================
   SOKONI — SOKONI Foundation workspace (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-foundation.js   ·   styles: sokoni-admin-payout-approvals.css (sk-pa-*)
                                            + sokoni-admin-foundation.css (sk-fd-*)

   Mounted by BOTH consoles with their own canonical transport (opts.call), same contract as
   Payout approvals / Partner registrations:
     admin-os.html     #panel-foundation  via SokoniAOS.navigate('foundation')  call = sokoni-aos.js _call()
     super-admin.html  #panel-foundation  via SA.nav('foundation')              call = fns.httpsCallable()

   TABS (each loads lazily on first open; every list is bounded; no listeners):
     Overview          impactAdminFoundationData {view:'summary'} + foundationContentDispatch {op:'adminCounts'}
     Donations         impactAdminFoundationData {view:'donations', status?, cursor?}
     Send support      impactAdminFoundationData {view:'disbursements', status?, cursor?} + the chain:
                       impactInitiateDisbursement → impactApproveDisbursement → impactAuthorizeDisbursement
                       → impactRefreshDisbursementStatus (M-PESA) | impactRecordManualDisbursement
                       (record / confirm / fail, manual rails) · impactCancelDisbursement (before authorization)
     Stories           foundationContentDispatch admin ops (adminList / adminSaveStory / adminSubmit /
                       adminDecide / adminPublish / adminUnpublish)
     Partner promotions financialPartnerDispatch {op:'adminListPromotionRequests' | 'adminDecidePromotion'}
     Reconciliation    impactGetFinancialReport {} (live)

   NONE of the admin callables except impactGetFinancialReport are deployed yet: not-found /
   unavailable / internal render "not available yet" with evidence UNREADABLE — never "none", never 0.

   RENDERING: textContent / setAttribute only — nothing from the server reaches innerHTML.
   MONEY: the server is the authority. A result (approved, authorized, completed…) is shown ONLY after
   the callable answers ok. An unknown number renders "—". A disbursement is never called "sent";
   it is "Completed (confirmed)" only when the server says completed.
   EVIDENCE: not-attempted · observed · empty · unreadable — never collapsed.
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminFoundation) return;

  var NEUTRAL = '—';
  var DATA_FN = 'impactAdminFoundationData';
  var CONTENT_FN = 'foundationContentDispatch';
  var PARTNER_FN = 'financialPartnerDispatch';
  var REPORT_FN = 'impactGetFinancialReport';
  var MAX_ROWS = 500;          /* Load more stops here — a list is never unbounded */
  var NOTE_MAX = 500;
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  var DENIED = /^(functions\/)?(permission-denied|unauthenticated)$/;

  var TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'donations', label: 'Donations' },
    { key: 'disbursements', label: 'Send support' },
    { key: 'stories', label: 'Stories & Media House' },
    { key: 'promotions', label: 'Partner promotions' },
    { key: 'reconciliation', label: 'Reconciliation' },
  ];

  var DON_STATUSES = ['pledged', 'completed', 'failed', 'review', 'refunded', 'partially_refunded'];
  var DON_LABEL = { pledged: 'Pledged — not paid yet', completed: 'Completed (paid)', failed: 'Failed', review: 'Under review', refunded: 'Refunded', partially_refunded: 'Partially refunded' };
  var DIS_STATUSES = ['pending_approval', 'pending_authorization', 'processing', 'awaiting_confirmation', 'completed', 'failed', 'cancelled'];
  var DIS_LABEL = {
    pending_approval: 'Needs approval',
    pending_authorization: 'Needs super-admin authorization',
    processing: 'Processing — not yet confirmed',
    awaiting_confirmation: 'Recorded — awaiting second admin',
    completed: 'Completed (confirmed)',
    failed: 'Failed — funds released',
    cancelled: 'Cancelled',
  };
  var DIS_COUNT_KEYS = [['pendingApproval', 'pending_approval'], ['pendingAuthorization', 'pending_authorization'], ['processing', 'processing'], ['awaitingConfirmation', 'awaiting_confirmation'], ['completed', 'completed'], ['failed', 'failed']];
  var DON_COUNT_KEYS = ['completed', 'pledged', 'failed', 'review', 'refunded'];
  var BAL_KEYS = [['balance', 'Balance'], ['reserved', 'Reserved'], ['available', 'Available'], ['totalReceived', 'Received'], ['totalDisbursed', 'Disbursed'], ['totalFees', 'Fees']];

  var STORY_STATUSES = ['draft', 'pending', 'approved', 'changes_requested', 'rejected', 'archived', 'removed'];
  var STORY_LABEL = { draft: 'Draft', pending: 'Waiting for review', approved: 'Approved, not published', scheduled: 'Approved, scheduled', published: 'Published', changes_requested: 'Changes requested', rejected: 'Rejected', archived: 'Archived', removed: 'Removed' };
  var DESTINATIONS = [['foundation_home', 'Foundation home'], ['donation_wizard', 'Donation wizard'], ['programme', 'Programme page'], ['banking_hub', 'Banking Hub']];
  var PROMO_STATUSES = ['pending', 'granted', 'declined'];
  var PROMO_LABEL = { pending: 'Waiting for a decision', granted: 'Promotion granted', declined: 'Declined' };

  var DEST_TYPES = ['MPESA', 'BANK', 'TILL', 'PAYBILL'];
  var DEST_LABEL = { MPESA: 'M-PESA phone', BANK: 'Bank account', TILL: 'Till (Buy Goods)', PAYBILL: 'Paybill' };
  var DEST_FIELDS = {
    MPESA: [['phone', 'M-PESA phone number', true]],
    BANK: [['bankName', 'Bank name', true], ['bankCode', 'Bank code (optional)', false], ['accountName', 'Account name', true], ['accountNumber', 'Account number', true]],
    TILL: [['tillNumber', 'Till number', true]],
    PAYBILL: [['paybillNumber', 'Paybill number', true], ['accountRef', 'Account reference', true]],
  };
  var MANUAL_RAIL_COPY = 'No automated rail — you pay outside SOKONI, record the reference, a second admin confirms.';
  var REFUND_COPY = 'Refund request — needs approval + super-admin authorization';

  var IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
  var IMAGE_MAX = 15 * 1024 * 1024, VIDEO_MAX = 80 * 1024 * 1024, MEDIA_MAX = 4;

  /* ── pure helpers (exported for scripts/test-admin-foundation.js) ─────── */
  function str(v) { return v == null ? '' : String(v); }
  function code(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }
  function bare(c) { return String(c).replace(/^functions\//, ''); }
  function classifyError(e) {
    var c = code(e);
    if (NOT_DEPLOYED.test(c)) return { state: 'unavailable', code: c };
    if (DENIED.test(c)) return { state: 'denied', code: c };
    return { state: 'error', code: c };
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtKES(v) { return isNum(v) ? 'KES ' + Math.round(v).toLocaleString('en-KE') : NEUTRAL; }
  function fmtCount(v) { return isNum(v) ? String(v) : NEUTRAL; }
  function toMs(v) {
    if (isNum(v)) return v;
    if (v && typeof v === 'object') {
      var s = isNum(v.seconds) ? v.seconds : isNum(v._seconds) ? v._seconds : null;
      if (s != null) return s * 1000;
    }
    if (typeof v === 'string' && v) { var t = Date.parse(v); if (isFinite(t)) return t; }
    return null;
  }
  function fmtTime(v) {
    var ms = toMs(v);
    if (ms == null) return NEUTRAL;
    try { return new Date(ms).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT'; }
    catch (_) { return new Date(ms).toISOString(); }
  }
  /* An administrator-facing explanation of a refused call. The server's own message is shown (as
     text) when it is a sentence — e.g. "Another administrator must approve a story you wrote". */
  function errorText(e, what) {
    var c = bare(code(e)), m = str(e && e.message).replace(/^functions\/[a-z-]+:?\s*/, '').trim().slice(0, 300);
    if (NOT_DEPLOYED.test(c)) return (what || 'This action') + ' is not available yet — the server side is not deployed (' + c + ')';
    if (c === 'unauthenticated') return 'Your session has expired — sign in again';
    if (m && m !== c && /\s/.test(m)) return m;
    if (c === 'permission-denied') return 'You are not allowed to do this step (it may need a different administrator)';
    if (c === 'failed-precondition') return 'Not allowed in its current state — refresh the list';
    if (c === 'invalid-argument') return 'The server rejected this request as invalid';
    if (c === 'already-exists') return 'Already done';
    return 'Failed (' + c + ')';
  }
  function okReply(res) { return !!res && (res.ok === true); }
  function randomHex(n) {
    var c = window.crypto, out = '';
    if (c && typeof c.getRandomValues === 'function') {
      var a = new Uint8Array(n); c.getRandomValues(a);
      for (var i = 0; i < a.length; i++) out += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return out;
    }
    return null;
  }
  function newRequestId() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var x = randomHex(16);
    if (!x) return null; /* no secure randomness → the form refuses to submit rather than invent an id */
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-4' + x.slice(13, 16) + '-' + ((parseInt(x.charAt(16), 16) & 3) | 8).toString(16) + x.slice(17, 20) + '-' + x.slice(20, 32);
  }
  function rows(d) { return d && Array.isArray(d.rows) ? d.rows : null; }
  function storyState(r) {
    var s = str(r && r.status);
    if (s !== 'approved') return s;
    if (r.published === true) return 'published';
    var pa = toMs(r.scheduledFor != null ? r.scheduledFor : r.publishAt);   /* server field: scheduledFor (ms) */
    if (pa == null) return 'approved';
    return pa <= Date.now() ? 'published' : 'scheduled';
  }
  function isManualRail(r) { return str(r.rail) === 'manual' || (r.destinationType && str(r.destinationType) !== 'MPESA'); }
  function maskedDestination(d) {
    if (d == null || d === '') return NEUTRAL;
    if (typeof d !== 'object') return str(d);
    return Object.keys(d).map(function (k) { return str(d[k]); }).filter(Boolean).join(' · ') || NEUTRAL;
  }
  function checkMedia(files) {
    var list = Array.prototype.slice.call(files || []), videos = 0;
    if (list.length > MEDIA_MAX) return 'At most ' + MEDIA_MAX + ' files';
    for (var i = 0; i < list.length; i++) {
      var f = list[i], t = str(f && f.type);
      if (IMAGE_TYPES[t]) { if (!(f.size <= IMAGE_MAX)) return 'Images must be 15 MB or smaller'; }
      else if (VIDEO_TYPES[t]) { videos++; if (!(f.size <= VIDEO_MAX)) return 'Videos must be 80 MB or smaller'; }
      else return 'Only JPEG, PNG, WebP images or MP4, WebM, MOV videos';
    }
    if (videos > 1) return 'At most one video';
    return '';
  }

  /* ── DOM builder: textContent / setAttribute only ─────────────────────── */
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
  function field(label, input, extraClass) {
    return h('label', { class: 'sk-pa-field sk-fd-field' + (extraClass ? ' ' + extraClass : '') }, [h('span', { text: label }), input]);
  }
  function select(key, options, allLabel) {
    var opts = [];
    if (allLabel) opts.push(h('option', { value: '', text: allLabel }));
    options.forEach(function (o) { opts.push(h('option', { value: o[0], text: o[1] })); });
    return h('select', { class: 'sk-pa-input', 'data-fd': key }, opts);
  }
  function defaultCall(name, data) {
    if (!window.firebase || typeof window.firebase.functions !== 'function') return Promise.reject({ code: 'functions/unavailable' });
    return window.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r && r.data; });
  }
  function defaultUploader() {
    var fb = window.firebase;
    if (!fb || typeof fb.storage !== 'function') return null;
    return function (path, file) {
      return Promise.resolve().then(function () { return fb.storage().ref(path).put(file, { contentType: file.type }); }).then(function () { return path; });
    };
  }

  /* A status line + evidence pill + detail, shared by every tab. */
  function Status(prefix) {
    this.evidence = h('span', { class: 'sk-pa-evidence', 'data-fd': prefix + '-evidence' });
    this.text = h('p', { class: 'sk-pa-status', role: 'status', 'aria-live': 'polite', 'data-fd': prefix + '-status' });
    this.detail = h('p', { class: 'sk-pa-detail', 'data-fd': prefix + '-detail', hidden: true });
    this.el = h('div', {}, [h('div', { class: 'sk-pa-summary' }, [this.evidence, this.text]), this.detail]);
  }
  Status.prototype.set = function (evidence, text, detail) {
    this.text.textContent = text;
    this.evidence.textContent = 'Evidence: ' + evidence;
    this.evidence.className = 'sk-pa-evidence sk-pa-ev-' + evidence;
    this.evidence.setAttribute('data-evidence', evidence);
    this.detail.textContent = detail || ''; this.detail.hidden = !detail;
  };
  Status.prototype.fromError = function (e, what, fn) {
    var c = classifyError(e);
    if (c.state === 'unavailable') this.set('unreadable', what + ' not available yet', 'The server side (' + fn + ') is not deployed yet (' + c.code + '). This is not “none”.');
    else if (c.state === 'denied') this.set('unreadable', 'You do not have access', 'Restricted to administrators (' + c.code + ').');
    else this.set('unreadable', 'Could not read ' + what.toLowerCase(), 'The server did not answer usefully (' + c.code + '). Nothing is shown in its place.');
    return c.state;
  };

  /* A row's action area: buttons + an optional note + a message; results only after ok. */
  function Actions(view, cellAttrs) {
    this.view = view; this.busy = false; this.buttons = [];
    this.msg = h('span', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-fd': 'row-msg' });
    this.bar = h('div', { class: 'sk-pa-confirm-actions' });
    this.extra = h('div', { class: 'sk-fd-extra' });
    this.cell = h('td', cellAttrs || { 'data-label': 'Actions', class: 'sk-pa-action' }, [this.extra, this.bar, this.msg]);
  }
  Actions.prototype.note = function (label) {
    if (!this.noteEl) {
      this.noteEl = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'data-fd': 'note', 'aria-label': label || 'Note' });
      this.extra.appendChild(this.noteEl);
    }
    return this.noteEl;
  };
  Actions.prototype.noteValue = function () { return this.noteEl ? str(this.noteEl.value).trim().slice(0, NOTE_MAX) : ''; };
  /* spec: { key, label, primary, needsNote, prepare() → payload | string(error), fn, done(res) → text } */
  Actions.prototype.add = function (spec) {
    var self = this;
    var b = h('button', { type: 'button', class: 'sk-pa-btn' + (spec.primary ? ' sk-pa-btn-primary' : ''), 'data-fd': 'act-' + spec.key, text: spec.label });
    if (spec.title) b.setAttribute('title', spec.title);
    b.addEventListener('click', function () { self.run(spec, b); });
    this.buttons.push(b); this.bar.appendChild(b);
    return b;
  };
  Actions.prototype.setDisabled = function (v) {
    this.buttons.forEach(function (b) { b.disabled = v; });
    if (this.noteEl) this.noteEl.disabled = v;
    (this.inputs || []).forEach(function (i) { i.disabled = v; });
  };
  Actions.prototype.run = function (spec, btn) {
    if (this.busy) return;
    var self = this, payload = spec.prepare();
    if (typeof payload === 'string') { this.msg.textContent = payload; this.cell.setAttribute('data-fd-result', 'refused-locally'); return; }
    this.busy = true; this.setDisabled(true);
    this.cell.setAttribute('data-fd-result', 'in-flight'); this.msg.textContent = 'Saving…';
    Promise.resolve().then(function () { return self.view.call(spec.fn, payload); }).then(function (res) {
      if (okReply(res)) {
        self.cell.setAttribute('data-fd-result', 'ok');
        self.msg.textContent = spec.done(res);
        self.buttons.forEach(function (b) { b.hidden = true; });
        if (self.noteEl) self.noteEl.hidden = true;
        (self.inputs || []).forEach(function (i) { i.hidden = true; });
      } else { self.fail('The server did not confirm this — nothing changed on screen'); }
    }, function (e) { self.fail(errorText(e || {}, spec.label)); }).then(function () { self.busy = false; });
  };
  Actions.prototype.fail = function (t) { this.cell.setAttribute('data-fd-result', 'error'); this.setDisabled(false); this.msg.textContent = t; };

  /* A paged list (cursor + Load more), bounded at MAX_ROWS, stale replies dropped. */
  function PagedList(view, opts) {
    this.view = view; this.opts = opts; this.seq = 0; this.rows = []; this.next = null; this.loading = false;
    this.status = new Status(opts.prefix);
    this.wrap = h('div', { class: 'sk-pa-scroll', tabindex: '0', role: 'region', 'aria-label': opts.title + ' (scrolls sideways on small screens)', hidden: true });
    var self = this;
    this.more = h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': opts.prefix + '-more', text: 'Load more', hidden: true, onclick: function () { self.load(true); } });
    this.el = h('div', {}, [this.status.el, this.wrap, h('div', { class: 'sk-fd-more' }, [this.more])]);
  }
  PagedList.prototype.load = function (append) {
    var self = this, seq = ++this.seq, payload = this.opts.payload();
    if (append) { if (!this.next || this.rows.length >= MAX_ROWS) return Promise.resolve(); payload.cursor = this.next; }
    else { this.rows = []; this.next = null; this.wrap.hidden = true; this.wrap.textContent = ''; this.status.set('not-attempted', 'Reading ' + this.opts.title.toLowerCase() + '…'); }
    this.loading = true; this.more.disabled = true;
    return Promise.resolve().then(function () { return self.view.call(self.opts.fn, payload); })
      .then(function (d) { return { data: d }; }, function (e) { return { error: e || {} }; })
      .then(function (o) {
        if (seq !== self.seq) return;
        self.loading = false; self.more.disabled = false;
        if (o.error !== undefined) {
          if (append) { self.status.detail.textContent = 'Load more failed: ' + errorText(o.error, 'Load more'); self.status.detail.hidden = false; return; }
          self.status.fromError(o.error, self.opts.title, self.opts.fn); self.more.hidden = true; return;
        }
        var list = rows(o.data);
        if (!list) { if (!append) { self.status.set('unreadable', 'Could not read ' + self.opts.title.toLowerCase(), 'Unexpected response from ' + self.opts.fn + '. Nothing is shown in its place.'); self.more.hidden = true; } return; }
        self.rows = self.rows.concat(list).slice(0, MAX_ROWS);
        self.next = o.data.next || null;
        self.render();
      });
  };
  PagedList.prototype.render = function () {
    var n = this.rows.length, what = this.opts.filterLabel();
    if (!n) this.status.set('empty', 'No ' + this.opts.title.toLowerCase() + (what ? ' — ' + what : ''));
    else this.status.set('observed', n + ' ' + this.opts.title.toLowerCase() + (what ? ' — ' + what : '') + (n >= MAX_ROWS ? ' (first ' + MAX_ROWS + ')' : ''));
    this.wrap.textContent = ''; this.wrap.hidden = !n;
    if (n) this.wrap.appendChild(this.opts.table(this.rows));
    this.more.hidden = !(this.next && n < MAX_ROWS);
  };
  function table(caption, cols, bodyRows) {
    return h('table', { class: 'sk-pa-table' }, [
      h('caption', { class: 'sk-pa-sr', text: caption }),
      h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
      h('tbody', {}, bodyRows),
    ]);
  }
  function td(label, text, cls) { return h('td', { 'data-label': label, class: cls || null, text: text == null || text === '' ? NEUTRAL : String(text) }); }

  /* ── the view ─────────────────────────────────────────────────────────── */
  function View(host, opts) {
    this.host = host;
    this.console = (opts && opts.console) || 'aos';
    this.call = (opts && typeof opts.call === 'function') ? opts.call : defaultCall;
    this.uploader = (opts && typeof opts.upload === 'function') ? opts.upload : null;
    this.panels = {}; this.loaded = {}; this.active = null;
    this.build();
    this.select('overview');
  }
  View.prototype.build = function () {
    var self = this;
    this.uid = 'skFd' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.host.textContent = '';
    this.tabButtons = {};
    var strip = h('div', { class: 'sk-fd-tabs', role: 'tablist', 'aria-label': 'SOKONI Foundation sections' });
    TABS.forEach(function (t, i) {
      var b = h('button', { type: 'button', role: 'tab', id: self.uid + '-tab-' + t.key, 'aria-controls': self.uid + '-panel-' + t.key, 'aria-selected': 'false', tabindex: '-1', class: 'sk-fd-tab', 'data-fd-tab': t.key, text: t.label });
      b.addEventListener('click', function () { self.select(t.key); });
      b.addEventListener('keydown', function (ev) {
        var k = ev && ev.key, j = null;
        if (k === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (k === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
        else if (k === 'Home') j = 0; else if (k === 'End') j = TABS.length - 1;
        if (j == null) return;
        if (ev.preventDefault) ev.preventDefault();
        self.select(TABS[j].key);
        var nb = self.tabButtons[TABS[j].key]; if (nb && typeof nb.focus === 'function') nb.focus();
      });
      self.tabButtons[t.key] = b; strip.appendChild(b);
    });
    this.panelHost = h('div', { class: 'sk-fd-panels' });
    this.host.appendChild(h('div', { class: 'sk-pa sk-fd', 'data-console': this.console }, [
      h('header', { class: 'sk-pa-hero' }, [
        h('p', { class: 'sk-pa-eyebrow', text: 'Impact · admin' }),
        h('h2', { class: 'sk-pa-title', text: 'SOKONI Foundation' }),
        h('p', { class: 'sk-pa-lede', text: 'Donations, support payments, stories and partner promotions. Every figure comes from the server; anything it could not read shows “—”. Money moves only through the approval chain: request → approve → super-admin authorization → confirmed.' }),
      ]),
      strip, this.panelHost,
    ]));
  };
  View.prototype.select = function (key, preset) {
    var self = this;
    TABS.forEach(function (t) {
      var on = t.key === key, b = self.tabButtons[t.key];
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1');
      b.className = 'sk-fd-tab' + (on ? ' sk-fd-tab-on' : '');
      if (self.panels[t.key]) self.panels[t.key].el.hidden = !on;
    });
    this.active = key;
    this.host.setAttribute('data-fd-active', key);
    if (!this.panels[key]) {
      var p = this['make_' + key]();
      p.el.setAttribute('role', 'tabpanel'); p.el.setAttribute('id', this.uid + '-panel-' + key); p.el.setAttribute('aria-labelledby', this.uid + '-tab-' + key);
      this.panels[key] = p; this.panelHost.appendChild(p.el);
    }
    var panel = this.panels[key];
    if (preset !== undefined && panel.preset) { panel.preset(preset); this.loaded[key] = true; return panel; }
    if (!this.loaded[key]) { this.loaded[key] = true; panel.load(); }
    return panel;
  };
  View.prototype.refresh = function () { var p = this.panels[this.active]; if (p) p.load(); };

  /* 1 ── Overview */
  View.prototype.make_overview = function () {
    var self = this, st = new Status('ov'), stories = new Status('ov-stories');
    var money = h('div', { class: 'sk-pa-cols', 'data-fd': 'ov-money' });
    var don = h('div', { class: 'sk-fd-counts', 'data-fd': 'ov-donations' });
    var dis = h('div', { class: 'sk-fd-counts', 'data-fd': 'ov-disbursements' });
    var sc = h('div', { class: 'sk-fd-counts', 'data-fd': 'ov-stories' });
    var refresh = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { load(); } });
    function countBtn(label, value, onOpen, dataKey) {
      return h('button', { type: 'button', class: 'sk-fd-count', 'data-fd-count': dataKey, 'aria-label': label + ': ' + fmtCount(value) + ' — open the list', onclick: onOpen }, [
        h('span', { class: 'sk-pa-col-label', text: label }), h('span', { class: 'sk-pa-col-value sk-pa-num', text: fmtCount(value) })]);
    }
    function render(d) {
      money.textContent = ''; don.textContent = ''; dis.textContent = '';
      var bal = d.balance && typeof d.balance === 'object' ? d.balance : null;
      BAL_KEYS.forEach(function (k) {
        var v = bal ? bal[k[0]] : null;
        money.appendChild(h('div', { class: 'sk-pa-col' + (isNum(v) ? '' : ' sk-pa-ev-unreadable'), 'data-fd-money': k[0] }, [
          h('span', { class: 'sk-pa-col-label', text: k[1] }), h('span', { class: 'sk-pa-col-value sk-pa-num', text: fmtKES(v) })]));
      });
      var dc = d.donations && typeof d.donations === 'object' ? d.donations : {};
      DON_COUNT_KEYS.forEach(function (k) { don.appendChild(countBtn(DON_LABEL[k], dc[k], function () { self.select('donations', k); }, 'donations:' + k)); });
      var xc = d.disbursements && typeof d.disbursements === 'object' ? d.disbursements : {};
      DIS_COUNT_KEYS.forEach(function (k) { dis.appendChild(countBtn(DIS_LABEL[k[1]], xc[k[0]], function () { self.select('disbursements', k[1]); }, 'disbursements:' + k[1])); });
    }
    var seq = 0;
    function load() {
      var my = ++seq;
      st.set('not-attempted', 'Reading the Foundation summary…'); stories.set('not-attempted', 'Reading story counts…');
      money.textContent = ''; don.textContent = ''; dis.textContent = ''; sc.textContent = '';
      Promise.resolve().then(function () { return self.call(DATA_FN, { view: 'summary' }); }).then(function (d) {
        if (my !== seq) return;
        if (!d || typeof d !== 'object') { st.set('unreadable', 'Could not read the Foundation summary', 'Unexpected response from ' + DATA_FN + '.'); return; }
        render(d);
        st.set(d.balance ? 'observed' : 'unreadable', d.balance ? 'Foundation summary' : 'Foundation summary — balance could not be read', d.balance ? '' : 'The server returned no balance; figures show “—”, never 0.');
      }, function (e) { if (my === seq) st.fromError(e || {}, 'Foundation summary', DATA_FN); });
      Promise.resolve().then(function () { return self.call(CONTENT_FN, { op: 'adminCounts' }); }).then(function (d) {
        if (my !== seq) return;
        var c = d && typeof d === 'object' ? (d.counts && typeof d.counts === 'object' ? d.counts : d) : null;
        if (!c) { stories.set('unreadable', 'Could not read story counts'); return; }
        ['pending', 'approved', 'draft', 'changes_requested', 'rejected', 'archived'].forEach(function (k) {
          sc.appendChild(countBtn(STORY_LABEL[k].replace(', not published', ''), c[k], function () { self.select('stories', k); }, 'stories:' + k));
        });
        stories.set('observed', 'Stories & testimonials');
      }, function (e) { if (my === seq) stories.fromError(e || {}, 'Story counts', CONTENT_FN); });
    }
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'overview' }, [
      h('div', { class: 'sk-pa-controls' }, [refresh]), st.el,
      h('h3', { class: 'sk-fd-h', text: 'Foundation account' }), money,
      h('h3', { class: 'sk-fd-h', text: 'Donations' }), don,
      h('h3', { class: 'sk-fd-h', text: 'Support payments' }), dis,
      h('h3', { class: 'sk-fd-h', text: 'Stories' }), stories.el, sc,
    ]);
    return { el: el, load: load };
  };

  /* 2 ── Donations */
  View.prototype.make_donations = function () {
    var self = this;
    var sel = select('don-filter', DON_STATUSES.map(function (s) { return [s, DON_LABEL[s]]; }), 'All statuses');
    var list = new PagedList(this, {
      prefix: 'don', title: 'Donations', fn: DATA_FN,
      payload: function () { var p = { view: 'donations' }; if (sel.value) p.status = sel.value; return p; },
      filterLabel: function () { return sel.value ? DON_LABEL[sel.value] : ''; },
      table: function (rs) {
        return table('Foundation donations', ['Date', 'Amount', 'Gross / fee / net', 'Programme', 'Purpose', 'Donor', 'Receipt', 'Provider ref', 'Status', 'Action'], rs.map(function (r) { return donationRow(r || {}); }));
      },
    });
    function donationRow(r) {
      var id = str(r.id || r.pledgeId), st = str(r.status);
      var donor = r.donor && typeof r.donor === 'object' ? str(r.donor.name || r.donor.displayName) : str(r.donor || r.donorName);
      var cell = h('td', { 'data-label': 'Action', class: 'sk-pa-action' });
      if (st === 'completed') {
        var gross = isNum(r.gross) ? r.gross : (isNum(r.amount) ? r.amount : null);
        cell.appendChild(h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': 'act-refund', text: 'Refund', title: REFUND_COPY,
          onclick: function () { self.select('disbursements').openForm({ refundOfPledgeId: id, amount: gross, max: gross }); } }));
      }
      return h('tr', { 'data-fd-row': id }, [
        td('Date', fmtTime(r.completedAt || r.createdAt)),
        td('Amount', fmtKES(r.amount), 'sk-pa-num'),
        td('Gross / fee / net', fmtKES(r.gross) + ' / ' + fmtKES(r.fee) + ' / ' + fmtKES(r.net), 'sk-pa-num'),
        td('Programme', str(r.programmeName || r.programmeId)),
        td('Purpose', str(r.purpose)),
        td('Donor', donor),
        td('Receipt', str(r.receiptId), 'sk-pa-mono'),
        td('Provider ref', str(r.providerRef || r.providerReference), 'sk-pa-mono'),
        td('Status', DON_LABEL[st] || st),
        cell,
      ]);
    }
    sel.addEventListener('change', function () { list.load(false); });
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'donations' }, [
      h('div', { class: 'sk-pa-controls' }, [field('Status', sel), h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { list.load(false); } })]),
      list.el,
    ]);
    return { el: el, load: function () { return list.load(false); }, preset: function (s) { sel.value = DON_STATUSES.indexOf(s) >= 0 ? s : ''; return list.load(false); }, list: list };
  };

  /* 3 ── Disbursements / Send support */
  View.prototype.make_disbursements = function () {
    var self = this;
    var sel = select('dis-filter', DIS_STATUSES.map(function (s) { return [s, DIS_LABEL[s]]; }), 'All statuses');
    var list = new PagedList(this, {
      prefix: 'dis', title: 'Support payments', fn: DATA_FN,
      payload: function () { var p = { view: 'disbursements' }; if (sel.value) p.status = sel.value; return p; },
      filterLabel: function () { return sel.value ? DIS_LABEL[sel.value] : ''; },
      table: function (rs) {
        return table('Foundation support payments', ['Created', 'Amount', 'Beneficiary', 'Purpose', 'Destination', 'Status', 'Reference', 'Actions'], rs.map(function (r) { return disRow(r || {}); }));
      },
    });
    function disRow(r) {
      var id = str(r.id || r.disbursementId), st = str(r.status), manual = isManualRail(r);
      var A = new Actions(self);
      function after(res) { var s = str(res && res.status); return DIS_LABEL[s] ? 'Done — now: ' + DIS_LABEL[s] : 'Done — refresh to see the new status'; }
      function withNote(extra, msg) { return function () { var n = A.noteValue(); if (!n) return msg; var p = { disbursementId: id, note: n }; Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; }); return p; }; }
      function plain(extra) { return function () { var p = { disbursementId: id }; Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; }); return p; }; }
      if (st === 'pending_approval') A.add({ key: 'approve', label: 'Approve', primary: true, fn: 'impactApproveDisbursement', prepare: plain(), done: after, title: 'A different administrator from the requester' });
      if (st === 'pending_authorization') {
        A.add({ key: 'authorize', label: 'Authorize', primary: true, fn: 'impactAuthorizeDisbursement', prepare: plain(), done: after });
        A.extra.appendChild(h('p', { class: 'sk-fd-hint', text: 'Super admin only — and a different person from the requester and the approver. Authorizing starts the payment.' }));
      }
      if (st === 'processing' && !manual) A.add({ key: 'check', label: 'Check status', primary: true, fn: 'impactRefreshDisbursementStatus', prepare: plain(), done: after });
      if (st === 'processing' && manual) {
        var ref = h('input', { type: 'text', class: 'sk-pa-input', maxlength: '80', 'data-fd': 'provider-ref', 'aria-label': 'Payment reference from the bank / M-PESA statement', placeholder: 'Payment reference' });
        A.inputs = [ref]; A.extra.appendChild(ref);
        A.extra.appendChild(h('p', { class: 'sk-fd-hint', text: MANUAL_RAIL_COPY }));
        A.add({ key: 'record', label: 'Record payment reference', primary: true, fn: 'impactRecordManualDisbursement', done: after,
          prepare: function () { var v = str(ref.value).trim(); if (!v) return 'Enter the payment reference first'; return { disbursementId: id, action: 'record', providerReference: v }; } });
      }
      if (st === 'awaiting_confirmation') {
        A.add({ key: 'confirm', label: 'Confirm', primary: true, fn: 'impactRecordManualDisbursement', prepare: plain({ action: 'confirm' }), done: after });
        A.extra.appendChild(h('p', { class: 'sk-fd-hint', text: 'Confirm only after checking the statement. Must be a different administrator from the one who recorded it.' }));
      }
      if ((st === 'processing' && manual) || st === 'awaiting_confirmation') {
        A.note('Note (required to mark failed)');
        A.add({ key: 'fail', label: 'Mark failed', fn: 'impactRecordManualDisbursement', prepare: withNote({ action: 'fail' }, 'Add a note saying why it failed'), done: after });
      }
      if (st === 'pending_approval' || st === 'pending_authorization') {
        A.note('Note (required to cancel)');
        A.add({ key: 'cancel', label: 'Cancel', fn: 'impactCancelDisbursement', prepare: withNote({}, 'Add a note saying why it is cancelled'), done: after });
      }
      var refText = [str(r.providerReference), str(r.trackingId)].filter(Boolean).join(' · ');
      return h('tr', { 'data-fd-row': id, 'data-fd-status': st }, [
        td('Created', fmtTime(r.initiatedAt || r.createdAt)),   /* disbursement rows: initiatedAt */
        td('Amount', fmtKES(r.amount), 'sk-pa-num'),
        td('Beneficiary', str(r.beneficiaryName)),
        td('Purpose', str(r.description) + (r.refundOfPledgeId ? ' (refund of ' + str(r.refundOfPledgeId) + ')' : '')),
        td('Destination', (DEST_LABEL[str(r.destinationType)] || str(r.destinationType) || NEUTRAL) + ' · ' + maskedDestination(r.destination) + (manual ? ' · manual rail' : '')),
        td('Status', DIS_LABEL[st] || st),
        td('Reference', refText, 'sk-pa-mono'),
        A.cell,
      ]);
    }
    sel.addEventListener('change', function () { list.load(false); });

    /* "New support payment" — requestId is generated ONCE per form open; a retried submit reuses it. */
    var formHost = h('div', { class: 'sk-fd-formhost', 'data-fd': 'dis-formhost', hidden: true });
    var form = null;
    function openForm(prefill) {
      prefill = prefill || {};
      var requestId = newRequestId();
      formHost.textContent = ''; formHost.hidden = false;
      var amount = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', class: 'sk-pa-input', 'data-fd': 'f-amount' });
      if (isNum(prefill.amount)) amount.value = String(prefill.amount);
      if (isNum(prefill.max)) amount.setAttribute('max', String(prefill.max));
      var name = h('input', { type: 'text', maxlength: '120', class: 'sk-pa-input', 'data-fd': 'f-beneficiary' });
      var desc = h('textarea', { maxlength: '500', rows: '2', class: 'sk-pa-input', 'data-fd': 'f-description' });
      var type = select('f-type', DEST_TYPES.map(function (t) { return [t, DEST_LABEL[t]]; }));
      var grant = h('input', { type: 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 'f-grant' });
      var camp = h('input', { type: 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 'f-campaign' });
      var destBox = h('div', { class: 'sk-fd-grid', 'data-fd': 'f-dest' });
      var railNote = h('p', { class: 'sk-pa-detail', 'data-fd': 'f-rail-note', hidden: true, text: MANUAL_RAIL_COPY });
      var destInputs = {};
      function drawDest() {
        destBox.textContent = ''; destInputs = {};
        var t = DEST_TYPES.indexOf(type.value) >= 0 ? type.value : 'MPESA';
        DEST_FIELDS[t].forEach(function (f) {
          var i = h('input', { type: f[0] === 'phone' ? 'tel' : 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 'f-dest-' + f[0] });
          destInputs[f[0]] = { input: i, required: f[2] };
          destBox.appendChild(field(f[1], i));
        });
        railNote.hidden = t === 'MPESA';
      }
      type.value = 'MPESA'; type.addEventListener('change', drawDest); drawDest();
      var msg = h('p', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-fd': 'f-msg' });
      var submit = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-fd': 'f-submit', text: prefill.refundOfPledgeId ? 'Request refund' : 'Request support payment' });
      var close = h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': 'f-close', text: 'Close', onclick: function () { formHost.hidden = true; formHost.textContent = ''; form = null; } });
      var busy = false, done = false;
      submit.addEventListener('click', function () {
        if (busy || done) return;
        if (!requestId) { msg.textContent = 'This browser cannot generate a secure request id — use a current browser'; return; }
        var amt = Number(amount.value);
        if (!(amt > 0) || Math.floor(amt) !== amt) { msg.textContent = 'Enter a whole amount in KES'; return; }
        if (isNum(prefill.max) && amt > prefill.max) { msg.textContent = 'A refund cannot exceed the gross donation (' + fmtKES(prefill.max) + ')'; return; }
        var bn = str(name.value).trim(), ds = str(desc.value).trim();
        if (!bn) { msg.textContent = 'Enter the beneficiary name'; return; }
        if (!ds) { msg.textContent = 'Enter the purpose'; return; }
        var t = DEST_TYPES.indexOf(type.value) >= 0 ? type.value : 'MPESA', dest = {}, missing = '';
        Object.keys(destInputs).forEach(function (k) { var v = str(destInputs[k].input.value).trim(); if (v) dest[k] = v; else if (destInputs[k].required && !missing) missing = k; });
        if (missing) { msg.textContent = 'Fill in every destination field'; return; }
        var payload = { requestId: requestId, amount: amt, beneficiaryName: bn, description: ds, destinationType: t, destination: dest };
        if (str(grant.value).trim()) payload.grantId = str(grant.value).trim();
        if (str(camp.value).trim()) payload.campaignId = str(camp.value).trim();
        if (prefill.refundOfPledgeId) payload.refundOfPledgeId = prefill.refundOfPledgeId;
        busy = true; submit.disabled = true; msg.textContent = 'Submitting…'; formHost.setAttribute('data-fd-result', 'in-flight');
        Promise.resolve().then(function () { return self.call('impactInitiateDisbursement', payload); }).then(function (res) {
          if (okReply(res) || (res && res.disbursementId)) {
            done = true; formHost.setAttribute('data-fd-result', 'ok');
            var s = DIS_LABEL[str(res.status)] ? str(res.status) : 'pending_approval';
            msg.textContent = 'Request created' + (res.disbursementId ? ' (' + str(res.disbursementId) + ')' : '') + ' — ' + DIS_LABEL[s] + '. Nothing has been paid.';
            submit.hidden = true;
            list.load(false);
          } else { formHost.setAttribute('data-fd-result', 'error'); msg.textContent = 'The server did not confirm the request — submit again (the same request id is reused, so it cannot be created twice)'; }
        }, function (e) { formHost.setAttribute('data-fd-result', 'error'); msg.textContent = errorText(e || {}, 'Send support') + ' — you can submit again safely (same request id)'; })
          .then(function () { busy = false; if (!done) submit.disabled = false; });
      });
      var kids = [h('h3', { class: 'sk-fd-h', text: prefill.refundOfPledgeId ? 'Refund request' : 'New support payment' })];
      if (prefill.refundOfPledgeId) kids.push(h('p', { class: 'sk-pa-detail', 'data-fd': 'f-refund-note', text: REFUND_COPY + ' — refund of donation ' + str(prefill.refundOfPledgeId) + (isNum(prefill.max) ? ', at most ' + fmtKES(prefill.max) : '') }));
      kids.push(h('div', { class: 'sk-fd-grid' }, [
        field('Amount (KES)', amount), field('Beneficiary name', name), field('Destination type', type),
        field('Grant id (optional)', grant), field('Campaign id (optional)', camp)]));
      kids.push(field('Purpose', desc, 'sk-pa-field-note'));
      kids.push(destBox, railNote);
      kids.push(h('p', { class: 'sk-fd-hint', text: 'Creating a request moves no money. It needs a second administrator\'s approval, then a super admin\'s authorization.' }));
      kids.push(h('div', { class: 'sk-pa-confirm-actions' }, [submit, close]), msg);
      formHost.appendChild(h('div', { class: 'sk-pa-confirm sk-fd-form', 'data-fd': 'dis-form', 'data-request-id': requestId || '' }, kids));
      form = { requestId: requestId };
      return form;
    }
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'disbursements' }, [
      h('div', { class: 'sk-pa-controls' }, [field('Status', sel),
        h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { list.load(false); } }),
        h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': 'dis-new', text: 'New support payment', onclick: function () { openForm({}); } })]),
      formHost, list.el,
    ]);
    return { el: el, load: function () { return list.load(false); }, preset: function (s) { sel.value = DIS_STATUSES.indexOf(s) >= 0 ? s : ''; return list.load(false); }, openForm: openForm, list: list };
  };

  /* 4 ── Stories & Media House */
  View.prototype.make_stories = function () {
    var self = this;
    var sel = select('st-filter', STORY_STATUSES.map(function (s) { return [s, STORY_LABEL[s]]; }), 'All statuses');
    var kind = select('st-kind', [['story', 'Stories'], ['testimonial', 'Testimonials']], 'All kinds');
    var list = new PagedList(this, {
      prefix: 'st', title: 'Stories', fn: CONTENT_FN,
      payload: function () { var p = { op: 'adminList' }; if (sel.value) p.status = sel.value; if (kind.value) p.kind = kind.value; return p; },
      filterLabel: function () { return [sel.value ? STORY_LABEL[sel.value] : '', kind.value].filter(Boolean).join(', '); },
      table: function (rs) { return table('Foundation stories and testimonials', ['Title', 'Kind', 'Status', 'Byline', 'Programme', 'Consent', 'Media', 'Updated', 'Actions'], rs.map(function (r) { return storyRow(r || {}); })); },
    });
    function storyRow(r) {
      var id = str(r.id), s = storyState(r), A = new Actions(self);
      function after(res) { var ns = res && res.status ? storyState({ status: res.status, publishAt: res.publishAt, published: res.published }) : ''; return STORY_LABEL[ns] ? 'Done — now: ' + STORY_LABEL[ns] : 'Done — refresh to see the new state'; }
      function decide(action, needsNote) {
        return function () { var p = { op: 'adminDecide', id: id, action: action }, n = A.noteValue(); if (needsNote && !n) return 'Add a note first'; if (n) p.note = n; return p; };
      }
      var noteNeeded = false;
      if (s === 'draft' || s === 'changes_requested') A.add({ key: 'submit', label: 'Submit for review', primary: true, fn: CONTENT_FN, prepare: function () { return { op: 'adminSubmit', id: id }; }, done: after });
      if (s === 'pending') {
        A.add({ key: 'approve', label: 'Approve', primary: true, fn: CONTENT_FN, prepare: decide('approve'), done: after });
        A.add({ key: 'request_changes', label: 'Request changes', fn: CONTENT_FN, prepare: decide('request_changes', true), done: after });
        A.add({ key: 'reject', label: 'Reject', fn: CONTENT_FN, prepare: decide('reject', true), done: after });
        noteNeeded = true;
      }
      if (s === 'approved' || s === 'scheduled') {
        var when = h('input', { type: 'datetime-local', class: 'sk-pa-input', 'data-fd': 'publish-at', 'aria-label': 'Publish at (your local time)' });
        A.inputs = [when]; A.extra.appendChild(when);
        A.add({ key: 'publish', label: 'Publish now', primary: true, fn: CONTENT_FN, prepare: function () { return { op: 'adminPublish', id: id }; }, done: after });
        A.add({ key: 'schedule', label: 'Schedule', fn: CONTENT_FN, done: after, prepare: function () {
          var ms = when.value ? new Date(when.value).getTime() : NaN;
          if (!isFinite(ms)) return 'Choose a date and time first';
          if (ms <= Date.now()) return 'Choose a time in the future, or use Publish now';
          return { op: 'adminPublish', id: id, publishAt: ms };
        } });
      }
      if (s === 'published' || s === 'scheduled') A.add({ key: 'unpublish', label: 'Unpublish', fn: CONTENT_FN, prepare: function () { return { op: 'adminUnpublish', id: id }; }, done: after });
      if (['draft', 'changes_requested', 'approved', 'scheduled', 'published', 'rejected'].indexOf(s) >= 0) A.add({ key: 'archive', label: 'Archive', fn: CONTENT_FN, prepare: decide('archive'), done: after });
      if (s === 'archived') A.add({ key: 'restore', label: 'Restore', fn: CONTENT_FN, prepare: decide('restore'), done: after });
      if (s && s !== 'removed') { A.add({ key: 'remove', label: 'Remove', fn: CONTENT_FN, prepare: decide('remove', true), done: after }); noteNeeded = true; }
      if (noteNeeded) A.note('Note (required to reject, request changes or remove)');
      var consent = NEUTRAL;
      if (str(r.kind) === 'testimonial') {
        var c = r.consent && typeof r.consent === 'object' ? r.consent : null;
        var yn = function (v) { return v === true ? 'yes' : v === false ? 'no' : NEUTRAL; };
        consent = c ? 'Publish: ' + yn(c.publish) + ' · show name: ' + yn(c.showName) + ' · show media: ' + yn(c.showMedia) : 'Consent not recorded';
      }
      var statusText = STORY_LABEL[s] || s || NEUTRAL;
      if (s === 'scheduled') statusText += ' for ' + fmtTime(r.publishAt);
      if (r.reviewNote || r.note) statusText += ' — ' + str(r.reviewNote || r.note);
      return h('tr', { 'data-fd-row': id, 'data-fd-status': s }, [
        td('Title', str(r.title)), td('Kind', str(r.kind)), td('Status', statusText),
        td('Byline', str(r.displayName || r.name)), td('Programme', str(r.programmeId)),
        td('Consent', consent), td('Media', Array.isArray(r.media) ? String(r.media.length) : NEUTRAL),
        td('Updated', fmtTime(r.updatedAt || r.createdAt)), A.cell,
      ]);
    }
    sel.addEventListener('change', function () { list.load(false); });
    kind.addEventListener('change', function () { list.load(false); });

    var formHost = h('div', { class: 'sk-fd-formhost', 'data-fd': 'st-formhost', hidden: true });
    function openStoryForm() {
      var requestId = newRequestId(), uploader = self.uploader || defaultUploader(), uploaded = null;
      formHost.textContent = ''; formHost.hidden = false;
      var title = h('input', { type: 'text', maxlength: '120', class: 'sk-pa-input', 'data-fd': 's-title' });
      var body = h('textarea', { maxlength: '5000', rows: '6', class: 'sk-pa-input', 'data-fd': 's-body' });
      var prog = h('input', { type: 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 's-programme' });
      var byline = h('input', { type: 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 's-byline' });
      var loc = h('input', { type: 'text', maxlength: '80', class: 'sk-pa-input', 'data-fd': 's-location' });
      var boxes = DESTINATIONS.map(function (d) {
        var cb = h('input', { type: 'checkbox', value: d[0], 'data-fd': 's-dest-' + d[0] });
        return { key: d[0], cb: cb, el: h('label', { class: 'sk-fd-check' }, [cb, h('span', { text: d[1] })]) };
      });
      var mediaMsg = h('p', { class: 'sk-fd-hint', 'data-fd': 's-media-msg' });
      var file = null, clear = null;
      if (uploader) {
        file = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime', class: 'sk-pa-input', 'data-fd': 's-media' });
        clear = h('button', { type: 'button', class: 'sk-pa-btn', text: 'Remove files', onclick: function () { file.value = ''; uploaded = null; mediaMsg.textContent = 'No files — the story will be text-only.'; } });
        file.addEventListener('change', function () { uploaded = null; var err = checkMedia(file.files); mediaMsg.textContent = err || ((file.files || []).length + ' file(s) ready — uploaded when you save'); });
        mediaMsg.textContent = 'Up to 4 files: JPEG/PNG/WebP ≤ 15 MB, at most one MP4/WebM/MOV video ≤ 80 MB.';
      } else {
        mediaMsg.textContent = 'Media upload not available in this console yet — you can save a text-only story.';
      }
      var msg = h('p', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-fd': 's-msg' });
      var busy = false, done = false;
      function save(submit) {
        if (busy || done) return;
        if (!requestId) { msg.textContent = 'This browser cannot generate a secure request id — use a current browser'; return; }
        var t = str(title.value).trim(), b = str(body.value).trim();
        if (!t || !b) { msg.textContent = 'Add a title and the story text'; return; }
        var files = file ? Array.prototype.slice.call(file.files || []) : [];
        var err = checkMedia(files);
        if (err) { msg.textContent = err; return; }
        busy = true; draftBtn.disabled = submitBtn.disabled = true; formHost.setAttribute('data-fd-result', 'in-flight');
        var up = Promise.resolve(uploaded || []);
        if (files.length && !uploaded) {
          msg.textContent = 'Uploading media…';
          up = files.reduce(function (p, f) {
            return p.then(function (acc) {
              var ext = IMAGE_TYPES[f.type] || VIDEO_TYPES[f.type], rnd = randomHex(12);
              if (!rnd) return Promise.reject({ code: 'no-random' });
              return uploader('foundation-media/admin/' + rnd + '.' + ext, f).then(function (path) { return acc.concat([str(path)]); });
            });
          }, Promise.resolve([])).then(function (paths) { uploaded = paths; return paths; }, function (e) {
            return Promise.reject({ upload: true, code: code(e) });
          });
        }
        up.then(function (paths) {
          msg.textContent = 'Saving…';
          var p = { op: 'adminSaveStory', requestId: requestId, title: t, body: b, media: paths, destinations: boxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.key; }) };
          if (str(prog.value).trim()) p.programmeId = str(prog.value).trim();
          if (str(byline.value).trim()) p.displayName = str(byline.value).trim();
          if (str(loc.value).trim()) p.location = str(loc.value).trim();
          if (submit) p.submit = true;
          return self.call(CONTENT_FN, p);
        }).then(function (res) {
          if (okReply(res)) {
            done = true; formHost.setAttribute('data-fd-result', 'ok');
            msg.textContent = submit ? 'Saved and submitted — another administrator must approve it' : 'Saved as draft';
            draftBtn.hidden = submitBtn.hidden = true;
            list.load(false);
          } else { formHost.setAttribute('data-fd-result', 'error'); msg.textContent = 'The server did not confirm the save — try again (same request id)'; }
        }, function (e) {
          formHost.setAttribute('data-fd-result', 'error');
          msg.textContent = e && e.upload ? 'Media upload failed (' + bare(e.code) + '). Remove the files to save text-only, or try again.' : errorText(e || {}, 'Saving the story');
        }).then(function () { busy = false; if (!done) draftBtn.disabled = submitBtn.disabled = false; });
      }
      var draftBtn = h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': 's-draft', text: 'Save as draft', onclick: function () { save(false); } });
      var submitBtn = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-fd': 's-submit', text: 'Save & submit for review', onclick: function () { save(true); } });
      var closeBtn = h('button', { type: 'button', class: 'sk-pa-btn', text: 'Close', onclick: function () { formHost.hidden = true; formHost.textContent = ''; } });
      formHost.appendChild(h('div', { class: 'sk-pa-confirm sk-fd-form', 'data-fd': 'st-form' }, [
        h('h3', { class: 'sk-fd-h', text: 'New story' }),
        field('Title', title, 'sk-pa-field-note'), field('Story', body, 'sk-pa-field-note'),
        h('div', { class: 'sk-fd-grid' }, [field('Programme id (optional)', prog), field('Byline (optional)', byline), field('Location (optional)', loc)]),
        h('fieldset', { class: 'sk-fd-fieldset' }, [h('legend', { text: 'Show on' })].concat(boxes.map(function (x) { return x.el; }))),
        h('div', { class: 'sk-fd-media' }, [file, clear, mediaMsg]),
        h('p', { class: 'sk-fd-hint', text: 'A story you write must be approved by a different administrator before it can be published.' }),
        h('div', { class: 'sk-pa-confirm-actions' }, [draftBtn, submitBtn, closeBtn]), msg,
      ]));
    }
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'stories' }, [
      h('div', { class: 'sk-pa-controls' }, [field('Status', sel), field('Kind', kind),
        h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { list.load(false); } }),
        h('button', { type: 'button', class: 'sk-pa-btn', 'data-fd': 'st-new', text: 'New story', onclick: openStoryForm })]),
      formHost, list.el,
    ]);
    return { el: el, load: function () { return list.load(false); }, preset: function (s) { sel.value = STORY_STATUSES.indexOf(s) >= 0 ? s : ''; return list.load(false); }, openForm: openStoryForm, list: list };
  };

  /* 5 ── Partner promotions */
  View.prototype.make_promotions = function () {
    var self = this;
    var sel = select('pr-filter', PROMO_STATUSES.map(function (s) { return [s, PROMO_LABEL[s]]; }));
    sel.value = 'pending';
    var list = new PagedList(this, {
      prefix: 'pr', title: 'Promotion requests', fn: PARTNER_FN,
      payload: function () { var p = { op: 'adminListPromotionRequests' }; if (sel.value) p.status = sel.value; return p; },
      filterLabel: function () { return PROMO_LABEL[sel.value] || ''; },
      table: function (rs) { return table('Partner promotion requests', ['Partner', 'Type', 'Requested', 'Status', 'Actions'], rs.map(function (r) { return promoRow(r || {}); })); },
    });
    function promoRow(r) {
      var id = str(r.id), st = str(r.status), A = new Actions(self);
      if (st === 'pending') {
        var days = h('input', { type: 'number', min: '1', max: '90', step: '1', value: '30', class: 'sk-pa-input', 'data-fd': 'promo-days', 'aria-label': 'Days to promote (1–90)' });
        A.inputs = [days]; A.extra.appendChild(field('Days (1–90)', days));
        A.note('Note (required to decline)');
        A.add({ key: 'grant', label: 'Grant promotion', primary: true, fn: PARTNER_FN, done: function () { return 'Promotion granted'; }, prepare: function () {
          var d = Number(days.value); if (!(d >= 1 && d <= 90) || Math.floor(d) !== d) return 'Days must be a whole number from 1 to 90';
          var p = { op: 'adminDecidePromotion', id: id, verdict: 'granted', days: d }, n = A.noteValue(); if (n) p.note = n; return p; } });
        A.add({ key: 'decline', label: 'Decline', fn: PARTNER_FN, done: function () { return 'Declined'; }, prepare: function () {
          var n = A.noteValue(); if (!n) return 'Add a note saying why it is declined'; return { op: 'adminDecidePromotion', id: id, verdict: 'declined', note: n }; } });
      }
      return h('tr', { 'data-fd-row': id }, [
        td('Partner', str(r.name || r.partnerName || r.partnerUid)), td('Type', str(r.institutionType)),
        td('Requested', fmtTime(r.requestedAt || r.createdAt)),
        td('Status', (PROMO_LABEL[st] || st || NEUTRAL) + (r.note ? ' — ' + str(r.note) : '')), A.cell,
      ]);
    }
    sel.addEventListener('change', function () { list.load(false); });
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'promotions' }, [
      h('p', { class: 'sk-pa-detail', 'data-fd': 'promo-label', text: 'Promotion ranks a listing; it never verifies it. No payment is taken.' }),
      h('div', { class: 'sk-pa-controls' }, [field('Show', sel), h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: function () { list.load(false); } })]),
      list.el,
    ]);
    return { el: el, load: function () { return list.load(false); }, list: list };
  };

  /* 6 ── Reconciliation */
  function ledgerGroups(d) {
    if (!d || typeof d !== 'object') return null;
    var out = [];
    function push(type, entries, total) { out.push({ type: str(type), entries: Array.isArray(entries) ? entries : [], total: total }); }
    var g = d.groups || d.byType;
    if (Array.isArray(g)) { g.forEach(function (x) { if (x) push(x.type, x.entries, x.total); }); return out; }
    if (g && typeof g === 'object') {
      Object.keys(g).forEach(function (k) { var v = g[k]; if (Array.isArray(v)) push(k, v); else if (v && typeof v === 'object') push(k, v.entries, v.total); });
      return out;
    }
    var flat = d.entries || d.ledger || d.recent;
    if (Array.isArray(flat)) {
      var idx = {};
      flat.forEach(function (e) { var t = str(e && e.type) || 'unknown'; if (!idx[t]) { idx[t] = { type: t, entries: [] }; out.push(idx[t]); } idx[t].entries.push(e); });
      return out;
    }
    return null;
  }
  View.prototype.make_reconciliation = function () {
    var self = this, st = new Status('rc'), box = h('div', { 'data-fd': 'rc-groups' }), seq = 0;
    function load() {
      var my = ++seq; box.textContent = ''; st.set('not-attempted', 'Reading the ledger…');
      Promise.resolve().then(function () { return self.call(REPORT_FN, {}); }).then(function (d) {
        if (my !== seq) return;
        var groups = ledgerGroups(d);
        if (!groups) { st.set('unreadable', 'Could not read the ledger', 'Unexpected response from ' + REPORT_FN + '. Nothing is shown in its place.'); return; }
        if (!groups.length) { st.set('empty', 'No ledger entries returned'); return; }
        st.set('observed', 'Last ledger entries, grouped by type');
        groups.forEach(function (g) {
          box.appendChild(h('h3', { class: 'sk-fd-h', text: (g.type || 'unknown') + ' — ' + g.entries.length + ' entr' + (g.entries.length === 1 ? 'y' : 'ies') + ' shown' + (isNum(g.total) ? ' · server total ' + fmtKES(g.total) : '') }));
          box.appendChild(h('div', { class: 'sk-pa-scroll', tabindex: '0', role: 'region', 'aria-label': 'Ledger: ' + (g.type || 'unknown') }, [
            table('Ledger entries of type ' + g.type, ['When', 'Amount', 'Reference', 'Description'], g.entries.slice(0, 100).map(function (e) {
              e = e || {};
              return h('tr', {}, [td('When', fmtTime(e.createdAt || e.timestamp || e.at)), td('Amount', fmtKES(isNum(e.amount) ? e.amount : (isNum(e.credit) && e.credit > 0 ? e.credit : (isNum(e.debit) && e.debit > 0 ? -e.debit : null))), 'sk-pa-num'),   /* ledger rows carry credit/debit */
                td('Reference', str(e.paymentRef || e.ref || e.reference || e.pledgeId || e.disbursementId || e.id), 'sk-pa-mono'), td('Description', str(e.description || e.note))]);
            }))]));
        });
      }, function (e) { if (my === seq) st.fromError(e || {}, 'Ledger', REPORT_FN); });
    }
    var el = h('section', { class: 'sk-fd-panel', 'data-fd-panel': 'reconciliation' }, [
      h('p', { class: 'sk-pa-detail sk-fd-warn', role: 'note', 'data-fd': 'rc-warning', text: 'Pre-fix checkout donations (before the pledge fix is deployed) were recorded as completed without payment — reconcile before trusting the balance.' }),
      h('p', { class: 'sk-pa-note', text: 'The daily reconciliation compares the ledger against the Foundation balance. The entries below are the most recent ledger lines exactly as the server returned them.' }),
      h('div', { class: 'sk-pa-controls' }, [h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', text: 'Refresh', onclick: load })]),
      st.el, box,
    ]);
    return { el: el, load: load };
  };

  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.SokoniAdminFoundation = {
    mount: function (host, opts) {
      if (!host) return null;
      var v = mounted && mounted.get(host);
      if (v) { v.refresh(); return v; }
      v = new View(host, opts); if (mounted) mounted.set(host, v); return v;
    },
    _test: { classifyError: classifyError, errorText: errorText, fmtKES: fmtKES, fmtCount: fmtCount, fmtTime: fmtTime, storyState: storyState, checkMedia: checkMedia, newRequestId: newRequestId, ledgerGroups: ledgerGroups, isManualRail: isManualRail, DIS_LABEL: DIS_LABEL },
  };
})();
