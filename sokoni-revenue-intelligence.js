/* ============================================================================
   SOKONI Revenue Intelligence — sokoni-revenue-intelligence.js   v1.0.0
   ============================================================================
   Money analytics for both platform-admin consoles:

     admin-os.html    → panel "revenue"  (claims.admin)
     super-admin.html → panel "revenue"  (claims.superAdmin)

   admin.html is not a consumer, matching the Integrations and Reports rulings.

   ─────────────────────────────────────────────────────────────────────────
   READ THIS BEFORE CHANGING A SINGLE FIGURE ON THIS SURFACE
   ─────────────────────────────────────────────────────────────────────────

   1. THE STATUS VOCABULARY IS UPPERCASE, AND `succeeded` DOES NOT EXIST
   ---------------------------------------------------------------------
   Production `payments` documents carry exactly four status values:

        PENDING · COMPLETE · FAILED · CANCELLED

   `succeeded`, `completed`, `paid`, `processing` and `refunded` have NEVER been
   written by any production writer. A filter spelled `'succeeded'`, or one that
   forgets `.toUpperCase()`, matches nothing and renders a confident **zero
   revenue** — a total fabrication that looks exactly like a real answer.

   This module therefore uppercases before comparing, exactly as the canonical
   server aggregate `adminGetFinance` does, and certification plants the
   lowercase spelling as a sabotage mutation to prove the guard is live.

   2. THIS IS NOT MARKETPLACE SALES REVENUE, AND IT MUST NOT BE LABELLED AS SUCH
   -----------------------------------------------------------------------------
   Every production payment document is a **wallet top-up / STK push**, keyed by
   `uid` + `checkoutId`. It is payment-rail throughput, not order revenue and not
   GMV. Calling the sum of it "Total Revenue" would misstate the business.

   So every figure here is named for what it actually measures — "Rail volume",
   "Gateway fees", "Completed payments" — and the surface says so in the open.
   Product GMV and commission live behind `adminGetFinance`; where this module
   cannot reach them it shows an em dash and names what is missing.

   3. A DORMANT COLLECTION LOOKS EXACTLY LIKE ZERO REVENUE
   -------------------------------------------------------
   The collection can go quiet for long stretches. A range with no documents in
   it renders as "no payments recorded in this range" ALONGSIDE the date of the
   most recent payment anywhere in the collection, so an operator can tell
   "nothing happened" from "nothing happened *recently*" from "I am looking at
   the wrong window". A bare 0 conveys none of those.

   4. THE ARITHMETIC MIRRORS THE SERVER; IT DOES NOT INVENT
   ---------------------------------------------------------
   Amount, fee and completion are computed with the SAME rules as
   `adminGetFinance` (functions/admin-os.js):

        amount = x.amount ?? x.amountKES
        net    = x.netAmount ?? amount
        fee    = max(0, amount - net)
        counts only when String(status).toUpperCase() === 'COMPLETE'

   If the server's rule changes, change this one in the same commit or the
   console and the API will disagree about the same money.

   5. WHAT IS DELIBERATELY NOT BUILT
   ----------------------------------
   The reference design carries four panels this platform cannot honestly fill.
   They are absent, and the surface states why rather than leaving a gap:

     • Revenue by geography  — no payment or order document carries a country or
                               region field. Nothing to group by.
     • Cohort retention      — no cohort store exists; deriving it client-side
                               over capped reads would be an invented number.
     • AI insights           — "revenue rose 10.7% driven by new enterprise
                               clients" is causal attribution. No attribution
                               data exists, and narrating a cause from a
                               correlation is fabrication with a confident voice.
     • By project / client   — SOKONI has no project or client entity.

   Adding any of them requires a real source first. Certification fails if one
   appears without one.

   6. READ-ONLY
   -------------
   No Firestore write of any kind, and no mutation of any money document.
   ========================================================================== */
