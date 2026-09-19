/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — ACTIVITY FEED for AdminOS
   sokoni-aos-activity.js

   The Audit Center's flat table, turned into something an administrator can actually read:
   a day-grouped timeline, category filters, a contributor breakdown and an activity shape —
   all computed from the SAME logs the table already fetched.

   ── WHAT THE SOURCE ACTUALLY GIVES US ───────────────────────────────────────────────────
   adminGetAuditLogs (and its payment / security / platform siblings) return

       { logs: [ … ] }        capped by a limit. No total. No cursor. No read state.

   That single fact decides most of this page:

     • THERE IS NO PLATFORM TOTAL. Every count here is "of the N loaded", and says so.
       Printing a headline figure the query never measured is the easiest lie a feed can
       tell, because it looks like the most ordinary number on the screen.

     • THERE IS NO UNREAD. Nothing anywhere records whether an administrator has seen an
       entry, so there is no Unread filter and no "mark all as read". A chip that counted
       nothing would be a control that cannot work.

     • THERE IS NO DAY-OVER-DAY TREND. The window is a fixed COUNT, not a date range, so its
       oldest day is usually truncated mid-day. Comparing a complete day to a truncated one
       produces a percentage that is always wrong and always plausible. Instead the feed
       MARKS the truncated day, which is the honest and more useful thing: it tells you the
       bottom of your view is not a whole day.

   ── WHAT IS GENUINELY DERIVABLE, AND IS SHOWN ───────────────────────────────────────────
   Category counts, per-day counts, the span the view covers, who acted and how often, and
   the shape of activity across the covered hours — all counted from the loaded entries.

   ADDITIVE. It renders into the existing #auditBody and returns false if it cannot, so the
   original table still runs. It performs no write, no export of its own, and no navigation.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CSS_ID = 'sokoni-aos-activity-css';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ms (t) {
    if (!t) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    var n = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(n) ? n : null;
  }
  function clock (m) {
    return m ? new Date(m).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function dayKey (m) { return m ? new Date(m).toISOString().slice(0, 10) : 'unknown'; }
  function dayLabel (k) {
    if (k === 'unknown') return 'Undated';
    var today = new Date().toISOString().slice(0, 10);
    var yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (k === today) return 'Today';
    if (k === yest) return 'Yesterday';
    return new Date(k + 'T00:00:00').toLocaleDateString('en-KE',
      { weekday: 'long', day: 'numeric', month: 'short' });
  }

  /* ── CATEGORIES ────────────────────────────────────────────────────────────────────────
     Derived from the action token, which is the only thing every log source reliably
     carries. An entry that matches nothing is "other" rather than being forced into a
     bucket — a feed that files everything as "security" teaches people to ignore the word. */
  var CATS = [
    { id: 'security', label: 'Security', icon: '🛡️',
      re: /login|auth|mfa|password|session|token|permission|role|admin|block|fraud|breach|suspicious/i },
    { id: 'money', label: 'Money', icon: '💳',
      re: /payment|payout|refund|invoice|charge|settle|wallet|commission|price|billing/i },
    { id: 'approval', label: 'Approvals', icon: '✅',
      re: /approv|reject|verif|review|grant|deny|decision/i },
    { id: 'data', label: 'Data', icon: '🗂️',
      re: /create|update|delete|export|import|upload|publish|archive|edit/i },
    { id: 'system', label: 'System', icon: '⚙️',
      re: /system|config|deploy|job|cron|sync|migrat|index|automation/i },
  ];
  function catOf (entry) {
    var t = String(entry.action || entry.event || entry.type || '');
    for (var i = 0; i < CATS.length; i++) if (CATS[i].re.test(t)) return CATS[i];
    return { id: 'other', label: 'Other', icon: '•', re: null };
  }
  function catById (id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i];
    return { id: 'other', label: 'Other', icon: '•' };
  }

  /* Severity, only where a source actually states one. Nothing is inferred from wording —
     guessing that "delete" is high would put a badge on routine housekeeping. */
  function sevOf (e) {
    var s = String(e.severity || e.level || '').toLowerCase();
    if (/crit|high|danger/.test(s)) return 'high';
    if (/med|warn/.test(s)) return 'med';
    if (/low|info/.test(s)) return 'low';
    return null;
  }

  /* WHAT THE ENTRY WAS ABOUT. The writers do record a target — they just each name it for
     the thing it is (`orderId`, `productId`, `notificationId`…) rather than using one
     generic key. Reading only `targetId`/`target`/`entityId` left the column empty on every
     row of a live page while the id sat in the document. The field NAME is kept alongside
     the value, because "ORD-1" means something different under orderId than under shopId.
     `uid` and `performedBy` are excluded: those are the actor, not the target. */
  var TARGET_FIELDS = ['targetId', 'target', 'entityId', 'orderId', 'productId', 'invoiceId',
                       'shopId', 'sellerId', 'payoutId', 'disputeId', 'ticketId',
                       'notificationId', 'targetUid', 'targetUserId'];
  function targetOf (l) {
    for (var i = 0; i < TARGET_FIELDS.length; i++) {
      var k = TARGET_FIELDS[i], v = l && l[k];
      if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') {
        return { key: k, value: String(v) };
      }
    }
    return null;
  }

  function normalise (logs) {
    return (logs || []).map(function (l) {
      var m = ms(l.createdAt || l.timestamp || l.ts || l.at);
      var tg = targetOf(l);
      return {
        raw: l,
        ms: m,
        day: dayKey(m),
        action: l.action || l.event || l.type || 'event',
        actor: l.adminEmail || l.actorEmail || l.adminUid || l.uid || l.performedBy || 'system',
        target: tg ? tg.value : '',
        targetField: tg ? tg.key : '',
        details: typeof l.details === 'object' && l.details !== null
          ? JSON.stringify(l.details) : (l.details || ''),
        cat: catOf(l),
        sev: sevOf(l),
      };
    }).sort(function (a, b) { return (b.ms || 0) - (a.ms || 0); });
  }

  /* ── THE TRUNCATION FACT ───────────────────────────────────────────────────────────────
     The query is capped by COUNT. When the cap is hit, the oldest day in the view is almost
     certainly cut off part-way through, so its count is not that day's count. Saying so is
     the difference between a feed you can reason about and one that quietly under-reports
     its own bottom row. */
  function truncation (items, limit) {
    if (!items.length || !limit || items.length < limit) return null;
    var oldest = items[items.length - 1];
    return { day: oldest.day, at: oldest.ms };
  }

  /* ── EVENT DETAIL ────────────────────────────────────────────────────────────
     An audit entry in this platform carries an ACTION, an ACTOR and a TIME, plus whatever
     that particular writer attached. It does NOT carry an IP address, a device or browser,
     an environment, a risk level or a compliance framework — nothing writes them, so none
     is shown. What is shown instead is the raw document, which is the honest answer to
     "what exactly was recorded": every field the writer actually set, and no more. */
  var DETAIL_KNOWN = ['action', 'event', 'type', 'createdAt', 'timestamp', 'ts', 'at',
                      'adminEmail', 'actorEmail', 'adminUid', 'uid', 'performedBy'];

  function detailRow (i) {
    var raw = i.raw || {};
    var extras = Object.keys(raw).filter(function (k) {
      return DETAIL_KNOWN.indexOf(k) === -1 && k !== 'id' && k !== i.targetField &&
             raw[k] !== null && raw[k] !== undefined && raw[k] !== '';
    });
    var val = function (v) {
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return '[object]'; } }
      return String(v);
    };
    return '<tr class="acx-drow"><td colspan="6"><div class="acx-detail">' +
      '<div class="acx-d-grid">' +
        '<div class="acx-d-k">Action</div><div class="acx-d-v"><b>' + esc(i.action) + '</b></div>' +
        '<div class="acx-d-k">Actor</div><div class="acx-d-v">' + esc(i.actor) + '</div>' +
        '<div class="acx-d-k">When</div><div class="acx-d-v">' +
          (i.ms ? esc(new Date(i.ms).toLocaleString('en-KE')) : '<i>no timestamp recorded</i>') +
        '</div>' +
        '<div class="acx-d-k">Target</div><div class="acx-d-v">' +
          (i.target ? esc(i.target) + '<small>recorded as <code>' + esc(i.targetField) +
                      '</code></small>'
                    : '<i>this entry names no target</i>') + '</div>' +
        '<div class="acx-d-k">Category</div><div class="acx-d-v">' +
          esc(i.cat.icon) + ' ' + esc(i.cat.label) +
          '<small>derived from the action name, not a stored field</small></div>' +
        '<div class="acx-d-k">Severity</div><div class="acx-d-v">' +
          (i.sev ? esc(i.sev) : '<i>this source states none</i>') + '</div>' +
        (extras.length
          ? extras.map(function (k) {
              return '<div class="acx-d-k">' + esc(k) + '</div><div class="acx-d-v">' +
                esc(val(raw[k])) + '</div>';
            }).join('')
          : '<div class="acx-d-k">Detail</div><div class="acx-d-v"><i>this writer recorded ' +
            'nothing beyond the action, actor and time</i></div>') +
      '</div>' +
      '<div class="acx-d-note">An audit entry here records <b>who did what, and when</b>. ' +
        'There is no IP address, device, browser, environment, risk level or compliance tag ' +
        'on it — nothing writes those, so none is shown rather than filled in.</div>' +
    '</div></td></tr>';
  }

  function render (host, state) {
    var items = state.items, limit = state.limit;
    var trunc = truncation(items, limit);

    /* Category tallies, counted from what is loaded — never claimed as a platform total. */
    var tally = {}; CATS.concat([{ id: 'other' }]).forEach(function (c) { tally[c.id] = 0; });
    items.forEach(function (i) { tally[i.cat.id] = (tally[i.cat.id] || 0) + 1; });

    var visible = items.filter(function (i) {
      if (state.cat !== 'all' && i.cat.id !== state.cat) return false;
      if (!state.q) return true;
      var hay = (i.action + ' ' + i.actor + ' ' + i.target + ' ' + i.details).toLowerCase();
      return hay.indexOf(state.q) > -1;
    });

    /* Contributors, from the loaded window. */
    var by = {};
    items.forEach(function (i) { by[i.actor] = (by[i.actor] || 0) + 1; });
    var contributors = Object.keys(by).map(function (k) { return { actor: k, n: by[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 6);
    var topN = contributors.length ? contributors[0].n : 1;

    /* The span the view actually covers — the honest replacement for "last 24 hours". */
    var withTime = items.filter(function (i) { return i.ms; });
    var newest = withTime.length ? withTime[0].ms : null;
    var oldest = withTime.length ? withTime[withTime.length - 1].ms : null;
    var spanH = (newest && oldest) ? Math.max(1, Math.round((newest - oldest) / 3600000)) : null;

    /* Activity shape across the covered hours. A bar chart of real buckets, not a smoothed
       curve — a curve implies a continuous measurement nobody took. */
    var buckets = new Array(12).fill(0);
    if (newest && oldest && newest > oldest) {
      var span = newest - oldest;
      withTime.forEach(function (i) {
        var b = Math.min(11, Math.floor(((i.ms - oldest) / span) * 12));
        buckets[b]++;
      });
    }
    var peak = Math.max.apply(null, buckets.concat([1]));

    /* Day groups, preserving order. */
    var groups = [], seen = {};
    visible.forEach(function (i) {
      if (!seen[i.day]) { seen[i.day] = { day: i.day, items: [] }; groups.push(seen[i.day]); }
      seen[i.day].items.push(i);
    });

    var chip = function (id, label, icon, n, on) {
      return '<button class="acx-chip' + (on ? ' on' : '') + '" data-acx="cat" data-cat="' +
        esc(id) + '"><span class="acx-chip-i">' + icon + '</span>' + esc(label) +
        '<span class="acx-chip-n">' + n + '</span></button>';
    };

    host.innerHTML =
      '<div class="acx">' +

      /* ── HEAD ──────────────────────────────────────────────────────────── */
      '<div class="acx-head">' +
        '<div class="acx-head-l">' +
          '<div class="acx-count">' + items.length +
            '<span>' + (trunc ? 'entries loaded (capped)' : 'entries loaded') + '</span></div>' +
          '<div class="acx-span">' +
            (spanH ? 'Covering about ' + spanH + ' hour' + (spanH === 1 ? '' : 's') +
                     ', newest first' : 'No timestamps on these entries') +
          '</div>' +
        '</div>' +
        '<div class="acx-search">' +
          '<input class="acx-in" type="search" placeholder="Search activity…" ' +
            'value="' + esc(state.qRaw || '') + '" data-acx="q" aria-label="Search activity">' +
          /* TWO READINGS OF ONE SOURCE, not two components. The timeline answers "what has
             been happening"; the log answers "what exactly happened, row by row". Both
             render the SAME normalised entries, so they cannot disagree. */
          '<div class="acx-view" role="group" aria-label="View">' +
            '<button class="acx-vb' + (state.view !== 'log' ? ' is-on' : '') +
              '" data-acx="view" data-v="timeline">Timeline</button>' +
            '<button class="acx-vb' + (state.view === 'log' ? ' is-on' : '') +
              '" data-acx="view" data-v="log">Log</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* ── FILTER CHIPS. Counts are of the loaded set, and the strip says so. ── */
      '<div class="acx-chips">' +
        chip('all', 'All', '📋', items.length, state.cat === 'all') +
        CATS.map(function (c) {
          return tally[c.id] ? chip(c.id, c.label, c.icon, tally[c.id], state.cat === c.id) : '';
        }).join('') +
        (tally.other ? chip('other', 'Other', '•', tally.other, state.cat === 'other') : '') +
      '</div>' +

      '<div class="acx-body">' +

        /* ── LOG. The same entries as rows, for reading one event precisely. ── */
        (state.view === 'log'
          ? '<div class="acx-log">' +
              (visible.length
                ? '<div class="acx-tw"><table class="acx-t"><thead><tr>' +
                    '<th>Time</th><th>Actor</th><th>Action</th><th>Target</th>' +
                    '<th>Category</th><th>Severity</th>' +
                  '</tr></thead><tbody>' +
                  visible.map(function (i, n) {
                    return '<tr' + (state.open === String(n) ? ' class="is-open"' : '') +
                      ' data-acx="row" data-n="' + n + '">' +
                      '<td class="acx-dim">' +
                        (i.ms ? esc(new Date(i.ms).toLocaleDateString('en-KE',
                                 { day: 'numeric', month: 'short' })) +
                                '<small>' + esc(clock(i.ms)) + '</small>'
                              : 'no timestamp') + '</td>' +
                      '<td>' + esc(i.actor) + '</td>' +
                      '<td><b>' + esc(i.action) + '</b></td>' +
                      '<td class="acx-dim">' + (i.target
                        ? esc(i.target) + '<small>' + esc(i.targetField) + '</small>'
                        : 'none recorded') + '</td>' +
                      '<td class="acx-dim">' + esc(i.cat.icon) + ' ' + esc(i.cat.label) + '</td>' +
                      /* Severity ONLY where the source states one. The blank is the answer. */
                      '<td>' + (i.sev
                        ? '<span class="acx-sev acx-sev--' + i.sev + '">' + esc(i.sev) + '</span>'
                        : '<span class="acx-dim">not stated</span>') + '</td>' +
                    '</tr>' +
                    (state.open === String(n) ? detailRow(i) : '');
                  }).join('') +
                  '</tbody></table></div>'
                : '<div class="acx-none"><b>' +
                    (items.length ? 'Nothing matches this filter' : 'No activity recorded') +
                  '</b><span>' + (items.length ? 'Clear the search or choose another category.'
                                               : 'This source returned no entries.') +
                  '</span></div>') +
            '</div>'
          : '') +

        /* ── TIMELINE ────────────────────────────────────────────────────── */
        (state.view === 'log' ? '' :
        '<div class="acx-feed">' +
          (groups.length ? groups.map(function (g) {
            var isTrunc = trunc && trunc.day === g.day;
            return '<section class="acx-day">' +
              '<div class="acx-day-h">' +
                '<span class="acx-day-t">' + esc(dayLabel(g.day)) + '</span>' +
                '<span class="acx-day-n">' + g.items.length + ' shown</span>' +
              '</div>' +
              '<ol class="acx-list">' + g.items.map(function (i) {
                return '<li class="acx-it">' +
                  '<time class="acx-it-t">' + esc(clock(i.ms)) + '</time>' +
                  '<span class="acx-it-ico acx-c--' + esc(i.cat.id) + '">' + i.cat.icon + '</span>' +
                  '<div class="acx-it-b">' +
                    '<div class="acx-it-a">' + esc(i.action) +
                      (i.sev ? '<span class="acx-sev acx-sev--' + i.sev + '">' +
                        esc(i.sev) + '</span>' : '') + '</div>' +
                    (i.details ? '<div class="acx-it-d">' + esc(i.details.slice(0, 140)) + '</div>' : '') +
                  '</div>' +
                  '<div class="acx-it-m">' +
                    '<span class="acx-it-who">' + esc(i.actor) + '</span>' +
                    (i.target ? '<span class="acx-it-tg">' + esc(i.target) + '</span>' : '') +
                  '</div>' +
                '</li>';
              }).join('') + '</ol>' +
              /* THE TRUNCATION MARKER. */
              (isTrunc ? '<div class="acx-trunc">This day is cut off by the ' + limit +
                '-entry limit — it is not a full day\'s activity. Raise the limit to see more.' +
                '</div>' : '') +
            '</section>';
          }).join('') :
            '<div class="acx-none"><b>' +
              (items.length ? 'Nothing matches this filter' : 'No activity recorded') +
            '</b><span>' + (items.length ? 'Clear the search or choose another category.'
                                          : 'This source returned no entries.') + '</span></div>') +
        '</div>') +

        /* ── SIDE ────────────────────────────────────────────────────────── */
        '<aside class="acx-side">' +

          '<div class="acx-card">' +
            '<div class="acx-card-h">Activity shape' +
              '<span class="acx-src">this view</span></div>' +
            (spanH
              ? '<div class="acx-spark">' + buckets.map(function (b) {
                  return '<i style="height:' + Math.max(3, Math.round((b / peak) * 100)) + '%" ' +
                    'title="' + b + ' entr' + (b === 1 ? 'y' : 'ies') + '"></i>';
                }).join('') + '</div>' +
                '<div class="acx-card-f">' + items.length + ' entries across ~' + spanH +
                'h · busiest bucket ' + peak + '</div>'
              : '<div class="acx-none acx-none--sm"><b>No timestamps</b>' +
                '<span>These entries carry no time, so no shape can be drawn.</span></div>') +
          '</div>' +

          '<div class="acx-card">' +
            '<div class="acx-card-h">Who acted' +
              '<span class="acx-src">this view</span></div>' +
            (contributors.length
              ? '<ul class="acx-cont">' + contributors.map(function (c) {
                  return '<li>' +
                    '<span class="acx-cont-n">' + esc(c.actor) + '</span>' +
                    '<span class="acx-cont-bar"><i style="width:' +
                      Math.round((c.n / topN) * 100) + '%"></i></span>' +
                    '<span class="acx-cont-v">' + c.n + '</span>' +
                  '</li>';
                }).join('') + '</ul>'
              : '<div class="acx-none acx-none--sm"><b>No actors recorded</b></div>') +
          '</div>' +

          /* ── WHAT THIS VIEW IS NOT ───────────────────────────────────────
             Stated on the page, because the three things a feed is expected to show and
             this one cannot are exactly the three someone would otherwise invent. */
          '<div class="acx-card acx-card--note">' +
            '<div class="acx-card-h">About these numbers</div>' +
            '<ul class="acx-note">' +
              '<li>Every count is <b>of the ' + items.length + ' entries loaded</b>, not a ' +
                'platform total — this source returns a capped page and no total.</li>' +
              '<li>There is <b>no unread state</b>: nothing records whether an entry has ' +
                'been seen, so there is no unread filter.</li>' +
              '<li>There is <b>no day-over-day change</b>: the window is a fixed count, so ' +
                'its oldest day is usually part-complete and would not compare fairly.</li>' +
            '</ul>' +
          '</div>' +

        '</aside>' +
      '</div>' +
      '</div>';
  }

  /* ── MOUNT ─────────────────────────────────────────────────────────────────────────── */
  function mount (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('auditBody');
    if (!host) return false;
    var logs = o.logs;
    if (!Array.isArray(logs)) return false;
    injectCss();

    var state = {
      items: normalise(logs),
      limit: o.limit || null,
      cat: 'all', q: '', qRaw: '', view: 'timeline', open: null,
    };
    var draw = function () { render(host, state); };
    draw();

    /* The panel remounts on every audit-source tab change, and listeners bind to the
       ELEMENT rather than the markup — without this, each remount would add another copy
       and one click would toggle a row open and shut again. */
    if (host.__acxOff) { try { host.__acxOff(); } catch (_) {} }
    var bound = [];
    var on = function (type, fn) { host.addEventListener(type, fn); bound.push([type, fn]); };
    host.__acxOff = function () {
      for (var i = 0; i < bound.length; i++) host.removeEventListener(bound[i][0], bound[i][1]);
      bound = [];
    };

    on('click', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-acx]');
      if (!el) return;
      var k = el.getAttribute('data-acx');
      if (k === 'cat')  { state.cat = el.getAttribute('data-cat') || 'all'; state.open = null; return draw(); }
      if (k === 'view') { state.view = el.getAttribute('data-v'); state.open = null; return draw(); }
      if (k === 'row')  {
        var n = el.getAttribute('data-n');
        state.open = (state.open === n) ? null : n;
        return draw();
      }
    });
    var t = null;
    on('input', function (ev) {
      var el = ev.target;
      if (!el || el.getAttribute('data-acx') !== 'q') return;
      var v = el.value;
      clearTimeout(t);
      t = setTimeout(function () {
        state.qRaw = v; state.q = String(v || '').trim().toLowerCase();
        draw();
        var again = host.querySelector('[data-acx="q"]');
        if (again) { again.focus(); try { again.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 180);
    });
    return true;
  }

  function injectCss () {
    if (document.getElementById(CSS_ID)) return;
    var l = document.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet'; l.href = 'sokoni-aos-activity.css';
    document.head.appendChild(l);
  }

  var api = { mount: mount, _render: render, _normalise: normalise,
              _catOf: catOf, _truncation: truncation, _sevOf: sevOf, CATS: CATS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAOSActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
