/* ============================================================================
   SOKONI — Updates centre (AdminOS + Super Admin, ONE implementation)
   sokoni-admin-updates.js   ·   styles: sokoni-admin-updates.css

   Mounted by BOTH consoles into their own panel, each handing in its OWN
   canonical callable transport (opts.call):
     admin-os.html     #panel-updates  via SokoniAOS.navigate('updates')  (deep link #updates)
                       call = sokoni-aos.js _call()
     super-admin.html  #panel-updates  via SA.nav('updates')
                       call = SA._fns.httpsCallable(name)(data)

   THREE SECTIONS, each from a canonical source or shown as not measured:
     1. Live now          /version.json (fetched fresh) + this browser's own
                          service worker (GET_VERSION on the controller).
     2. Installs & updates  the server aggregate, read through the admin callable
                          adminGetAppInstallStats (functions/app-release-metrics.js).
                          'not-computed-yet', an undeployed callable, or a null
                          figure renders "—" + "Not measured yet" + the reason.
                          Never 0 for unknown; never an estimate; nothing before
                          the counter's "since" date is back-filled.
     3. Release log       ADMIN-ONLY (owner decision A): paged from the admin
                          callable adminReleaseLog, which serves the log bundled
                          in the functions source. There is NO public
                          /release-log.json. While the callable is not deployed
                          the section says so — never an empty list.

   No Firestore reads, no writes, no localStorage as a source. Everything is
   rendered with textContent — nothing from the server reaches innerHTML.
   ========================================================================= */
