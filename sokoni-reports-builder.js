/* ============================================================================
   SOKONI Reports Builder — sokoni-reports-builder.js   v1.0.0
   ============================================================================
   Compose a report from canonical platform metrics, preview it, and export it.
   Mounted by BOTH platform-admin consoles:

     admin-os.html    → panel "reports"  (claims.admin)
     super-admin.html → panel "reports"  (claims.superAdmin)

   admin.html is not a consumer, matching the Integrations Control Center ruling.

   THE DATA SPINE
   --------------
   Everything on the canvas is built from ONE canonical store:

     ops_reports/{YYYY-MM-DD}

   written each morning by `scheduledDailyOpsReport` (functions/scheduled-reports.js)
   and readable by admins (`allow read: if isAdmin()`). One document per day, so a
   date range IS the series — no client-side aggregation, no derived arithmetic
   over unrelated collections, no interpolation between days.

   Fields, exactly as the scheduler writes them:
     orders24h · paidOrders24h · failedPayments24h · paymentSuccessRate
     emailFailed24h · cspViolations24h · openFeedback · generatedAt

   NULL IS A HOLE, NOT A ZERO
   --------------------------
   The scheduler's own `safe()` helper writes **null** when a sub-query fails, so
   a null in these documents means "not measured that day", never "none that day".
   This module honours that end to end:

     • a null point is a GAP in the line, not a dip to the axis
     • a null is excluded from totals, averages and deltas
     • a day with no document at all is absent from the series, not a zero row
     • a KPI whose period contains no measured value renders an em dash

   Drawing a null as zero would invent a collapse in payment success that never
   happened. That is the single most dangerous thing this file could do, so the
   null path is certified in both directions: a gap must render as a gap, and a
   real zero must still render as zero.

   DELTAS
   ------
   A comparison figure is shown only when BOTH periods have at least one measured
   value. A period with no data compares to nothing and says so; it never reads as
   "0%" or as a 100% improvement over an absent baseline.

   WHAT THIS SURFACE CANNOT DO, AND WHY IT SAYS SO
   -----------------------------------------------
   Publishing and scheduled delivery are NOT implemented, and their controls are
   disabled with the reason shown in the UI rather than hidden:

     • there is no canonical store for a report definition. `ops_reports` is
       read-only to clients and `/reports/{reportId}` is the user ABUSE-REPORT
       collection — repurposing it would corrupt trust & safety data.
     • scheduled delivery in this platform is fixed in code (daily ops 06:00 EAT,
       weekly security Mon 07:00 EAT). A frequency/timezone/channel picker that
       wrote nowhere would be a fabricated control.
     • both would need a rules change and a function deploy, and function deploys
       are frozen by the Artifact Registry investigation.

   A draft layout saves to localStorage and is labelled as device-local, because
   that is what it is. Export is real: it prints through a stylesheet, which needs
   no backend at all.

   READ-ONLY AGAINST FIRESTORE
   ---------------------------
   This module performs no Firestore write of any kind. Report layout is UI state
   and lives in localStorage; platform data is read and never written back.
   ========================================================================== */
