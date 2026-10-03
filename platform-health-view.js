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

   UI DATA INTEGRITY: a score that is not a finite number renders "—". Never 0, never a
   colour that implies a grade, never a verdict. A canonical 0 from the server renders 0.

   Plain IIFE: loads as a classic <script> (window.SokoniPlatformHealthView) and under Node
   (module.exports) so scripts/test-platform-health-page.js runs it without a browser.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var DASH = '—';
  var DEFAULT_TIMEOUT_MS = 45000;

  /* The five dimensions exactly as getPlatformHealthScores returns them (keys) with the
     weights its overall formula uses. */
  var CARDS = [
    { id: 'marketplace', key: 'marketplace', label: 'Marketplace Health', weight: 30 },
    { id: 'seller',      key: 'seller',      label: 'Seller Success',     weight: 25 },
    { id: 'buyer',       key: 'buyer',       label: 'Buyer Satisfaction', weight: 25 },
    { id: 'operational', key: 'operational', label: 'Operational Health', weight: 15 },
    { id: 'cost',        key: 'cost',        label: 'Cost Efficiency',    weight: 5  },
  ];

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtScore(v) { return isNum(v) ? String(Math.round(v)) : DASH; }
  function scoreColor(s) {
    if (!isNum(s)) return '#9ca3af';            /* unknown = neutral grey, not red */
    if (s >= 80) return '#16a34a';
    if (s >= 60) return '#d97706';
    return '#dc2626';
  }

  /* Same rule as the server's requireAdmin (admin === true || superAdmin === true). */
  function isAdminClaims(claims) {
    return !!claims && (claims.admin === true || claims.superAdmin === true);
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
        title: 'Overall score unavailable',
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
      sub: '',
    };
  }

  function timeText(iso) {
    var t = iso ? new Date(iso) : null;
    if (!t || isNaN(t.getTime())) return DASH;
    try { return t.toLocaleString('en-KE'); } catch (_) { return t.toISOString(); }
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
      var pct = Math.max(0, Math.min(100, Math.round((dim.contribution / dim.max) * 100)));
      bar = '<div class="score-dim-bar"><div class="score-dim-fill" style="width:' + pct +
        '%;background:' + scoreColor(pct) + '"></div></div>';
    }
    return '<div class="score-dim"><div class="score-dim-header"><span class="score-dim-name">' +
      name + '</span><span class="score-dim-value">' + esc(dim.value == null ? DASH : dim.value) +
      '</span></div>' + bar + '</div>';
  }

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
      body = (Array.isArray(x.dimensions) ? x.dimensions : []).map(dimRowHtml).join('');
    }
    var circ = 2 * Math.PI * 28;
    return '<div class="score-card" data-card="' + esc(card.id) + '" data-known="' + known + '">' +
      '<div class="score-card-header"><div class="score-ring-sm"><svg viewBox="0 0 64 64">' +
      '<circle class="track" cx="32" cy="32" r="28"/>' +
      '<circle class="fill" id="ring-' + esc(card.id) + '" cx="32" cy="32" r="28" stroke-dasharray="' +
      circ + '" stroke-dashoffset="' + circ + '"/></svg>' +
      '<div class="score-ring-label"><span class="sv" style="color:' + scoreColor(x.score) + '">' +
      fmtScore(x.score) + '</span><span class="gv">' + esc(known && x.grade ? x.grade : '') + '</span></div></div>' +
      '<div><div class="score-card-name">' + esc(card.label) + '</div>' +
      '<div class="score-card-weight">' + card.weight + '% of overall</div></div></div>' +
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

  function pips(val) {
    var n = isNum(val) ? val : 0;
    var out = '';
    for (var i = 0; i < 5; i++) out += '<div class="criterion-pip' + (i < n ? ' filled' : '') + '"></div>';
    return out;
  }

  function prioritiesList(res) {
    if (!res || typeof res !== 'object') return [];
    if (Array.isArray(res.topPriorities)) return res.topPriorities;
    if (Array.isArray(res.priorities)) return res.priorities;
    return [];
  }

  function prioritiesHtml(res) {
    var list = prioritiesList(res);
    if (!list.length) return '<p class="ph-empty">No priorities data yet.</p>';
    var rows = list.map(function (p, i) {
      var badgeBg = i === 0 ? '#6366f1' : i === 1 ? '#3b82f6' : '#6b7280';
      var ready = p.evidenceReady
        ? '<span class="pri-ready-badge">Ready</span>'
        : (isNum(p.totalScore) && p.totalScore >= 18
          ? '<span class="pri-wait-badge">Phase B</span>'
          : '<span class="pri-block-badge">Phase C</span>');
      var sp = '<span style="width:8px"></span>';
      return '<tr><td><span class="pri-score-badge" style="background:' + badgeBg + '">' +
        fmtScore(p.totalScore) + '</span></td><td><div class="pri-name">' + esc(p.name || p.title) +
        '</div><div class="pri-desc">' + esc(p.description) + '</div></td>' +
        '<td class="hide-mobile"><div style="font-size:.75rem;margin-bottom:4px">Revenue · Demand · Effort · Strategic · Cost</div>' +
        '<div class="criterion-row">' + pips(p.revenueImpact) + sp + pips(p.userDemand) + sp +
        pips(p.effortInverse) + sp + pips(p.strategic) + sp + pips(p.costInverse) + '</div></td>' +
        '<td>' + ready + '<div style="font-size:.72rem;color:#6b7280;margin-top:4px">' +
        esc(p.evidenceGate) + '</div></td></tr>';
    }).join('');
    return '<table class="priorities-table"><thead><tr><th>Score</th><th>Initiative</th>' +
      '<th class="hide-mobile">Scoring</th><th>Evidence Gate</th></tr></thead><tbody>' + rows +
      '</tbody></table><p style="font-size:.8rem;color:#6b7280;margin-bottom:24px">Each criterion ' +
      'scored 1–5 (max 25). Scores adjust based on live Firestore evidence. Only start "Ready" ' +
      'initiatives — all others wait for Phase A/B data.</p>';
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
    setText(doc, 'computed-at', 'Not loaded');
    heroUnknown(doc, 'Health data unavailable', '');
    return e;
  }

  function renderEmpty(doc) {
    show(doc, 'loading-state', false);
    show(doc, 'main-content', false);
    show(doc, 'error-state', false);
    show(doc, 'empty-state', true);
    setText(doc, 'computed-at', 'No data yet');
    heroUnknown(doc, 'No health data yet', 'The health service answered but returned no measurable dimension.');
  }

  function renderData(doc, d, pri, raf) {
    var ov = overallView(d);
    setText(doc, 'overall-score', ov.score);
    setText(doc, 'overall-grade', ov.grade);
    setText(doc, 'overall-title', ov.title);
    var budget = d.indexBudget && isNum(d.indexBudget.used) && isNum(d.indexBudget.max)
      ? 'Index budget: ' + d.indexBudget.used + '/' + d.indexBudget.max : '';
    setText(doc, 'overall-sub', [ov.sub, budget].filter(Boolean).join(' · '));
    setRing(el(doc, 'overall-fill'), ov.known ? d.overall.score : null, 50, raf);
    setText(doc, 'computed-at', 'Last updated: ' + timeText(d.computedAt));

    var alerts = alertsHtml(d.alerts);
    var area = el(doc, 'alerts-area');
    if (area) { area.innerHTML = alerts; area.style.display = alerts ? 'flex' : 'none'; }

    var grid = el(doc, 'scores-grid');
    if (grid) grid.innerHTML = CARDS.map(function (c) { return cardHtml(c, dimension(d, c.key)); }).join('');
    CARDS.forEach(function (c) {
      var x = dimension(d, c.key);
      setRing(el(doc, 'ring-' + c.id), x && isNum(x.score) ? x.score : null, 28, raf);
    });

    var pa = el(doc, 'priorities-area');
    if (pa) {
      if (pri.status === 'fulfilled') pa.innerHTML = prioritiesHtml(pri.value);
      else {
        var e = describeError(pri.reason);
        pa.innerHTML = '<div class="ph-error" role="alert">Priorities unavailable — ' + esc(e.lead) +
          (e.message ? ' ' + esc(e.message) : '') + '</div>';
      }
    }

    show(doc, 'loading-state', false);
    show(doc, 'error-state', false);
    show(doc, 'empty-state', false);
    show(doc, 'main-content', true);
  }

  /* deps: { doc, callScores(), callPriorities(), timeoutMs, raf }
     Resolves to the state rendered: 'data' | 'empty' | 'error'. Never rejects. */
  function load(deps) {
    var doc = deps.doc;
    var ms = deps.timeoutMs;
    renderLoading(doc);
    var retry = function () { return load(deps); };
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
    DASH: DASH, CARDS: CARDS, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    esc: esc, isNum: isNum, fmtScore: fmtScore, scoreColor: scoreColor,
    isAdminClaims: isAdminClaims, withTimeout: withTimeout, describeError: describeError,
    hasHealthData: hasHealthData, overallView: overallView, cardHtml: cardHtml,
    prioritiesList: prioritiesList, prioritiesHtml: prioritiesHtml,
    chips: chips, chipsHtml: chipsHtml,
    renderLoading: renderLoading, renderError: renderError, renderEmpty: renderEmpty,
    renderData: renderData, load: load,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SokoniPlatformHealthView = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
