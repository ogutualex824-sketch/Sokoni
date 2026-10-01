/* ============================================================================
   SOKONI — Payout approvals view (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-payout-approvals.js   ·   styles: sokoni-admin-payout-approvals.css

   OWNER DECISION: a seller payout may be marked ready only after an ADMIN
   approves it. This view lists the completed/delivered items whose seller
   payout is waiting for that approval, and lets an admin approve one at a time.

   Mounted by BOTH consoles into their own panel, each handing in its OWN
   canonical callable transport (opts.call) — the same contract as Failures:
     admin-os.html     #panel-payout-approvals  via SokoniAOS.navigate('payout-approvals')
                       call = sokoni-aos.js _call()
     super-admin.html  #panel-payout-approvals  via SA.nav('payout-approvals')
                       call = SA._fns.httpsCallable(name)(data)

   SOURCE: two admin-only callables (App Check enforced; NOT deployed yet):
     adminListPendingSellerPayouts({ collection?: 'packageRequests'|'deliveries'|'orders',
                                     limit?: 1-200 })
       → { pending:[{ collection, id, status, sellerUid, buyerUid,
                      amountKES (number|null), completedAt (ISO|null) }],
           count, truncated, unreadable:[collection names that could not be read] }
     adminApproveSellerPayout({ collection, id, note?: string ≤300 })
       → { ok:true, already:boolean }
       errors: permission-denied (non-admin OR self-approval), failed-precondition
               (not delivered/completed), not-found, invalid-argument.

   RENDERING: textContent / setAttribute only — nothing from the server reaches
   innerHTML. Ids and uids are untrusted strings.

   MONEY: the server is the authority. "Approved" is shown ONLY after the
   approve callable resolves with ok:true; nothing is optimistic. An unknown
   amount renders "—", never 0.

   EVIDENCE VOCABULARY (never collapsed):
     not-attempted  nothing asked yet / collection filtered out of this query
     observed       the server returned pending payouts
     empty          the server answered and reported none pending
     unreadable     the server (or one collection) could not be read
   A collection named in `unreadable` is "could not be read" — never "nothing pending".
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminPayoutApprovals) return;

  var NEUTRAL = '—';
  var COLLECTIONS = ['packageRequests', 'deliveries', 'orders'];
  var COL_LABEL = { packageRequests: 'Package requests', deliveries: 'Deliveries', orders: 'Orders' };
  var LIMIT = 100;
  var NOTE_MAX = 300;
  var LIST_FN = 'adminListPendingSellerPayouts';
  var APPROVE_FN = 'adminApproveSellerPayout';

  /* Same rule as Failures / the Updates centre: a callable that is not deployed
     surfaces as not-found / unavailable — or 'internal' when the 404 has no CORS. */
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  var DENIED = /^(functions\/)?(permission-denied|unauthenticated)$/;
  function errCode(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }
  function bare(code) { return String(code).replace(/^functions\//, ''); }

  /* ── pure helpers (exported for scripts/test-admin-payout-approvals.js) ─── */
  function str(v) { return v == null ? '' : String(v); }

  function classifyError(e) {
    var code = errCode(e);
    if (NOT_DEPLOYED.test(code)) return { state: 'unavailable', code: code };
    if (DENIED.test(code)) return { state: 'denied', code: code };
    return { state: 'error', code: code };
  }

  function shortUid(u) {
    u = str(u);
    if (!u) return NEUTRAL;
    return u.length > 8 ? u.slice(0, 6) + '…' : u;
  }

  /* KES from the server's own figure. null / missing / non-finite → "—", never 0. */
  function fmtKES(n) {
    if (typeof n !== 'number' || !isFinite(n)) return NEUTRAL;
    var s;
    try { s = n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
    catch (_) { s = String(Math.round(n * 100) / 100); }
    return 'KES ' + s;
  }

  function fmtTime(iso) {
    var d = new Date(str(iso));
    if (!iso || isNaN(d.getTime())) return NEUTRAL;
    try {
      return d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT';
    } catch (_) { return d.toISOString(); }
  }

  /* The meaning of an approve failure, in words an admin can act on. */
  function approveErrorText(e) {
    var code = bare(errCode(e));
    var msg = str(e && e.message);
    if (code === 'permission-denied') {
      return /yourself|self|own payout|own seller/i.test(msg)
        ? 'You cannot approve a payout to yourself'
        : 'You do not have permission to approve payouts';
    }
    if (code === 'unauthenticated') return 'Your session has expired — sign in again';
    if (code === 'failed-precondition') return 'Not delivered yet';
    if (code === 'not-found') return 'Not found — the item is gone, or approvals are not available yet';
    if (code === 'unavailable' || code === 'internal') return 'Payout approvals not available yet';
    if (code === 'invalid-argument') return 'The server rejected this request as invalid';
    return 'Approval failed (' + code + ')';
  }

  /* Per-collection evidence. Never inferred: unreadable comes from the server's
     own `unreadable` list; a collection outside the filter was not asked. */
  function collectionEvidence(vm) {
    var asked = vm.filter && vm.filter.collection ? [vm.filter.collection] : COLLECTIONS;
    var d = vm.data;
    var unread = d && Array.isArray(d.unreadable) ? d.unreadable.map(str) : [];
    return COLLECTIONS.map(function (c) {
      var out = { collection: c, label: COL_LABEL[c], evidence: 'not-attempted', text: 'Not read' };
      if (asked.indexOf(c) < 0) { out.text = 'Not in this filter'; return out; }
      if (vm.state === 'loading') { out.text = 'Checking…'; return out; }
      if (!d) { out.evidence = 'unreadable'; out.text = 'Could not be read'; return out; }
      if (unread.indexOf(c) >= 0) { out.evidence = 'unreadable'; out.text = 'Could not be read'; return out; }
      var n = d.pending.filter(function (p) { return p && str(p.collection) === c; }).length;
      if (n) { out.evidence = 'observed'; out.text = n + (d.truncated ? '+' : '') + ' awaiting approval'; }
      else if (d.truncated) { out.evidence = 'not-attempted'; out.text = 'Not reached (list truncated)'; }
      else { out.evidence = 'empty'; out.text = 'Nothing awaiting approval'; }
      return out;
    });
  }

  /* Result (or thrown error) → view model. */
  function toViewModel(outcome, filter) {
    var vm = { filter: filter || { collection: '' } };
    if (!outcome) { vm.state = 'loading'; return vm; }
    if (outcome.error !== undefined) { var c = classifyError(outcome.error); vm.state = c.state; vm.code = c.code; return vm; }
    var d = outcome.data;
    if (!d || !Array.isArray(d.pending)) { vm.state = 'error'; vm.code = 'unexpected response'; return vm; }
    vm.data = d;
    var asked = vm.filter.collection ? [vm.filter.collection] : COLLECTIONS;
    var unread = Array.isArray(d.unreadable) ? d.unreadable.map(str).filter(function (c) { return asked.indexOf(c) >= 0; }) : [];
    vm.unreadable = unread;
    if (d.pending.length) vm.state = 'observed';
    else if (unread.length >= asked.length) vm.state = 'unreadable';
    else if (unread.length) vm.state = 'partial';
    else vm.state = 'empty';
    return vm;
  }

  function labelList(cols) { return cols.map(function (c) { return COL_LABEL[c] || c; }).join(', '); }

  /* The words for each state. One place, so the consoles cannot disagree. */
  function headline(vm) {
    switch (vm.state) {
      case 'loading': return { evidence: 'not-attempted', text: 'Reading payouts awaiting approval…' };
      case 'unavailable': return { evidence: 'unreadable', text: 'Payout approvals not available yet',
        detail: 'The server side of this view (' + LIST_FN + ') is not deployed yet (' + vm.code + '). Nothing is shown in its place — this is not “nothing pending”.' };
      case 'denied': return { evidence: 'unreadable', text: 'You do not have access',
        detail: 'Payout approvals are restricted to administrators (' + vm.code + ').' };
      case 'error': return { evidence: 'unreadable', text: 'Could not read payouts awaiting approval',
        detail: 'The server did not return the list (' + vm.code + '). Nothing is shown in its place.' };
      case 'unreadable': return { evidence: 'unreadable', text: 'Pending payouts could not be read',
        detail: labelList(vm.unreadable) + ' could not be read. This is not “nothing pending”.' };
      case 'partial': return { evidence: 'unreadable', text: 'Nothing awaiting approval in the collections that could be read',
        detail: labelList(vm.unreadable) + ' could not be read — payouts there may still be waiting.' };
      case 'empty': return { evidence: 'empty', text: 'No payouts awaiting approval' };
      case 'observed': {
        var n = vm.data.pending.length;
        return { evidence: 'observed', text: n + ' payout' + (n === 1 ? '' : 's') + ' awaiting approval',
          detail: vm.unreadable && vm.unreadable.length ? labelList(vm.unreadable) + ' could not be read — payouts there are not listed.' : '' };
      }
      default: return { evidence: 'not-attempted', text: 'Not read yet.' };
    }
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
    this.filter = { collection: '' };
    this.seq = 0;
    this.inflight = 0;
    this.vm = toViewModel(null, this.filter);
    this.build();
    this.refresh();
  }

  View.prototype.build = function () {
    var self = this;
    var uid = 'skPa' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.host.textContent = '';
    this.status = h('p', { class: 'sk-pa-status', role: 'status', 'aria-live': 'polite', 'data-pa': 'status' });
    this.detail = h('p', { class: 'sk-pa-detail', 'data-pa': 'detail', hidden: true });
    this.evidence = h('span', { class: 'sk-pa-evidence', 'data-pa': 'evidence' });
    this.cols = h('div', { class: 'sk-pa-cols', 'data-pa': 'collections', role: 'list', 'aria-label': 'Evidence by collection' });
    this.note = h('p', { class: 'sk-pa-note', 'data-pa': 'truncated', hidden: true });
    this.tableWrap = h('div', { class: 'sk-pa-scroll', 'data-pa': 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Payouts awaiting approval (scrolls sideways on small screens)', hidden: true });

    var colSel = h('select', { id: uid + 'Col', class: 'sk-pa-input', 'data-pa': 'collection',
      onchange: function () { self.filter.collection = COLLECTIONS.indexOf(this.value) >= 0 ? this.value : ''; self.refresh(); } },
      [h('option', { value: '', text: 'All collections' })].concat(COLLECTIONS.map(function (c) { return h('option', { value: c, text: COL_LABEL[c] }); })));
    this.refreshBtn = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-pa': 'refresh', text: 'Refresh', onclick: function () { self.refresh(); } });

    this.host.appendChild(h('div', { class: 'sk-pa', 'data-console': this.console }, [
      h('header', { class: 'sk-pa-hero' }, [
        h('p', { class: 'sk-pa-eyebrow', text: 'Money · admin approval' }),
        h('h2', { class: 'sk-pa-title', text: 'Payout approvals' }),
        h('p', { class: 'sk-pa-lede', text: 'Completed deliveries and orders whose seller payout is waiting for an admin. A payout is marked ready only after you approve it here and the server confirms. You cannot approve a payout to yourself.' }),
      ]),
      h('div', { class: 'sk-pa-controls', role: 'group', 'aria-label': 'Payout approval filters' }, [
        h('label', { class: 'sk-pa-field', for: uid + 'Col' }, [h('span', { text: 'Collection' }), colSel]),
        this.refreshBtn,
      ]),
      h('div', { class: 'sk-pa-summary' }, [this.evidence, this.status]),
      this.detail,
      this.cols,
      this.note,
      this.tableWrap,
    ]));
  };

  View.prototype.syncRefresh = function () {
    /* No re-list while an approval is in flight: its row must stay to show the answer. */
    this.refreshBtn.disabled = this.vm.state === 'loading' || this.inflight > 0;
  };

  View.prototype.refresh = function () {
    if (this.inflight > 0) return Promise.resolve();
    var self = this, seq = ++this.seq;   /* a newer request wins; late answers are dropped */
    var filter = { collection: this.filter.collection };
    var q = { limit: LIMIT };
    if (filter.collection) q.collection = filter.collection;
    this.vm = toViewModel(null, filter);
    this.render();
    return Promise.resolve().then(function () { return self.call(LIST_FN, q); }).then(
      function (d) { return { data: d }; },
      function (e) { return { error: e || {} }; }
    ).then(function (outcome) {
      if (seq !== self.seq) return;
      self.vm = toViewModel(outcome, filter);
      self.render();
    });
  };

  View.prototype.render = function () {
    var vm = this.vm, hd = headline(vm), self = this;
    this.status.textContent = hd.text;
    this.evidence.textContent = 'Evidence: ' + hd.evidence;
    this.evidence.className = 'sk-pa-evidence sk-pa-ev-' + hd.evidence;
    this.evidence.setAttribute('data-evidence', hd.evidence);
    this.host.setAttribute('data-pa-state', vm.state);
    this.detail.textContent = hd.detail || '';
    this.detail.hidden = !hd.detail;

    this.cols.textContent = '';
    collectionEvidence(vm).forEach(function (c) {
      self.cols.appendChild(h('div', { class: 'sk-pa-col sk-pa-ev-' + c.evidence, role: 'listitem', 'data-col': c.collection, 'data-evidence': c.evidence }, [
        h('span', { class: 'sk-pa-col-label', text: c.label }),
        h('span', { class: 'sk-pa-col-value', 'data-pa': 'col-' + c.collection, text: c.text }),
        h('span', { class: 'sk-pa-col-note', text: c.evidence }),
      ]));
    });

    var d = vm.data;
    var noteText = d && d.truncated ? 'The server returned only the first ' + d.pending.length + ' payouts; more are waiting than are shown. Filter by collection, or approve some and refresh.' : '';
    this.note.textContent = noteText;
    this.note.hidden = !noteText;

    this.tableWrap.textContent = '';
    this.tableWrap.hidden = vm.state !== 'observed';
    if (vm.state === 'observed') this.tableWrap.appendChild(this.table(d.pending));
    this.syncRefresh();
  };

  View.prototype.table = function (rows) {
    var self = this;
    var cols = ['Collection', 'Item', 'Status', 'Seller', 'Amount', 'Completed', 'Action'];
    return h('table', { class: 'sk-pa-table', 'data-pa': 'table' }, [
      h('caption', { class: 'sk-pa-sr', text: 'Seller payouts awaiting admin approval' }),
      h('thead', {}, [h('tr', {}, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
      h('tbody', {}, rows.map(function (r) { return self.row(r || {}); })),
    ]);
  };

  View.prototype.row = function (r) {
    var self = this;
    var col = str(r.collection), id = str(r.id);
    var msg = h('span', { class: 'sk-pa-msg', role: 'status', 'aria-live': 'polite', 'data-pa': 'row-msg' });
    var approveBtn = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-pa': 'approve',
      'aria-label': 'Approve payout for ' + (COL_LABEL[col] || col || 'item') + ' ' + (id || NEUTRAL), text: 'Approve' });
    var noteInput = h('textarea', { class: 'sk-pa-input sk-pa-note-input', 'data-pa': 'note', maxlength: String(NOTE_MAX), rows: '2' });
    var confirmBtn = h('button', { type: 'button', class: 'sk-pa-btn sk-pa-btn-primary', 'data-pa': 'confirm', text: 'Confirm approval' });
    var cancelBtn = h('button', { type: 'button', class: 'sk-pa-btn', 'data-pa': 'cancel', text: 'Cancel' });
    var confirmBox = h('div', { class: 'sk-pa-confirm', 'data-pa': 'confirm-box', role: 'group', 'aria-label': 'Confirm payout approval', hidden: true }, [
      h('p', { class: 'sk-pa-confirm-q', text: 'Approve this seller payout? The server marks it ready for payout.' }),
      h('label', { class: 'sk-pa-field sk-pa-field-note' }, [h('span', { text: 'Note (optional, up to ' + NOTE_MAX + ' characters)' }), noteInput]),
      h('div', { class: 'sk-pa-confirm-actions' }, [confirmBtn, cancelBtn]),
    ]);
    var actionCell = h('td', { 'data-label': 'Action', class: 'sk-pa-action' }, [approveBtn, confirmBox, msg]);
    var tr = h('tr', { 'data-pa-row': col + '/' + id, 'data-pa-result': 'pending' }, [
      h('td', { 'data-label': 'Collection', text: COL_LABEL[col] || col || NEUTRAL }),
      h('td', { 'data-label': 'Item', class: 'sk-pa-mono', text: id || NEUTRAL }),
      h('td', { 'data-label': 'Status', text: str(r.status) || NEUTRAL }),
      h('td', { 'data-label': 'Seller' }, [h('span', { class: 'sk-pa-mono', title: str(r.sellerUid) || null, text: shortUid(r.sellerUid) })]),
      h('td', { 'data-label': 'Amount', class: 'sk-pa-num', 'data-pa': 'amount', text: fmtKES(r.amountKES) }),
      h('td', { 'data-label': 'Completed' }, [h('time', { datetime: str(r.completedAt) || null, text: fmtTime(r.completedAt) })]),
      actionCell,
    ]);

    var busy = false;
    function openConfirm() {
      if (busy) return;
      msg.textContent = '';
      approveBtn.hidden = true;
      confirmBox.hidden = false;
      if (typeof noteInput.focus === 'function') noteInput.focus();
    }
    function closeConfirm() {
      if (busy) return;
      confirmBox.hidden = true;
      approveBtn.hidden = false;
      if (typeof approveBtn.focus === 'function') approveBtn.focus();
    }
    function submit() {
      if (busy) return;
      busy = true;
      self.inflight++;
      confirmBtn.disabled = true; cancelBtn.disabled = true; noteInput.disabled = true;
      tr.setAttribute('data-pa-result', 'in-flight');
      msg.textContent = 'Approving…';
      self.syncRefresh();
      var payload = { collection: col, id: id };
      var note = str(noteInput.value).trim().slice(0, NOTE_MAX);
      if (note) payload.note = note;
      Promise.resolve().then(function () { return self.call(APPROVE_FN, payload); }).then(
        function (res) {
          /* Success ONLY on the server's explicit ok:true. */
          if (res && res.ok === true) {
            var already = res.already === true;
            tr.setAttribute('data-pa-result', already ? 'already' : 'approved');
            confirmBox.hidden = true; approveBtn.hidden = true;
            msg.textContent = already ? 'Already approved' : 'Approved';
            return;
          }
          fail('The server did not confirm the approval');
        },
        function (e) { fail(approveErrorText(e || {})); }
      ).then(function () {
        busy = false;
        self.inflight--;
        self.syncRefresh();
      });
    }
    function fail(text) {
      tr.setAttribute('data-pa-result', 'error');
      confirmBtn.disabled = false; cancelBtn.disabled = false; noteInput.disabled = false;
      confirmBox.hidden = true; approveBtn.hidden = false;
      msg.textContent = text;
    }
    approveBtn.addEventListener('click', openConfirm);
    confirmBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', closeConfirm);
    confirmBox.addEventListener('keydown', function (ev) { if (ev && ev.key === 'Escape') closeConfirm(); });
    return tr;
  };

  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  window.SokoniAdminPayoutApprovals = {
    /* Idempotent: a second mount on the same host refreshes instead of rebuilding. */
    mount: function (host, opts) {
      if (!host) return null;
      var v = mounted && mounted.get(host);
      if (v) { v.refresh(); return v; }
      v = new View(host, opts);
      if (mounted) mounted.set(host, v);
      return v;
    },
    COLLECTIONS: COLLECTIONS,
    /* Pure functions, exported for scripts/test-admin-payout-approvals.js. */
    _test: { classifyError: classifyError, toViewModel: toViewModel, headline: headline, collectionEvidence: collectionEvidence, fmtKES: fmtKES, shortUid: shortUid, approveErrorText: approveErrorText },
  };
})();
