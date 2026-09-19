/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — USERS for AdminOS
   sokoni-aos-users.js

   The user directory, built on what `adminSearchUsers` actually returns.

   ── THE CONTRACT, READ RATHER THAN ASSUMED ──────────────────────────────────────────────
   adminSearchUsers returns ONE key — `users` — and each entry carries exactly:

       id · displayName · email · phone · role · status · verified · createdAt

   No total. No status facets. No lastLogin. No photoURL. No teams. No history.

   That decides the page:

     • COUNTS ARE OF THE LOADED SET. There is no total and no facet query, so the strip
       counts what was fetched and says so. "128 users" from a page of 20 would be the
       easiest lie here, because a directory is exactly where a total looks unremarkable.

     • NO TREND ARROWS. "+12% vs last month" needs a prior-period count. Nothing returns
       one, and a percentage computed from a single page compared to itself is noise
       wearing a confidence interval.

     • NO ACCESS PERCENTAGES. "Platform access 100%" has no source at all. Role is a single
       string; there is no entitlement breakdown behind it to total up.

     • NO TEAMS. This platform has shops and shopEmployees, not teams. Rendering a Teams
       column would invent a structure the data model does not have.

   ── A DEFECT THIS PAGE DOES NOT INHERIT ─────────────────────────────────────────────────
   The existing table renders `u.name`, `u.lastLogin` and `u.photoURL`. The callable returns
   NONE of those — the name field is `displayName`. So every row's NAME, the primary
   identifier in a user directory, renders as an em dash, and every avatar falls back. The
   page looks correct and identifies nobody.

   This reads `displayName`, falls back to `name` for any other caller's shape, and derives
   initials rather than requesting a photograph that is never sent.

   ── TWO HOSTS, ONE DIRECTORY ────────────────────────────────────────────────────────────
   AdminOS and the Super Admin portal both list users, from DIFFERENT sources: AdminOS calls
   adminSearchUsers, while Super Admin reads users/{uid} directly, ordered by createdAt and
   capped at 50. Rather than let a second directory grow beside this one, both mount THIS
   module and each supplies its own shape and its own actions. What differs between them is
   passed in, never branched on here:

     • `source` — the sentence naming what was actually fetched, so neither page implies a
       platform total it did not ask for.
     • `actions` — capability. A host with no per-user detail view gets no View button,
       because a control wired to nothing reads as broken permissions.

   ADDITIVE at both. Renders into a host beside the original table; returns false if it
   cannot, leaving that table to run. It performs no read and no write of its own — role
   changes and suspension delegate to the actions each portal already owns, which is why
   there is still exactly one writer behind both surfaces.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CSS_ID = 'sokoni-aos-users-css';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ms (t) {
    if (!t) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    if (t._seconds) return t._seconds * 1000;
    var n = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(n) ? n : null;
  }
  function when (t) {
    var m = ms(t);
    return m ? new Date(m).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  }
  function ago (t) {
    var m = ms(t);
    if (!m) return null;
    var d = Math.floor((Date.now() - m) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 30) return d + 'd ago';
    if (d < 365) return Math.floor(d / 30) + 'mo ago';
    return Math.floor(d / 365) + 'y ago';
  }

  /* THE NAME, from whichever field the caller actually supplies. adminSearchUsers sends
     `displayName`; other admin callables use `name`. Neither is guessed at — an account
     with no name shows its email, and one with neither says so rather than rendering a
     dash that looks like a rendering failure. */
  function nameOf (u) {
    var n = (u.displayName || u.name || '').trim();
    if (n) return { text: n, isName: true };
    if (u.email) return { text: String(u.email).split('@')[0], isName: false };
    return { text: 'Unnamed account', isName: false };
  }
  function initials (u) {
    var n = nameOf(u);
    var parts = n.text.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  /* A stable colour per account, so the same person looks the same on every visit. Derived
     from the id, never random. */
  var TONES = ['a', 'b', 'c', 'd', 'e', 'f'];
  function tone (u) {
    var s = String(u.id || u.uid || u.email || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return TONES[Math.abs(h) % TONES.length];
  }

  var STATUSES = [
    { id: 'active',    label: 'Active',    tone: 'ok' },
    { id: 'pending',   label: 'Pending',   tone: 'warn' },
    { id: 'suspended', label: 'Suspended', tone: 'bad' },
    { id: 'banned',    label: 'Banned',    tone: 'bad' },
  ];
  function statusTone (s) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === s) return STATUSES[i].tone;
    return 'muted';
  }

  function render (host, state) {
    var users = state.users;

    /* Counts OF THE LOADED SET. Every label says so; none is presented as a platform total. */
    var byStatus = {};
    users.forEach(function (u) {
      var s = u.status || 'active';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    var byRole = {};
    users.forEach(function (u) { var r = u.role || 'buyer'; byRole[r] = (byRole[r] || 0) + 1; });
    var roles = Object.keys(byRole).sort(function (a, b) { return byRole[b] - byRole[a]; });

    /* `verified` is a boolean adminSearchUsers always sends — but a caller reading the raw
       users document sees it ABSENT on accounts nothing ever verified. Absent is unknown,
       not false: counting it as false would report "0 Verified" for a source that simply
       does not carry the field. So the count is only claimed when at least one loaded
       account actually has it. */
    var vKnown = users.some(function (u) { return u.verified === true || u.verified === false; });
    var verified = users.filter(function (u) { return u.verified; }).length;

    /* Only the actions the host actually owns get a button. A control wired to nothing is
       worse than an absent one: it reads as broken permissions. */
    var can = state.can || { view: true, role: true, ban: true };

    var visible = users.filter(function (u) {
      if (state.status !== 'all' && (u.status || 'active') !== state.status) return false;
      if (state.role !== 'all' && (u.role || 'buyer') !== state.role) return false;
      if (!state.q) return true;
      var n = nameOf(u).text;
      return (n + ' ' + (u.email || '') + ' ' + (u.phone || '') + ' ' + (u.id || ''))
        .toLowerCase().indexOf(state.q) > -1;
    });

    var sel = state.selected;
    var selCount = Object.keys(sel).length;

    var stat = function (label, n, t, sub) {
      return '<div class="usx-stat usx-stat--' + t + '">' +
        '<div class="usx-stat-n">' + n + '</div>' +
        '<div class="usx-stat-l">' + esc(label) + '</div>' +
        '<div class="usx-stat-s">' + esc(sub) + '</div></div>';
    };

    host.innerHTML =
      '<div class="usx">' +

      /* ── STRIP. "loaded", never "total". ────────────────────────────────── */
      '<div class="usx-strip">' +
        stat('Loaded', users.length, 'info', 'this page, not a platform total') +
        stat('Active', byStatus.active || 0, 'ok', 'of those loaded') +
        stat('Pending', byStatus.pending || 0, 'warn', 'of those loaded') +
        stat('Suspended', (byStatus.suspended || 0) + (byStatus.banned || 0), 'bad', 'of those loaded') +
        stat('Verified', vKnown ? verified : '&mdash;', 'info',
             vKnown ? 'of those loaded' : 'not recorded in this source') +
      '</div>' +

      /* ── TOOLBAR ───────────────────────────────────────────────────────── */
      '<div class="usx-tools">' +
        '<input class="usx-in" type="search" placeholder="Filter loaded users…" ' +
          'value="' + esc(state.qRaw || '') + '" data-usx="q" aria-label="Filter users">' +
        '<select class="usx-sel" data-usx="status" aria-label="Status">' +
          '<option value="all">All statuses</option>' +
          STATUSES.map(function (s) {
            return byStatus[s.id] ? '<option value="' + s.id + '"' +
              (state.status === s.id ? ' selected' : '') + '>' + s.label +
              ' (' + byStatus[s.id] + ')</option>' : '';
          }).join('') +
        '</select>' +
        '<select class="usx-sel" data-usx="role" aria-label="Role">' +
          '<option value="all">All roles</option>' +
          roles.map(function (r) {
            return '<option value="' + esc(r) + '"' + (state.role === r ? ' selected' : '') +
              '>' + esc(r) + ' (' + byRole[r] + ')</option>';
          }).join('') +
        '</select>' +
        '<span class="usx-showing">' + visible.length + ' of ' + users.length + ' shown</span>' +
      '</div>' +

      /* ── BULK BAR. Only the actions AdminOS actually owns. ──────────────── */
      (selCount
        ? '<div class="usx-bulk">' +
            '<span class="usx-bulk-n">' + selCount + ' selected</span>' +
            (can.role ? '<button class="usx-btn" data-usx="bulkrole">Change role…</button>' : '') +
            (can.ban ? '<button class="usx-btn usx-btn--danger" data-usx="bulkban">Suspend…</button>' : '') +
            '<button class="usx-btn ghost" data-usx="clearsel">Clear</button>' +
            '<span class="usx-bulk-h">Each acts one account at a time, through the same ' +
              'confirmation as a single change.</span>' +
          '</div>'
        : '') +

      /* ── TABLE ─────────────────────────────────────────────────────────── */
      (visible.length
        ? '<div class="usx-tw"><table class="usx-t"><thead><tr>' +
            '<th class="usx-cbx"><input type="checkbox" data-usx="selall"' +
              (selCount && selCount === visible.length ? ' checked' : '') + ' aria-label="Select all shown"></th>' +
            '<th>User</th><th>Role</th><th>Status</th><th>Joined</th><th></th>' +
          '</tr></thead><tbody>' +
          visible.map(function (u) {
            var id = u.id || u.uid || '';
            var n = nameOf(u);
            var j = when(u.createdAt), ja = ago(u.createdAt);
            return '<tr' + (sel[id] ? ' class="is-sel"' : '') + '>' +
              '<td class="usx-cbx"><input type="checkbox" data-usx="sel" data-id="' + esc(id) + '"' +
                (sel[id] ? ' checked' : '') + ' aria-label="Select ' + esc(n.text) + '"></td>' +
              '<td><div class="usx-u">' +
                /* Initials, not a photograph — the API sends no photoURL, so requesting one
                   would 404 on every row. */
                '<span class="usx-av usx-av--' + tone(u) + '">' + esc(initials(u)) + '</span>' +
                '<div class="usx-u-b">' +
                  '<div class="usx-u-n' + (n.isName ? '' : ' usx-u-n--derived') + '">' +
                    esc(n.text) +
                    (u.verified ? '<span class="usx-vf" title="Verified">✓</span>' : '') +
                  '</div>' +
                  '<div class="usx-u-e">' + esc(u.email || 'no email on record') + '</div>' +
                '</div>' +
              '</div></td>' +
              '<td><span class="usx-role">' + esc(u.role || 'buyer') + '</span></td>' +
              '<td><span class="usx-st usx-st--' + statusTone(u.status || 'active') + '">' +
                esc(u.status || 'active') + '</span></td>' +
              /* An absent join date is said, not rendered as a dash that reads like a bug. */
              '<td class="usx-dim">' +
                (j ? esc(j) + (ja ? '<small>' + esc(ja) + '</small>' : '') : 'not recorded') +
              '</td>' +
              '<td class="usx-r">' +
                (can.view ? '<button class="usx-btn sm" data-usx="view" data-id="' + esc(id) +
                  '">View</button>' : '') +
                (can.role ? '<button class="usx-btn sm" data-usx="role" data-id="' + esc(id) +
                  '">Role</button>' : '') +
                (can.ban ? '<button class="usx-btn sm usx-btn--danger" data-usx="ban" data-id="' + esc(id) +
                  '" data-status="' + esc(u.status || 'active') + '">' +
                  ((u.status === 'banned' || u.status === 'suspended') ? 'Restore' : 'Suspend') +
                  '</button>' : '') +
              '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div>'
        : '<div class="usx-none"><b>' +
            (users.length ? 'No loaded user matches this filter' : 'No users returned') +
          '</b><span>' + (users.length ? 'Clear the filter or widen the search.'
            : 'The directory search returned an empty result.') + '</span></div>') +

      /* ── WHAT THIS VIEW IS NOT ─────────────────────────────────────────── */
      '<div class="usx-note">' +
        '<b>About these numbers.</b> Every count is <b>of the ' + users.length +
        ' accounts loaded</b> — ' + esc(state.source ||
          'this search returns a capped page with no total and no status facets') +
        '. There is no month-on-month change because no prior-period count ' +
        'exists, no access-percentage because a role is a single value with no entitlement ' +
        'breakdown behind it, and no teams column because this platform has shops and ' +
        'shop employees rather than teams.' +
      '</div>' +
      '</div>';
  }

  function mount (opts) {
    var o = opts || {};
    var host = o.host;
    if (!host || !Array.isArray(o.users)) return false;
    injectCss();

    /* Capability follows the actions the caller supplied, so a host without a per-user
       detail view simply has no View button rather than a dead one. */
    var A0 = o.actions || {};
    var state = {
      users: o.users, q: '', qRaw: '', role: 'all', status: 'all', selected: {},
      can: { view: !!A0.viewUser, role: !!A0.changeRole, ban: !!A0.banUser },
      source: o.source || '',
    };
    var draw = function () { render(host, state); };
    draw();

    /* A host is re-mounted whenever the caller reloads or re-filters. Listeners are bound to
       the ELEMENT, not the markup, so without this every remount would add another copy and
       one click would suspend an account twice. */
    if (host.__usxOff) { try { host.__usxOff(); } catch (_) {} }
    var bound = [];
    var on = function (type, fn) {
      host.addEventListener(type, fn);
      bound.push([type, fn]);
    };
    host.__usxOff = function () {
      for (var i = 0; i < bound.length; i++) host.removeEventListener(bound[i][0], bound[i][1]);
      bound = [];
    };

    on('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-usx]');
      if (!b) return;
      var k = b.getAttribute('data-usx'), id = b.getAttribute('data-id');
      var A = o.actions || {};
      if (k === 'view' && A.viewUser) return A.viewUser(id);
      if (k === 'role' && A.changeRole) return A.changeRole(id);
      if (k === 'ban' && A.banUser) return A.banUser(id, b.getAttribute('data-status'));
      if (k === 'clearsel') { state.selected = {}; return draw(); }
      if (k === 'bulkrole' || k === 'bulkban') {
        var ids = Object.keys(state.selected);
        /* Sequential, through the SAME confirmation each single action uses. A bulk path
           that skipped the confirmation would be a second, weaker way to suspend accounts. */
        var run = function (i) {
          if (i >= ids.length) { state.selected = {}; draw(); return; }
          var p = (k === 'bulkrole')
            ? (A.changeRole ? A.changeRole(ids[i]) : null)
            : (A.banUser ? A.banUser(ids[i], 'active') : null);
          Promise.resolve(p).then(function () { run(i + 1); }, function () { run(i + 1); });
        };
        return run(0);
      }
    });

    on('change', function (ev) {
      var el = ev.target;
      var k = el.getAttribute && el.getAttribute('data-usx');
      if (!k) return;
      if (k === 'sel') {
        var id = el.getAttribute('data-id');
        if (el.checked) state.selected[id] = true; else delete state.selected[id];
        return draw();
      }
      if (k === 'selall') {
        state.selected = {};
        if (el.checked) {
          host.querySelectorAll('[data-usx="sel"]').forEach(function (c) {
            state.selected[c.getAttribute('data-id')] = true;
          });
        }
        return draw();
      }
      if (k === 'status') { state.status = el.value; return draw(); }
      if (k === 'role') { state.role = el.value; return draw(); }
    });

    var t = null;
    on('input', function (ev) {
      var el = ev.target;
      if (!el.getAttribute || el.getAttribute('data-usx') !== 'q') return;
      var v = el.value;
      clearTimeout(t);
      t = setTimeout(function () {
        state.qRaw = v; state.q = String(v || '').trim().toLowerCase();
        draw();
        var again = host.querySelector('[data-usx="q"]');
        if (again) { again.focus(); try { again.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 180);
    });
    return true;
  }

  function injectCss () {
    if (document.getElementById(CSS_ID)) return;
    var l = document.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet'; l.href = 'sokoni-aos-users.css';
    document.head.appendChild(l);
  }

  var api = { mount: mount, _render: render, _nameOf: nameOf, _initials: initials, _tone: tone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAOSUsers = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