(function () {
  'use strict';

  var EM = '—';

  /* The complete production status vocabulary. Anything outside this set is
     surfaced as "other" rather than silently dropped — an unrecognised status
     is information, not noise. */
  var STATUSES = ['COMPLETE', 'PENDING', 'FAILED', 'CANCELLED'];

  /* Read ceiling. `payments` is capped so a console cannot fan out unbounded;
     when the cap is hit the surface SAYS the view is partial rather than
     presenting a truncated sum as a total. */
  var CAP = 1000;

  var RANGES = [
    { days: 7,  label: 'Last 7 days' },
    { days: 30, label: 'Last 30 days' },
    { days: 90, label: 'Last 90 days' },
    { days: 365, label: 'Last 12 months' },
  ];

  /* ── State ───────────────────────────────────────────────────────────── */
  var _root = null, _mounted = false, _loading = false;
  var _days = 30, _compare = true, _tab = 'overview';

  var _pay = { ok: null, rows: [], error: '', capped: false, newestAll: 0 };
  var _ops = { ok: null, rows: [], error: '' };

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  function _esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _db() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    try { return firebase.firestore(); } catch (e) { return null; }
  }

  function _ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return 0; } }
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (e) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    return 0;
  }

  function _day(ms) {
    if (!ms) return '';
    try { return new Date(ms).toISOString().split('T')[0]; } catch (e) { return ''; }
  }

  function _date(ms) {
    if (!ms) return EM;
    try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return EM; }
  }

  /** KES formatting. A null is unknown and must never format as "KES 0". */
  function _kes(v) {
    if (v == null) return EM;
    try { return 'KES ' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
    catch (e) { return 'KES ' + Math.round(v); }
  }

  /* ── The canonical payment rules, mirrored from adminGetFinance ──────
     Kept as three tiny named functions so the mirror is reviewable at a glance
     and so certification can assert each rule independently. */

  /** COMPLETE, case-insensitively. The single most important line in the file. */
  function _isComplete(doc) {
    return String(doc && doc.status || '').toUpperCase() === 'COMPLETE';
  }

  /** Gross amount. `amount` first, `amountKES` as the documented alternate. */
  function _amount(doc) {
    var a = (doc && doc.amount != null) ? doc.amount : (doc && doc.amountKES);
    var n = Number(a);
    return isFinite(n) ? n : null;
  }

  /** Gateway fee = gross - net, floored at zero. Null when gross is unknown. */
  function _fee(doc) {
    var amt = _amount(doc);
    if (amt == null) return null;
    var net = Number(doc.netAmount != null ? doc.netAmount : amt);
    if (!isFinite(net)) return null;
    return Math.max(0, amt - net);
  }

  /* ── Windowing ───────────────────────────────────────────────────────── */

  function _startOf(daysAgo) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  }

  /** Documents inside [from, to) by createdAt. */
  function _window(from, to) {
    return _pay.rows.filter(function (r) {
      var t = _ms(r.createdAt);
      return t >= from && (to == null || t < to);
    });
  }

  function _currentRows()  { return _window(_startOf(_days), null); }
  function _previousRows() { return _window(_startOf(_days * 2), _startOf(_days)); }

  /* ── Aggregation ─────────────────────────────────────────────────────
     Returns nulls, not zeros, when a figure cannot be known. `count` is always
     knowable once the read succeeded, so it is a real number; `volume` is null
     when no COMPLETE document carried a readable amount. */
  function _agg(rows) {
    var out = {
      count: rows.length, complete: 0, volume: null, fees: null, net: null,
      byStatus: {}, unreadableAmounts: 0,
    };
    STATUSES.forEach(function (s) { out.byStatus[s] = 0; });
    out.byStatus.other = 0;

    var vol = 0, fee = 0, sawAmount = false;
    rows.forEach(function (r) {
      var s = String(r.status || '').toUpperCase();
      if (STATUSES.indexOf(s) !== -1) out.byStatus[s]++; else out.byStatus.other++;
      if (!_isComplete(r)) return;
      out.complete++;
      var a = _amount(r), f = _fee(r);
      if (a == null) { out.unreadableAmounts++; return; }
      sawAmount = true;
      vol += a;
      if (f != null) fee += f;
    });

    if (sawAmount) {
      out.volume = Math.round(vol * 100) / 100;
      out.fees   = Math.round(fee * 100) / 100;
      out.net    = Math.round((vol - fee) * 100) / 100;
    }
    return out;
  }

  /** Percentage change, or null when there is no comparable baseline. */
  function _delta(cur, prev) {
    if (cur == null || prev == null) return null;
    if (prev === 0) return null;          /* a change from zero has no ratio */
    return ((cur - prev) / Math.abs(prev)) * 100;
  }

  function _deltaHtml(cur, prev, betterUp) {
    if (!_compare) return '';
    var d = _delta(cur, prev);
    if (d == null) {
      return '<span class="ri-d none" title="No comparable measured value in the previous period">' +
             'no baseline</span>';
    }
    var good = betterUp ? d >= 0 : d <= 0;
    var arrow = d > 0 ? '↑' : (d < 0 ? '↓' : '→');
    return '<span class="ri-d ' + (d === 0 ? 'flat' : (good ? 'good' : 'bad')) + '">' +
           arrow + ' ' + Math.abs(Math.round(d * 10) / 10) + '%</span>';
  }

  /* ── Loading ─────────────────────────────────────────────────────────
     Two independent sources, judged independently. `payments` is admin-readable
     directly (firestore.rules), so this needs no callable and no deploy. */
  function load() {
    if (_loading) return Promise.resolve();
    var db = _db();
    if (!db) {
      _pay = { ok: false, rows: [], error: 'Firestore is not initialised on this page.', capped: false, newestAll: 0 };
      _render();
      return Promise.resolve();
    }
    _loading = true;
    _render();

    var since = _startOf(_days * (_compare ? 2 : 1));

    var pays = db.collection('payments')
      .where('createdAt', '>=', new Date(since))
      .limit(CAP).get()
      .then(function (snap) {
        var rows = [];
        snap.forEach(function (d) { var o = d.data() || {}; o.id = d.id; rows.push(o); });
        return { ok: true, rows: rows, capped: rows.length >= CAP, error: '' };
      })
      .catch(function (e) { return { ok: false, rows: [], capped: false, error: (e && e.message) || 'read failed' }; });

    /* The newest payment ANYWHERE, so a quiet range can be told apart from a
       quiet collection. One document, ordered desc — cheap and decisive. */
    var newest = db.collection('payments').orderBy('createdAt', 'desc').limit(1).get()
      .then(function (snap) {
        var t = 0;
        snap.forEach(function (d) { t = _ms((d.data() || {}).createdAt); });
        return t;
      })
      .catch(function () { return 0; });

    /* Daily order counts, reusing the spine the Reports Builder certified. */
    var ops = Promise.all((function () {
      var out = [];
      for (var i = 0; i < _days; i++) {
        var d = new Date(); d.setDate(d.getDate() - i);
        out.push(d.toISOString().split('T')[0]);
      }
      return out;
    })().map(function (id) {
      return db.collection('ops_reports').doc(id).get()
        .then(function (s) { if (!s.exists) return null; var o = s.data() || {}; o.id = id; return o; })
        .catch(function () { return { _error: true }; });
    })).then(function (rs) {
      var errs = rs.filter(function (r) { return r && r._error; });
      var rows = rs.filter(function (r) { return r && !r._error; });
      if (errs.length === rs.length && rs.length) return { ok: false, rows: [], error: 'ops_reports unreadable' };
      return { ok: true, rows: rows, error: '' };
    });

    return Promise.all([pays, newest, ops]).then(function (r) {
      _pay = { ok: r[0].ok, rows: r[0].rows, error: r[0].error, capped: r[0].capped, newestAll: r[1] };
      _ops = r[2];
      _loading = false;
      _render();
    });
  }

  /* ── Charts ──────────────────────────────────────────────────────────
     Daily COMPLETE volume. A day with no payment is genuinely zero volume —
     unlike ops_reports, absence here is a measured absence, because the read
     covered the whole window. That distinction is why this chart may draw a
     zero and the Reports Builder's may not. */
  function _dailyVolume(rows) {
    var by = {};
    for (var i = _days - 1; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      by[d.toISOString().split('T')[0]] = 0;
    }
    rows.forEach(function (r) {
      if (!_isComplete(r)) return;
      var a = _amount(r); if (a == null) return;
      var k = _day(_ms(r.createdAt));
      if (k in by) by[k] += a;
    });
    return Object.keys(by).sort().map(function (k) { return { date: k, value: by[k] }; });
  }

  function _lineChart(series) {
    if (!series.length) return '<div class="ri-empty">Nothing to chart.</div>';
    var vals = series.map(function (p) { return p.value; });
    var hi = Math.max.apply(null, vals), lo = 0;
    if (hi === lo) hi = 1;
    var W = 660, H = 180, P = 8;
    var stepX = series.length > 1 ? (W - P * 2) / (series.length - 1) : 0;
    var pts = series.map(function (p, i) {
      return { x: P + i * stepX, y: H - P - (p.value / hi) * (H - P * 2), p: p };
    });
    var d = pts.map(function (q, i) { return (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); }).join(' ');
    return '<svg class="ri-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="Completed payment volume per day">' +
      '<path class="ri-area" d="' + d + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + (H - P) +
      ' L' + pts[0].x.toFixed(1) + ' ' + (H - P) + ' Z"/>' +
      '<path class="ri-line" d="' + d + '"/></svg>' +
      '<div class="ri-axis"><span>' + _esc(series[0].date) + '</span>' +
      '<span>peak ' + _kes(hi) + '</span>' +
      '<span>' + _esc(series[series.length - 1].date) + '</span></div>';
  }

  /** Outcome split — a real decomposition with a real denominator. */
  function _donut(agg) {
    var order = ['COMPLETE', 'PENDING', 'FAILED', 'CANCELLED', 'other'];
    var cls = { COMPLETE: 'a', PENDING: 'b', FAILED: 'c', CANCELLED: 'd', other: 'e' };
    var parts = order.map(function (k) { return { k: k, n: agg.byStatus[k] || 0 }; })
                     .filter(function (p) { return p.n > 0; });
    if (!parts.length) return '<div class="ri-empty">No payments in this range.</div>';
    var total = agg.count, R = 54, C = 2 * Math.PI * R, off = 0;

    return '<div class="ri-donut-wrap">' +
      '<svg viewBox="0 0 140 140" class="ri-donut" role="img" aria-label="Payment outcome split">' +
      '<circle class="ri-track" cx="70" cy="70" r="' + R + '"/>' +
      parts.map(function (p) {
        var frac = p.n / total;
        var s = '<circle class="ri-arc ' + cls[p.k] + '" cx="70" cy="70" r="' + R + '" ' +
          'stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) + '" ' +
          'stroke-dashoffset="' + (-off * C).toFixed(2) + '"><title>' +
          _esc(p.k + ': ' + p.n) + '</title></circle>';
        off += frac; return s;
      }).join('') +
      '<text x="70" y="66" class="ri-dv">' + total + '</text>' +
      '<text x="70" y="82" class="ri-dl">payments</text></svg>' +
      '<ul class="ri-legend">' + parts.map(function (p) {
        return '<li><span class="ri-sw ' + cls[p.k] + '"></span>' + _esc(p.k) +
               '<b>' + p.n + '</b><i>' + Math.round(p.n / total * 1000) / 10 + '%</i></li>';
      }).join('') + '</ul></div>';
  }

  /* ── Panels ──────────────────────────────────────────────────────────── */

  function _kpis(cur, prev) {
    function card(label, value, sub, delta, accent) {
      return '<div class="ri-kpi' + (accent ? ' accent' : '') + '">' +
        '<div class="ri-kpi-l">' + _esc(label) + '</div>' +
        '<div class="ri-kpi-v">' + value + '</div>' +
        '<div class="ri-kpi-s">' + (delta || '') + '<span class="ri-sub">' + _esc(sub) + '</span></div></div>';
    }
    var rate = cur.count ? (cur.complete / cur.count) * 100 : null;
    var prate = prev.count ? (prev.complete / prev.count) * 100 : null;

    return '<div class="ri-kpis">' +
      card('Rail volume', _kes(cur.volume), 'completed payments only',
           _deltaHtml(cur.volume, prev.volume, true), true) +
      card('Net of fees', _kes(cur.net), 'gross less gateway fees',
           _deltaHtml(cur.net, prev.net, true)) +
      card('Gateway fees', _kes(cur.fees), 'gross less net amount',
           _deltaHtml(cur.fees, prev.fees, false)) +
      card('Completed', String(cur.complete), 'of ' + cur.count + ' payments',
           _deltaHtml(cur.complete, prev.complete, true)) +
      card('Completion rate', rate == null ? EM : (Math.round(rate * 10) / 10) + '%',
           'COMPLETE / all', _deltaHtml(rate, prate, true)) +
      '</div>';
  }

  function _overview(cur, prev) {
    var agg = cur;
    return _kpis(cur, prev) +
      '<div class="ri-row">' +
      '<section class="ri-card wide"><header><h3>Completed volume over time</h3>' +
      '<span>Daily, ' + _days + '-day window</span></header>' +
      '<div class="ri-card-b">' + (agg.complete ? _lineChart(_dailyVolume(_currentRows()))
        : '<div class="ri-empty">No completed payment in this range, so there is no volume to plot.</div>') +
      '</div></section>' +
      '<section class="ri-card"><header><h3>Payment outcomes</h3>' +
      '<span>Share of all payments</span></header>' +
      '<div class="ri-card-b">' + _donut(agg) + '</div></section>' +
      '</div>' +
      (agg.unreadableAmounts
        ? '<div class="ri-warn">' + agg.unreadableAmounts + ' completed payment(s) carry no readable ' +
          'amount. They are counted but excluded from every money figure — not treated as zero.</div>'
        : '');
  }

  function _ledger() {
    var rows = _currentRows().slice().sort(function (a, b) {
      return _ms(b.createdAt) - _ms(a.createdAt);
    });
    if (!rows.length) return '<div class="ri-empty">No payments in this range.</div>';
    return '<div class="ri-scroll"><table class="ri-table">' +
      '<thead><tr><th>Date</th><th>Status</th><th>Gross</th><th>Net</th><th>Fee</th><th>Reference</th></tr></thead>' +
      '<tbody>' + rows.slice(0, 200).map(function (r) {
        var s = String(r.status || '').toUpperCase();
        var known = STATUSES.indexOf(s) !== -1;
        var a = _amount(r), f = _fee(r);
        return '<tr><td class="ri-mono">' + _esc(_date(_ms(r.createdAt))) + '</td>' +
          '<td><span class="ri-badge ' + (known ? s.toLowerCase() : 'unknown') + '">' +
          _esc(s || 'MISSING') + '</span></td>' +
          '<td>' + _kes(a) + '</td>' +
          '<td>' + _kes(a == null || f == null ? null : a - f) + '</td>' +
          '<td>' + _kes(f) + '</td>' +
          '<td class="ri-mono ri-sub">' + _esc(r.checkoutId || r.id || EM) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (rows.length > 200 ? '<p class="ri-note">Showing the 200 most recent of ' + rows.length +
        ' in range. Totals above cover the full range.</p>' : '');
  }

  function _orders() {
    if (!_ops.ok) {
      return '<div class="ri-empty">The daily order record could not be read, so order counts ' +
             'are unknown for this range.</div>';
    }
    if (!_ops.rows.length) {
      return '<div class="ri-empty">No daily order report exists in this range.</div>';
    }
    var rows = _ops.rows.slice().sort(function (a, b) { return a.id < b.id ? 1 : -1; });
    var ord = 0, paid = 0, seen = 0;
    rows.forEach(function (r) {
      if (typeof r.orders24h === 'number') { ord += r.orders24h; seen++; }
      if (typeof r.paidOrders24h === 'number') paid += r.paidOrders24h;
    });
    return '<div class="ri-kpis">' +
      '<div class="ri-kpi"><div class="ri-kpi-l">Orders</div><div class="ri-kpi-v">' +
      (seen ? ord : EM) + '</div><div class="ri-kpi-s"><span class="ri-sub">' +
      (seen ? seen + ' of ' + _days + ' days measured' : 'not measured') + '</span></div></div>' +
      '<div class="ri-kpi"><div class="ri-kpi-l">Paid orders</div><div class="ri-kpi-v">' +
      (seen ? paid : EM) + '</div><div class="ri-kpi-s"><span class="ri-sub">from the daily record</span></div></div>' +
      '</div>' +
      '<p class="ri-note">Order counts come from <span class="ri-mono">ops_reports</span>, which is a ' +
      'different source from <span class="ri-mono">payments</span>. They are shown side by side, never ' +
      'divided into one another — an order and a wallet top-up are not the same event, so a ' +
      '"revenue per order" figure built from these two would be meaningless.</p>';
  }

  /* The panels this platform cannot fill, stated rather than silently missing. */
  function _notBuilt() {
    var items = [
      ['Revenue by geography', 'No payment or order document carries a country or region field. ' +
        'There is nothing to group by, and inferring location from a phone prefix would be a guess.'],
      ['Cohort retention', 'No cohort store exists. Deriving cohorts client-side over a capped read ' +
        'would produce a number that changes with the cap — an artefact, not a measurement.'],
      ['AI insights', 'Statements like "revenue rose because of new enterprise clients" are causal ' +
        'attribution. No attribution data exists on these documents, and narrating a cause from a ' +
        'correlation is fabrication delivered in a confident voice.'],
      ['By project / client', 'SOKONI has no project or client entity. The reference design belongs ' +
        'to a different product shape.'],
    ];
    return '<div class="ri-grid2">' + items.map(function (it) {
      return '<div class="ri-off"><div class="ri-off-h">⚠ Not built</div>' +
        '<strong>' + _esc(it[0]) + '</strong><p>' + _esc(it[1]) + '</p></div>';
    }).join('') + '</div>' +
    '<p class="ri-note">Each of these needs a real source before it can exist. Certification fails ' +
    'if one is added without one.</p>';
  }

  /* ── Shell ───────────────────────────────────────────────────────────── */

  function _render() {
    if (!_root) return;

    if (_loading && _pay.ok === null) {
      _root.innerHTML = '<div class="ri"><div class="ri-top"><h2>Revenue Intelligence</h2></div>' +
        '<div class="ri-skel"></div><div class="ri-skel"></div></div>';
      return;
    }

    var body;
    if (_pay.ok === false) {
      body = '<div class="ri-fail"><strong>The payments ledger could not be read.</strong> ' +
        _esc(_pay.error) + '<br>No money figure is shown rather than showing zero. This surface ' +
        'reads <span class="ri-mono">payments</span>, which requires an admin claim.</div>';
    } else {
      var cur = _agg(_currentRows()), prev = _agg(_previousRows());
      body =
        (_pay.rows.length === 0
          ? '<div class="ri-fail info"><strong>No payments recorded in this range.</strong> ' +
            (_pay.newestAll
              ? 'The most recent payment anywhere in the collection is ' + _esc(_date(_pay.newestAll)) +
                '. A quiet range is not the same as a quiet platform — widen the window before ' +
                'concluding anything.'
              : 'No payment exists anywhere in the collection that this console can read.') +
            '</div>'
          : '') +
        (_pay.capped
          ? '<div class="ri-warn">The read hit its ' + CAP + '-document cap, so this view is ' +
            'PARTIAL. The totals below are a floor, not a total. Narrow the range.</div>'
          : '') +
        (_tab === 'overview' ? _overview(cur, prev)
         : _tab === 'ledger' ? _ledger()
         : _tab === 'orders' ? _orders()
         : _notBuilt());
    }

    var tabs = [['overview', 'Overview'], ['ledger', 'Payment ledger'],
                ['orders', 'Orders'], ['notbuilt', 'Not built']];

    _root.innerHTML = '<div class="ri">' +
      '<div class="ri-top"><div><h2>Revenue Intelligence</h2>' +
      '<p>Payment-rail performance from the canonical <span class="ri-mono">payments</span> ledger.</p></div>' +
      '<div class="ri-ctl">' +
      '<select class="ri-in" aria-label="Date range" onchange="SokoniRevenue.days(this.value)">' +
      RANGES.map(function (r) {
        return '<option value="' + r.days + '"' + (_days === r.days ? ' selected' : '') + '>' +
               _esc(r.label) + '</option>';
      }).join('') + '</select>' +
      '<label class="ri-check"><input type="checkbox"' + (_compare ? ' checked' : '') +
      ' onchange="SokoniRevenue.compare(this.checked)"> Compare to previous period</label>' +
      '<button class="ri-btn" onclick="SokoniRevenue.refresh()"' + (_loading ? ' disabled' : '') + '>' +
      (_loading ? 'Refreshing…' : '↻ Refresh') + '</button>' +
      '</div></div>' +

      '<div class="ri-disc"><strong>What these figures are.</strong> Every production payment is a ' +
      'wallet top-up or STK push, keyed by <span class="ri-mono">uid</span> and ' +
      '<span class="ri-mono">checkoutId</span>. This is payment-rail throughput — not marketplace ' +
      'sales revenue and not GMV. Nothing here is labelled "Total Revenue", because it would not be true.</div>' +

      '<div class="ri-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button class="ri-tab" role="tab" aria-selected="' + (_tab === t[0]) + '" ' +
          'onclick="SokoniRevenue.tab(\'' + t[0] + '\')">' + _esc(t[1]) + '</button>';
      }).join('') + '</div>' +

      body +

      '<p class="ri-foot">Completion is judged as <span class="ri-mono">' +
      'String(status).toUpperCase() === \'COMPLETE\'</span>, mirroring ' +
      '<span class="ri-mono">adminGetFinance</span>. The production vocabulary is ' +
      'PENDING / COMPLETE / FAILED / CANCELLED — <span class="ri-mono">succeeded</span> is never ' +
      'written, and matching it would render a confident zero.</p>' +
      '</div>';
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.SokoniRevenue = {
    version: '1.0.0',
    mount: function (target) {
      var el = typeof target === 'string' ? document.getElementById(target) : target;
      if (!el) return;
      _styles();
      _root = el;
      if (_mounted) { _render(); return; }
      _mounted = true;
      load();
    },
    refresh: function () { return load(); },
    tab:     function (t) { _tab = t; _render(); },
    days:    function (v) { _days = parseInt(v, 10) || 30; load(); },
    compare: function (on) { _compare = !!on; load(); },

    /* Exposed so certification can assert the canonical rules directly rather
       than only through rendered markup. */
    _rules:  { isComplete: _isComplete, amount: _amount, fee: _fee },
    _agg:    _agg,
    _state:  function () { return { pay: _pay, ops: _ops, days: _days }; },
  };

  /* ── Styles ──────────────────────────────────────────────────────────── */
  function _styles() {
    if (document.getElementById('riStyles')) return;
    var el = document.createElement('style');
    el.id = 'riStyles';
    el.textContent = [
      '.ri{',
      '--ri-s:var(--aos-surface,var(--surface,rgba(255,255,255,.03)));',
      '--ri-s2:var(--aos-surface2,var(--card,rgba(255,255,255,.06)));',
      '--ri-b:var(--aos-border,var(--border,rgba(255,255,255,.08)));',
      '--ri-a:var(--aos-accent,var(--accent,#71ff00));',
      '--ri-t:var(--aos-text,var(--text,rgba(255,255,255,.9)));',
      '--ri-m:var(--aos-muted,var(--muted,rgba(255,255,255,.4)));',
      '--ri-ok:var(--aos-success,var(--green,#4caf50));',
      '--ri-wa:var(--aos-warn,var(--orange,#ff9800));',
      '--ri-ba:var(--aos-danger,var(--red,#f44336));',
      '--ri-r:var(--aos-radius,var(--radius,10px));',
      'display:block;color:var(--ri-t);font-size:14px}',

      '.ri-top{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin-bottom:14px}',
      '.ri-top h2{font-size:20px;font-weight:700;margin:0}',
      '.ri-top p{font-size:12px;color:var(--ri-m);margin:3px 0 0}',
      '.ri-ctl{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.ri-in{background:var(--ri-s2);border:1px solid var(--ri-b);border-radius:8px;color:var(--ri-t);',
      'padding:7px 11px;font-size:12.5px;font-family:inherit;outline:none}',
      '.ri-in:focus{border-color:var(--ri-a)}',
      '.ri-check{display:flex;gap:7px;align-items:center;font-size:12px;color:var(--ri-m)}',
      '.ri-btn{background:var(--ri-s2);border:1px solid var(--ri-b);border-radius:8px;color:var(--ri-t);',
      'padding:7px 13px;font-size:12.5px;cursor:pointer;font-family:inherit}',
      '.ri-btn:hover:not(:disabled){border-color:var(--ri-a);color:var(--ri-a)}',
      '.ri-btn:disabled{opacity:.45;cursor:not-allowed}',

      '.ri-disc{background:var(--ri-s);border:1px solid var(--ri-b);border-left:3px solid var(--ri-a);',
      'border-radius:var(--ri-r);padding:11px 14px;font-size:12px;color:var(--ri-m);line-height:1.6;',
      'margin-bottom:14px}',
      '.ri-disc strong{color:var(--ri-t)}',

      '.ri-tabs{display:flex;gap:3px;flex-wrap:wrap;border-bottom:1px solid var(--ri-b);margin-bottom:16px}',
      '.ri-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--ri-m);',
      'padding:8px 13px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.ri-tab:hover{color:var(--ri-t)}',
      '.ri-tab[aria-selected="true"]{color:var(--ri-a);border-bottom-color:var(--ri-a);font-weight:600}',

      '.ri-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:16px}',
      '.ri-kpi{background:var(--ri-s);border:1px solid var(--ri-b);border-radius:var(--ri-r);padding:14px}',
      '.ri-kpi.accent{border-color:rgba(113,255,0,.28)}',
      '.ri-kpi-l{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ri-m)}',
      '.ri-kpi-v{font-size:23px;font-weight:800;margin:5px 0 3px;line-height:1.1}',
      '.ri-kpi-s{display:flex;flex-wrap:wrap;gap:7px;align-items:center}',
      '.ri-sub{font-size:10.5px;color:var(--ri-m)}',
      '.ri-d{font-size:11px;font-weight:700;border-radius:4px;padding:1px 5px;background:var(--ri-s2)}',
      '.ri-d.good{color:var(--ri-ok)}.ri-d.bad{color:var(--ri-ba)}',
      '.ri-d.flat,.ri-d.none{color:var(--ri-m);font-weight:500}',

      '.ri-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px;margin-bottom:14px}',
      '@media(max-width:1000px){.ri-row{grid-template-columns:minmax(0,1fr)}}',
      '.ri-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}',
      '.ri-card{background:var(--ri-s);border:1px solid var(--ri-b);border-radius:var(--ri-r);overflow:hidden}',
      '.ri-card header{padding:11px 14px;border-bottom:1px solid var(--ri-b)}',
      '.ri-card header h3{font-size:13px;font-weight:600;margin:0}',
      '.ri-card header span{font-size:10.5px;color:var(--ri-m)}',
      '.ri-card-b{padding:14px}',

      '.ri-svg{width:100%;height:150px;display:block;overflow:visible}',
      '.ri-line{fill:none;stroke:var(--ri-a);stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}',
      '.ri-area{fill:var(--ri-a);opacity:.13;stroke:none}',
      '.ri-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--ri-m);margin-top:6px}',

      '.ri-donut-wrap{display:flex;gap:14px;align-items:center;flex-wrap:wrap}',
      '.ri-donut{width:126px;height:126px;flex-shrink:0;transform:rotate(-90deg)}',
      '.ri-track{fill:none;stroke:var(--ri-b);stroke-width:14}',
      '.ri-arc{fill:none;stroke-width:14}',
      '.ri-arc.a{stroke:var(--ri-ok)}.ri-arc.b{stroke:var(--ri-wa)}.ri-arc.c{stroke:var(--ri-ba)}',
      '.ri-arc.d{stroke:var(--ri-m)}.ri-arc.e{stroke:#7c4dff}',
      '.ri-dv,.ri-dl{transform:rotate(90deg);transform-origin:70px 70px;text-anchor:middle;',
      'fill:var(--ri-t);font-family:inherit}',
      '.ri-dv{font-size:17px;font-weight:800}.ri-dl{font-size:9px;fill:var(--ri-m)}',
      '.ri-legend{list-style:none;margin:0;padding:0;flex:1;min-width:140px}',
      '.ri-legend li{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 0}',
      '.ri-legend b{margin-left:auto}.ri-legend i{color:var(--ri-m);font-style:normal;width:42px;text-align:right}',
      '.ri-sw{width:9px;height:9px;border-radius:2px}',
      '.ri-sw.a{background:var(--ri-ok)}.ri-sw.b{background:var(--ri-wa)}.ri-sw.c{background:var(--ri-ba)}',
      '.ri-sw.d{background:var(--ri-m)}.ri-sw.e{background:#7c4dff}',

      '.ri-scroll{overflow-x:auto}',
      '.ri-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:620px}',
      '.ri-table th{text-align:left;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--ri-m);padding:9px 10px;border-bottom:1px solid var(--ri-b);white-space:nowrap}',
      '.ri-table td{padding:9px 10px;border-bottom:1px solid var(--ri-b)}',
      '.ri-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
      '.ri-badge{font-size:10px;font-weight:700;border-radius:4px;padding:2px 7px;border:1px solid var(--ri-b)}',
      '.ri-badge.complete{color:var(--ri-ok);border-color:rgba(76,175,80,.4)}',
      '.ri-badge.pending{color:var(--ri-wa);border-color:rgba(255,152,0,.4)}',
      '.ri-badge.failed{color:var(--ri-ba);border-color:rgba(244,67,54,.4)}',
      '.ri-badge.cancelled,.ri-badge.unknown{color:var(--ri-m)}',

      '.ri-empty{padding:30px 14px;text-align:center;color:var(--ri-m);font-size:12.5px;line-height:1.6}',
      '.ri-note{font-size:11px;color:var(--ri-m);margin-top:10px;line-height:1.6}',
      '.ri-foot{font-size:11px;color:var(--ri-m);margin-top:16px;line-height:1.65}',
      '.ri-warn{background:rgba(255,152,0,.07);border:1px solid rgba(255,152,0,.35);color:var(--ri-wa);',
      'border-radius:var(--ri-r);padding:11px 14px;font-size:12.5px;margin-bottom:14px;line-height:1.55}',
      '.ri-fail{border:1px solid rgba(244,67,54,.35);background:rgba(244,67,54,.06);color:var(--ri-ba);',
      'border-radius:var(--ri-r);padding:16px;font-size:12.5px;line-height:1.65;margin-bottom:14px}',
      '.ri-fail.info{border-color:var(--ri-b);background:var(--ri-s2);color:var(--ri-m)}',
      '.ri-fail strong{display:inline}',
      '.ri-off{background:var(--ri-s);border:1px solid rgba(255,152,0,.28);border-radius:var(--ri-r);padding:13px}',
      '.ri-off-h{font-size:10px;font-weight:700;color:var(--ri-wa);margin-bottom:6px}',
      '.ri-off strong{display:block;font-size:12.5px;margin-bottom:5px}',
      '.ri-off p{font-size:11px;color:var(--ri-m);line-height:1.6;margin:0}',
      '.ri-skel{height:72px;border-radius:var(--ri-r);margin-bottom:10px;',
      'background:linear-gradient(90deg,var(--ri-s) 25%,rgba(255,255,255,.06) 37%,var(--ri-s) 63%);',
      'background-size:400% 100%;animation:risk 1.2s ease infinite}',
      '@keyframes risk{0%{background-position:100% 50%}100%{background-position:0 50%}}',
      '@media(prefers-reduced-motion:reduce){.ri-skel{animation:none}}',
    ].join('');
    document.head.appendChild(el);
  }
})();
