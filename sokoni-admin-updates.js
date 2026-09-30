/* ============================================================================
   SOKONI — Updates centre (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-updates.js   ·   styles: sokoni-admin-updates.css

   Mounted by BOTH consoles into their own panel:
     admin-os.html     #panel-updates  via SokoniAOS.navigate('updates')  (deep link #updates)
     super-admin.html  #panel-updates  via SA.nav('updates')

   THREE SECTIONS, each from a canonical source or shown as not measured:
     1. Live now          /version.json (fetched fresh) + this browser's own
                          service worker (GET_VERSION on the controller).
     2. Installs & updates  NO canonical source exists today (census:
                          docs/ADMIN_UPDATES_CENTER_CENSUS.md). Every metric
                          renders the neutral state and the reason. It never
                          renders 0 and never an estimate — unknown is not zero.
     3. Release log       /release-log.json, generated from CHANGELOG.md by
                          scripts/build-release-log.js (hosting does not serve
                          .md). An entry is "Committed" unless /version.json
                          proves it is the live build.

   No Firestore reads, no writes, no localStorage as a source. Everything is
   rendered with textContent — nothing from a fetched file reaches innerHTML.
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminUpdates) return;

  var PAGE = 40;
  var NEUTRAL = '—';

  /* ── Install / update metrics ──────────────────────────────────────────────
     source: null means NO canonical source exists. The renderer shows NEUTRAL
     and "Not measured yet" for every such metric. When a server slice lands
     (appInstalls + version heartbeat, aggregated server-side — see the census),
     a metric gains a `source` and only then may render a figure. */
  var INSTALL_METRICS = [
    { key: 'installs', label: 'App installs (downloads)', source: null,
      reason: 'Nothing records an install. The browser’s appinstalled event is handled only to hide the install banner (sw-register.js, index.html); no server record is written.' },
    { key: 'onLatest', label: 'Devices on the live build', source: null,
      reason: 'No device reports the build it runs to a store an admin can read. SW telemetry goes to /api/diag → routeDiagnostics: anomaly beacons from an unauthenticated endpoint, not one row per device, 30-day TTL, and no admin read rule.' },
    { key: 'behind', label: 'Devices still on an older build', source: null,
      reason: 'Same gap: without a per-device build heartbeat there is nothing to compare against the live cacheVersion.' },
    { key: 'androidApp', label: 'Android app (Play Store) downloads', source: null,
      reason: 'Play Console statistics are not exported to SOKONI, and whether the TWA package is published is not recorded in this repository.' },
    { key: 'signedInDevices', label: 'Signed-in devices', source: null,
      reason: 'userDevices is server-written on sign-in (deviceRegister) but records no install or build, has no admin read rule, and no count callable exists.' },
  ];

  var TYPE_LABEL = { fix: 'Fix', feat: 'Feature', deploy: 'Deploy record', docs: 'Docs', test: 'Test', other: 'Change' };

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

  function fmtDate(iso) {
    if (!iso) return 'Undated';
    try {
      return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    } catch (_) { return iso; }
  }
  function fmtStamp(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return null;
    var abs = d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) + ' EAT';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    var rel = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : mins < 2880 ? Math.round(mins / 60) + ' h ago' : Math.round(mins / 1440) + ' days ago';
    return { abs: abs, rel: mins >= 0 ? rel : null };
  }
  function buildNo(cache) { var m = /-v(\d+)$/.exec(String(cache || '')); return m ? parseInt(m[1], 10) : null; }

  async function fetchJson(url) {
    var r = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'cb=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* The cache version THIS browser's controlling worker runs — asked, not guessed. */
  function runningVersion() {
    return new Promise(function (resolve) {
      try {
        var c = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!c || typeof MessageChannel === 'undefined') return resolve({ state: 'none' });
        var ch = new MessageChannel(), done = false;
        var t = setTimeout(function () { if (!done) { done = true; resolve({ state: 'silent' }); } }, 3000);
        ch.port1.onmessage = function (e) {
          if (done) return; done = true; clearTimeout(t);
          var v = e.data && e.data.version;
          resolve(v ? { state: 'ok', version: String(v) } : { state: 'silent' });
        };
        c.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      } catch (_) { resolve({ state: 'none' }); }
    });
  }

  /* ── instance ──────────────────────────────────────────────────────────── */
  function Centre(host, opts) {
    this.host = host;
    this.console = (opts && opts.console) || 'aos';
    this.live = null;       /* version.json or null */
    this.liveError = null;
    this.log = null;
    this.logError = null;
    this.shown = PAGE;
    this.filter = { q: '', type: 'all', status: 'all' };
    this.render();
    this.refresh();
  }

  Centre.prototype.render = function () {
    var self = this;
    var uid = 'skUpd' + (this.console === 'sa' ? 'Sa' : 'Aos');
    this.ids = { live: uid + 'Live', inst: uid + 'Inst', log: uid + 'Log' };
    this.host.textContent = '';
    this.status = h('p', { class: 'sk-upd-sr', role: 'status', 'aria-live': 'polite' });

    var jump = function (id, label) {
      return h('button', { type: 'button', class: 'sk-upd-chip', 'data-jump': id, text: label, onclick: function () {
        var t = document.getElementById(id);
        if (t) { t.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); var hd = t.querySelector('h3'); if (hd) hd.focus({ preventScroll: true }); }
      } });
    };

    this.liveBody = h('div', { class: 'sk-upd-facts', 'data-upd': 'live' }, [h('p', { class: 'sk-upd-muted', text: 'Reading /version.json…' })]);
    this.instBody = h('div', { class: 'sk-upd-metrics', 'data-upd': 'installs' });
    this.logMeta = h('p', { class: 'sk-upd-muted', 'data-upd': 'log-meta', text: 'Reading /release-log.json…' });
    this.logList = h('ol', { class: 'sk-upd-timeline', 'data-upd': 'log', 'aria-label': 'Release log, newest first' });
    this.moreBtn = h('button', { type: 'button', class: 'sk-upd-btn', hidden: true, 'data-upd': 'more', onclick: function () { self.shown += PAGE; self.renderLog(); } });

    var search = h('input', { type: 'search', id: uid + 'Q', class: 'sk-upd-input', placeholder: 'Search titles, files, commits…', autocomplete: 'off',
      oninput: function () { self.filter.q = this.value.trim().toLowerCase(); self.shown = PAGE; self.renderLog(); } });
    var typeSel = h('select', { id: uid + 'T', class: 'sk-upd-input', onchange: function () { self.filter.type = this.value; self.shown = PAGE; self.renderLog(); } },
      [['all', 'All types'], ['fix', 'Fixes'], ['feat', 'Features'], ['deploy', 'Deploy records'], ['docs', 'Docs'], ['test', 'Tests'], ['other', 'Other changes']]
        .map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var statSel = h('select', { id: uid + 'S', class: 'sk-upd-input', onchange: function () { self.filter.status = this.value; self.shown = PAGE; self.renderLog(); } },
      [['all', 'Any status'], ['live', 'Proven live now'], ['deployed', 'Changelog says deployed'], ['not-deployed', 'Changelog says not deployed'], ['committed', 'Committed (no claim)']]
        .map(function (o) { return h('option', { value: o[0], text: o[1] }); }));

    INSTALL_METRICS.forEach(function (m) {
      /* Neutral state ONLY. Every metric here has source:null today, and a metric
         without a canonical source never renders a figure — not 0, not an estimate.
         Wiring a real source is a server slice, not an edit to this line. */
      var value = NEUTRAL;
      self.instBody.appendChild(h('article', { class: 'sk-upd-metric', 'data-metric': m.key, 'data-measured': 'false' }, [
        h('h4', { class: 'sk-upd-metric-label', text: m.label }),
        h('p', { class: 'sk-upd-metric-value', 'aria-label': m.label + ': not measured yet', text: value }),
        h('p', { class: 'sk-upd-metric-state', text: 'Not measured yet' }),
        h('p', { class: 'sk-upd-metric-why', text: m.reason }),
      ]));
    });

    var section = function (id, title, lede, body) {
      return h('section', { class: 'sk-upd-section', id: id, 'aria-labelledby': id + 'H' }, [
        h('div', { class: 'sk-upd-section-head' }, [
          h('h3', { id: id + 'H', tabindex: '-1', text: title }),
          lede ? h('p', { class: 'sk-upd-muted', text: lede }) : null,
        ]),
      ].concat(body));
    };

    var root = h('div', { class: 'sk-upd', 'data-console': this.console }, [
      h('header', { class: 'sk-upd-hero' }, [
        h('div', { class: 'sk-upd-hero-text' }, [
          h('p', { class: 'sk-upd-eyebrow', text: 'Release centre' }),
          h('h2', { class: 'sk-upd-title', text: 'Updates' }),
          h('p', { class: 'sk-upd-lede', text: 'What is live, what changed and in what order, and who is running it. Every figure comes from a canonical source, or is shown as not measured — never guessed.' }),
        ]),
        h('button', { type: 'button', class: 'sk-upd-btn sk-upd-btn-primary', 'data-upd': 'refresh', text: 'Refresh', onclick: function () { self.refresh(true); } }),
      ]),
      h('nav', { class: 'sk-upd-jump', 'aria-label': 'Updates sections' }, [
        jump(this.ids.live, 'Live now'), jump(this.ids.inst, 'Installs & updates'), jump(this.ids.log, 'Release log'),
      ]),
      this.status,
      section(this.ids.live, 'Live now', 'The build production is serving, read fresh from /version.json, and the build this browser is running.', [this.liveBody]),
      section(this.ids.inst, 'Installs & updates', 'How many people have installed SOKONI and how many have updated to the live build.', [
        h('p', { class: 'sk-upd-notice', 'data-upd': 'installs-notice' }, [
          h('strong', { text: 'Not measured yet. ' }),
          'SOKONI does not record installs or the build each device runs, so there is no honest count to show. The server slice that would measure it is designed in the census (appInstalls + a build heartbeat, counted server-side).',
        ]),
        this.instBody,
      ]),
      section(this.ids.log, 'Release log', 'Fixes and features in order, newest first — generated from CHANGELOG.md of the deployed tree.', [
        h('p', { class: 'sk-upd-notice' }, [
          'Every entry is at least ', h('strong', { text: 'Committed' }), ' — written up in this tree’s changelog. ',
          h('strong', { text: 'Live now' }), ' is shown only where /version.json proves it: the entry records a deployment of the exact commit production reports. A changelog heading that says “deployed” is shown as the changelog’s claim, not as proof.',
        ]),
        h('div', { class: 'sk-upd-filters', role: 'search' }, [
          h('label', { class: 'sk-upd-field', for: uid + 'Q' }, [h('span', { text: 'Search' }), search]),
          h('label', { class: 'sk-upd-field', for: uid + 'T' }, [h('span', { text: 'Type' }), typeSel]),
          h('label', { class: 'sk-upd-field', for: uid + 'S' }, [h('span', { text: 'Status' }), statSel]),
        ]),
        this.logMeta,
        this.logList,
        h('div', { class: 'sk-upd-more' }, [this.moreBtn]),
      ]),
    ]);
    this.host.appendChild(root);
  };

  Centre.prototype.refresh = async function (announce) {
    var self = this;
    if (announce) this.status.textContent = 'Refreshing…';
    var results = await Promise.all([
      fetchJson('/version.json').then(function (v) { self.live = v; self.liveError = null; }, function (e) { self.live = null; self.liveError = e.message || 'unreadable'; }),
      this.log ? Promise.resolve() : fetchJson('/release-log.json').then(function (l) {
        if (!l || !Array.isArray(l.entries)) throw new Error('unexpected shape');
        self.log = l; self.logError = null;
      }, function (e) { self.logError = e.message || 'unreadable'; }),
      runningVersion().then(function (r) { self.running = r; }),
    ]);
    void results;
    this.renderLive();
    this.renderLog();
    if (announce) this.status.textContent = 'Updates refreshed.';
  };

  Centre.prototype.renderLive = function () {
    var b = this.liveBody;
    b.textContent = '';
    var v = this.live;
    var row = function (label, value, opts) {
      opts = opts || {};
      return h('div', { class: 'sk-upd-fact' + (opts.wide ? ' sk-upd-fact-wide' : ''), 'data-fact': opts.key || null }, [
        h('dt', { text: label }),
        h('dd', { class: opts.mono ? 'sk-upd-mono' : null, title: opts.title || null }, [value == null || value === '' ? NEUTRAL : String(value)].concat(opts.extra || [])),
      ]);
    };
    var dl = h('dl', { class: 'sk-upd-grid' });
    if (!v) {
      b.appendChild(h('p', { class: 'sk-upd-notice sk-upd-warn', 'data-upd': 'live-error', text: 'Could not read /version.json (' + (this.liveError || 'unknown') + '). The live build is not known from this browser; nothing is shown in its place.' }));
    }
    var stamp = v && fmtStamp(v.buildTime);
    dl.appendChild(row('Hosting commit', v && (v.commitShort || (v.commit ? String(v.commit).slice(0, 7) : null)), { mono: true, key: 'commit', title: v && v.commit }));
    dl.appendChild(row('Branch', v && v.branch, { mono: true, key: 'branch' }));
    dl.appendChild(row('Built', stamp ? stamp.abs : null, { key: 'buildTime', extra: stamp && stamp.rel ? [h('span', { class: 'sk-upd-sub', text: ' · ' + stamp.rel })] : [] }));
    dl.appendChild(row('Live cache version', v && v.cacheVersion, { mono: true, key: 'cacheVersion' }));
    if (v && v.environment) dl.appendChild(row('Environment', v.environment, { key: 'environment' }));
    if (v && typeof v.dirtyWorkingTree === 'boolean') dl.appendChild(row('Built from a clean tree', v.dirtyWorkingTree ? 'No — uncommitted edits were deployed' : 'Yes', { key: 'dirty' }));

    /* This browser */
    var r = this.running || { state: 'none' };
    var mine = r.state === 'ok' ? r.version : null;
    var verdict, tone;
    if (!mine) { verdict = r.state === 'none' ? 'No service worker controls this tab, so its build cannot be read.' : 'The service worker did not answer, so this tab’s build is not known.'; tone = 'muted'; }
    else if (!v || !v.cacheVersion) { verdict = 'Live build unknown — cannot compare.'; tone = 'muted'; }
    else if (mine === v.cacheVersion) { verdict = 'Up to date — this browser runs the live build.'; tone = 'ok'; }
    else {
      var a = buildNo(mine), l = buildNo(v.cacheVersion);
      verdict = (a != null && l != null && a < l) ? 'Behind live (v' + a + ' vs v' + l + ') — an update is waiting.' : 'Different from live — this browser runs another build.';
      tone = 'warn';
    }
    dl.appendChild(row('This browser runs', mine, { mono: true, key: 'running' }));
    var verdictEl = h('div', { class: 'sk-upd-fact sk-upd-fact-wide', 'data-fact': 'verdict' }, [
      h('dt', { text: 'This browser vs live' }),
      h('dd', {}, [h('span', { class: 'sk-upd-pill sk-upd-pill-' + tone, text: verdict })]),
    ]);
    if (tone === 'warn' && typeof window.sokoniCheckForUpdates === 'function') {
      var upd = h('button', { type: 'button', class: 'sk-upd-btn', text: 'Update this browser', onclick: function () { window.sokoniCheckForUpdates(upd); } });
      verdictEl.lastChild.appendChild(upd);
    }
    dl.appendChild(verdictEl);
    b.appendChild(dl);
  };

  Centre.prototype.liveCommit = function () {
    var v = this.live;
    return v && (v.commit || v.commitShort) ? String(v.commit || v.commitShort).toLowerCase() : null;
  };

  /* PROVEN live: the entry records a deployment AND names the commit production reports. */
  Centre.prototype.statusOf = function (e) {
    var live = this.liveCommit();
    if (live && e.claim === 'deployed' && Array.isArray(e.commits) && e.commits.some(function (c) {
      c = String(c).toLowerCase(); return c.length >= 7 && (live.indexOf(c) === 0 || c.indexOf(live) === 0);
    })) return 'live';
    if (e.claim === 'deployed') return 'deployed';
    if (e.claim === 'not-deployed') return 'not-deployed';
    return 'committed';
  };

  var STATUS_LABEL = {
    live: 'Live now · proven by /version.json',
    deployed: 'Changelog says deployed · not the live build',
    'not-deployed': 'Committed · changelog says not deployed',
    committed: 'Committed',
  };

  Centre.prototype.matches = function (e) {
    var f = this.filter;
    if (f.type !== 'all' && e.type !== f.type) return false;
    if (f.status !== 'all' && this.statusOf(e) !== f.status) return false;
    if (f.q) {
      var hay = (e.title + ' ' + (e.summary || '') + ' ' + (e.files || []).join(' ') + ' ' + (e.commits || []).join(' ') + ' ' + (e.date || '')).toLowerCase();
      if (hay.indexOf(f.q) < 0) return false;
    }
    return true;
  };

  Centre.prototype.renderLog = function () {
    var self = this, list = this.logList;
    list.textContent = '';
    if (!this.log) {
      this.logMeta.textContent = this.logError
        ? 'Could not read /release-log.json (' + this.logError + '). No entries are shown in its place.'
        : 'Reading /release-log.json…';
      this.moreBtn.hidden = true;
      return;
    }
    var all = this.log.entries;
    var hits = all.filter(function (e) { return self.matches(e); });
    var page = hits.slice(0, this.shown);
    this.logMeta.textContent = 'Showing ' + page.length + ' of ' + hits.length + (hits.length !== all.length ? ' matching (' + all.length + ' in the log)' : ' entries')
      + ' · source ' + (this.log.source || 'CHANGELOG.md') + (this.log.sourceSha256 ? ' @ sha256 ' + String(this.log.sourceSha256).slice(0, 12) : '');
    if (!hits.length) list.appendChild(h('li', { class: 'sk-upd-empty', text: 'No entries match these filters.' }));
    var lastDate;
    page.forEach(function (e) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        list.appendChild(h('li', { class: 'sk-upd-day', 'aria-hidden': 'true' }, [h('span', { text: fmtDate(e.date) })]));
      }
      var st = self.statusOf(e);
      var files = (e.files || []);
      var kids = [
        h('div', { class: 'sk-upd-entry-top' }, [
          h('span', { class: 'sk-upd-type sk-upd-type-' + (TYPE_LABEL[e.type] ? e.type : 'other'), text: TYPE_LABEL[e.type] || 'Change' }),
          h('time', { class: 'sk-upd-date', datetime: e.date || null, text: fmtDate(e.date) }),
          h('span', { class: 'sk-upd-status sk-upd-status-' + st, 'data-status': st, text: STATUS_LABEL[st] }),
        ]),
        h('h4', { class: 'sk-upd-entry-title', text: e.title }),
        e.summary ? h('p', { class: 'sk-upd-entry-summary', text: e.summary }) : null,
      ];
      if ((e.commits && e.commits.length) || files.length) {
        var det = h('details', { class: 'sk-upd-entry-more' }, [
          h('summary', { text: [files.length ? files.length + (e.filesMore ? '+' + e.filesMore : '') + ' file' + (files.length === 1 && !e.filesMore ? '' : 's') : null, e.commits && e.commits.length ? 'commit ' + e.commits.join(', ') : null].filter(Boolean).join(' · ') }),
          files.length ? h('ul', { class: 'sk-upd-files' }, files.map(function (f) { return h('li', { class: 'sk-upd-mono', text: f }); })) : null,
        ]);
        kids.push(det);
      }
      list.appendChild(h('li', { class: 'sk-upd-entry', 'data-date': e.date || '', 'data-type': e.type, 'data-status': st }, [h('article', {}, kids)]));
    });
    var left = hits.length - page.length;
    this.moreBtn.hidden = left <= 0;
    this.moreBtn.textContent = left > 0 ? 'Show ' + Math.min(PAGE, left) + ' more (' + left + ' remaining)' : '';
  };

  var mounted = new WeakMap();
  window.SokoniAdminUpdates = {
    /* Idempotent: a second mount on the same host refreshes instead of rebuilding. */
    mount: function (host, opts) {
      if (!host) return null;
      var c = mounted.get(host);
      if (c) { c.refresh(); return c; }
      c = new Centre(host, opts);
      mounted.set(host, c);
      return c;
    },
    INSTALL_METRICS: INSTALL_METRICS,
  };
})();
