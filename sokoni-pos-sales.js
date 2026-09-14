/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI POS — Sales · Employees · Shift
   ══════════════════════════════════════════════════════════════════════════════
   The operational trail a merchant actually needs:

     employee → time in → sell → sale attributed → time out → sales history

   THIS MODULE READS. It creates no employee store, no sales collection and no shift
   state machine. Everything comes from an authority that already exists:

     employees   listShopEmployees          (callable, owner-scoped)
     shift       openShift / getCurrentShift / closeShift   (callables, server clock)
     sales       posRetailSales             (Firestore, CF-written, read-only to clients)

   ATTRIBUTION IS DISPLAYED EXACTLY AS STRONG AS IT IS. Two fields on a sale carry very
   different weight, and this module must not flatten them:

     servedBy   resolved server-side from employment records. PROVEN.
                Absent → "Employee: Not recorded". Never inferred from the session,
                the current shift, the device or the timestamp. A sale whose seller we
                cannot prove is a sale we do not name.

     shiftId    taken from the request and only sanitized. RECORDED, NOT PROVEN.
                It is shown as "recorded" and never presented as server-verified,
                because a caller can attach a sale to another shift. Making it
                authoritative means deriving the open shift inside checkout, which is
                money-path work and is deliberately not done here.

   MY SALES IS NOT BUILT. The served rule authorises a cashier read with
   `resource.data.cashierUid == request.auth.uid`, and NO writer produces `cashierUid`.
   Building it would mean manufacturing that field, changing Rules, or filtering
   client-side and calling it authorisation. All three are wrong, so the tab reports
   itself blocked and explains why. A feature that silently shows nothing is worse than
   one that says it is unavailable.

   LAZY. pos.html installs a shim; this file arrives only when Sales is opened.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var _els = null, _tab = 'overview', _cache = { sales: null, employees: null, shift: null };

  function _esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }
  function _money (n) {
    var v = Number(n || 0);
    return 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function _time (ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }
  function _dur (a, b) {
    if (!a) return '—';
    var m = Math.max(0, Math.round(((b || Date.now()) - a) / 60000));
    return (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60) + 'm';
  }

  /* ── authorities ─────────────────────────────────────────────────────────── */

  async function _call (name, payload) {
    if (!root.firebaseApp) throw new Error('offline');
    var fn = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    return (await fn.httpsCallable(fn.getFunctions(root.firebaseApp), name)(payload || {})).data;
  }

  /* Equality-only query + in-memory sort, so no composite index is required — the same
     shape accountSubscriptions uses. `sellerId` is the read key the served rule checks. */
  async function _loadSales (uid) {
    if (!root.firebaseDB) return { ok: false, reason: 'offline' };
    try {
      var m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      var q = m.query(m.collection(root.firebaseDB, 'posRetailSales'),
                      m.where('sellerId', '==', uid), m.limit(200));
      var snap = await m.getDocs(q);
      var rows = [];
      snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
      rows.sort(function (a, b) { return (_ms(b) || 0) - (_ms(a) || 0); });
      return { ok: true, rows: rows };
    } catch (err) {
      /* permission-denied here is meaningful: it means this sale set is not readable by
         this identity, which is a real answer and not a bug to hide. */
      return { ok: false, reason: (err && err.code) || 'error' };
    }
  }

  function _ms (s) {
    if (!s) return 0;
    if (typeof s.saleDateMs === 'number') return s.saleDateMs;
    var t = s.createdAt || s.soldAt || s.timestamp;
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    return 0;
  }

  function _isToday (ms) {
    if (!ms) return false;
    var d = new Date(ms), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  /* THE ONE ATTRIBUTION RULE. Returns a name only when the server proved one. */
  function _seller (sale) {
    var sb = sale && sale.servedBy;
    if (sb && sb.name) return { proven: true, name: String(sb.name), role: sb.role || null };
    return { proven: false, name: 'Not recorded', role: null };
  }

  /* ── views ───────────────────────────────────────────────────────────────── */

  function _todayView (rows) {
    var t = rows.filter(function (s) { return _isToday(_ms(s)); });
    var live = t.filter(function (s) { return s.status !== 'voided'; });
    var total = 0, byMethod = {};
    live.forEach(function (s) {
      total += Number(s.grandTotal || 0);
      (s.payments || []).forEach(function (p) {
        var k = (p.method || 'other').toLowerCase();
        byMethod[k] = (byMethod[k] || 0) + Number(p.amount || s.grandTotal || 0);
      });
    });
    var voided = t.length - live.length;
    var refunded = t.filter(function (s) { return s.status === 'refunded'; }).length;

    return '<div class="pss-cards">' +
      _card('Sales today', String(live.length)) +
      _card('Total', _money(total)) +
      _card('Refunded', String(refunded)) +
      _card('Voided', String(voided)) +
      '</div>' +
      '<div class="pss-sub">By payment method</div>' +
      (Object.keys(byMethod).length
        ? '<div class="pss-cards">' + Object.keys(byMethod).map(function (k) {
            return _card(k.toUpperCase(), _money(byMethod[k]));
          }).join('') + '</div>'
        : '<div class="pss-empty">No payments recorded today.</div>');
  }

  function _byEmployeeView (rows) {
    var g = {}, unattributed = 0;
    rows.forEach(function (s) {
      if (s.status === 'voided') return;
      var who = _seller(s);
      if (!who.proven) { unattributed++; return; }
      var k = who.name;
      g[k] = g[k] || { n: 0, total: 0, role: who.role };
      g[k].n++; g[k].total += Number(s.grandTotal || 0);
    });
    var names = Object.keys(g).sort(function (a, b) { return g[b].total - g[a].total; });
    if (!names.length && !unattributed) return '<div class="pss-empty">No sales yet.</div>';

    return '<table class="pss-tbl"><thead><tr><th>Employee</th><th>Role</th>' +
      '<th style="text-align:right">Sales</th><th style="text-align:right">Total</th></tr></thead><tbody>' +
      names.map(function (n) {
        return '<tr><td>' + _esc(n) + '</td><td>' + _esc(g[n].role || '—') + '</td>' +
          '<td style="text-align:right">' + g[n].n + '</td>' +
          '<td style="text-align:right">' + _money(g[n].total) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (unattributed
        ? '<div class="pss-note">' + unattributed + ' sale' + (unattributed === 1 ? '' : 's') +
          ' could not be attributed to an employee and are excluded from these totals. ' +
          'They are shown individually as <b>Not recorded</b> rather than assigned to anyone.</div>'
        : '');
  }

  function _txnView (rows) {
    if (!rows.length) return '<div class="pss-empty">No transactions.</div>';
    return '<table class="pss-tbl"><thead><tr><th>Time</th><th>Employee</th><th>Items</th>' +
      '<th style="text-align:right">Total</th><th>Method</th><th>Status</th></tr></thead><tbody>' +
      rows.slice(0, 100).map(function (s) {
        var who = _seller(s);
        var pm = ((s.payments || [])[0] || {}).method || '—';
        var n = (s.items || []).length;
        return '<tr data-sale="' + _esc(s.id) + '">' +
          '<td>' + _time(_ms(s)) + '</td>' +
          '<td' + (who.proven ? '' : ' class="pss-unattr"') + '>' + _esc(who.name) + '</td>' +
          '<td>' + n + '</td>' +
          '<td style="text-align:right">' + _money(s.grandTotal) + '</td>' +
          '<td>' + _esc(pm) + '</td>' +
          '<td>' + _esc(s.status || 'completed') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function _myView () {
    /* Deliberately not implemented. See the header. */
    return '<div class="pss-blocked"><b>My Sales is not available yet.</b>' +
      '<div>A cashier read is authorised on <code>cashierUid</code>, and no writer produces ' +
      'that field. Showing your sales would mean inventing the field, changing the security ' +
      'rules, or filtering in the browser and calling that authorisation — so it is left ' +
      'switched off until that decision is made.</div></div>';
  }

  function _employeesView (emps, shift) {
    if (!emps || !emps.length) return '<div class="pss-empty">No employees found for this shop.</div>';
    return '<table class="pss-tbl"><thead><tr><th>Employee</th><th>Role</th><th>Status</th>' +
      '<th>Shift</th></tr></thead><tbody>' +
      emps.map(function (e) {
        var on = shift && shift.cashierUid === e.uid;
        return '<tr><td>' + _esc(e.name || e.email || e.uid) + '</td>' +
          '<td>' + _esc(e.role || '—') + '</td>' +
          '<td>' + _esc(e.status || 'active') + '</td>' +
          '<td>' + (on ? 'ON SHIFT since ' + _time(shift.openedAtMs) : 'Off shift') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function _shiftView (shift, rows) {
    if (!shift) {
      return '<div class="pss-empty">No open shift.</div>' +
        '<button class="pss-btn primary" data-pss="start">TIME IN — Start shift</button>';
    }
    var mine = rows.filter(function (s) { return s.shiftId && s.shiftId === shift.shiftId; });
    var total = mine.reduce(function (n, s) { return n + (s.status === 'voided' ? 0 : Number(s.grandTotal || 0)); }, 0);
    return '<div class="pss-shift">' +
      '<div class="pss-shift-h">ON SHIFT</div>' +
      '<div class="pss-shift-n">' + _esc(shift.cashierName || shift.cashierUid || '') + '</div>' +
      '<dl class="pss-kv">' +
        '<dt>Started</dt><dd>' + _time(shift.openedAtMs) + '</dd>' +
        '<dt>Duration</dt><dd>' + _dur(shift.openedAtMs) + '</dd>' +
        '<dt>Opening float</dt><dd>' + _money(shift.openingCash) + '</dd>' +
        '<dt>Sales (this shift)</dt><dd>' + mine.length + '</dd>' +
        '<dt>Sales total</dt><dd>' + _money(total) + '</dd>' +
      '</dl>' +
      '<div class="pss-note">Shift figures come from sales carrying this shift id. That id is ' +
      '<b>recorded by the till, not verified by the server</b>, so treat it as an operational ' +
      'figure rather than a reconciliation. Cash, refunds, expenses and variance are not ' +
      'calculated here.</div>' +
      '<button class="pss-btn" data-pss="end">TIME OUT — End shift</button>' +
      '</div>';
  }

  function _card (label, value) {
    return '<div class="pss-card"><div class="pss-card-l">' + _esc(label) + '</div>' +
           '<div class="pss-card-v">' + _esc(value) + '</div></div>';
  }


  /* ══════════════════════════════════════════════════════════════════════════
     CONTROL CENTRE
     ══════════════════════════════════════════════════════════════════════════
     Everything below is a READ of an authority that already exists, plus the two
     approval decisions the server already exposes (reviewApproval). It adds no
     store, no second shift arithmetic and no client-side authorisation.

     WHAT THE SERVER CANNOT TELL US, AND WHICH THIS THEREFORE DOES NOT SHOW:
     `getCurrentShift` is CALLER-SCOPED — it returns the shift of whoever asks. There
     is no readable "all active shifts for this shop", so a manager cannot be shown a
     count of who is on shift. That figure renders "Not available" rather than being
     approximated from employees, sales timestamps or the caller's own shift. */

  var _approvals = null;        /* {ok, list} | {ok:false, reason} */
  var _detail = null;           /* {kind:'sale'|'approval', id} */
  var _filters = { emp: '', status: '', pay: '', q: '' };

  async function _loadApprovals (uid) {
    try {
      var r = await _call('getPendingApprovals', { sellerId: uid });
      return { ok: true, list: (r && r.approvals) || [] };
    } catch (err) {
      return { ok: false, reason: (err && (err.code || err.message)) || 'unknown' };
    }
  }

  /* An approval states the operation it authorises in `binding`. The manager must see
     THAT, never a vague "discount requested" — the primitive binds it precisely, so
     the screen has no excuse for being vaguer than the record. */
  function _bindingRows (a) {
    var b = (a && a.binding) || null;
    if (!b || !Object.keys(b).length) {
      return '<dt>Operation</dt><dd class="pss-unattr">No bound detail recorded</dd>';
    }
    var LABEL = { amount: 'Amount', saleId: 'Sale', productId: 'Product' };
    return Object.keys(b).map(function (k) {
      var v = (k === 'amount') ? _money(b[k]) : _esc(String(b[k]));
      return '<dt>' + _esc(LABEL[k] || k) + '</dt><dd>' + v + '</dd>';
    }).join('');
  }

  function _attention () {
    var ap = (_approvals && _approvals.ok) ? _approvals.list.length : 0;
    var rows = (_cache.sales && _cache.sales.ok) ? _cache.sales.rows : [];
    var today = rows.filter(function (s) { return _isToday(_ms(s)); });
    var rv = today.filter(function (s) { return s.status === 'refunded' || s.status === 'voided'; }).length;
    return { approvals: ap, reversals: rv, total: ap + rv };
  }

  function _overviewView () {
    var readable = _cache.sales && _cache.sales.ok;
    var rows = readable ? _cache.sales.rows : [];
    var today = rows.filter(function (s) { return _isToday(_ms(s)); });
    var live = today.filter(function (s) { return s.status !== 'voided'; });
    var total = 0, cash = 0, other = 0, refunded = 0;
    live.forEach(function (s) {
      total += Number(s.grandTotal || 0);
      (s.payments || []).forEach(function (p) {
        var amt = Number(p.amount || 0);
        if (String(p.method || '').toLowerCase() === 'cash') cash += amt; else other += amt;
      });
    });
    today.forEach(function (s) { if (s.status === 'refunded') refunded += Number(s.grandTotal || 0); });
    var voids = today.length - live.length;
    var att = _attention();

    var cards =
      _card("Today's sales", readable ? _money(total) : 'Not available') +
      _card('Transactions', readable ? String(live.length) : 'Not available') +
      _card('Cash', readable ? _money(cash) : 'Not available') +
      _card('Card / digital', readable ? _money(other) : 'Not available') +
      _card('Refunded', readable ? _money(refunded) : 'Not available') +
      _card('Voids', readable ? String(voids) : 'Not available') +
      _card('Pending approvals', _approvals ? (_approvals.ok ? String(att.approvals) : 'Not available') : '…') +
      /* Deliberately NOT a shop-wide count — see the header note. */
      _card('Active shifts', 'Not available');

    var attentionHtml;
    if (att.total === 0) {
      attentionHtml = '<div class="pss-empty">Nothing is waiting on you.</div>';
    } else {
      var bits = [];
      if (att.approvals) {
        bits.push('<button class="pss-att-row" data-pss="tab" data-to="approvals">' +
          '<span class="pss-dot red"></span><b>' + att.approvals + ' approval request' +
          (att.approvals === 1 ? '' : 's') + '</b><span class="pss-go">Review</span></button>');
      }
      if (att.reversals) {
        bits.push('<button class="pss-att-row" data-pss="tab" data-to="activity">' +
          '<span class="pss-dot amber"></span><b>' + att.reversals + ' refund/void event' +
          (att.reversals === 1 ? '' : 's') + ' today</b><span class="pss-go">View</span></button>');
      }
      attentionHtml = bits.join('');
    }

    return '<div class="pss-cards">' + cards + '</div>' +
      '<div class="pss-sub">Needs your attention</div>' + attentionHtml +
      (_approvals && !_approvals.ok
        ? '<div class="pss-blocked"><b>Approval requests could not be read.</b><div>' +
          (_approvals.reason === 'permission-denied'
            ? 'This account is not authorised to review approvals for this shop.'
            : 'Reason: ' + _esc(_approvals.reason)) + '</div></div>'
        : '') +
      '<div class="pss-sub">Recent sales</div>' + _txnView(today.slice(0, 8));
  }

  function _approvalsView () {
    if (!_approvals) return '<div class="pss-empty">Loading…</div>';
    if (!_approvals.ok) {
      return '<div class="pss-blocked"><b>Approval requests could not be read.</b><div>' +
        (_approvals.reason === 'permission-denied'
          ? 'This account is not authorised to review approvals for this shop.'
          : 'Reason: ' + _esc(_approvals.reason)) + '</div></div>';
    }
    if (!_approvals.list.length) return '<div class="pss-empty">No pending approval requests.</div>';
    return _notEnforcedNote() +
      _approvals.list.map(function (a) {
        var b = (a.binding || {});
        var summary = [a.type, b.amount != null ? _money(b.amount) : null, b.saleId || b.productId || null]
          .filter(Boolean).map(_esc).join(' · ');
        return '<button class="pss-att-row" data-pss="approval" data-id="' + _esc(a.id) + '">' +
          '<span class="pss-dot red"></span>' +
          '<b>' + _esc(summary || a.type) + '</b>' +
          '<span class="pss-go">' + _esc(a.requestedByName || a.requestedBy || '') + '</span></button>';
      }).join('');
  }

  /* The one thing this screen must never imply. */
  function _notEnforcedNote () {
    return '<div class="pss-blocked"><b>Approving here records a decision. It does not yet ' +
      'gate the operation.</b><div>No protected operation consumes an approval on the server ' +
      'yet, so a refund, void or discount is still controlled by the till PIN and the ' +
      'operation’s own permission check — not by this decision.</div></div>';
  }

  function _approvalDetailView (id) {
    var a = (_approvals && _approvals.ok)
      ? _approvals.list.filter(function (x) { return x.id === id; })[0] : null;
    if (!a) return '<div class="pss-empty">That request is no longer pending.</div>' +
      '<button class="pss-btn" data-pss="back">Back</button>';
    return '<button class="pss-back" data-pss="back">← All requests</button>' +
      '<div class="pss-shift">' +
        '<div class="pss-shift-h">APPROVAL REQUEST</div>' +
        '<div class="pss-shift-n">' + _esc(String(a.type || '').replace(/_/g, ' ')) + '</div>' +
        '<dl class="pss-kv">' +
          '<dt>Requested by</dt><dd>' + _esc(a.requestedByName || a.requestedBy || 'Unknown') + '</dd>' +
          _bindingRows(a) +
          '<dt>Reason</dt><dd>' + _esc((a.requestData && a.requestData.reason) || '—') + '</dd>' +
          '<dt>Requested</dt><dd>' + _time(_toMs(a.createdAt)) + '</dd>' +
          '<dt>Status</dt><dd>' + _esc(a.status || 'pending') + '</dd>' +
        '</dl>' +
        _notEnforcedNote() +
        '<button class="pss-btn primary" data-pss="approve" data-id="' + _esc(a.id) + '">Approve</button>' +
        '<button class="pss-btn" data-pss="reject" data-id="' + _esc(a.id) + '">Reject</button>' +
      '</div>';
  }

  function _toMs (v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v._seconds) return v._seconds * 1000;
    if (v.seconds) return v.seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }

  /* ── activity ────────────────────────────────────────────────────────────
     Composed ONLY from records that exist: sales, their reversal status, the
     caller's shift, and pending approvals. Nothing is synthesised. */
  function _activityView () {
    var rows = (_cache.sales && _cache.sales.ok) ? _cache.sales.rows : [];
    var ev = [];
    rows.filter(function (s) { return _isToday(_ms(s)); }).forEach(function (s) {
      var who = _seller(s);
      var label = who.proven ? who.name : 'Not recorded';
      if (s.status === 'voided')        ev.push([_ms(s), label + ' — sale voided', _money(s.grandTotal)]);
      else if (s.status === 'refunded') ev.push([_ms(s), label + ' — sale refunded', _money(s.grandTotal)]);
      else                              ev.push([_ms(s), label + ' — sale completed', _money(s.grandTotal)]);
    });
    if (_cache.shift && _cache.shift.openedAtMs) {
      ev.push([_cache.shift.openedAtMs,
        _esc(_cache.shift.cashierName || 'Cashier') + ' — opened shift', '']);
    }
    if (_approvals && _approvals.ok) {
      _approvals.list.forEach(function (a) {
        var b = a.binding || {};
        ev.push([_toMs(a.createdAt),
          _esc(a.requestedByName || a.requestedBy || 'Someone') + ' — requested ' +
          _esc(String(a.type || '').replace(/_/g, ' ')),
          b.amount != null ? _money(b.amount) : '']);
      });
    }
    if (!ev.length) return '<div class="pss-empty">No activity recorded today.</div>';
    ev.sort(function (a, b) { return b[0] - a[0]; });
    return '<table class="pss-tbl"><tbody>' + ev.map(function (e) {
      return '<tr><td style="width:64px;color:rgba(233,238,245,.5)">' + _time(e[0]) + '</td>' +
             '<td>' + e[1] + '</td><td style="text-align:right">' + e[2] + '</td></tr>';
    }).join('') + '</tbody></table>' +
    '<div class="pss-note">Built from sales, the shift you can read, and pending requests. ' +
    'Refund and void times are the sale’s own timestamp, not a separate event log.</div>';
  }

  /* ── sale detail ─────────────────────────────────────────────────────────── */
  function _saleDetailView (id) {
    var rows = (_cache.sales && _cache.sales.ok) ? _cache.sales.rows : [];
    var s = rows.filter(function (x) { return x.id === id; })[0];
    if (!s) return '<div class="pss-empty">Sale not found.</div>' +
      '<button class="pss-btn" data-pss="back">Back</button>';
    var who = _seller(s);
    var items = (s.items || []).map(function (i) {
      return '<tr><td>' + _esc(String(i.qty || 1)) + ' × ' + _esc(i.name || 'Item') + '</td>' +
             '<td style="text-align:right">' + _money(i.lineTotal != null ? i.lineTotal : i.price) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="pss-unattr">No line items recorded</td></tr>';
    var pays = (s.payments || []).map(function (p) {
      return '<tr><td>' + _esc(p.method || 'other') + '</td>' +
             '<td style="text-align:right">' + _money(p.amount) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="pss-unattr">No payment recorded</td></tr>';

    return '<button class="pss-back" data-pss="back">← Transactions</button>' +
      '<div class="pss-shift">' +
        '<div class="pss-shift-h">SALE</div>' +
        '<div class="pss-shift-n">' + _money(s.grandTotal) + '</div>' +
        '<dl class="pss-kv">' +
          '<dt>Status</dt><dd>' + _esc(s.status || 'completed') + '</dd>' +
          '<dt>Time</dt><dd>' + _time(_ms(s)) + '</dd>' +
          '<dt>Sold by</dt><dd' + (who.proven ? '' : ' class="pss-unattr"') + '>' +
            _esc(who.name) + '</dd>' +
          '<dt>Shift</dt><dd>' + (s.shiftId
            ? _esc(String(s.shiftId).slice(-8))
            : '<span class="pss-unattr">Not recorded</span>') + '</dd>' +
        '</dl>' +
        '<div class="pss-sub">Items</div><table class="pss-tbl"><tbody>' + items + '</tbody></table>' +
        '<div class="pss-sub">Payment</div><table class="pss-tbl"><tbody>' + pays + '</tbody></table>' +
        (who.proven ? '' : '<div class="pss-note">This sale carries no server-resolved seller, so ' +
          'no employee is named. It is excluded from employee totals rather than guessed.</div>') +
      '</div>';
  }

  /* ── filters — PRESENTATION ONLY ─────────────────────────────────────────
     These narrow what is already on screen. The security boundary is the served
     rule plus the sellerId query; nothing here is an authorisation check, and a
     filter must never be the reason a row is unreachable to someone. */
  function _filterBar (rows) {
    var names = {}, methods = {};
    rows.forEach(function (s) {
      var w = _seller(s); if (w.proven) names[w.name] = 1;
      (s.payments || []).forEach(function (p) { methods[String(p.method || 'other').toLowerCase()] = 1; });
    });
    var opt = function (list, cur) {
      return list.map(function (v) {
        return '<option value="' + _esc(v[0]) + '"' + (cur === v[0] ? ' selected' : '') + '>' +
          _esc(v[1]) + '</option>';
      }).join('');
    };
    return '<div class="pss-filters">' +
      '<select data-f="emp"><option value="">All employees</option>' +
        opt(Object.keys(names).sort().map(function (n) { return [n, n]; }), _filters.emp) + '</select>' +
      '<select data-f="status"><option value="">All status</option>' +
        opt([['completed', 'Completed'], ['refunded', 'Refunded'], ['voided', 'Voided']], _filters.status) +
      '</select>' +
      '<select data-f="pay"><option value="">All payments</option>' +
        opt(Object.keys(methods).sort().map(function (m) { return [m, m]; }), _filters.pay) + '</select>' +
      '<input data-f="q" placeholder="Search sale or product" value="' + _esc(_filters.q) + '">' +
      '</div>';
  }

  function _applyFilters (rows) {
    var q = _filters.q.trim().toLowerCase();
    return rows.filter(function (s) {
      if (_filters.emp) { var w = _seller(s); if (!w.proven || w.name !== _filters.emp) return false; }
      if (_filters.status && (s.status || 'completed') !== _filters.status) return false;
      if (_filters.pay && !(s.payments || []).some(function (p) {
        return String(p.method || 'other').toLowerCase() === _filters.pay; })) return false;
      if (q) {
        var hay = (String(s.id || '') + ' ' + (s.items || []).map(function (i) {
          return i.name || ''; }).join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* ── shell ───────────────────────────────────────────────────────────────── */

  function _css () {
    if (document.getElementById('pss-css')) return;
    var s = document.createElement('style');
    s.id = 'pss-css';
    s.textContent =
      '.pss-wrap{position:fixed;inset:0;z-index:99990;background:#0b0d10;color:#e9eef5;display:flex;' +
        'flex-direction:column;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '.pss-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;' +
        'border-bottom:1px solid rgba(255,255,255,.09)}' +
      '.pss-x{background:none;border:0;color:#e9eef5;font-size:24px;cursor:pointer}' +
      '.pss-tabs{display:flex;gap:6px;padding:10px 14px;overflow-x:auto;border-bottom:1px solid rgba(255,255,255,.09)}' +
      '.pss-tab{white-space:nowrap;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);' +
        'color:#e9eef5;border-radius:999px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer}' +
      '.pss-tab.on{background:#71ff00;color:#0b0d10;border-color:#71ff00}' +
      '.pss-body{flex:1;overflow:auto;padding:14px}' +
      '.pss-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}' +
      '.pss-card{background:#14181d;border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px}' +
      '.pss-card-l{font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;color:rgba(233,238,245,.5);font-weight:700}' +
      '.pss-card-v{font-size:19px;font-weight:800;margin-top:4px}' +
      '.pss-sub{margin:18px 0 8px;font-size:11px;letter-spacing:.8px;text-transform:uppercase;' +
        'color:rgba(233,238,245,.45);font-weight:700}' +
      '.pss-tbl{width:100%;border-collapse:collapse;font-size:13px}' +
      '.pss-tbl th{text-align:left;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;' +
        'color:rgba(233,238,245,.45);padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.09)}' +
      '.pss-tbl td{padding:9px 6px;border-bottom:1px solid rgba(255,255,255,.05)}' +
      '.pss-unattr{color:rgba(233,238,245,.42);font-style:italic}' +
      '.pss-empty,.pss-note,.pss-blocked{font-size:12.5px;color:rgba(233,238,245,.6);' +
        'background:rgba(255,255,255,.03);border-left:3px solid rgba(255,255,255,.2);' +
        'border-radius:0 9px 9px 0;padding:11px 13px;margin-top:12px}' +
      '.pss-blocked{border-left-color:#f5a524;color:#f7d9a4}' +
      '.pss-shift{background:#14181d;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:16px}' +
      '.pss-shift-h{font-size:11px;letter-spacing:1px;color:#3ddc84;font-weight:800}' +
      '.pss-shift-n{font-size:20px;font-weight:800;margin:2px 0 10px}' +
      '.pss-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}' +
      '.pss-kv dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:rgba(233,238,245,.45);font-weight:700;align-self:center}' +
      '.pss-kv dd{margin:0}' +
      '.pss-btn{width:100%;margin-top:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);' +
        'color:#e9eef5;border-radius:10px;padding:12px;font-weight:800;cursor:pointer}' +
      '.pss-btn.primary{background:#71ff00;color:#0b0d10;border-color:#71ff00}' +
        '.pss-att-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;margin-bottom:8px;' +
          'background:#14181d;border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:13px 14px;' +
          'color:#e9eef5;font:inherit;cursor:pointer;min-height:48px}' +
        '.pss-att-row b{flex:1;font-size:13.5px}' +
        '.pss-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}' +
        '.pss-dot.red{background:#ff4d4f}.pss-dot.amber{background:#f5a524}' +
        '.pss-go{font-size:11.5px;color:rgba(233,238,245,.55);font-weight:700}' +
        '.pss-back{background:none;border:0;color:#71ff00;font-weight:800;font-size:13px;cursor:pointer;padding:0 0 12px}' +
        '.pss-hdr-badge{background:#ff4d4f;color:#fff;border-radius:999px;font-size:11px;font-weight:800;padding:2px 8px;margin-left:8px}' +
        '.pss-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px}' +
        '.pss-filters select,.pss-filters input{background:#14181d;border:1px solid rgba(255,255,255,.12);' +
          'color:#e9eef5;border-radius:9px;padding:10px;font:inherit;min-height:44px}' +
        '@media(max-width:640px){.pss-tbl th:nth-child(3),.pss-tbl td:nth-child(3){display:none}.pss-card-v{font-size:17px}}';
    document.head.appendChild(s);
  }

  var TABS = [['overview', 'Overview'], ['txn', 'Transactions'], ['employee', 'By Employee'],
                ['staff', 'Employees'], ['shift', 'Shifts'], ['approvals', 'Approvals'],
                ['activity', 'Activity'], ['mine', 'My Sales']];

  function _render () {
    if (!_els) return;
    var rows = (_cache.sales && _cache.sales.ok) ? _cache.sales.rows : [];
    var html;
    var NEEDS_SALES = { today: 1, employee: 1, txn: 1 };
    if (_detail && _detail.kind === 'sale') {
      html = _saleDetailView(_detail.id);
    } else if (_detail && _detail.kind === 'approval') {
      html = _approvalDetailView(_detail.id);
    } else if (_cache.sales && !_cache.sales.ok && NEEDS_SALES[_tab]) {
      html = '<div class="pss-blocked"><b>Sales could not be read.</b><div>' +
        (_cache.sales.reason === 'permission-denied'
          ? 'This account is not authorised to read this shop\'s sales.'
          : 'Reason: ' + _esc(_cache.sales.reason)) +
        '</div></div>';
    } else if (_tab === 'overview')  html = _overviewView();
    else if (_tab === 'today')       html = _todayView(rows);
    else if (_tab === 'approvals')   html = _approvalsView();
    else if (_tab === 'activity')    html = _activityView();
    else if (_tab === 'employee')   html = _byEmployeeView(rows);
    else if (_tab === 'txn')        html = _filterBar(rows) + _txnView(_applyFilters(rows));
    else if (_tab === 'mine')       html = _myView();
    else if (_tab === 'staff')      html = _employeesView(_cache.employees, _cache.shift);
    else                            html = _shiftView(_cache.shift, rows);

    _els.body.innerHTML = html;
    var badge = _els.wrap.querySelector('.pss-hdr-badge');
    if (badge) {
      var nAtt = _attention().total;
      badge.textContent = nAtt ? String(nAtt) : '';
      badge.hidden = !nAtt;
    }
    Array.prototype.forEach.call(_els.wrap.querySelectorAll('.pss-tab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === _tab);
    });
  }

  async function _refresh (uid) {
    _cache.sales = await _loadSales(uid);
    _approvals = await _loadApprovals(uid);
    try { _cache.employees = (await _call('listShopEmployees')).employees || []; } catch (_) { _cache.employees = null; }
    try {
      var cur = await _call('getCurrentShift', { sellerId: uid });
      _cache.shift = (cur && cur.shift) ? cur.shift : (cur && cur.shiftId ? cur : null);
    } catch (_) { _cache.shift = null; }
    _render();
  }

  async function open (opts) {
    opts = opts || {};
    var uid = opts.uid || (root.firebaseAuth && root.firebaseAuth.currentUser && root.firebaseAuth.currentUser.uid);
    _css();
    var w = document.createElement('div');
    w.className = 'pss-wrap';
    w.innerHTML =
      '<div class="pss-top"><b>Sales Control Centre</b><span class="pss-hdr-badge" hidden></span><button class="pss-x" data-pss="close">×</button></div>' +
      '<div class="pss-tabs">' + TABS.map(function (t) {
        return '<button class="pss-tab" data-tab="' + t[0] + '">' + _esc(t[1]) + '</button>';
      }).join('') + '</div>' +
      '<div class="pss-body">Loading…</div>';
    document.body.appendChild(w);
    _els = { wrap: w, body: w.querySelector('.pss-body') };

    w.addEventListener('click', function (e) {
      var t = e.target.closest('.pss-tab');
      if (t) { _tab = t.dataset.tab; _detail = null; return _render(); }
      var b = e.target.closest('[data-pss]');
      if (!b) {
        /* A transaction row opens its own detail. The rows already carried data-sale;
           nothing listened for it, so the detail view was unreachable by tap. */
        var row = e.target.closest('[data-sale]');
        if (row) { _detail = { kind: 'sale', id: row.dataset.sale }; return _render(); }
        return;
      }
      if (b.dataset.pss === 'close') return close();
      if (b.dataset.pss === 'start') return _startShift(uid);
      if (b.dataset.pss === 'end')   return _endShift(uid);
      if (b.dataset.pss === 'back')  { _detail = null; return _render(); }
      if (b.dataset.pss === 'tab')   { _tab = b.dataset.to; _detail = null; return _render(); }
      if (b.dataset.pss === 'approval') { _detail = { kind: 'approval', id: b.dataset.id }; return _render(); }
      if (b.dataset.pss === 'approve')  return _decide(uid, b.dataset.id, 'approved');
      if (b.dataset.pss === 'reject')   return _decide(uid, b.dataset.id, 'rejected');
    });

    /* Filters are PRESENTATION. They never change what was fetched, only what is
       shown of it — the sellerId query and the served rule are the boundary. */
    w.addEventListener('change', function (e) {
      var f = e.target.closest('[data-f]');
      if (!f) return;
      _filters[f.dataset.f] = f.value;
      _render();
    });

    await _refresh(uid);
    return true;
  }

  /* A decision is RE-READ from the server afterwards, never assumed. Painting an
     'approved' state locally would be the client asserting an authorisation outcome. */
  async function _decide (uid, id, decision) {
    try {
      await _call('reviewApproval', { approvalId: id, decision: decision });
      _detail = null;
      _approvals = await _loadApprovals(uid);
      _render();
    } catch (err) {
      _els.body.innerHTML = '<div class="pss-blocked"><b>That decision was not recorded.</b><div>' +
        _esc((err && (err.message || err.code)) || 'unknown') + '</div></div>' +
        '<button class="pss-btn" data-pss="back">Back</button>';
    }
  }

  /* Time in / time out go through the EXISTING server operations. The server clock and the
     server's duplicate/ownership checks are the authority; this module adds neither. */
  async function _startShift (uid) {
    try {
      await _call('openShift', { sellerId: uid, openingCash: 0 });
      await _refresh(uid);
    } catch (err) {
      _els.body.innerHTML = '<div class="pss-blocked"><b>Could not start the shift.</b><div>' +
        _esc((err && err.message) || 'unknown') + '</div></div>';
    }
  }
  async function _endShift (uid) {
    try {
      await _call('closeShift', { sellerId: uid, closingCash: 0 });
      await _refresh(uid);
    } catch (err) {
      _els.body.innerHTML = '<div class="pss-blocked"><b>Could not end the shift.</b><div>' +
        _esc((err && err.message) || 'unknown') + '</div></div>';
    }
  }

  function close () {
    try { _els && _els.wrap && _els.wrap.remove(); } catch (_) {}
    _els = null;
  }

  var api = { open: open, close: close, _internal: { seller: _seller, todayView: _todayView,
              byEmployeeView: _byEmployeeView, txnView: _txnView, myView: _myView, ms: _ms,
              overviewView: _overviewView, approvalsView: _approvalsView,
              approvalDetailView: _approvalDetailView, activityView: _activityView,
              saleDetailView: _saleDetailView, bindingRows: _bindingRows,
              attention: _attention, applyFilters: _applyFilters, filterBar: _filterBar,
              notEnforcedNote: _notEnforcedNote,
              _set: function (k, v) { if (k === 'approvals') _approvals = v;
                else if (k === 'sales') _cache.sales = v;
                else if (k === 'shift') _cache.shift = v;
                else if (k === 'filters') _filters = v; } } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PosSalesView = api;
}(typeof window !== 'undefined' ? window : this));
