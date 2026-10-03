/* ============================================================================
   SOKONI — Partner plans & promotions (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-commercial.js   ·   styles: reuses sokoni-admin-payout-approvals.css (sk-pa-*)
                                         + sokoni-admin-foundation.css (sk-fd-* tabs/counts)

   Mounted by BOTH consoles with their own canonical transport (opts.call), same contract as
   Payout approvals / Partner registrations / SOKONI Foundation:
     admin-os.html     #panel-commercial  via SokoniAOS.navigate('commercial')  call = sokoni-aos.js _call()
     super-admin.html  #panel-commercial  via SA.nav('commercial')              call = fns.httpsCallable()

   SOURCE: financialPartnerDispatch (App Check; admin claim checked server-side; NOT deployed yet)
     { op:'adminListCommercial', view:'entitlements'|'campaigns'|'fulfilments', status? }
       → { rows:[{ id, ownerId, planId, productId, placement, status, reason, amountKES, intentRef,
                   startAt (ms|null), endAt (ms|null) }] }       (fulfilments: status = outcome)
     { op:'adminStopCampaign', campaignId, reason }               → { ok:true, status:'stopped', note }
     { op:'adminListPromotionRequests', status:'pending'|'granted'|'declined' }
       → { rows:[{ id, partnerUid, placement, message, status, createdAt }] }
     { op:'adminDecidePromotion', id, verdict:'granted'|'declined', days:1..90, note? } → { ok:true, status }
   Promotion requests live HERE only (moved out of the Foundation workspace — one place).

   READ-ONLY CATALOGUE: plans, prices and promotion products are defined server-side in
   functions/commercial-entitlements.js. Nothing here edits a price; amounts are the server's ("KES n" or "—").
   A PLAN NEVER BUYS TRUST: the "Registration reviewed by SOKONI" badge and licence checks are separate.

   RENDERING: textContent / setAttribute only. A result (stopped, granted…) is shown ONLY after ok:true.
   EVIDENCE: not-attempted · observed · empty · unreadable — never collapsed; not-deployed is unreadable.
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminCommercial) return;

  var NEUTRAL = '—';
  var FN = 'financialPartnerDispatch';
  var NOTE_MAX = 300;
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  var DENIED = /^(functions\/)?(permission-denied|unauthenticated)$/;
  var CATALOGUE_NOTE = 'Plans, prices and promotion products are read-only here. They are defined in the server catalogue (functions/commercial-entitlements.js) and change only through a reviewed release. A plan never buys trust: the “Registration reviewed by SOKONI” badge and licence checks are separate.';
  var STOP_DONE = 'Campaign stopped — any refund goes through the refund authority (request → approval); history is kept.';

  /* status filters per view — '' = all (the server applies no status filter) */
  var TABS = [
    { key: 'entitlements', label: 'Entitlements', statuses: [['active', 'Active'], ['expired', 'Expired'], ['cancelled', 'Cancelled']] },
    { key: 'campaigns', label: 'Campaigns', statuses: [['active', 'Active'], ['review', 'Under review'], ['stopped', 'Stopped'], ['ended', 'Ended']] },
    { key: 'fulfilments', label: 'Fulfilments', statuses: [['fulfilled', 'Fulfilled'], ['review', 'Under review']] },
    { key: 'promotions', label: 'Promotion requests', statuses: [['pending', 'Waiting for a decision'], ['granted', 'Promotion granted'], ['declined', 'Declined']], noAll: true },
  ];
  var STATUS_LABEL = { active: 'Active', expired: 'Expired', cancelled: 'Cancelled', review: 'Under review — payment received, SOKONI is checking it', stopped: 'Stopped', ended: 'Ended', fulfilled: 'Fulfilled', pending: 'Waiting for a decision', granted: 'Promotion granted', declined: 'Declined' };
  var REASON_LABEL = { amount_mismatch: 'Amount did not match the catalogue price', unknown_plan: 'Unknown plan', listing_not_approved: 'Listing not approved' };

  function str(v) { return v == null ? '' : String(v); }
  function code(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtKES(v) { return isNum(v) ? 'KES ' + Math.round(v).toLocaleString('en-KE') : NEUTRAL; }
  function fmtTime(ms) {
    if (!isNum(ms)) return NEUTRAL;
    try { return new Date(ms).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT'; }
    catch (_) { return new Date(ms).toISOString(); }
  }
  function classifyError(e) {
    var c = code(e);
    if (NOT_DEPLOYED.test(c)) return { state: 'unavailable', code: c };
    if (DENIED.test(c)) return { state: 'denied', code: c };
    return { state: 'error', code: c };
  }
  function errorText(e, what) {
    var c = code(e).replace(/^functions\//, ''), m = str(e && e.message).replace(/^functions\/[a-z-]+:?\s*/, '').trim().slice(0, 300);
    if (NOT_DEPLOYED.test(c)) return (what || 'This action') + ' is not available yet — the server side is not deployed (' + c + ')';
    if (c === 'unauthenticated') return 'Your session has expired — sign in again';
    if (m && m !== c && /\s/.test(m)) return m;
    if (c === 'permission-denied') return 'You are not allowed to do this';
    if (c === 'failed-precondition') return 'Not allowed in its current state — refresh the list';
    if (c === 'invalid-argument') return 'The server rejected this request as invalid';
    return 'Failed (' + c + ')';
  }
  function statusText(s, reason) {
    var t = STATUS_LABEL[s] || s || NEUTRAL;
    if (reason) t += ' — ' + (REASON_LABEL[reason] || reason);
    return t;
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
  function td(label, text, cls) { return h('td', { 'data-label': label, class: cls || null, text: text == null || text === '' ? NEUTRAL : String(text) }); }
  function defaultCall(name, data) {
    if (!window.firebase || typeof window.firebase.functions !== 'function') return Promise.reject({ code: 'functions/unavailable' });
    return window.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r && r.data; });
  }

  /* A row's action area: inputs + buttons + message; the result appears only after ok:true. */
  function Actions(view) {
    this.view = view; this.busy = false; this.buttons = []; this.inputs = [];
    this.msg = h('span', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-cm': 'row-msg' });
    this.extra = h('div', { class: 'sk-fd-extra' });
    this.bar = h('div', { class: 'sk-pa-confirm-actions' });
    this.cell = h('td', { 'data-label': 'Actions', class: 'sk-pa-action' }, [this.extra, this.bar, this.msg]);
  }
  Actions.prototype.add = function (spec) {
    var self = this, b = h('button', { type: 'button', class: 'sk-pa-btn' + (spec.primary ? ' sk-pa-btn-primary' : ''), 'data-cm': 'act-' + spec.key, text: spec.label });
    b.addEventListener('click', function () { self.run(spec); });
    this.buttons.push(b); this.bar.appendChild(b);
  };
  Actions.prototype.set = function (v) { this.buttons.concat(this.inputs).forEach(function (x) { x.disabled = v; }); };
  Actions.prototype.run = function (spec) {
    if (this.busy) return;
    var self = this, payload = spec.prepare();
    if (typeof payload === 'string') { this.msg.textContent = payload; this.cell.setAttribute('data-cm-result', 'refused-locally'); return; }
    this.busy = true; this.set(true); this.cell.setAttribute('data-cm-result', 'in-flight'); this.msg.textContent = 'Saving…';
    Promise.resolve().then(function () { return self.view.call(FN, payload); }).then(function (res) {
      if (res && res.ok === true) {
        self.cell.setAttribute('data-cm-result', 'ok'); self.msg.textContent = spec.done(res);
        self.buttons.concat(self.inputs).forEach(function (x) { x.hidden = true; });
      } else self.fail('The server did not confirm this — nothing changed on screen');
    }, function (e) { self.fail(errorText(e || {}, spec.label)); }).then(function () { self.busy = false; });
  };
  Actions.prototype.fail = function (t) { this.cell.setAttribute('data-cm-result', 'error'); this.set(false); this.msg.textContent = t; };

  function View(host, opts) {
    this.host = host;
    this.console = (opts && opts.console) || 'aos';
    this.call = (opts && typeof opts.call === 'function') ? opts.call : defaultCall;
    this.panels = {}; this.loaded = {}; this.active = null;
    this.build();
    this.select('entitlements');
  }
  View.prototype.build = function () {
    var self = this;
    this.uid = 'skCm' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.host.textContent = '';
    this.tabButtons = {};
    var strip = h('div', { class: 'sk-fd-tabs', role: 'tablist', 'aria-label': 'Partner plans and promotions sections' });
    TABS.forEach(function (t, i) {
      var b = h('button', { type: 'button', role: 'tab', id: self.uid + '-tab-' + t.key, 'aria-controls': self.uid + '-panel-' + t.key, 'aria-selected': 'false', tabindex: '-1', class: 'sk-fd-tab', 'data-cm-tab': t.key, text: t.label });
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
        h('p', { class: 'sk-pa-eyebrow', text: 'Banking Hub · commercial' }),
        h('h2', { class: 'sk-pa-title', text: 'Partner plans & promotions' }),
        h('p', { class: 'sk-pa-lede', text: 'What financial partners bought (plans, promotion campaigns), how each payment was fulfilled, and promotion requests waiting for a decision. Every figure comes from the server; anything it could not read shows “—”.' }),
      ]),
      h('p', { class: 'sk-pa-detail', role: 'note', 'data-cm': 'catalogue-note', text: CATALOGUE_NOTE }),
      strip, this.panelHost,
    ]));
  };
  View.prototype.select = function (key) {
    var self = this;
    TABS.forEach(function (t) {
      var on = t.key === key, b = self.tabButtons[t.key];
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1');
      b.className = 'sk-fd-tab' + (on ? ' sk-fd-tab-on' : '');
      if (self.panels[t.key]) self.panels[t.key].el.hidden = !on;
    });
    this.active = key;
    this.host.setAttribute('data-cm-active', key);
    if (!this.panels[key]) {
      var tab = null; TABS.forEach(function (t) { if (t.key === key) tab = t; });
      var p = this.makePanel(tab);
      p.el.setAttribute('role', 'tabpanel'); p.el.setAttribute('id', this.uid + '-panel-' + key); p.el.setAttribute('aria-labelledby', this.uid + '-tab-' + key);
      this.panels[key] = p; this.panelHost.appendChild(p.el);
    }
    if (!this.loaded[key]) { this.loaded[key] = true; this.panels[key].load(); }
    return this.panels[key];
  };
  View.prototype.refresh = function () { var p = this.panels[this.active]; if (p) p.load(); };

  /* One panel per tab: status filter + bounded list (server limit 100) + rows. Stale replies are dropped. */
  View.prototype.makePanel = function (tab) {
    var self = this, key = tab.key, seq = 0;
    var opts = tab.noAll ? [] : [h('option', { value: '', text: 'All statuses' })];
    tab.statuses.forEach(function (s) { opts.push(h('option', { value: s[0], text: s[1] })); });
    var sel = h('select', { class: 'sk-pa-input', 'data-cm': key + '-filter' }, opts);
    sel.value = tab.noAll ? tab.statuses[0][0] : '';
    var evidence = h('span', { class: 'sk-pa-evidence', 'data-cm': key + '-evidence' });
    var status = h('p', { class: 'sk-pa-status', role: 'status', 'aria-live': 'polite', 'data-cm': key + '-status' });
    var detail = h('p', { class: 'sk-pa-detail', 'data-cm': key + '-detail', hidden: true });
    var wrap = h('div', { class: 'sk-pa-scroll', tabindex: '0', role: 'region', 'aria-label': tab.label + ' (scrolls sideways on small screens)', hidden: true });
    function setStatus(ev, text, det) {
      evidence.textContent = 'Evidence: ' + ev; evidence.className = 'sk-pa-evidence sk-pa-ev-' + ev; evidence.setAttribute('data-evidence', ev);
      status.textContent = text; detail.textContent = det || ''; detail.hidden = !det;
    }
    function filterLabel() { var t = ''; tab.statuses.forEach(function (s) { if (s[0] === sel.value) t = s[1]; }); return t; }
    function payload() {
      if (key === 'promotions') return { op: 'adminListPromotionRequests', status: sel.value || 'pending' };
      var p = { op: 'adminListCommercial', view: key }; if (sel.value) p.status = sel.value; return p;
    }
    function load() {
      var my = ++seq, what = tab.label.toLowerCase();
      wrap.hidden = true; wrap.textContent = ''; setStatus('not-attempted', 'Reading ' + what + '…');
      return Promise.resolve().then(function () { return self.call(FN, payload()); }).then(function (d) { return { data: d }; }, function (e) { return { error: e || {} }; }).then(function (o) {
        if (my !== seq) return;
        if (o.error !== undefined) {
          var c = classifyError(o.error);
          if (c.state === 'unavailable') setStatus('unreadable', tab.label + ' not available yet', 'The server side (' + FN + ') is not deployed yet (' + c.code + '). This is not “none”.');
          else if (c.state === 'denied') setStatus('unreadable', 'You do not have access', 'Restricted to administrators (' + c.code + ').');
          else setStatus('unreadable', 'Could not read ' + what, 'The server did not answer usefully (' + c.code + '). Nothing is shown in its place.');
          return;
        }
        var list = o.data && Array.isArray(o.data.rows) ? o.data.rows : null;
        if (!list) { setStatus('unreadable', 'Could not read ' + what, 'Unexpected response from ' + FN + '. Nothing is shown in its place.'); return; }
        var f = filterLabel();
        if (!list.length) { setStatus('empty', 'No ' + what + (f ? ' — ' + f : '')); return; }
        setStatus('observed', list.length + ' ' + what + (f ? ' — ' + f : '') + (list.length >= 100 ? ' (first 100)' : ''));
        wrap.hidden = false; wrap.appendChild(self['table_' + key](list.slice(0, 100)));
      });
    }
    sel.addEventListener('change', function () { load(); });
    var kids = [h('div', { class: 'sk-pa-controls' }, [h('label', { class: 'sk-pa-field' }, [h('span', { text: 'Status' }), sel]),
      h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-cm': key + '-refresh', text: 'Refresh', onclick: function () { load(); } })])];
    if (key === 'promotions') kids.unshift(h('p', { class: 'sk-pa-detail', 'data-cm': 'promo-label', text: 'Promotion ranks a listing; it never verifies it. Granting a request takes no payment.' }));
    kids.push(h('div', { class: 'sk-pa-summary' }, [evidence, status]), detail, wrap);
    return { el: h('section', { class: 'sk-fd-panel', 'data-cm-panel': key }, kids), load: load };
  };
  function table(caption, cols, body) {
    return h('table', { class: 'sk-pa-table' }, [h('caption', { class: 'sk-pa-sr', text: caption }),
      h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]), h('tbody', {}, body)]);
  }
  View.prototype.table_entitlements = function (rs) {
    return table('Partner plan entitlements', ['Partner', 'Plan', 'Status', 'Amount', 'Payment ref', 'Starts', 'Ends'], rs.map(function (r) {
      r = r || {};
      return h('tr', { 'data-cm-row': str(r.id) }, [td('Partner', str(r.ownerId), 'sk-pa-mono'), td('Plan', str(r.planId)), td('Status', statusText(str(r.status), r.reason)),
        td('Amount', fmtKES(r.amountKES), 'sk-pa-num'), td('Payment ref', str(r.intentRef), 'sk-pa-mono'), td('Starts', fmtTime(r.startAt)), td('Ends', fmtTime(r.endAt))]);
    }));
  };
  View.prototype.table_fulfilments = function (rs) {
    return table('Commercial fulfilments', ['Partner', 'Plan / product', 'Outcome', 'Amount', 'Payment ref', 'Period starts', 'Period ends'], rs.map(function (r) {
      r = r || {};
      return h('tr', { 'data-cm-row': str(r.id) }, [td('Partner', str(r.ownerId), 'sk-pa-mono'), td('Plan / product', str(r.planId || r.productId)), td('Outcome', statusText(str(r.status), r.reason)),
        td('Amount', fmtKES(r.amountKES), 'sk-pa-num'), td('Payment ref', str(r.intentRef), 'sk-pa-mono'), td('Period starts', fmtTime(r.startAt)), td('Period ends', fmtTime(r.endAt))]);
    }));
  };
  View.prototype.table_campaigns = function (rs) {
    var self = this;
    return table('Promotion campaigns', ['Campaign', 'Partner', 'Product', 'Placement', 'Status', 'Amount', 'Starts', 'Ends', 'Actions'], rs.map(function (r) {
      r = r || {};
      var id = str(r.id), st = str(r.status), A = new Actions(self);
      if (st === 'active' || st === 'review') {
        var reason = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'data-cm': 'stop-reason', 'aria-label': 'Reason for stopping (required)' });
        A.inputs = [reason]; A.extra.appendChild(reason);
        A.add({ key: 'stop', label: 'Stop campaign', fn: FN, done: function () { return STOP_DONE; }, prepare: function () {
          var n = str(reason.value).trim().slice(0, NOTE_MAX); if (!n) return 'Add the reason for stopping this campaign';
          return { op: 'adminStopCampaign', campaignId: id, reason: n }; } });
        A.extra.appendChild(h('p', { class: 'sk-fd-hint', text: 'Stopping ends the placement now. It does not refund — a refund goes through the refund authority.' }));
      }
      return h('tr', { 'data-cm-row': id, 'data-cm-status': st }, [td('Campaign', id, 'sk-pa-mono'), td('Partner', str(r.ownerId), 'sk-pa-mono'), td('Product', str(r.productId)),
        td('Placement', str(r.placement)), td('Status', statusText(st, r.reason)), td('Amount', fmtKES(r.amountKES), 'sk-pa-num'), td('Starts', fmtTime(r.startAt)), td('Ends', fmtTime(r.endAt)), A.cell]);
    }));
  };
  View.prototype.table_promotions = function (rs) {
    var self = this;
    return table('Partner promotion requests', ['Partner', 'Placement', 'Message', 'Requested', 'Status', 'Actions'], rs.map(function (r) {
      r = r || {};
      var id = str(r.id), st = str(r.status), A = new Actions(self);
      if (st === 'pending') {
        var days = h('input', { type: 'number', min: '1', max: '90', step: '1', value: '30', class: 'sk-pa-input', 'data-cm': 'promo-days', 'aria-label': 'Days to promote (1–90)' });
        var note = h('textarea', { class: 'sk-pa-input sk-pa-note-input', maxlength: String(NOTE_MAX), rows: '2', 'data-cm': 'note', 'aria-label': 'Note (required to decline)' });
        A.inputs = [days, note];
        A.extra.appendChild(h('label', { class: 'sk-pa-field' }, [h('span', { text: 'Days (1–90)' }), days])); A.extra.appendChild(note);
        A.add({ key: 'grant', label: 'Grant promotion', primary: true, fn: FN, done: function () { return 'Promotion granted'; }, prepare: function () {
          var d = Number(days.value); if (!(d >= 1 && d <= 90) || Math.floor(d) !== d) return 'Days must be a whole number from 1 to 90';
          var p = { op: 'adminDecidePromotion', id: id, verdict: 'granted', days: d }, n = str(note.value).trim().slice(0, NOTE_MAX); if (n) p.note = n; return p; } });
        A.add({ key: 'decline', label: 'Decline', fn: FN, done: function () { return 'Declined'; }, prepare: function () {
          var n = str(note.value).trim().slice(0, NOTE_MAX); if (!n) return 'Add a note saying why it is declined';
          return { op: 'adminDecidePromotion', id: id, verdict: 'declined', note: n }; } });
      }
      return h('tr', { 'data-cm-row': id }, [td('Partner', str(r.partnerName || r.name || r.partnerUid)), td('Placement', str(r.placement)), td('Message', str(r.message)),
        td('Requested', fmtTime(isNum(r.createdAt) ? r.createdAt : r.requestedAt)), td('Status', (STATUS_LABEL[st] || st || NEUTRAL) + (r.note ? ' — ' + str(r.note) : '')), A.cell]);
    }));
  };

  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.SokoniAdminCommercial = {
    mount: function (host, opts) {
      if (!host) return null;
      var v = mounted && mounted.get(host);
      if (v) { v.refresh(); return v; }
      v = new View(host, opts); if (mounted) mounted.set(host, v); return v;
    },
    _test: { classifyError: classifyError, errorText: errorText, fmtKES: fmtKES, statusText: statusText, TABS: TABS },
  };
})();