(function () {
  'use strict';
  if (window.SokoniAdminUpdates) return;

  var PAGE = 40;
  var NEUTRAL = '—';
  var NOT_MEASURED = 'Not measured yet';
  var LOG_UNAVAILABLE = 'Release log is served to admins by the server — not available yet';

  /* ── Install / update metrics ──────────────────────────────────────────────
     field: the adminGetAppInstallStats field that carries the figure. A metric
     with field:null has NO canonical source and always renders the neutral
     state with its reason. */
  var INSTALL_METRICS = [
    { key: 'installs', field: 'total', label: 'App installs',
      def: 'Devices that reported the browser’s “app installed” event.' },
    { key: 'standalone', field: 'standalone', label: 'Opened as the installed app',
      def: 'Devices whose latest report came from the installed app — includes iPhones, which never fire an install event.' },
    { key: 'active7', field: 'active7', label: 'Active devices · 7 days',
      def: 'Devices that reported in during the last 7 days.' },
    { key: 'active30', field: 'active30', label: 'Active devices · 30 days',
      def: 'Devices that reported in during the last 30 days.' },
    { key: 'onLatest', field: 'onLive', label: 'Devices on the live build',
      def: 'Devices whose latest report was the build production serves now.' },
    { key: 'behind', field: 'behind', label: 'Devices on an older build',
      def: 'Devices whose latest report was any other build — includes devices not seen recently.' },
    { key: 'devices', field: 'devices', label: 'Devices reporting',
      def: 'Every device that has reported at least once (browser tab or installed app).' },
    { key: 'androidApp', field: null, label: 'Android app (Play Store) downloads',
      reason: 'Play Console statistics are not exported to SOKONI, and whether the TWA package is published is not recorded in this repository.' },
  ];

  var TYPE_LABEL = { fix: 'Fix', feat: 'Feature', deploy: 'Deploy record', docs: 'Docs', test: 'Test', other: 'Change' };

  /* A callable that is not deployed surfaces as not-found / unavailable — or as
     'internal' when the 404 carries no CORS headers. All three mean "the server
     side of this is not there yet", which is rendered as exactly that. */
  var NOT_DEPLOYED = /^(functions\/)?(not-found|unavailable|internal)$/;
  function errCode(e) { return String((e && e.code) || (e && e.message) || 'unknown'); }

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

  /* Fallback transport when a console hands none in: the compat SDK both
     consoles already load. Returns the callable's data. */
  function defaultCall(name, data) {
    if (!window.firebase || typeof window.firebase.functions !== 'function') {
      return Promise.reject({ code: 'functions/unavailable', message: 'Firebase Functions is not loaded on this page' });
    }
    return window.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r && r.data; });
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
    this.call = (opts && typeof opts.call === 'function') ? opts.call : defaultCall;
    this.live = null;       /* version.json or null */
    this.liveError = null;
    this.stats = { state: 'loading' };
    this.log = { state: 'loading', entries: [], total: 0, entryCount: 0, next: null, source: null, sha: null, code: null };
    this.logSeq = 0;
    this.searchTimer = null;
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
    this.instMeta = h('p', { class: 'sk-upd-notice', 'data-upd': 'installs-notice' });
    this.instBody = h('div', { class: 'sk-upd-metrics', 'data-upd': 'installs' });
    this.logMeta = h('p', { class: 'sk-upd-muted', 'data-upd': 'log-meta', text: 'Asking the server for the release log…' });
    this.logList = h('ol', { class: 'sk-upd-timeline', 'data-upd': 'log', 'aria-label': 'Release log, newest first' });
    this.moreBtn = h('button', { type: 'button', class: 'sk-upd-btn', hidden: true, 'data-upd': 'more', onclick: function () { self.loadLog(false); } });

    var search = h('input', { type: 'search', id: uid + 'Q', class: 'sk-upd-input', placeholder: 'Search titles, files, commits…', autocomplete: 'off', maxlength: '100',
      oninput: function () {
        var v = this.value.trim().toLowerCase();
        clearTimeout(self.searchTimer);
        self.searchTimer = setTimeout(function () { self.filter.q = v; self.loadLog(true); }, 300);
      } });
    var typeSel = h('select', { id: uid + 'T', class: 'sk-upd-input', onchange: function () { self.filter.type = this.value; self.loadLog(true); } },
      [['all', 'All types'], ['fix', 'Fixes'], ['feat', 'Features'], ['deploy', 'Deploy records'], ['docs', 'Docs'], ['test', 'Tests'], ['other', 'Other changes']]
        .map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var statSel = h('select', { id: uid + 'S', class: 'sk-upd-input', onchange: function () { self.filter.status = this.value; self.loadLog(true); } },
      [['all', 'Any status'], ['live', 'Proven live now'], ['deployed', 'Changelog says deployed'], ['not-deployed', 'Changelog says not deployed'], ['committed', 'Committed (no claim)']]
        .map(function (o) { return h('option', { value: o[0], text: o[1] }); }));

    this.renderInstalls();

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
      section(this.ids.inst, 'Installs & updates', 'How many devices have installed SOKONI and how many run the live build — counted on the server from devices that report in.', [
        this.instMeta,
        this.instBody,
      ]),
      section(this.ids.log, 'Release log', 'Fixes and features in order, newest first — served to admins only, generated from the CHANGELOG.md of the tree the server was deployed from.', [
        h('p', { class: 'sk-upd-notice' }, [
          'Every entry is at least ', h('strong', { text: 'Committed' }), ' — written up in the changelog. ',
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
    /* version.json first: the log's "Live now" filter needs the live commit. */
    await Promise.all([
      fetchJson('/version.json').then(function (v) { self.live = v; self.liveError = null; }, function (e) { self.live = null; self.liveError = e.message || 'unreadable'; }),
      runningVersion().then(function (r) { self.running = r; }),
    ]);
    this.renderLive();
    await Promise.all([this.loadStats(), this.loadLog(true)]);
    if (announce) this.status.textContent = 'Updates refreshed.';
  };

  /* ── installs ──────────────────────────────────────────────────────────── */
  Centre.prototype.loadStats = function () {
    var self = this;
    return Promise.resolve().then(function () { return self.call('adminGetAppInstallStats', {}); }).then(function (d) {
      if (d && d.state === 'computed') self.stats = d;
      else if (d && d.state === 'not-computed-yet') self.stats = { state: 'not-computed-yet' };
      else self.stats = { state: 'error', code: 'unexpected response' };
    }, function (e) {
      var code = errCode(e);
      self.stats = { state: NOT_DEPLOYED.test(code) ? 'unavailable' : 'error', code: code };
    }).then(function () { self.renderInstalls(); });
  };

  Centre.prototype.renderInstalls = function () {
    var self = this, s = this.stats || { state: 'loading' };
    var since = s.state === 'computed' ? fmtStamp(s.since) : null;
    var computed = s.state === 'computed' ? fmtStamp(s.computedAt) : null;

    /* Section notice — what state the counter is in, in words. */
    var m = this.instMeta;
    m.textContent = '';
    m.className = 'sk-upd-notice';
    if (s.state === 'loading') {
      m.appendChild(document.createTextNode('Asking the server for the install counter…'));
    } else if (s.state === 'computed') {
      m.appendChild(h('strong', { text: 'Measured on the server. ' }));
      m.appendChild(document.createTextNode(
        (since ? 'Counting since ' + since.abs + ' — the first report received; nothing before it is counted or estimated. ' : 'No device has reported yet. ')
        + (computed ? 'Last computed ' + computed.abs + (computed.rel ? ' (' + computed.rel + ')' : '') + '; recomputed every 6 hours. ' : '')
        + 'Only devices whose owner accepted analytics consent report in.'));
    } else {
      m.className = 'sk-upd-notice sk-upd-warn';
      m.appendChild(h('strong', { text: NOT_MEASURED + '. ' }));
      m.appendChild(document.createTextNode(this.stateReason(s)));
    }

    this.instBody.textContent = '';
    INSTALL_METRICS.forEach(function (mt) {
      var v = (s.state === 'computed' && mt.field) ? s[mt.field] : null;
      var measured = typeof v === 'number' && isFinite(v);
      var reason;
      if (measured) {
        reason = mt.def + (since ? ' Since ' + since.abs + '.' : '') + (computed ? ' Computed ' + computed.abs + '.' : '');
      } else if (!mt.field) {
        reason = mt.reason;
      } else if (s.state === 'computed') {
        reason = (mt.field === 'onLive' || mt.field === 'behind')
          ? 'The live build could not be read when the count ran' + (s.liveError ? ' (' + s.liveError + ')' : '') + ', so there was nothing to compare against.'
          : 'This figure is not in the latest aggregate.';
      } else {
        reason = self.stateReason(s);
      }
      /* A figure is rendered ONLY when the canonical aggregate carries a number
         for it. Everything else is the neutral dash — not 0, not an estimate. */
      var value = measured ? Number(v).toLocaleString('en-KE') : NEUTRAL;
      var state = measured ? 'Measured' : s.state === 'loading' && mt.field ? 'Checking…' : NOT_MEASURED;
      self.instBody.appendChild(h('article', { class: 'sk-upd-metric', 'data-metric': mt.key, 'data-measured': measured ? 'true' : 'false' }, [
        h('h4', { class: 'sk-upd-metric-label', text: mt.label }),
        h('p', { class: 'sk-upd-metric-value', 'aria-label': mt.label + ': ' + (measured ? value : 'not measured yet'), text: value }),
        h('p', { class: 'sk-upd-metric-state' + (measured ? ' sk-upd-metric-state-ok' : ''), text: state }),
        h('p', { class: 'sk-upd-metric-why', text: reason }),
      ]));
    });
  };

  Centre.prototype.stateReason = function (s) {
    if (s.state === 'loading') return 'Asking the server…';
    if (s.state === 'not-computed-yet') return 'The install counter is live, but its first count has not run yet (it runs every 6 hours).';
    if (s.state === 'unavailable') return 'The install counter (adminGetAppInstallStats) is not available on the server yet (' + s.code + '). Installs before it ships are never back-filled.';
    return 'The server did not return the install counter (' + (s.code || 'unknown') + ').';
  };

  /* ── live ──────────────────────────────────────────────────────────────── */
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
    var c = v && (v.commit || v.commitShort) ? String(v.commit || v.commitShort).toLowerCase() : null;
    return c && /^[0-9a-f]{7,40}$/.test(c) ? c : null;
  };

  /* PROVEN live: the entry records a deployment AND names the commit production
     reports. Same rule as the server's statusOf (functions/app-release-metrics.js). */
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

  /* ── release log (server-paged) ────────────────────────────────────────── */
  Centre.prototype.loadLog = function (reset) {
    var self = this, L = this.log;
    var seq = ++this.logSeq;   /* a newer request wins; late answers are dropped */
    var q = { limit: PAGE, type: this.filter.type, status: this.filter.status, q: this.filter.q };
    var lc = this.liveCommit();
    if (lc) q.liveCommit = lc;
    if (!reset && L.next) q.cursor = L.next;
    if (reset) { L.state = L.state === 'ok' ? 'ok' : 'loading'; }
    this.moreBtn.disabled = true;
    return Promise.resolve().then(function () { return self.call('adminReleaseLog', q); }).then(function (d) {
      if (seq !== self.logSeq) return;
      if (!d || !Array.isArray(d.entries)) throw { code: 'unexpected response' };
      L.entries = reset ? d.entries.slice() : L.entries.concat(d.entries);
      L.total = typeof d.total === 'number' ? d.total : L.entries.length;
      L.entryCount = typeof d.entryCount === 'number' ? d.entryCount : L.total;
      L.next = d.nextCursor || null;
      L.source = d.source || 'CHANGELOG.md';
      L.sha = d.sourceSha256 || null;
      L.state = 'ok'; L.code = null;
    }).catch(function (e) {
      if (seq !== self.logSeq) return;
      var code = errCode(e);
      L.state = NOT_DEPLOYED.test(code) ? 'unavailable' : 'error';
      L.code = code;
      L.entries = []; L.next = null;
    }).then(function () { if (seq === self.logSeq) self.renderLog(); });
  };

  Centre.prototype.renderLog = function () {
    var self = this, list = this.logList, L = this.log;
    list.textContent = '';
    this.moreBtn.disabled = false;
    if (L.state !== 'ok') {
      this.logMeta.textContent = L.state === 'unavailable'
        ? LOG_UNAVAILABLE + ' (' + L.code + '). No entries are shown in its place.'
        : L.state === 'error'
          ? 'The server did not return the release log (' + L.code + '). No entries are shown in its place.'
          : 'Asking the server for the release log…';
      this.moreBtn.hidden = true;
      return;
    }
    var filtered = this.filter.q || this.filter.type !== 'all' || this.filter.status !== 'all';
    this.logMeta.textContent = 'Showing ' + L.entries.length + ' of ' + L.total + (filtered ? ' matching (' + L.entryCount + ' in the log)' : ' entries')
      + ' · source ' + L.source + (L.sha ? ' @ sha256 ' + String(L.sha).slice(0, 12) : '');
    if (!L.entries.length) list.appendChild(h('li', { class: 'sk-upd-empty', text: L.entryCount ? 'No entries match these filters.' : 'The server’s release log has no entries.' }));
    var lastDate;
    L.entries.forEach(function (e) {
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
    var left = L.total - L.entries.length;
    this.moreBtn.hidden = !(L.next && left > 0);
    this.moreBtn.textContent = L.next && left > 0 ? 'Show ' + Math.min(PAGE, left) + ' more (' + left + ' remaining)' : '';
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