(function () {
  'use strict';

  var EM = '—';
  var LS_KEY = 'sokoni.reports.draft.v1';

  /* ── Metric registry ─────────────────────────────────────────────────
     The closed set of metrics this builder can show, because it is exactly
     the set `scheduledDailyOpsReport` writes. Adding a metric here without a
     writer produces a permanently empty series, so the certification suite
     checks every key against the fields the scheduler actually emits.

     `better` says which direction is good, so a delta can be coloured without
     the UI guessing. `unit` drives formatting only. */
  var METRICS = [
    { key: 'orders24h',          label: 'Orders',               unit: 'count',   better: 'up'   },
    { key: 'paidOrders24h',      label: 'Paid orders',          unit: 'count',   better: 'up'   },
    { key: 'failedPayments24h',  label: 'Failed payments',      unit: 'count',   better: 'down' },
    { key: 'paymentSuccessRate', label: 'Payment success rate', unit: 'percent', better: 'up'   },
    { key: 'emailFailed24h',     label: 'Email failures',       unit: 'count',   better: 'down' },
    { key: 'cspViolations24h',   label: 'CSP violations',       unit: 'count',   better: 'down' },
    { key: 'openFeedback',       label: 'Open feedback',        unit: 'count',   better: 'down' },
  ];
  var METRIC_BY_KEY = {};
  METRICS.forEach(function (m) { METRIC_BY_KEY[m.key] = m; });

  /* ── Module registry ─────────────────────────────────────────────────
     Only modules that can be filled from the spine are offered. A palette
     entry with no canonical source would be a dead control, so Map and Image
     from the reference design are deliberately absent: this platform has no
     geo series and no report-asset upload target. */
  var MODULES = [
    { type: 'kpi',      label: 'KPI Summary',   icon: '▦', desc: 'Latest measured value per metric, with period delta.' },
    { type: 'line',     label: 'Line Chart',    icon: '╱', desc: 'One metric across the range. Gaps where unmeasured.' },
    { type: 'area',     label: 'Area Chart',    icon: '◢', desc: 'Same series, filled.' },
    { type: 'bar',      label: 'Bar Chart',     icon: '█', desc: 'One bar per measured day.' },
    { type: 'donut',    label: 'Donut Chart',   icon: '○', desc: 'Order outcome split across the range.' },
    { type: 'table',    label: 'Data Table',    icon: '☷', desc: 'The underlying daily documents, unaggregated.' },
    { type: 'metrics',  label: 'Metric List',   icon: '≡', desc: 'Compact list of every metric in the period.' },
    { type: 'progress', label: 'Progress List', icon: '▬', desc: 'Each metric against its best day in range.' },
    { type: 'note',     label: 'Text / Note',   icon: '✎', desc: 'Editable commentary. Author-written, never generated.' },
    { type: 'divider',  label: 'Divider',       icon: '—', desc: 'Section break.' },
  ];
  var MODULE_BY_TYPE = {};
  MODULES.forEach(function (m) { MODULE_BY_TYPE[m.type] = m; });

  /* ── Templates ───────────────────────────────────────────────────────
     Each template composes only modules this spine can fill. There is no
     "Project Performance" template: the platform has no canonical project
     series, and a template that renders empty every time is worse than no
     template. */
  var TEMPLATES = [
    { id: 'executive', name: 'Executive Summary', desc: 'Headline KPIs, order trend and outcome split.',
      blocks: [
        { type: 'kpi',   metrics: ['orders24h', 'paidOrders24h', 'paymentSuccessRate', 'failedPayments24h'] },
        { type: 'line',  metric: 'orders24h', span: 2 },
        { type: 'donut', span: 1 },
        { type: 'metrics', span: 1 },
      ] },
    { id: 'reliability', name: 'Payment Reliability', desc: 'Success rate, failures and the daily record behind them.',
      blocks: [
        { type: 'kpi',   metrics: ['paymentSuccessRate', 'failedPayments24h', 'paidOrders24h'] },
        { type: 'area',  metric: 'paymentSuccessRate', span: 2 },
        { type: 'bar',   metric: 'failedPayments24h', span: 1 },
        { type: 'table', span: 2 },
      ] },
    { id: 'operations', name: 'Operations Report', desc: 'Delivery health: email, CSP and open feedback.',
      blocks: [
        { type: 'kpi',      metrics: ['emailFailed24h', 'cspViolations24h', 'openFeedback'] },
        { type: 'line',     metric: 'emailFailed24h', span: 1 },
        { type: 'line',     metric: 'cspViolations24h', span: 1 },
        { type: 'progress', span: 2 },
      ] },
    { id: 'blank', name: 'Blank Report', desc: 'Start from nothing.', blocks: [] },
  ];

  /* ── State ───────────────────────────────────────────────────────────── */
  var _root = null, _mounted = false, _loading = false;
  var _leftTab = 'templates', _paletteTab = 'modules', _rightTab = 'settings';

  var _doc = {
    name: 'Executive Performance Report',
    description: '',
    templateId: 'executive',
    days: 30,
    compare: true,
    columns: 2,
    showDeltas: true,
    blocks: [],
    savedAt: 0,
  };

  /* The spine. `ok:null` = not attempted. Absent days are simply absent. */
  var _data = { ok: null, rows: [], error: '', loadedAt: 0 };
  var _selected = null;   /* selected block index, for the Style tab */
  var _toast = '';

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

  /** YYYY-MM-DD for a day offset from today, in the document id's own format. */
  function _dayId(offset) {
    var d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toISOString().split('T')[0];
  }

  /** A measured number, or null. Anything non-finite is NOT measured. */
  function _num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function _fmt(v, unit) {
    if (v == null) return EM;
    if (unit === 'percent') return (Math.round(v * 10) / 10) + '%';
    return String(Math.round(v * 100) / 100);
  }

  /* ── Series ──────────────────────────────────────────────────────────
     A series is one point per DOCUMENT THAT EXISTS, carrying either a measured
     number or null. Missing days do not become points, and nulls do not become
     zeros. Everything downstream consumes this shape. */
  function _series(metricKey, offsetFrom, offsetTo) {
    var out = [];
    _data.rows.forEach(function (r) {
      if (r._offset < offsetFrom || r._offset > offsetTo) return;
      out.push({ date: r.id, value: _num(r[metricKey]) });
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }

  /** Measured values only. The length of this array IS the sample size. */
  function _measured(series) {
    return series.filter(function (p) { return p.value != null; }).map(function (p) { return p.value; });
  }

  function _avg(values) {
    if (!values.length) return null;
    var s = 0;
    values.forEach(function (v) { s += v; });
    return s / values.length;
  }

  function _sum(values) {
    if (!values.length) return null;
    var s = 0;
    values.forEach(function (v) { s += v; });
    return s;
  }

  /** The most recent measured value in the range, or null. */
  function _latest(series) {
    for (var i = series.length - 1; i >= 0; i--) if (series[i].value != null) return series[i].value;
    return null;
  }

  /* Current period vs the immediately preceding one of equal length. A delta
     exists only when BOTH sides have at least one measured value. */
  function _delta(metricKey) {
    var n = _doc.days;
    var cur  = _measured(_series(metricKey, 0, n - 1));
    var prev = _measured(_series(metricKey, n, (2 * n) - 1));
    if (!cur.length || !prev.length) return null;
    var a = _avg(cur), b = _avg(prev);
    if (b === 0) return null;               /* a change from zero has no ratio */
    return ((a - b) / Math.abs(b)) * 100;
  }

  function _deltaHtml(metricKey) {
    if (!_doc.showDeltas || !_doc.compare) return '';
    var d = _delta(metricKey);
    if (d == null) {
      return '<span class="rb-delta none" title="No comparable measured data in the previous period">' +
             'no baseline</span>';
    }
    var m = METRIC_BY_KEY[metricKey] || { better: 'up' };
    var good = (m.better === 'up') ? d >= 0 : d <= 0;
    var sign = d > 0 ? '↑' : (d < 0 ? '↓' : '→');
    return '<span class="rb-delta ' + (d === 0 ? 'flat' : (good ? 'good' : 'bad')) + '">' +
           sign + ' ' + Math.abs(Math.round(d * 10) / 10) + '%</span>';
  }

  /* ── Loading ─────────────────────────────────────────────────────────
     Reads 2x the range so the comparison period is covered by the same pass.
     Each day is fetched by document id — `ops_reports` is keyed by date, so
     this needs no index and no orderBy. A day that does not exist is skipped,
     never materialised as a zero row. */
  function load() {
    if (_loading) return Promise.resolve();
    var db = _db();
    if (!db) {
      _data = { ok: false, rows: [], error: 'Firestore is not initialised on this page.', loadedAt: Date.now() };
      _render();
      return Promise.resolve();
    }
    _loading = true;
    _render();

    var span = _doc.days * (_doc.compare ? 2 : 1);
    var ids = [];
    for (var i = 0; i < span; i++) ids.push({ id: _dayId(i), offset: i });

    return Promise.all(ids.map(function (d) {
      return db.collection('ops_reports').doc(d.id).get()
        .then(function (snap) {
          if (!snap.exists) return null;
          var o = snap.data() || {};
          o.id = d.id;
          o._offset = d.offset;
          return o;
        })
        .catch(function (e) { return { _error: (e && e.message) || 'read failed' }; });
    })).then(function (results) {
      var errs = results.filter(function (r) { return r && r._error; });
      var rows = results.filter(function (r) { return r && !r._error; });

      /* Every single read failing is an outage, not an empty history. The two
         are reported differently because they mean opposite things. */
      if (errs.length === results.length && results.length) {
        _data = { ok: false, rows: [], error: errs[0]._error, loadedAt: Date.now() };
      } else {
        _data = { ok: true, rows: rows, error: errs.length ? (errs.length + ' day(s) unreadable') : '', loadedAt: Date.now() };
      }
      _loading = false;
      _render();
    });
  }

  /* ── SVG charts ──────────────────────────────────────────────────────
     Inline SVG, no charting library: both consoles get identical output, it
     prints cleanly, and nothing has to be added to either page.

     The gap rule lives here. A null does not start a segment and does not end
     one — the path simply breaks, and the reader sees missing data as missing. */
  function _chart(kind, metricKey) {
    var m = METRIC_BY_KEY[metricKey] || METRICS[0];
    var s = _series(metricKey, 0, _doc.days - 1);
    var vals = _measured(s);

    if (!s.length) {
      return '<div class="rb-empty">No daily report exists in this range. ' +
             'Nothing is charted rather than charting zeros.</div>';
    }
    if (!vals.length) {
      return '<div class="rb-empty">' + _esc(m.label) + ' was not measured on any day in this range.</div>';
    }

    var W = 640, H = 180, PAD = 8;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (m.unit === 'percent') { lo = Math.min(lo, 0); hi = Math.max(hi, 100); }
    if (hi === lo) { hi = lo + 1; }

    var stepX = s.length > 1 ? (W - PAD * 2) / (s.length - 1) : 0;
    function x(i) { return PAD + i * stepX; }
    function y(v) { return H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2); }

    if (kind === 'bar') {
      var bw = Math.max(2, (W - PAD * 2) / s.length - 2);
      return '<svg class="rb-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" ' +
        'aria-label="' + _esc(m.label) + ' per day">' +
        s.map(function (p, i) {
          if (p.value == null) return '';   /* no bar: unmeasured, not zero */
          var yy = y(p.value);
          return '<rect x="' + (x(i) - bw / 2) + '" y="' + yy + '" width="' + bw +
                 '" height="' + Math.max(1, (H - PAD - yy)) + '" rx="1" class="rb-bar"><title>' +
                 _esc(p.date + ': ' + _fmt(p.value, m.unit)) + '</title></rect>';
        }).join('') + '</svg>';
    }

    /* Build contiguous runs of measured points; each run is its own path. */
    var runs = [], cur = [];
    s.forEach(function (p, i) {
      if (p.value == null) { if (cur.length) { runs.push(cur); cur = []; } return; }
      cur.push({ x: x(i), y: y(p.value), p: p });
    });
    if (cur.length) runs.push(cur);

    var paths = runs.map(function (run) {
      var d = run.map(function (pt, i) { return (i ? 'L' : 'M') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1); }).join(' ');
      var out = '';
      if (kind === 'area' && run.length > 1) {
        out += '<path class="rb-area" d="' + d + ' L' + run[run.length - 1].x.toFixed(1) + ' ' + (H - PAD) +
               ' L' + run[0].x.toFixed(1) + ' ' + (H - PAD) + ' Z"/>';
      }
      /* A lone measured point between two gaps still has to be visible. */
      out += run.length === 1
        ? '<circle class="rb-pt" cx="' + run[0].x.toFixed(1) + '" cy="' + run[0].y.toFixed(1) + '" r="2.5"/>'
        : '<path class="rb-line" d="' + d + '"/>';
      return out;
    }).join('');

    var gaps = s.filter(function (p) { return p.value == null; }).length;

    return '<svg class="rb-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="' + _esc(m.label) + ' over ' + _doc.days + ' days">' + paths + '</svg>' +
      '<div class="rb-axis"><span>' + _esc(s[0].date) + '</span>' +
      '<span>' + _fmt(lo, m.unit) + ' – ' + _fmt(hi, m.unit) + '</span>' +
      '<span>' + _esc(s[s.length - 1].date) + '</span></div>' +
      (gaps ? '<div class="rb-gapnote">' + gaps + ' day' + (gaps === 1 ? '' : 's') +
              ' unmeasured — shown as gaps, not zeros.</div>' : '');
  }

  /* Order outcome split. Paid and failed are measured directly; the remainder
     is only computed when BOTH the total and its parts are measured, and it is
     floored at zero so a late-settling payment cannot render a negative wedge. */
  function _donut() {
    var paidS  = _measured(_series('paidOrders24h', 0, _doc.days - 1));
    var failS  = _measured(_series('failedPayments24h', 0, _doc.days - 1));
    var totS   = _measured(_series('orders24h', 0, _doc.days - 1));
    var paid = _sum(paidS), failed = _sum(failS), total = _sum(totS);

    if (paid == null && failed == null) {
      return '<div class="rb-empty">No order outcome was measured in this range.</div>';
    }
    var parts = [];
    if (paid   != null) parts.push({ label: 'Paid',   value: paid,   cls: 'a' });
    if (failed != null) parts.push({ label: 'Failed', value: failed, cls: 'b' });
    if (total != null && paid != null && failed != null) {
      var rest = Math.max(0, total - paid - failed);
      parts.push({ label: 'Other', value: rest, cls: 'c' });
    }
    var sum = 0;
    parts.forEach(function (p) { sum += p.value; });
    if (sum <= 0) return '<div class="rb-empty">No orders recorded in this range.</div>';

    var R = 54, C = 2 * Math.PI * R, off = 0;
    var ring = parts.map(function (p) {
      var frac = p.value / sum;
      var seg = '<circle class="rb-arc ' + p.cls + '" cx="70" cy="70" r="' + R + '" ' +
        'stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-off * C).toFixed(2) + '"><title>' +
        _esc(p.label + ': ' + p.value) + '</title></circle>';
      off += frac;
      return seg;
    }).join('');

    return '<div class="rb-donut-wrap">' +
      '<svg viewBox="0 0 140 140" class="rb-donut" role="img" aria-label="Order outcome split">' +
      '<circle class="rb-track" cx="70" cy="70" r="' + R + '"/>' + ring +
      '<text x="70" y="66" class="rb-donut-v">' + sum + '</text>' +
      '<text x="70" y="82" class="rb-donut-l">orders</text></svg>' +
      '<ul class="rb-legend">' + parts.map(function (p) {
        return '<li><span class="rb-sw ' + p.cls + '"></span>' + _esc(p.label) +
               '<b>' + p.value + '</b><i>' + Math.round(p.value / sum * 1000) / 10 + '%</i></li>';
      }).join('') + '</ul>' +
      (total == null || paid == null || failed == null
        ? '<p class="rb-gapnote">"Other" is omitted: it needs the total and both parts measured.</p>' : '') +
      '</div>';
  }

  /* ── Block renderers ─────────────────────────────────────────────────── */

  function _blockBody(b) {
    if (b.type === 'divider') return '<hr class="rb-hr">';
    if (b.type === 'note') {
      return '<textarea class="rb-note" rows="3" placeholder="Written commentary… never generated" ' +
             'oninput="SokoniReports.note(' + b._i + ', this.value)">' + _esc(b.text || '') + '</textarea>';
    }
    if (b.type === 'kpi') {
      var keys = b.metrics && b.metrics.length ? b.metrics : ['orders24h', 'paidOrders24h', 'paymentSuccessRate'];
      return '<div class="rb-kpis">' + keys.map(function (k) {
        var m = METRIC_BY_KEY[k]; if (!m) return '';
        var s = _series(k, 0, _doc.days - 1);
        var v = _latest(s);
        var n = _measured(s).length;
        return '<div class="rb-kpi"><div class="rb-kpi-l">' + _esc(m.label) + '</div>' +
          '<div class="rb-kpi-v">' + _fmt(v, m.unit) + '</div>' +
          '<div class="rb-kpi-s">' + _deltaHtml(k) +
          '<span class="rb-n">' + (n ? n + ' of ' + s.length + ' days measured' : 'not measured') + '</span>' +
          '</div></div>';
      }).join('') + '</div>';
    }
    if (b.type === 'line' || b.type === 'area' || b.type === 'bar') {
      return _chart(b.type, b.metric || 'orders24h');
    }
    if (b.type === 'donut') return _donut();
    if (b.type === 'metrics') {
      return '<ul class="rb-mlist">' + METRICS.map(function (m) {
        var s = _series(m.key, 0, _doc.days - 1);
        var vals = _measured(s);
        var v = m.unit === 'percent' ? _avg(vals) : _sum(vals);
        return '<li><span>' + _esc(m.label) + '</span>' +
               '<b>' + _fmt(v, m.unit) + '</b>' + _deltaHtml(m.key) + '</li>';
      }).join('') + '</ul>' +
      '<p class="rb-gapnote">Rates are averaged over measured days; counts are summed. ' +
      'Unmeasured days are excluded from both.</p>';
    }
    if (b.type === 'progress') {
      return '<ul class="rb-prog">' + METRICS.map(function (m) {
        var s = _series(m.key, 0, _doc.days - 1);
        var vals = _measured(s);
        if (!vals.length) {
          return '<li><div class="rb-prog-h"><span>' + _esc(m.label) + '</span><b>' + EM + '</b></div>' +
                 '<div class="rb-prog-t"></div></li>';
        }
        var cur = _latest(s), peak = Math.max.apply(null, vals);
        var pct = peak > 0 ? Math.min(100, (cur / peak) * 100) : 0;
        return '<li><div class="rb-prog-h"><span>' + _esc(m.label) + '</span>' +
          '<b>' + _fmt(cur, m.unit) + ' <i>of ' + _fmt(peak, m.unit) + ' peak</i></b></div>' +
          '<div class="rb-prog-t"><span style="width:' + pct.toFixed(1) + '%"></span></div></li>';
      }).join('') + '</ul>';
    }
    if (b.type === 'table') {
      var rows = _data.rows.filter(function (r) { return r._offset < _doc.days; })
                           .sort(function (a, b2) { return a.id < b2.id ? 1 : -1; });
      if (!rows.length) return '<div class="rb-empty">No daily documents in this range.</div>';
      return '<div class="rb-scroll"><table class="rb-table"><thead><tr><th>Date</th>' +
        METRICS.map(function (m) { return '<th>' + _esc(m.label) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows.map(function (r) {
          return '<tr><td class="rb-mono">' + _esc(r.id) + '</td>' + METRICS.map(function (m) {
            var v = _num(r[m.key]);
            return '<td' + (v == null ? ' class="rb-na" title="Not measured"' : '') + '>' +
                   _fmt(v, m.unit) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="rb-gapnote">' + EM + ' marks a value the scheduler recorded as unmeasured. ' +
        'It is not zero.</p>';
    }
    return '';
  }

  function _canvas() {
    if (_data.ok === false) {
      return '<div class="rb-fail"><strong>The report spine could not be read.</strong> ' +
        _esc(_data.error) + '<br>Nothing is rendered rather than rendering zeros. ' +
        'This surface reads <span class="rb-mono">ops_reports</span>, which requires an admin claim.</div>';
    }
    if (_data.ok && !_data.rows.length) {
      return '<div class="rb-fail info"><strong>No daily reports exist in this range.</strong> ' +
        '<span class="rb-mono">ops_reports</span> is written each morning by ' +
        '<span class="rb-mono">scheduledDailyOpsReport</span>. An empty range means the job has not ' +
        'written for these dates — it does not mean the platform recorded zero activity.</div>';
    }
    if (!_doc.blocks.length) {
      return '<div class="rb-drop"><div class="rb-drop-i">▦</div>' +
        '<strong>Drop modules here</strong><span>Or pick a template on the left.</span></div>';
    }

    return '<div class="rb-grid" style="--rb-cols:' + _doc.columns + '">' +
      _doc.blocks.map(function (b, i) {
        b._i = i;
        var meta = MODULE_BY_TYPE[b.type] || { label: b.type };
        var span = Math.min(b.span || 1, _doc.columns);
        return '<section class="rb-block' + (_selected === i ? ' sel' : '') + '" ' +
          'style="grid-column:span ' + span + '" draggable="true" ' +
          'ondragstart="SokoniReports.dragBlock(event,' + i + ')" ' +
          'ondragover="event.preventDefault()" ' +
          'ondrop="SokoniReports.dropOn(event,' + i + ')" ' +
          'onclick="SokoniReports.select(' + i + ')">' +
          '<header class="rb-block-h"><span class="rb-grip" aria-hidden="true">∷</span>' +
          '<h4>' + _esc(b.title || meta.label) + '</h4>' +
          (b.metric ? '<span class="rb-tag">' + _esc((METRIC_BY_KEY[b.metric] || {}).label || b.metric) + '</span>' : '') +
          '<button class="rb-x" aria-label="Remove module" ' +
          'onclick="event.stopPropagation();SokoniReports.remove(' + i + ')">✕</button></header>' +
          '<div class="rb-block-b">' + _blockBody(b) + '</div></section>';
      }).join('') + '</div>';
  }

  /* ── Panels ──────────────────────────────────────────────────────────── */

  function _left() {
    if (_leftTab === 'saved') {
      var d = _readDraft();
      return '<div class="rb-pane">' + (d
        ? '<button class="rb-tpl" onclick="SokoniReports.restore()">' +
          '<strong>' + _esc(d.name || 'Untitled') + '</strong>' +
          '<span>' + (d.blocks || []).length + ' modules · saved ' + _esc(_when(d.savedAt)) + '</span>' +
          '</button>' +
          '<p class="rb-note-s">Drafts are stored in this browser only. They are not shared, not ' +
          'backed up, and not visible to anyone else — there is no canonical report store yet.</p>'
        : '<div class="rb-empty">No draft saved on this device.</div>') + '</div>';
    }
    return '<div class="rb-pane">' + TEMPLATES.map(function (t) {
      return '<button class="rb-tpl' + (_doc.templateId === t.id ? ' on' : '') + '" ' +
        'onclick="SokoniReports.template(\'' + t.id + '\')">' +
        '<strong>' + _esc(t.name) + '</strong><span>' + _esc(t.desc) + '</span></button>';
    }).join('') + '</div>';
  }

  function _palette() {
    if (_paletteTab === 'layout') {
      return '<div class="rb-pane">' + [1, 2, 3].map(function (n) {
        return '<button class="rb-mod' + (_doc.columns === n ? ' on' : '') + '" ' +
          'onclick="SokoniReports.columns(' + n + ')"><span class="rb-mod-i">▤</span>' +
          '<span class="rb-mod-t">' + n + ' Column' + (n > 1 ? 's' : '') + '</span></button>';
      }).join('') + '<p class="rb-note-s">Columns apply to the canvas and to the printed export.</p></div>';
    }
    return '<div class="rb-pane">' + MODULES.map(function (m) {
      return '<button class="rb-mod" draggable="true" title="' + _esc(m.desc) + '" ' +
        'ondragstart="SokoniReports.dragNew(event,\'' + m.type + '\')" ' +
        'onclick="SokoniReports.add(\'' + m.type + '\')">' +
        '<span class="rb-mod-i" aria-hidden="true">' + m.icon + '</span>' +
        '<span class="rb-mod-t">' + _esc(m.label) + '</span></button>';
    }).join('') +
    '<p class="rb-note-s">Map and Image are absent by design: this platform has no canonical geo ' +
    'series and no report-asset store, so both would be controls that do nothing.</p></div>';
  }

  function _right() {
    if (_rightTab === 'filters') {
      var b = _selected != null ? _doc.blocks[_selected] : null;
      return '<div class="rb-pane">' +
        '<label class="rb-lab">Date range</label>' +
        '<select class="rb-in" onchange="SokoniReports.days(this.value)">' +
        [7, 14, 30, 60, 90].map(function (n) {
          return '<option value="' + n + '"' + (_doc.days === n ? ' selected' : '') + '>Last ' + n + ' days</option>';
        }).join('') + '</select>' +
        '<label class="rb-check"><input type="checkbox"' + (_doc.compare ? ' checked' : '') +
        ' onchange="SokoniReports.compare(this.checked)"> Compare to previous ' + _doc.days + ' days</label>' +
        '<label class="rb-check"><input type="checkbox"' + (_doc.showDeltas ? ' checked' : '') +
        ' onchange="SokoniReports.deltas(this.checked)"> Show period deltas</label>' +
        '<div class="rb-sect">Selected module</div>' +
        (b && (b.type === 'line' || b.type === 'area' || b.type === 'bar')
          ? '<label class="rb-lab">Metric</label><select class="rb-in" onchange="SokoniReports.metric(this.value)">' +
            METRICS.map(function (m) {
              return '<option value="' + m.key + '"' + (b.metric === m.key ? ' selected' : '') + '>' +
                     _esc(m.label) + '</option>';
            }).join('') + '</select>'
          : '<p class="rb-note-s">' + (b ? 'This module has no metric to choose.'
                                         : 'Select a module on the canvas to configure it.') + '</p>') +
        '</div>';
    }
    if (_rightTab === 'style') {
      var b2 = _selected != null ? _doc.blocks[_selected] : null;
      return '<div class="rb-pane">' +
        '<label class="rb-lab">Canvas columns</label>' +
        '<select class="rb-in" onchange="SokoniReports.columns(+this.value)">' +
        [1, 2, 3].map(function (n) {
          return '<option value="' + n + '"' + (_doc.columns === n ? ' selected' : '') + '>' + n + '</option>';
        }).join('') + '</select>' +
        (b2 ? '<label class="rb-lab">Module title</label>' +
              '<input class="rb-in" value="' + _esc(b2.title || '') + '" ' +
              'placeholder="' + _esc((MODULE_BY_TYPE[b2.type] || {}).label || '') + '" ' +
              'oninput="SokoniReports.title(this.value)">' +
              '<label class="rb-lab">Width</label>' +
              '<select class="rb-in" onchange="SokoniReports.span(+this.value)">' +
              [1, 2, 3].map(function (n) {
                return '<option value="' + n + '"' + ((b2.span || 1) === n ? ' selected' : '') + '>' +
                       'Span ' + n + '</option>';
              }).join('') + '</select>'
            : '<p class="rb-note-s">Select a module on the canvas to style it.</p>') +
        '</div>';
    }

    /* Settings — including the two controls that are honestly switched off. */
    return '<div class="rb-pane">' +
      '<label class="rb-lab">Report name</label>' +
      '<input class="rb-in" value="' + _esc(_doc.name) + '" oninput="SokoniReports.name(this.value)">' +
      '<label class="rb-lab">Description</label>' +
      '<textarea class="rb-in" rows="3" oninput="SokoniReports.desc(this.value)">' +
      _esc(_doc.description) + '</textarea>' +

      '<div class="rb-sect">Source</div>' +
      '<div class="rb-kv"><span>Collection</span><strong class="rb-mono">ops_reports</strong></div>' +
      '<div class="rb-kv"><span>Written by</span><strong class="rb-mono">scheduledDailyOpsReport</strong></div>' +
      '<div class="rb-kv"><span>Days in range</span><strong>' +
        (_data.ok ? _data.rows.filter(function (r) { return r._offset < _doc.days; }).length +
                    ' of ' + _doc.days : EM) + '</strong></div>' +
      '<div class="rb-kv"><span>Loaded</span><strong>' +
        (_data.loadedAt ? _esc(_when(_data.loadedAt)) : EM) + '</strong></div>' +

      '<div class="rb-sect">Delivery &amp; schedule</div>' +
      '<div class="rb-off"><div class="rb-off-h">⚠ Not available</div>' +
      '<p>Scheduled delivery is fixed in platform code — daily ops at 06:00 EAT and the weekly ' +
      'security digest Monday 07:00 EAT. There is no per-report schedule store, so a frequency, ' +
      'timezone or channel picker here would write nowhere.</p>' +
      '<p>Enabling it needs a schedule collection, rules for it, and a Cloud Function deploy — ' +
      'and function deploys are frozen by the Artifact Registry investigation.</p></div>' +

      '<div class="rb-sect">Publishing</div>' +
      '<div class="rb-off"><div class="rb-off-h">⚠ Not available</div>' +
      '<p>No canonical store exists for a report definition. ' +
      '<span class="rb-mono">ops_reports</span> is read-only to clients, and ' +
      '<span class="rb-mono">/reports</span> is the user abuse-report collection — writing ' +
      'layouts there would corrupt trust &amp; safety data.</p>' +
      '<p>Draft saving works, and stores on this device only.</p></div>' +
      '</div>';
  }

  function _when(ms) {
    if (!ms) return EM;
    var d = Date.now() - ms, m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  /* ── Draft persistence (device-local, and labelled as such) ─────────── */
  function _readDraft() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }       /* private mode, blocked storage, bad JSON */
  }

  function _writeDraft() {
    try {
      _doc.savedAt = Date.now();
      localStorage.setItem(LS_KEY, JSON.stringify(_doc));
      return true;
    } catch (e) { return false; }
  }

  /* ── Shell ───────────────────────────────────────────────────────────── */

  function _render() {
    if (!_root) return;

    if (_loading && !_data.loadedAt) {
      _root.innerHTML = '<div class="rb"><div class="rb-top"><h2>Reports Builder</h2></div>' +
        '<div class="rb-skel"></div><div class="rb-skel"></div><div class="rb-skel"></div></div>';
      return;
    }

    function tabs(group, cur, defs, fn) {
      return '<div class="rb-tabs" role="tablist">' + defs.map(function (d) {
        return '<button class="rb-tab" role="tab" aria-selected="' + (cur === d[0]) + '" ' +
          'onclick="SokoniReports.' + fn + '(\'' + d[0] + '\')">' + _esc(d[1]) + '</button>';
      }).join('') + '</div>';
    }

    _root.innerHTML = '<div class="rb">' +
      '<div class="rb-top">' +
      '<div class="rb-title"><input class="rb-name" value="' + _esc(_doc.name) + '" ' +
      'aria-label="Report name" oninput="SokoniReports.name(this.value)">' +
      '<span class="rb-state">' + (_doc.savedAt ? 'Draft · saved ' + _esc(_when(_doc.savedAt))
                                                : 'Draft · unsaved') + '</span></div>' +
      '<div class="rb-acts">' +
      '<button class="rb-btn" onclick="SokoniReports.refresh()"' + (_loading ? ' disabled' : '') + '>' +
      (_loading ? 'Refreshing…' : '↻ Refresh') + '</button>' +
      '<button class="rb-btn" onclick="SokoniReports.save()">Save draft</button>' +
      '<button class="rb-btn primary" onclick="SokoniReports.print()">Export / Print</button>' +
      '<button class="rb-btn" disabled title="No canonical report store exists — see Settings">' +
      'Publish</button>' +
      '</div></div>' +

      (_toast ? '<div class="rb-toast">' + _esc(_toast) + '</div>' : '') +
      (_data.ok && _data.error ? '<div class="rb-warn">' + _esc(_data.error) +
        ' — those days are excluded from every figure rather than counted as zero.</div>' : '') +

      '<div class="rb-shell">' +
      '<aside class="rb-side">' +
        tabs('left', _leftTab, [['templates', 'Templates'], ['saved', 'Saved']], 'leftTab') + _left() +
        tabs('pal', _paletteTab, [['modules', 'Modules'], ['layout', 'Layout']], 'paletteTab') + _palette() +
      '</aside>' +
      '<main class="rb-canvas" ondragover="event.preventDefault()" ' +
        'ondrop="SokoniReports.dropEnd(event)" id="rbCanvas">' + _canvas() + '</main>' +
      '<aside class="rb-side right">' +
        tabs('right', _rightTab, [['settings', 'Settings'], ['filters', 'Filters'], ['style', 'Style']], 'rightTab') +
        _right() +
      '</aside>' +
      '</div>' +

      '<p class="rb-foot">Every figure is read from <span class="rb-mono">ops_reports</span>, one ' +
      'document per day. Unmeasured values render as ' + EM + ' and break the line; they are never ' +
      'drawn as zero, summed, or averaged.</p>' +
      '</div>';
  }

  /* ── Drag and drop ───────────────────────────────────────────────────── */
  var _drag = null;

  /* ── Public API ──────────────────────────────────────────────────────── */

  function _flash(msg) {
    _toast = msg;
    _render();
    setTimeout(function () { _toast = ''; _render(); }, 2600);
  }

  function _applyTemplate(id) {
    var t = null;
    TEMPLATES.forEach(function (x) { if (x.id === id) t = x; });
    if (!t) return;
    _doc.templateId = id;
    _doc.blocks = JSON.parse(JSON.stringify(t.blocks));
    _selected = null;
  }

  window.SokoniReports = {
    version: '1.0.0',

    mount: function (target) {
      var el = typeof target === 'string' ? document.getElementById(target) : target;
      if (!el) return;
      _styles();
      _root = el;
      if (_mounted) { _render(); return; }
      _mounted = true;
      if (!_doc.blocks.length) _applyTemplate(_doc.templateId);
      load();
    },

    refresh:    function () { return load(); },
    leftTab:    function (t) { _leftTab = t; _render(); },
    paletteTab: function (t) { _paletteTab = t; _render(); },
    rightTab:   function (t) { _rightTab = t; _render(); },
    template:   function (id) { _applyTemplate(id); _render(); },
    columns:    function (n) { _doc.columns = n; _render(); },
    name:       function (v) { _doc.name = v; },
    desc:       function (v) { _doc.description = v; },
    note:       function (i, v) { if (_doc.blocks[i]) _doc.blocks[i].text = v; },
    select:     function (i) { _selected = i; _rightTab = 'style'; _render(); },
    remove:     function (i) { _doc.blocks.splice(i, 1); _selected = null; _render(); },
    title:      function (v) { if (_doc.blocks[_selected]) { _doc.blocks[_selected].title = v; } },
    span:       function (n) { if (_doc.blocks[_selected]) { _doc.blocks[_selected].span = n; _render(); } },
    metric:     function (k) { if (_doc.blocks[_selected]) { _doc.blocks[_selected].metric = k; _render(); } },

    /* Range and comparison change what must be FETCHED, not just drawn. */
    days:    function (v) { _doc.days = parseInt(v, 10) || 30; load(); },
    compare: function (on) { _doc.compare = !!on; load(); },
    deltas:  function (on) { _doc.showDeltas = !!on; _render(); },

    add: function (type) {
      _doc.blocks.push({ type: type, span: 1, metric: (type === 'line' || type === 'area' || type === 'bar')
        ? 'orders24h' : undefined });
      _render();
    },

    dragNew:   function (e, type) { _drag = { kind: 'new', type: type }; },
    dragBlock: function (e, i) { _drag = { kind: 'move', from: i }; },
    dropOn: function (e, i) {
      e.preventDefault(); e.stopPropagation();
      if (!_drag) return;
      if (_drag.kind === 'new') _doc.blocks.splice(i, 0, { type: _drag.type, span: 1,
        metric: /line|area|bar/.test(_drag.type) ? 'orders24h' : undefined });
      else if (_drag.from !== i) {
        var b = _doc.blocks.splice(_drag.from, 1)[0];
        _doc.blocks.splice(i, 0, b);
      }
      _drag = null; _selected = null; _render();
    },
    dropEnd: function (e) {
      e.preventDefault();
      if (!_drag) return;
      if (_drag.kind === 'new') _doc.blocks.push({ type: _drag.type, span: 1,
        metric: /line|area|bar/.test(_drag.type) ? 'orders24h' : undefined });
      else _doc.blocks.push(_doc.blocks.splice(_drag.from, 1)[0]);
      _drag = null; _render();
    },

    /* A save reports the OUTCOME. Storage can refuse (private mode, blocked
       site data), and a success message over a failed write is exactly the
       lie this platform forbids. */
    save: function () {
      _flash(_writeDraft()
        ? 'Draft saved on this device only — not shared, not backed up.'
        : 'Draft NOT saved: this browser refused local storage.');
    },

    restore: function () {
      var d = _readDraft();
      if (!d) { _flash('No draft on this device.'); return; }
      _doc = d;
      _doc.blocks = _doc.blocks || [];
      _selected = null;
      _leftTab = 'templates';
      load();
    },

    print: function () { try { window.print(); } catch (e) { _flash('This browser blocked printing.'); } },

    _state: function () { return { doc: _doc, data: _data }; },
    _series: _series,
    _metrics: METRICS,
    _templates: TEMPLATES,
    _modules: MODULES,
  };

  /* ── Styles ──────────────────────────────────────────────────────────
     Namespaced `rb-`, resolving through a local token layer that falls back
     across BOTH consoles' variable sets, so neither page restyles it. The
     print block is what makes Export real. */
  function _styles() {
    if (document.getElementById('rbStyles')) return;
    var el = document.createElement('style');
    el.id = 'rbStyles';
    el.textContent = [
      '.rb{',
      '--rb-s:var(--aos-surface,var(--surface,rgba(255,255,255,.03)));',
      '--rb-s2:var(--aos-surface2,var(--card,rgba(255,255,255,.06)));',
      '--rb-b:var(--aos-border,var(--border,rgba(255,255,255,.08)));',
      '--rb-a:var(--aos-accent,var(--accent,#71ff00));',
      '--rb-t:var(--aos-text,var(--text,rgba(255,255,255,.9)));',
      '--rb-m:var(--aos-muted,var(--muted,rgba(255,255,255,.4)));',
      '--rb-ok:var(--aos-success,var(--green,#4caf50));',
      '--rb-wa:var(--aos-warn,var(--orange,#ff9800));',
      '--rb-ba:var(--aos-danger,var(--red,#f44336));',
      '--rb-r:var(--aos-radius,var(--radius,10px));',
      'display:block;color:var(--rb-t);font-size:14px}',

      '.rb-top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px}',
      '.rb-title{min-width:220px;flex:1}',
      '.rb-name{background:none;border:1px solid transparent;border-radius:6px;color:var(--rb-t);',
      'font-size:19px;font-weight:700;padding:3px 6px;width:100%;max-width:440px;font-family:inherit}',
      '.rb-name:hover{border-color:var(--rb-b)}.rb-name:focus{border-color:var(--rb-a);outline:none}',
      '.rb-state{display:block;font-size:11px;color:var(--rb-m);padding-left:7px;margin-top:2px}',
      '.rb-acts{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}',
      '.rb-btn{background:var(--rb-s2);border:1px solid var(--rb-b);border-radius:8px;color:var(--rb-t);',
      'padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.rb-btn:hover:not(:disabled){border-color:var(--rb-a);color:var(--rb-a)}',
      '.rb-btn:disabled{opacity:.42;cursor:not-allowed}',
      '.rb-btn.primary{background:var(--rb-a);border-color:var(--rb-a);color:#04120a;font-weight:700}',
      '.rb-btn.primary:hover{filter:brightness(1.08);color:#04120a}',

      '.rb-toast{background:var(--rb-s2);border:1px solid var(--rb-a);border-radius:var(--rb-r);',
      'padding:10px 14px;font-size:12.5px;margin-bottom:12px}',
      '.rb-warn{background:rgba(255,152,0,.07);border:1px solid rgba(255,152,0,.35);color:var(--rb-wa);',
      'border-radius:var(--rb-r);padding:10px 14px;font-size:12.5px;margin-bottom:12px}',

      '.rb-shell{display:grid;grid-template-columns:230px minmax(0,1fr) 290px;gap:14px;align-items:start}',
      '@media(max-width:1350px){.rb-shell{grid-template-columns:210px minmax(0,1fr)}',
      '.rb-side.right{grid-column:1/-1}}',
      '@media(max-width:900px){.rb-shell{grid-template-columns:minmax(0,1fr)}}',

      '.rb-side{background:var(--rb-s);border:1px solid var(--rb-b);border-radius:var(--rb-r);padding:12px}',
      '.rb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--rb-b);margin-bottom:10px}',
      '.rb-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--rb-m);',
      'padding:7px 10px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.rb-tab[aria-selected="true"]{color:var(--rb-a);border-bottom-color:var(--rb-a);font-weight:600}',
      '.rb-pane{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}',

      '.rb-tpl{text-align:left;background:var(--rb-s2);border:1px solid var(--rb-b);border-radius:8px;',
      'padding:10px;cursor:pointer;color:var(--rb-t);font-family:inherit}',
      '.rb-tpl:hover{border-color:var(--rb-a)}.rb-tpl.on{border-color:var(--rb-a);background:rgba(255,255,255,.07)}',
      '.rb-tpl strong{display:block;font-size:12.5px}',
      '.rb-tpl span{display:block;font-size:11px;color:var(--rb-m);margin-top:2px;line-height:1.45}',

      '.rb-mod{display:flex;align-items:center;gap:9px;background:var(--rb-s2);border:1px solid var(--rb-b);',
      'border-radius:7px;padding:8px 10px;cursor:grab;color:var(--rb-t);font-family:inherit;text-align:left}',
      '.rb-mod:hover{border-color:var(--rb-a)}.rb-mod.on{border-color:var(--rb-a)}',
      '.rb-mod-i{font-size:13px;color:var(--rb-a);width:16px;text-align:center}',
      '.rb-mod-t{font-size:12.5px}',

      '.rb-canvas{background:var(--rb-s);border:1px solid var(--rb-b);border-radius:var(--rb-r);',
      'padding:16px;min-height:420px}',
      '.rb-grid{display:grid;grid-template-columns:repeat(var(--rb-cols),minmax(0,1fr));gap:12px}',
      '@media(max-width:700px){.rb-grid{grid-template-columns:minmax(0,1fr)}',
      '.rb-block{grid-column:span 1!important}}',
      '.rb-block{background:var(--rb-s2);border:1px solid var(--rb-b);border-radius:var(--rb-r);',
      'overflow:hidden;cursor:pointer}',
      '.rb-block.sel{border-color:var(--rb-a)}',
      '.rb-block-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--rb-b)}',
      '.rb-block-h h4{font-size:12.5px;font-weight:600;margin:0;flex:1}',
      '.rb-grip{color:var(--rb-m);cursor:grab;font-size:12px}',
      '.rb-tag{font-size:10px;color:var(--rb-m);border:1px solid var(--rb-b);border-radius:5px;padding:1px 6px}',
      '.rb-x{background:none;border:none;color:var(--rb-m);cursor:pointer;font-size:12px}',
      '.rb-x:hover{color:var(--rb-ba)}',
      '.rb-block-b{padding:12px}',

      '.rb-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '.rb-kpi{background:var(--rb-s);border:1px solid var(--rb-b);border-radius:8px;padding:10px}',
      '.rb-kpi-l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--rb-m)}',
      '.rb-kpi-v{font-size:22px;font-weight:800;margin:3px 0;line-height:1.1}',
      '.rb-kpi-s{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.rb-n{font-size:10px;color:var(--rb-m)}',
      '.rb-delta{font-size:11px;font-weight:700;border-radius:4px;padding:1px 5px;background:var(--rb-s2)}',
      '.rb-delta.good{color:var(--rb-ok)}.rb-delta.bad{color:var(--rb-ba)}',
      '.rb-delta.flat,.rb-delta.none{color:var(--rb-m);font-weight:500}',

      '.rb-svg{width:100%;height:150px;display:block;overflow:visible}',
      '.rb-line{fill:none;stroke:var(--rb-a);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;',
      'vector-effect:non-scaling-stroke}',
      '.rb-area{fill:var(--rb-a);opacity:.14;stroke:none}',
      '.rb-pt{fill:var(--rb-a)}',
      '.rb-bar{fill:var(--rb-a);opacity:.8}',
      '.rb-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--rb-m);margin-top:6px}',
      '.rb-gapnote{font-size:10.5px;color:var(--rb-m);margin-top:7px;line-height:1.5}',

      '.rb-donut-wrap{display:flex;gap:14px;align-items:center;flex-wrap:wrap}',
      '.rb-donut{width:130px;height:130px;flex-shrink:0;transform:rotate(-90deg)}',
      '.rb-track{fill:none;stroke:var(--rb-b);stroke-width:14}',
      '.rb-arc{fill:none;stroke-width:14}',
      '.rb-arc.a{stroke:var(--rb-ok)}.rb-arc.b{stroke:var(--rb-ba)}.rb-arc.c{stroke:var(--rb-m)}',
      '.rb-donut-v,.rb-donut-l{transform:rotate(90deg);transform-origin:70px 70px;text-anchor:middle;',
      'fill:var(--rb-t);font-family:inherit}',
      '.rb-donut-v{font-size:17px;font-weight:800}',
      '.rb-donut-l{font-size:9px;fill:var(--rb-m)}',
      '.rb-legend{list-style:none;margin:0;padding:0;flex:1;min-width:150px}',
      '.rb-legend li{display:flex;align-items:center;gap:7px;font-size:12px;padding:3px 0}',
      '.rb-legend b{margin-left:auto;font-weight:700}',
      '.rb-legend i{color:var(--rb-m);font-style:normal;font-size:11px;width:44px;text-align:right}',
      '.rb-sw{width:9px;height:9px;border-radius:2px}',
      '.rb-sw.a{background:var(--rb-ok)}.rb-sw.b{background:var(--rb-ba)}.rb-sw.c{background:var(--rb-m)}',

      '.rb-mlist,.rb-prog{list-style:none;margin:0;padding:0}',
      '.rb-mlist li{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:6px 0;',
      'border-bottom:1px solid var(--rb-b)}',
      '.rb-mlist li:last-child{border-bottom:none}',
      '.rb-mlist li span{flex:1;color:var(--rb-m)}.rb-mlist li b{font-weight:700}',
      '.rb-prog li{padding:6px 0}',
      '.rb-prog-h{display:flex;font-size:12px;margin-bottom:4px}',
      '.rb-prog-h span{flex:1;color:var(--rb-m)}',
      '.rb-prog-h i{color:var(--rb-m);font-style:normal;font-weight:400;font-size:10.5px}',
      '.rb-prog-t{height:5px;background:var(--rb-b);border-radius:99px;overflow:hidden}',
      '.rb-prog-t span{display:block;height:100%;background:var(--rb-a);border-radius:99px}',

      '.rb-scroll{overflow-x:auto}',
      '.rb-table{width:100%;border-collapse:collapse;font-size:12px;min-width:560px}',
      '.rb-table th{text-align:left;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--rb-m);padding:7px 8px;border-bottom:1px solid var(--rb-b);white-space:nowrap}',
      '.rb-table td{padding:7px 8px;border-bottom:1px solid var(--rb-b)}',
      '.rb-table td.rb-na{color:var(--rb-m)}',
      '.rb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',

      '.rb-note{width:100%;background:var(--rb-s);border:1px solid var(--rb-b);border-radius:7px;',
      'color:var(--rb-t);padding:9px;font-family:inherit;font-size:12.5px;resize:vertical}',
      '.rb-hr{border:none;border-top:1px solid var(--rb-b);margin:6px 0}',

      '.rb-lab{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;',
      'color:var(--rb-m);margin:9px 0 4px;font-weight:600}',
      '.rb-in{width:100%;background:var(--rb-s2);border:1px solid var(--rb-b);border-radius:7px;',
      'color:var(--rb-t);padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none}',
      '.rb-in:focus{border-color:var(--rb-a)}',
      '.rb-check{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--rb-m);margin-top:8px}',
      '.rb-sect{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--rb-m);',
      'font-weight:700;margin:16px 0 7px;padding-top:11px;border-top:1px solid var(--rb-b)}',
      '.rb-kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:4px 0}',
      '.rb-kv span{color:var(--rb-m)}',
      '.rb-off{background:rgba(255,152,0,.06);border:1px solid rgba(255,152,0,.3);border-radius:8px;padding:10px}',
      '.rb-off-h{font-size:11px;font-weight:700;color:var(--rb-wa);margin-bottom:5px}',
      '.rb-off p{font-size:11px;color:var(--rb-m);line-height:1.55;margin:0 0 6px}',
      '.rb-off p:last-child{margin-bottom:0}',
      '.rb-note-s{font-size:11px;color:var(--rb-m);line-height:1.55;margin:4px 0 0}',

      '.rb-empty{padding:26px 12px;text-align:center;color:var(--rb-m);font-size:12.5px;line-height:1.6}',
      '.rb-drop{padding:64px 20px;text-align:center;color:var(--rb-m);border:1px dashed var(--rb-b);',
      'border-radius:var(--rb-r)}',
      '.rb-drop-i{font-size:26px;color:var(--rb-a);margin-bottom:8px}',
      '.rb-drop strong{display:block;font-size:13px;color:var(--rb-t)}',
      '.rb-drop span{font-size:11.5px}',
      '.rb-fail{border:1px solid rgba(244,67,54,.35);background:rgba(244,67,54,.06);color:var(--rb-ba);',
      'border-radius:var(--rb-r);padding:16px;font-size:12.5px;line-height:1.65}',
      '.rb-fail.info{border-color:var(--rb-b);background:var(--rb-s2);color:var(--rb-m)}',
      '.rb-foot{font-size:11px;color:var(--rb-m);margin-top:14px;line-height:1.6}',
      '.rb-skel{height:64px;border-radius:var(--rb-r);margin-bottom:10px;',
      'background:linear-gradient(90deg,var(--rb-s) 25%,rgba(255,255,255,.06) 37%,var(--rb-s) 63%);',
      'background-size:400% 100%;animation:rbsk 1.2s ease infinite}',
      '@keyframes rbsk{0%{background-position:100% 50%}100%{background-position:0 50%}}',
      '@media(prefers-reduced-motion:reduce){.rb-skel{animation:none}}',

      /* Print — this is what makes Export real. Chrome prints to PDF from here.
         The two side rails, the console chrome and every control disappear;
         only the report itself is on the page. */
      '@media print{',
      'body *{visibility:hidden!important}',
      '.rb,.rb *{visibility:visible!important}',
      '.rb{position:absolute;left:0;top:0;width:100%;color:#000;font-size:11px}',
      '.rb-side,.rb-acts,.rb-tabs,.rb-x,.rb-grip,.rb-toast,.rb-drop{display:none!important}',
      '.rb-shell{display:block}',
      '.rb-canvas{border:none;padding:0;background:none}',
      '.rb-block{break-inside:avoid;page-break-inside:avoid;border:1px solid #ccc;background:none}',
      '.rb-name{color:#000;font-size:20px;border:none}',
      '.rb-kpi,.rb-in{background:none;border-color:#ccc}',
      '.rb-line,.rb-pt,.rb-bar{stroke:#333;fill:none}.rb-bar{fill:#333}.rb-pt{fill:#333}',
      '.rb-area{fill:#333;opacity:.1}',
      '}',
    ].join('');
    document.head.appendChild(el);
  }
})();
