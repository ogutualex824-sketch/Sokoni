/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI POS — CASHIER SIDE OF THE APPROVAL LOOP
   ══════════════════════════════════════════════════════════════════════════════
   The cashier half of:

     cashier requests → manager reviews in the Sales Control Centre → cashier reads
     the server's decision

   APPROVAL IS NOT EXECUTION, AND THIS FILE MUST NEVER IMPLY OTHERWISE.
   A manager approving a refund or void has not carried it out; they have recorded a decision. Execution is a
   separate SERVER call that spends the approval (posVoidSale; posProcessRefund by a manager/owner) — 2026-10-03. So this module says
   "Approved by manager" and never "Refund completed" — the words are the contract.

   IT CREATES NOTHING NEW. One callable to raise a request, one to poll it:

     createApprovalRequest   binds the exact operation (server-side)
     checkApproval           reads the authoritative status

   `getPendingApprovals` is deliberately NOT used here: it requires the supervisor
   role, which a cashier does not have. Duplicate protection therefore works from the
   ids this session raised, re-checked against the server — see _pending below.

   NO BROWSER AUTHORISATION. Nothing here decides anything. The status shown is the
   status the server returned, every time.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Session-scoped, in memory only. NOT storage, NOT state, NOT authority — purely
     so a cashier who taps twice is routed to the request they already raised. It is
     lost on reload, and that is correct: the server remains the only record. */
  var _pending = {};        /* dedupeKey -> approvalId */
  var _sheet = null;
  var _poll = null;

  function _esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _money (n) {
    var v = Number(n || 0);
    return 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  async function _call (name, payload) {
    if (!root.firebaseApp) throw new Error('Firebase is not ready');
    var m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    var fns = m.getFunctions(root.firebaseApp);
    return (await m.httpsCallable(fns, name)(payload || {})).data;
  }

  /* The shop. Taken from the signed-in user, never from a caller argument — and the
     server re-derives it anyway inside createApprovalRequest. */
  function _sellerId (opts) {
    if (opts && opts.sellerId) return opts.sellerId;
    return (root.firebaseAuth && root.firebaseAuth.currentUser && root.firebaseAuth.currentUser.uid) || null;
  }

  var LABEL = {
    discount: 'Discount', price_override: 'Price override',
    refund: 'Refund', void: 'Void',
  };

  /* What the manager will see, rendered for the cashier too, so both sides are
     looking at the same operation rather than a category. */
  function _describe (type, binding) {
    var b = binding || {};
    var bits = [];
    if (b.amount != null)    bits.push(_money(b.amount));
    if (b.saleId)            bits.push('Sale ' + String(b.saleId).slice(-8));
    if (b.productId)         bits.push('Product ' + String(b.productId).slice(-8));
    return (LABEL[type] || type) + (bits.length ? ' · ' + bits.join(' · ') : '');
  }

  function _css () {
    if (document.getElementById('par-css')) return;
    var s = document.createElement('style');
    s.id = 'par-css';
    s.textContent =
      '.par-back{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;' +
        'align-items:flex-end;justify-content:center}' +
      '@media(min-width:640px){.par-back{align-items:center}}' +
      '.par-sheet{background:#14181d;color:#e9eef5;width:100%;max-width:460px;border-radius:18px 18px 0 0;' +
        'padding:20px 18px 24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'border:1px solid rgba(255,255,255,.09)}' +
      '@media(min-width:640px){.par-sheet{border-radius:18px}}' +
      '.par-h{font-size:11px;letter-spacing:1px;font-weight:800;color:#f5a524}' +
      '.par-t{font-size:20px;font-weight:800;margin:4px 0 14px}' +
      '.par-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 14px}' +
      '.par-kv dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700;' +
        'color:rgba(233,238,245,.45);align-self:center}' +
      '.par-kv dd{margin:0;font-weight:600}' +
      '.par-note{font-size:12.5px;color:rgba(233,238,245,.62);background:rgba(255,255,255,.04);' +
        'border-left:3px solid #f5a524;border-radius:0 9px 9px 0;padding:11px 13px;margin-bottom:14px}' +
      '.par-btn{width:100%;min-height:48px;border-radius:11px;font-weight:800;font-size:14px;cursor:pointer;' +
        'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#e9eef5;margin-top:8px}' +
      '.par-btn.primary{background:#71ff00;color:#0b0d10;border-color:#71ff00}' +
      '.par-status{font-size:15px;font-weight:800;padding:12px;border-radius:11px;text-align:center;margin-bottom:12px}' +
      '.par-status.pending{background:rgba(245,165,36,.14);color:#f5a524}' +
      '.par-status.approved{background:rgba(61,220,132,.14);color:#3ddc84}' +
      '.par-status.rejected{background:rgba(255,77,79,.14);color:#ff4d4f}' +
      '.par-status.expired{background:rgba(255,255,255,.07);color:rgba(233,238,245,.6)}';
    document.head.appendChild(s);
  }

  function _close () {
    if (_poll) { clearInterval(_poll); _poll = null; }
    try { _sheet && _sheet.remove(); } catch (_) {}
    _sheet = null;
  }

  function _open (html) {
    _css();
    if (!_sheet) {
      _sheet = document.createElement('div');
      _sheet.className = 'par-back';
      document.body.appendChild(_sheet);
      _sheet.addEventListener('click', function (e) {
        if (e.target === _sheet) return _close();
        var b = e.target.closest('[data-par]');
        if (b && b.dataset.par === 'close') return _close();
      });
    }
    _sheet.innerHTML = '<div class="par-sheet">' + html + '</div>';
  }

  /* THE WORDS ARE THE CONTRACT. "Approved" never becomes "applied", "refunded" or
     "voided", because nothing has executed. */
  var COPY = {
    pending:  ['pending',  'Waiting for a manager'],
    approved: ['approved', 'Approved by manager'],
    rejected: ['rejected', 'Request rejected'],
    expired:  ['expired',  'Request expired'],
  };

  function _statusHtml (type, binding, status, extra) {
    var c = COPY[status] || COPY.pending;
    return '<div class="par-h">MANAGER APPROVAL</div>' +
      '<div class="par-t">' + _esc(_describe(type, binding)) + '</div>' +
      '<div class="par-status ' + c[0] + '">' + _esc(c[1]) + '</div>' +
      (extra || '') +
      (status === 'approved'
        ? '<div class="par-note">The manager approved this request. It has <b>not</b> been ' +
          'carried out — approving records the decision, and the operation still runs through ' +
          'its own checks.</div>'
        : '') +
      (status === 'pending'
        ? '<div class="par-note">The manager sees this in Sales → Needs your attention. This ' +
          'screen shows whatever the server reports; nothing is assumed here.</div>'
        : '') +
      '<button class="par-btn" data-par="close">Close</button>';
  }

  function _detailsHtml (type, binding, reason) {
    var b = binding || {};
    var rows = '';
    if (b.amount != null) rows += '<dt>Amount</dt><dd>' + _money(b.amount) + '</dd>';
    if (b.saleId)         rows += '<dt>Sale</dt><dd>' + _esc(b.saleId) + '</dd>';
    if (b.productId)      rows += '<dt>Product</dt><dd>' + _esc(b.productId) + '</dd>';
    rows += '<dt>Reason</dt><dd>' + _esc(reason || '—') + '</dd>';
    return '<dl class="par-kv">' + rows + '</dl>';
  }

  /* Poll the AUTHORITATIVE status. Never infer from the click that raised it. */
  function _watch (approvalId, type, binding, reason) {
    if (_poll) clearInterval(_poll);
    var tick = async function () {
      var r;
      try { r = await _call('checkApproval', { approvalId: approvalId }); }
      catch (_) { return; }
      var st = (r && r.status) || 'pending';
      if (r && r.expired) st = 'expired';
      _open(_statusHtml(type, binding, st, _detailsHtml(type, binding, reason)));
      if (st !== 'pending') { clearInterval(_poll); _poll = null; }
    };
    _poll = setInterval(tick, 4000);
    tick();
  }

  /**
   * Raise a manager approval request for an EXACT operation.
   * Returns { ok, approvalId, duplicate } — and NEVER performs the operation.
   */
  async function request (type, binding, opts) {
    opts = opts || {};
    var reason = opts.reason || '';
    var key = type + '|' + JSON.stringify(binding || {});

    /* Duplicate protection, using only what a cashier is authorised to read: the id
       this session raised, re-checked against the server. */
    if (_pending[key]) {
      var prior = null;
      try { prior = await _call('checkApproval', { approvalId: _pending[key] }); } catch (_) {}
      if (prior && prior.status === 'pending' && !prior.expired) {
        _open(_statusHtml(type, binding, 'pending',
          '<div class="par-note">Approval already pending for this exact operation.</div>' +
          _detailsHtml(type, binding, reason)));
        _watch(_pending[key], type, binding, reason);
        return { ok: true, approvalId: _pending[key], duplicate: true };
      }
      delete _pending[key];
    }

    _open('<div class="par-h">MANAGER APPROVAL</div><div class="par-t">' +
      _esc(_describe(type, binding)) + '</div><div class="par-status pending">Requesting…</div>');

    var res;
    try {
      res = await _call('createApprovalRequest', {
        sellerId: _sellerId(opts),
        type: type,
        /* The server builds `binding` from these and refuses anything unbound. */
        requestData: Object.assign({}, binding, { reason: reason }),
        requestedByName: opts.requestedByName || null,
      });
    } catch (err) {
      _open('<div class="par-h">MANAGER APPROVAL</div>' +
        '<div class="par-t">' + _esc(_describe(type, binding)) + '</div>' +
        '<div class="par-status rejected">Request not created</div>' +
        '<div class="par-note">' + _esc((err && (err.message || err.code)) || 'unknown') + '</div>' +
        '<button class="par-btn" data-par="close">Close</button>');
      return { ok: false, error: (err && (err.message || err.code)) || 'unknown' };
    }

    var id = res && res.approvalId;
    if (!id) return { ok: false, error: 'no approvalId returned' };
    _pending[key] = id;
    _open(_statusHtml(type, binding, 'pending', _detailsHtml(type, binding, reason)));
    _watch(id, type, binding, reason);
    return { ok: true, approvalId: id, duplicate: false };
  }

  /* The approval id this session raised for an EXACT operation, so the till can spend it on the server
     (posVoidSale re-checks status, shop, type and binding — this is a lookup, never an authorisation). */
  function approvalIdFor (type, binding) {
    return _pending[type + '|' + JSON.stringify(binding || {})] || null;
  }

  var api = {
    request: request,
    approvalIdFor: approvalIdFor,
    close: _close,
    _internal: {
      describe: _describe, statusHtml: _statusHtml, detailsHtml: _detailsHtml,
      COPY: COPY, LABEL: LABEL,
      pending: function () { return _pending; },
      reset: function () { _pending = {}; },
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PosApprovalRequest = api;
}(typeof window !== 'undefined' ? window : this));
