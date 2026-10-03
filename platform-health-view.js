/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Platform Health view (one renderer for every surface that shows it)
   ------------------------------------------------------------------------------
   Consumers: platform-health.html (full page), sokoni-aos.js (AdminOS dashboard card),
   super-admin.html (Overview health chips + business priorities).

   WHY THIS FILE EXISTS (diagnosis 2026-10-03, live hosting 72dca56, serving functions
   archive = f4422b4, revisions getplatformhealthscores-00014-jep /
   gettopbusinesspriorities-00015-hin):

   The server answers. 45 days of Cloud Run logs show every call 200 and no WARNING/ERROR
   entry for either callable. The surfaces that call it did not agree with what it returns:

     * AdminOS read `h.scores` — a field the callable has never returned. The card kept its
       initial spinner forever, and a rejected call left it spinning too.
     * super-admin.html read `data.dimensions` keyed users/revenue/performance/security/
       reliability, and `res.data.priorities`. The server returns marketplace / seller /
       buyer / operational / cost and `topPriorities`. Both panels therefore always said
       "unavailable" / "No priorities data available" while the data was there.
     * platform-health.html admitted only `claims.admin` (the server accepts admin OR
       superAdmin), had no handler for a failed token refresh or a failed firebase.js
       import (spinner forever), no timeout, left the hero on "Computing scores…" after an
       error, and rendered the server's WITHHELD overall (score:null — f4422b4's
       allSettled path) as a red ring titled "Platform requires immediate attention".
       That is a verdict invented from an unknown.

   The response shape is defined ONCE here, from the serving archive, so the three
   surfaces cannot drift apart again.

   RESPONSE SHAPES (serving archive f4422b4, functions/platform-health.js):
     getPlatformHealthScores → { overall:{score,grade} | {score:null,grade:null,unavailable,
       failedDimensions[]}, marketplace|seller|buyer|operational|cost: {score,grade,
       dimensions:[{name,value,contribution,max,missing}],dataComplete[,failed,error:{code,
       message}]}, alerts:[{severity,area,message}], computedAt, indexBudget:{used,max} }
     getTopBusinessPriorities → { topPriorities:[{id,name,description,revenueImpact,
       userDemand,effortInverse,strategic,costInverse,evidenceGate,evidenceReady,
       totalScore}], allCandidates, recommendation, evidenceSignals:{activeSellerCount,
       cartToPaidRate,jobSearchCount,loyaltyMentions,walletMentions}, computedAt }

   TIME SERIES (2026-10-04, owner decision): the serving f4422b4 archive stored no
   history. The functions branch feat/platform-health-history-on-669e5ba adds
   platformHealthSnapshot (daily, 03:00 Africa/Nairobi → platformHealthHistory/{date})
   and getPlatformHealthScores.history = [{date, overall, dimensions{5}}], oldest first,
   ≤90. Therefore:
     * SERIES_FIELD = 'history'. KPI sparklines and the "over time" card draw ONLY from
       it; null values and days with no snapshot are gaps, never 0.
     * history [] / absent (server not yet deployed) / null (read failed) → the honest
       empty state "Trend history starts after the first daily snapshot".
     * COMPARISON_FIELD stays null: no delta is drawn.
     * The overall weights (30/25/25/15/5) are the server formula's constants, not
       response fields, so no donut of "share of overall" is drawn — a donut of five
       independent 0–100 scores would imply they sum to a whole. A bar list of the
       server's per-dimension scores is drawn instead.

   UI DATA INTEGRITY: a score that is not a finite number renders "—". Never 0, never a
   colour that implies a grade, never a verdict. A canonical 0 from the server renders 0.

   Plain IIFE: loads as a classic <script> (window.SokoniPlatformHealthView) and under Node
   (module.exports) so scripts/test-platform-health-page.js runs it without a browser.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var DASH = '—';
  var DEFAULT_TIMEOUT_MS = 45000;

  /* SERIES_FIELD: the top-level daily-history array getPlatformHealthScores returns
     (functions branch feat/platform-health-history-on-669e5ba). COMPARISON_FIELD: none —
     no delta is drawn. Never point either at a client cache. */
  var SERIES_FIELD = 'history';
  var COMPARISON_FIELD = null;

  /* Icons: decorative line glyphs, 24×24, aria-hidden. */
  var ICONS = {
    overall:     'M3 12h4l3-8 4 16 3-8h4',
    marketplace: 'M4 9l1.5-5h13L20 9M5 9v11h14V9M4 9h16M10 20v-6h4v6',
    seller:      'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    buyer:       'M3 4h2l2.4 11h10.8L21 7H6.2M9 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2M18 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    operational: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
    cost:        'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 6.5v11M15 9h-4.5a1.75 1.75 0 0 0 0 3.5h3a1.75 1.75 0 0 1 0 3.5H9',
    priority:    'M5 21V4h11l-1.5 4L16 12H5',
  };

  /* The five dimensions exactly as getPlatformHealthScores returns them (keys) with the
     weights its overall formula uses (server constants, shown as labels only). The
     collections each one reads are listed from the serving archive's code — the response
     does not name them. */
  var CARDS = [
    { id: 'marketplace', key: 'marketplace', label: 'Marketplace Health', weight: 30, tone: 'violet',
      sources: ['ops_reports', 'products', 'sellerPerformance'] },
    { id: 'seller',      key: 'seller',      label: 'Seller Success',     weight: 25, tone: 'blue',
      sources: ['sellerPerformance'] },
    { id: 'buyer',       key: 'buyer',       label: 'Buyer Satisfaction', weight: 25, tone: 'teal',
      sources: ['feedback', 'sellerPerformance'] },
    { id: 'operational', key: 'operational', label: 'Operational Health', weight: 15, tone: 'amber',
      sources: ['healthSnapshots', 'ops_reports'] },
    { id: 'cost',        key: 'cost',        label: 'Cost Efficiency',    weight: 5,  tone: 'pink',
      sources: ['architecture constants in code (no live read; Cloud Billing is not connected)'] },
  ];
  var PRIORITY_SOURCES = ['sellerPerformance', 'funnelStats', 'searchQueryLog', 'feedback'];
  /* Each priority criterion is scored 1–5 by the server; five criteria → max 25. */
  var PRIORITY_MAX = 25;
  var CRITERIA = [
    { key: 'revenueImpact', label: 'Revenue' }, { key: 'userDemand', label: 'Demand' },
    { key: 'effortInverse', label: 'Effort' }, { key: 'strategic', label: 'Strategic' },
    { key: 'costInverse', label: 'Cost' },
  ];
  var SIGNALS = [
    { key: 'activeSellerCount', label: 'Active sellers' },
    { key: 'cartToPaidRate',    label: 'Cart → paid rate', suffix: '%' },
    { key: 'jobSearchCount',    label: 'Job-related searches' },
    { key: 'loyaltyMentions',   label: 'Loyalty feature requests' },
    { key: 'walletMentions',    label: 'Wallet feature requests' },
  ];

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtScore(v) { return isNum(v) ? String(Math.round(v)) : DASH; }
  function fmtNum(v) { return isNum(v) ? String(Math.round(v * 10) / 10) : DASH; }
  function scoreColor(s) {
    if (!isNum(s)) return '#9ca3af';            /* unknown = neutral grey, not red */
    if (s >= 80) return '#16a34a';
    if (s >= 60) return '#d97706';
    return '#dc2626';
  }
  function pct(v, max) {
    return Math.max(0, Math.min(100, Math.round((v / max) * 100)));
  }
  function icon(name) {
    return '<svg class="ph-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' +
      (ICONS[name] || ICONS.overall) + '"/></svg>';
  }

  /* Same rule as the server's requireAdmin (admin === true || superAdmin === true). */
  function isAdminClaims(claims) {
    return !!claims && (claims.admin === true || claims.superAdmin === true);
  }

  /* The way back for a standalone visit. A Super Admin returns to Super Admin; everyone
     else the server admits returns to AdminOS (the canonical admin workspace). */
  function backLink(claims) {
    return claims && claims.superAdmin === true
      ? { href: 'super-admin.html', label: 'Back to Super Admin' }
      : { href: 'admin-os.html', label: 'Back to AdminOS' };
  }

  function withTimeout(promise, ms, label) {
    var limit = isNum(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        var e = new Error((label || 'The request') + ' did not respond within ' +
          Math.round(limit / 1000) + 's.');
        e.code = 'deadline-exceeded';
        reject(e);
      }, limit);
    });
    return Promise.race([Promise.resolve(promise), timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }

  /* Server message first; the code decides only the lead-in. Never an internal stack. */
  function describeError(err) {
    var code = String((err && err.code) || 'unknown').replace(/^functions\//, '');
    var msg = String((err && err.message) || '').trim();
    var lead;
    if (code === 'permission-denied') lead = 'Admin or Super Admin access required.';
    else if (code === 'unauthenticated') lead = 'Your session has expired. Sign in again.';
    else if (code === 'deadline-exceeded') lead = 'The health service timed out.';
    else if (code === 'unavailable') lead = 'The health service is unreachable.';
    else lead = 'The health service returned an error.';
    return { code: code, lead: lead, message: msg && msg !== lead ? msg : '' };
  }

  function dimension(d, key) {
    var v = d && d[key];
    return v && typeof v === 'object' ? v : null;
  }

  /* "Empty" = the call succeeded but carried nothing measurable: no numeric overall, no
     numeric dimension score, no dimension rows, no failure detail. */
  function hasHealthData(d) {
    if (!d || typeof d !== 'object') return false;
    if (d.overall && isNum(d.overall.score)) return true;
    return CARDS.some(function (c) {
      var x = dimension(d, c.key);
      return !!x && (isNum(x.score) || x.failed === true ||
        (Array.isArray(x.dimensions) && x.dimensions.length > 0));
    });
  }

  function overallView(d) {
    var o = (d && d.overall) || {};
    if (!isNum(o.score)) {
      var failed = Array.isArray(o.failedDimensions) ? o.failedDimensions : [];
      return {
        score: fmtScore(o.score), grade: '', color: scoreColor(null), known: false,
        title: 'Overall score unavailable', pill: 'Overall withheld', tone: 'unknown',
        sub: failed.length
          ? 'Withheld by the server: ' + failed.join(', ') + ' could not be computed.'
          : 'The server did not return an overall score.',
      };
    }
    var s = o.score;
    return {
      score: fmtScore(s), grade: o.grade ? 'Grade ' + o.grade : '', color: scoreColor(s), known: true,
      title: s >= 80 ? 'Platform is healthy'
        : s >= 60 ? 'Platform needs attention in some areas'
        : 'Platform requires immediate attention',
      pill: s >= 80 ? 'Healthy' : s >= 60 ? 'Needs attention' : 'Critical',
      tone: s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad',
      sub: '',
    };
  }

  /* <time> carries the server's ISO value; the visible text is the viewer's locale. */
  function timeHtml(iso) {
    var t = iso ? new Date(iso) : null;
    if (!t || isNaN(t.getTime())) return DASH;
    var txt;
    try { txt = t.toLocaleString('en-KE'); } catch (_) { txt = t.toISOString(); }
    return '<time datetime="' + esc(t.toISOString()) + '">' + esc(txt) + '</time>';
  }

  /* ── series / comparison: rendered ONLY from server fields ───────────────────────
     SERIES_FIELD names the top-level array getPlatformHealthScores returns:
       history: [{ date:'YYYY-MM-DD', overall:number|null,
                   dimensions:{ marketplace|seller|buyer|operational|cost: number|null } }]
     one entry per daily snapshot (platformHealthSnapshot, 03:00 Africa/Nairobi), oldest
     first, ≤90. A null value and a day with no snapshot are both GAPS in the line — never
     0, never interpolated. history [] / absent / null → the honest empty state. */

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var DAY_MS = 86400000;
  function dayNum(date) { return Math.round(Date.parse(date + 'T00:00:00Z') / DAY_MS); }

  /* Points for one key ('overall' or a dimension key): [{date, v:number|null}], by date. */
  function seriesOf(d, key) {
    var h = SERIES_FIELD && d && Array.isArray(d[SERIES_FIELD]) ? d[SERIES_FIELD] : null;
    if (!h) return null;
    var pts = [];
    h.forEach(function (e) {
      if (!e || typeof e !== 'object' || typeof e.date !== 'string' || !DATE_RE.test(e.date)) return;
      var raw = key === 'overall' ? e.overall : (e.dimensions && typeof e.dimensions === 'object' ? e.dimensions[key] : null);
      pts.push({ date: e.date, v: isNum(raw) ? raw : null });
    });
    pts.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return pts;
  }
  function entryOn(d, date) {
    var h = SERIES_FIELD && d && Array.isArray(d[SERIES_FIELD]) ? d[SERIES_FIELD] : [];
    for (var i = 0; i < h.length; i++) if (h[i] && h[i].date === date) return h[i];
    return null;
  }
  function comparisonOf(x) {
    return COMPARISON_FIELD && x ? x[COMPARISON_FIELD] : null;
  }
  function knownCount(series) {
    return Array.isArray(series) ? series.filter(function (p) { return p && isNum(p.v); }).length : 0;
  }
  /* A sparkline needs two measured points; a lone reading is shown as a value, not a line. */
  function validSeries(series) {
    return knownCount(series) >= 2;
  }
  /* Split into runs of consecutive measured days. A null, or a missing day between two
     snapshots, ends the run: the line breaks rather than bridging an unmeasured day. */
  function segments(series) {
    var out = [], cur = [], prevDay = null;
    (series || []).forEach(function (p) {
      var dn = dayNum(p.date);
      if (!isNum(p.v) || (prevDay != null && dn - prevDay > 1)) { if (cur.length) out.push(cur); cur = []; }
      if (isNum(p.v)) cur.push(p);
      prevDay = dn;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  /* SVG geometry: x by calendar day across the series' date span, y on the fixed 0–100
     score scale (one axis, never rescaled to the data). */
  function plot(series, w, h, pad) {
    var first = dayNum(series[0].date), last = dayNum(series[series.length - 1].date);
    var span = Math.max(1, last - first);
    var single = last === first;
    function x(p) { return single ? w / 2 : pad + ((dayNum(p.date) - first) / span) * (w - 2 * pad); }
    function y(v) { return pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (h - 2 * pad); }
    return { x: x, y: y };
  }
  function lineSvg(series, opts) {
    var w = opts.w, h = opts.h, pad = opts.pad;
    var g = plot(series, w, h, pad);
    var segs = segments(series);
    var parts = [];
    if (opts.grid) {
      [0, 50, 100].forEach(function (v) {
        var gy = g.y(v).toFixed(1);
        parts.push('<line class="ph-grid" x1="' + pad + '" x2="' + (w - pad) + '" y1="' + gy + '" y2="' + gy + '"/>');
      });
    }
    segs.forEach(function (seg) {
      if (seg.length > 1) {
        parts.push('<polyline points="' + seg.map(function (p) {
          return g.x(p).toFixed(1) + ',' + g.y(p.v).toFixed(1);
        }).join(' ') + '"/>');
      }
    });
    if (opts.markers) {
      series.forEach(function (p) {
        if (!isNum(p.v)) return;
        var cx = g.x(p).toFixed(1), cy = g.y(p.v).toFixed(1);
        parts.push('<g class="ph-pt"><circle class="ph-hit" cx="' + cx + '" cy="' + cy + '" r="9"/>' +
          '<circle class="ph-dotm" cx="' + cx + '" cy="' + cy + '" r="3.5"/>' +
          '<title>' + esc(p.date) + ': ' + esc(fmtScore(p.v)) + '</title></g>');
      });
    } else {
      /* an isolated reading still shows as a dot, so a lone day is not invisible */
      segs.forEach(function (seg) {
        if (seg.length === 1) parts.push('<circle class="ph-dotm" cx="' + g.x(seg[0]).toFixed(1) +
          '" cy="' + g.y(seg[0].v).toFixed(1) + '" r="2"/>');
      });
    }
    return parts.join('');
  }
  function sparkHtml(series) {
    if (!validSeries(series)) return '';
    return '<svg class="ph-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="Daily score history">' +
      lineSvg(series, { w: 100, h: 28, pad: 2 }) + '</svg>';
  }
  function deltaHtml(x) {
    var prev = comparisonOf(x);
    if (!isNum(prev) || !isNum(x && x.score)) return '';
    var diff = Math.round(x.score - prev);
    var dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    return '<span class="ph-delta ' + dir + '">' + (diff > 0 ? '+' : '') + diff + ' vs previous</span>';
  }

  function latestKnown(series) {
    for (var i = (series ? series.length : 0) - 1; i >= 0; i--) if (isNum(series[i].v)) return series[i];
    return null;
  }

  /* "Over time" card: Overall as its own single-series chart on the 0–100 axis, then the
     five dimensions as small multiples — each a single-series chart named by its title, so
     identity never rests on colour. A table of the same values follows. */
  function trendHtml(d) {
    var overall = seriesOf(d, 'overall');
    var anyKnown = !!overall && (knownCount(overall) > 0 ||
      CARDS.some(function (c) { return knownCount(seriesOf(d, c.key)) > 0; }));
    if (!anyKnown) {
      return '<div class="ph-trend-empty" role="status"><strong>Trend history starts after the first daily snapshot</strong>' +
        '<p>The health service records one reading per day, early each morning (Nairobi time). Until a reading has been ' +
        'recorded there is nothing to plot, so no line is drawn.</p></div>';
    }
    var first = overall[0].date, last = overall[overall.length - 1].date;
    var lk = latestKnown(overall);
    var html = '<div class="ph-trend-chart" data-series="overall">' +
      '<div class="ph-trend-head"><span class="ph-trend-name">Overall</span><span class="ph-trend-last">' +
      (lk ? esc(fmtScore(lk.v)) + ' <small>on ' + esc(lk.date) + '</small>' : DASH) + '</span></div>' +
      '<div class="ph-trend-plot"><div class="ph-axis" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div>' +
      '<svg class="ph-trend-svg overall" viewBox="0 0 600 180" role="img" aria-label="Overall health score by day, ' +
      esc(first) + ' to ' + esc(last) + '. Gaps are days with no reading.">' +
      (knownCount(overall) ? lineSvg(overall, { w: 600, h: 180, pad: 10, grid: true, markers: true }) : '') + '</svg></div>' +
      '<div class="ph-trend-range"><span>' + esc(first) + '</span><span>' + esc(last) + '</span></div></div>';
    html += '<div class="ph-multiples">' + CARDS.map(function (c) {
      var s = seriesOf(d, c.key);
      var l = latestKnown(s);
      return '<div class="ph-mini ' + c.tone + '" data-series="' + esc(c.key) + '"><div class="ph-trend-head">' +
        '<span class="ph-trend-name">' + esc(c.label) + '</span><span class="ph-trend-last">' +
        (l ? esc(fmtScore(l.v)) : DASH) + '</span></div>' +
        (knownCount(s) ? '<svg class="ph-trend-svg mini" viewBox="0 0 200 60" role="img" aria-label="' + esc(c.label) +
          ' by day. Gaps are days with no reading.">' + lineSvg(s, { w: 200, h: 60, pad: 5, grid: true, markers: true }) + '</svg>'
          : '<p class="ph-mini-empty">No reading recorded</p>') + '</div>';
    }).join('') + '</div>';
    /* table view: the same values, newest first, — for unknown */
    html += '<details class="ph-trend-table"><summary>Show data table</summary><div class="ph-table-wrap"><table>' +
      '<thead><tr><th scope="col">Date</th><th scope="col">Overall</th>' +
      CARDS.map(function (c) { return '<th scope="col">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      overall.slice().reverse().map(function (p) {
        var e = entryOn(d, p.date);
        var dims = e && e.dimensions && typeof e.dimensions === 'object' ? e.dimensions : {};
        return '<tr><th scope="row">' + esc(p.date) + '</th><td>' + fmtScore(p.v) + '</td>' +
          CARDS.map(function (c) { return '<td>' + fmtScore(isNum(dims[c.key]) ? dims[c.key] : null) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></details>';
    return html;
  }

  /* ── page blocks ─────────────────────────────────────────────────────────────── */

  function kpiCardHtml(card, x, d) {
    var known = !!x && isNum(x.score);
    var note;
    if (x && x.failed) {
      var e = x.error || {};
      note = '<span class="ph-kpi-note bad">Could not be computed' + (e.code ? ' (' + esc(e.code) + ')' : '') + '</span>';
    } else if (!x) {
      note = '<span class="ph-kpi-note">Not returned by the server</span>';
    } else {
      note = '<span class="ph-kpi-note">' + (known && x.grade ? 'Grade ' + esc(x.grade) + ' · ' : '') +
        card.weight + '% of overall' + (x.dataComplete === false ? ' · inputs incomplete' : '') + '</span>';
    }
    var spark = sparkHtml(seriesOf(d, card.key));
    return '<article class="ph-kpi" data-kpi="' + esc(card.id) + '" data-known="' + known + '">' +
      '<div class="ph-kpi-top"><span class="ph-tile ' + card.tone + '">' + icon(card.id) + '</span>' +
      '<h3 class="ph-kpi-label">' + esc(card.label) + '</h3></div>' +
      '<div class="ph-kpi-value"><span class="ph-kpi-num">' + fmtScore(known ? x.score : null) + '</span>' +
      (known ? '<span class="ph-kpi-unit">/100</span>' : '') +
      (known ? '<span class="ph-dot" style="background:' + scoreColor(x.score) + '" aria-hidden="true"></span>' : '') +
      '</div>' + deltaHtml(x) + note + (spark ? '<div class="ph-kpi-spark">' + spark + '</div>' : '') +
      '</article>';
  }

  /* Bar list, not a donut: the response has no "share of overall" field (see header). */
  function breakdownHtml(d) {
    return '<ul class="ph-bars" aria-label="Dimension scores out of 100">' + CARDS.map(function (c) {
      var x = dimension(d, c.key);
      var known = !!x && isNum(x.score);
      var bar = known
        ? '<span class="ph-bar" aria-hidden="true"><span class="ph-bar-fill ' + c.tone + '" style="width:' +
          pct(x.score, 100) + '%"></span></span>'
        : '<span class="ph-bar empty" aria-hidden="true"></span>';
      return '<li class="ph-bar-row" data-dim="' + esc(c.id) + '"><span class="ph-legend-dot ' + c.tone +
        '" aria-hidden="true"></span><span class="ph-bar-label">' + esc(c.label) +
        '<small>' + c.weight + '% weight</small></span>' + bar +
        '<span class="ph-bar-val">' + fmtScore(known ? x.score : null) + '</span></li>';
    }).join('') + '</ul>';
  }

  function dimRowHtml(dim) {
    if (!dim || typeof dim !== 'object') return '';
    var name = esc(dim.name);
    if (dim.missing) {
      return '<div class="score-dim"><div class="score-dim-header"><span class="score-dim-name">' +
        name + '</span></div><div class="dim-missing">' + esc(dim.value) + '</div></div>';
    }
    var bar = '';
    if (isNum(dim.contribution) && isNum(dim.max) && dim.max > 0) {
      var p = pct(dim.contribution, dim.max);
      bar = '<div class="score-dim-bar" aria-hidden="true"><div class="score-dim-fill" style="width:' + p +
        '%;background:' + scoreColor(p) + '"></div></div>';
    }
    return '<div class="score-dim"><div class="score-dim-header"><span class="score-dim-name">' +
      name + '</span><span class="score-dim-value">' + esc(dim.value == null ? DASH : dim.value) +
      '</span></div>' + bar + '</div>';
  }

  /* Drill-down card: the server's per-input rows for one dimension. */
  function cardHtml(card, data) {
    var x = data || {};
    var known = isNum(x.score);
    var body;
    if (x.failed) {
      var e = x.error || {};
      body = '<div class="dim-missing">Could not be computed' +
        (e.code ? ' (' + esc(e.code) + ')' : '') + (e.message ? ': ' + esc(e.message) : '') + '</div>';
    } else if (!data) {
      body = '<div class="dim-missing">Not returned by the server.</div>';
    } else {
      body = (Array.isArray(x.dimensions) ? x.dimensions : []).map(dimRowHtml).join('') ||
        '<div class="dim-missing">No input rows returned.</div>';
    }
    return '<div class="score-card" data-card="' + esc(card.id) + '" data-known="' + known + '">' +
      '<div class="score-card-header"><span class="ph-tile sm ' + card.tone + '">' + icon(card.id) + '</span>' +
      '<h3 class="score-card-name">' + esc(card.label) + '</h3>' +
      '<span class="score-card-val">' + fmtScore(x.score) + '</span></div>' +
      '<div class="score-dims">' + body + '</div></div>';
  }

  function alertsHtml(alerts) {
    if (!Array.isArray(alerts) || !alerts.length) return '';
    return alerts.map(function (a) {
      var sev = /^(high|medium|info)$/.test(a && a.severity) ? a.severity : 'info';
      return '<div class="ph-alert ' + sev + '"><strong class="ph-alert-area">' + esc(a && a.area) +
        '</strong><span>' + esc(a && a.message) + '</span></div>';
    }).join('');
  }

  function prioritiesList(res) {
    if (!res || typeof res !== 'object') return [];
    if (Array.isArray(res.topPriorities)) return res.topPriorities;
    if (Array.isArray(res.priorities)) return res.priorities;
    return [];
  }

  /* "Top" list: icon chip, name, bar = server totalScore out of 25 (only when numeric),
     value, the five criterion scores as text, and the server's evidence gate. */
  function prioritiesHtml(res) {
    var list = prioritiesList(res);
    if (!list.length) return '<p class="ph-empty">No priorities data yet.</p>';
    return '<ol class="ph-top">' + list.map(function (p) {
      p = p || {};
      var scored = isNum(p.totalScore);
      var bar = scored
        ? '<span class="ph-bar" aria-hidden="true"><span class="ph-bar-fill violet" style="width:' +
          pct(p.totalScore, PRIORITY_MAX) + '%"></span></span>' : '';
      var crit = CRITERIA.filter(function (c) { return isNum(p[c.key]); })
        .map(function (c) { return esc(c.label) + ' ' + p[c.key]; }).join(' · ');
      var badge = p.evidenceReady === true
        ? '<span class="ph-badge good">Evidence ready</span>'
        : '<span class="ph-badge">Waiting on evidence</span>';
      return '<li class="ph-top-row"><span class="ph-tile sm violet">' + icon('priority') + '</span>' +
        '<div class="ph-top-body"><div class="ph-top-head"><span class="pri-name">' + esc(p.name || p.title) +
        '</span><span class="ph-top-val">' + (scored ? fmtScore(p.totalScore) + '<small>/' + PRIORITY_MAX + '</small>' : DASH) +
        '</span></div>' + bar +
        (p.description ? '<div class="pri-desc">' + esc(p.description) + '</div>' : '') +
        (crit ? '<div class="pri-crit">' + crit + '</div>' : '') +
        '<div class="pri-gate">' + badge + '<span>' + esc(p.evidenceGate) + '</span></div></div></li>';
    }).join('') + '</ol>';
  }

  function signalsHtml(res) {
    var s = res && typeof res === 'object' && res.evidenceSignals && typeof res.evidenceSignals === 'object'
      ? res.evidenceSignals : null;
    if (!s) return '<p class="ph-empty">No evidence signals returned.</p>';
    return '<dl class="ph-fields">' + SIGNALS.map(function (g) {
      var v = s[g.key];
      return '<div><dt>' + esc(g.label) + '</dt><dd>' + (isNum(v) ? fmtNum(v) + (g.suffix || '') : DASH) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function sourcesHtml() {
    return '<ul class="ph-sources">' + CARDS.map(function (c) {
      return '<li><strong>' + esc(c.label) + '</strong><span>' + c.sources.map(esc).join(', ') + '</span></li>';
    }).join('') + '<li><strong>Business priorities</strong><span>' + PRIORITY_SOURCES.join(', ') +
      '</span></li></ul>';
  }

  /* Compact chips for AdminOS / super-admin: overall + the five dimensions. */
  function chips(d) {
    var list = [{ key: 'overall', label: 'Overall', score: d && d.overall && isNum(d.overall.score) ? d.overall.score : null }];
    CARDS.forEach(function (c) {
      var x = dimension(d, c.key);
      list.push({ key: c.key, label: c.label, score: x && isNum(x.score) ? x.score : null });
    });
    return list;
  }

  /* AdminOS / super-admin card body for one settled call. `outcome` is
     {status:'fulfilled', value} | {status:'rejected', reason}. */
  function chipsHtml(outcome) {
    if (!outcome || outcome.status === 'rejected') {
      var e = describeError(outcome && outcome.reason);
      return '<p class="ph-chip-note" role="alert">Health scores unavailable — ' + esc(e.lead) +
        (e.message ? ' ' + esc(e.message) : '') + ' <a href="platform-health.html">Open Platform Health</a></p>';
    }
    if (!hasHealthData(outcome.value)) {
      return '<p class="ph-chip-note">No health data yet.</p>';
    }
    return chips(outcome.value).map(function (c) {
      var known = isNum(c.score);
      var w = known ? Math.max(0, Math.min(100, Math.round(c.score))) : 0;
      return '<div class="health-chip" data-score="' + (known ? Math.round(c.score) : '') + '">' +
        '<span>' + esc(c.label) + '</span><strong>' + fmtScore(c.score) +
        (known ? '<small>/100</small>' : '') + '</strong>' +
        '<div class="health-bar"><div style="width:' + w + '%"></div></div></div>';
    }).join('');
  }

  /* ── full-page controller (platform-health.html) ─────────────────────────────── */

  function el(doc, id) { return doc.getElementById(id); }
  function show(doc, id, on, disp) { var e = el(doc, id); if (e) e.style.display = on ? (disp || 'block') : 'none'; }
  function setText(doc, id, t) { var e = el(doc, id); if (e) e.textContent = t; }
  function setHtml(doc, id, h) { var e = el(doc, id); if (e) e.innerHTML = h; }

  function setRing(fillEl, score, r, raf) {
    if (!fillEl) return;
    var circ = 2 * Math.PI * r;
    fillEl.style.strokeDasharray = circ;
    fillEl.style.strokeDashoffset = circ;
    fillEl.style.stroke = scoreColor(score);
    if (!isNum(score)) return;                       /* unknown: empty ring, no fill */
    var offset = circ - (Math.max(0, Math.min(100, score)) / 100) * circ;
    (raf || function (f) { f(); })(function () { fillEl.style.strokeDashoffset = offset; });
  }

  function setPill(doc, text, tone) {
    var p = el(doc, 'status-pill');
    if (!p) return;
    p.textContent = text;
    p.className = 'ph-pill ' + (tone || 'unknown');
  }

  function setBusy(doc, busy) {
    ['refresh-btn', 'panel-refresh-btn'].forEach(function (id) {
      var b = el(doc, id);
      if (!b) return;
      b.disabled = !!busy;
      if (b.setAttribute) b.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  /* Every non-data state resets the dynamic panel fields to the neutral mark. */
  function resetPanel(doc) {
    ['panel-computed', 'panel-pri-computed', 'panel-budget', 'panel-recommendation'].forEach(function (id) {
      setText(doc, id, DASH);
    });
    setHtml(doc, 'panel-signals', '<p class="ph-empty">' + DASH + '</p>');
    setHtml(doc, 'kpi-grid', '');
  }

  function heroUnknown(doc, title, sub) {
    setText(doc, 'overall-score', fmtScore(null));   /* the ONE unknown renderer */
    setText(doc, 'overall-grade', '');
    setText(doc, 'overall-title', title);
    setText(doc, 'overall-sub', sub || '');
    setRing(el(doc, 'overall-fill'), null, 50);
  }

  function renderLoading(doc) {
    show(doc, 'loading-state', true);
    show(doc, 'main-content', false);
    show(doc, 'empty-state', false);
    show(doc, 'error-state', false);
    show(doc, 'alerts-area', false);
    setText(doc, 'computed-at', 'Loading…');
    setPill(doc, 'Loading', 'unknown');
    resetPanel(doc);
    setBusy(doc, true);
    heroUnknown(doc, 'Computing scores…', '');
  }

  function renderError(doc, err, opts) {
    var e = describeError(err);
    show(doc, 'loading-state', false);
    show(doc, 'main-content', false);
    show(doc, 'empty-state', false);
    show(doc, 'error-state', true);
    setText(doc, 'error-title', e.lead);
    setText(doc, 'error-message', e.message + (e.code && e.code !== 'unknown' ? ' [' + e.code + ']' : ''));
    var retry = el(doc, 'retry-btn');
    if (retry) {
      retry.style.display = opts && opts.noRetry ? 'none' : '';
      if (opts && typeof opts.onRetry === 'function') retry.onclick = opts.onRetry;
    }
    if (opts && typeof opts.onRetry === 'function') {
      ['refresh-btn', 'panel-refresh-btn'].forEach(function (id) { var b = el(doc, id); if (b) b.onclick = opts.onRetry; });
    }
    setText(doc, 'computed-at', 'Not loaded');
    setPill(doc, 'Not loaded', 'unknown');
    resetPanel(doc);
    setBusy(doc, !!(opts && opts.noRetry));
    heroUnknown(doc, 'Health data unavailable', '');
    return e;
  }

  function renderEmpty(doc) {
    show(doc, 'loading-state', false);
    show(doc, 'main-content', false);
    show(doc, 'error-state', false);
    show(doc, 'empty-state', true);
    setText(doc, 'computed-at', 'No data yet');
    setPill(doc, 'No data yet', 'unknown');
    resetPanel(doc);
    setBusy(doc, false);
    heroUnknown(doc, 'No health data yet', 'The health service answered but returned no measurable dimension.');
  }

  function renderData(doc, d, pri, raf) {
    var ov = overallView(d);
    setText(doc, 'overall-score', ov.score);
    setText(doc, 'overall-grade', ov.grade);
    setText(doc, 'overall-title', ov.title);
    setText(doc, 'overall-sub', ov.sub);
    setRing(el(doc, 'overall-fill'), ov.known ? d.overall.score : null, 50, raf);
    setPill(doc, ov.pill, ov.tone);
    setHtml(doc, 'computed-at', 'Computed ' + timeHtml(d.computedAt));

    var alerts = alertsHtml(d.alerts);
    var area = el(doc, 'alerts-area');
    if (area) { area.innerHTML = alerts; area.style.display = alerts ? 'flex' : 'none'; }

    setHtml(doc, 'kpi-grid', CARDS.map(function (c) { return kpiCardHtml(c, dimension(d, c.key), d); }).join(''));
    setHtml(doc, 'trend-area', trendHtml(d));
    setHtml(doc, 'breakdown-area', breakdownHtml(d));
    setHtml(doc, 'scores-grid', CARDS.map(function (c) { return cardHtml(c, dimension(d, c.key)); }).join(''));

    var pa = el(doc, 'priorities-area');
    var priOk = pri && pri.status === 'fulfilled';
    if (pa) {
      if (priOk) pa.innerHTML = prioritiesHtml(pri.value);
      else {
        var e = describeError(pri && pri.reason);
        pa.innerHTML = '<div class="ph-error" role="alert">Priorities unavailable — ' + esc(e.lead) +
          (e.message ? ' ' + esc(e.message) : '') + '</div>';
      }
    }

    /* details panel — server values only */
    setHtml(doc, 'panel-computed', timeHtml(d.computedAt));
    setHtml(doc, 'panel-pri-computed', priOk && pri.value ? timeHtml(pri.value.computedAt) : DASH);
    setText(doc, 'panel-budget', d.indexBudget && isNum(d.indexBudget.used) && isNum(d.indexBudget.max)
      ? d.indexBudget.used + ' / ' + d.indexBudget.max + ' indexes' : DASH);
    setText(doc, 'panel-recommendation', priOk && pri.value && typeof pri.value.recommendation === 'string' &&
      pri.value.recommendation ? pri.value.recommendation : DASH);
    setHtml(doc, 'panel-signals', priOk ? signalsHtml(pri.value) : '<p class="ph-empty">' + DASH + '</p>');

    show(doc, 'loading-state', false);
    show(doc, 'error-state', false);
    show(doc, 'empty-state', false);
    show(doc, 'main-content', true);
    setBusy(doc, false);
  }

  /* deps: { doc, callScores(), callPriorities(), timeoutMs, raf }
     Resolves to the state rendered: 'data' | 'empty' | 'error'. Never rejects. */
  function load(deps) {
    var doc = deps.doc;
    var ms = deps.timeoutMs;
    renderLoading(doc);
    var retry = function () { return load(deps); };
    ['refresh-btn', 'panel-refresh-btn'].forEach(function (id) {
      var b = el(doc, id);
      if (b) b.onclick = retry;                       /* Refresh = re-call the server */
    });
    function settle(p) {
      return p.then(function (v) { return { status: 'fulfilled', value: v }; },
                    function (e) { return { status: 'rejected', reason: e }; });
    }
    function call(fn, label) {
      try { return withTimeout(fn(), ms, label); } catch (e) { return Promise.reject(e); }
    }
    return Promise.all([
      settle(call(deps.callScores, 'Platform health scores')),
      settle(call(deps.callPriorities, 'Business priorities')),
    ]).then(function (r) {
      var sc = r[0], pri = r[1];
      if (sc.status === 'rejected') {
        renderError(doc, sc.reason, { onRetry: retry });
        return 'error';
      }
      var d = sc.value && sc.value.data !== undefined ? sc.value.data : sc.value;
      if (pri.status === 'fulfilled' && pri.value && pri.value.data !== undefined) pri = { status: 'fulfilled', value: pri.value.data };
      if (!hasHealthData(d)) { renderEmpty(doc); return 'empty'; }
      renderData(doc, d, pri, deps.raf);
      return 'data';
    }).catch(function (e) {
      /* a render defect must surface, not spin */
      renderError(doc, e, { onRetry: retry });
      return 'error';
    });
  }

  var api = {
    DASH: DASH, CARDS: CARDS, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, PRIORITY_MAX: PRIORITY_MAX,
    esc: esc, isNum: isNum, fmtScore: fmtScore, scoreColor: scoreColor,
    isAdminClaims: isAdminClaims, backLink: backLink, withTimeout: withTimeout, describeError: describeError,
    hasHealthData: hasHealthData, overallView: overallView, cardHtml: cardHtml, kpiCardHtml: kpiCardHtml,
    trendHtml: trendHtml, breakdownHtml: breakdownHtml, sparkHtml: sparkHtml, deltaHtml: deltaHtml,
    seriesOf: seriesOf, segments: segments, SERIES_FIELD: SERIES_FIELD,
    prioritiesList: prioritiesList, prioritiesHtml: prioritiesHtml, signalsHtml: signalsHtml,
    sourcesHtml: sourcesHtml,
    chips: chips, chipsHtml: chipsHtml,
    renderLoading: renderLoading, renderError: renderError, renderEmpty: renderEmpty,
    renderData: renderData, load: load,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SokoniPlatformHealthView = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
