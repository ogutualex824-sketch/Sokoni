/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniEducationEnterprise — the company's OWN Education shell (education-enterprise.html), Education E2 2026-10-03
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Layout = merchant-v2's frame (owner: "like merchant-v2.html with the side bar"): a sidebar rendered from the
   server's module answer, a header, one content area. A company BUYS training; it is never an Education provider (no
   courses, teachers, storefront or provider wallet here).
   Access is the server's educationWorkspace answer: an account that is not a verified, ACTIVE company is told why and
   offered the application. Module states come from the server — AVAILABLE opens, NOT_IMPLEMENTED shows "Soon" and
   does nothing. Staff training is CONSENT-BASED (educationEnterprise): single-use invite codes, redeemed by each
   employee from their OWN account. The company sees display names only.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fn = function (name) { return function (data) { return G.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r.data; }); }; };
  var ent = function (op, data) { return fn('educationEnterprise')(Object.assign({ op: op }, data || {})); };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  /* sidebar = the server's ENTERPRISE_MODULES, grouped; 'overview' is the shell's own home */
  var NAV = [
    ['Company', [['overview', 'Overview', '🏠'], ['companyProfile', 'Company profile', '🏢'], ['roles', 'Staff & roles', '🔑'], ['settings', 'Settings', '⚙️']]],
    ['People', [['employees', 'Employees', '👥'], ['training', 'Training invites', '🎟️'], ['enrolments', 'Enrolments', '📝']]],
    ['Learning', [['programmes', 'Programmes', '📚'], ['liveClasses', 'Live classes', '🎥'], ['providers', 'Providers', '🧑‍🏫'], ['bookings', 'Bookings', '📅']]],
    ['Money', [['payments', 'Payments', '💳'], ['receipts', 'Receipts', '🧾'], ['wallet', 'Business wallet', '👛']]],
    ['Insight', [['reports', 'Reports', '📊'], ['messages', 'Messages', '💬']]],
  ];
  var STATUS = { active: 'Active', ended: 'Ended', open: 'Open', used: 'Used', revoked: 'Withdrawn', expired: 'Expired' };
  var S = { ws: null, ov: null, assigns: null, invites: null, view: 'overview' };
  var $ = function (id) { return document.getElementById(id); };

  function stateOf(key) {
    if (key === 'overview') return 'AVAILABLE';
    var m = S.ws && S.ws.enterprise && S.ws.enterprise.modules && S.ws.enterprise.modules[key];
    return (m && m.state) || 'UNKNOWN';
  }

  function renderNav() {
    var nav = $('entNav'); if (!nav) return;
    nav.innerHTML = NAV.map(function (g) {
      return '<div class="side-group">' + esc(g[0]) + '</div>' + g[1].map(function (it) {
        var st = stateOf(it[0]); var on = S.view === it[0];
        return '<button type="button" class="nav-item' + (on ? ' on' : '') + '" data-ent-nav="' + esc(it[0]) + '"' + (st === 'AVAILABLE' ? '' : ' aria-disabled="true"')
          + (on ? ' aria-current="page"' : '') + '><span class="ico" aria-hidden="true">' + it[2] + '</span><span class="lbl">' + esc(it[1]) + '</span>'
          + (st === 'AVAILABLE' ? '' : '<span class="tag">' + (st === 'NOT_IMPLEMENTED' ? 'Soon' : '—') + '</span>') + '</button>';
      }).join('');
    }).join('');
  }

  function labelOf(key) { for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i][1].length; j++) if (NAV[i][1][j][0] === key) return NAV[i][1][j][1]; return 'Company training'; }

  function viewOverview() {
    var c = (S.ov && S.ov.company) || {};
    var n = S.ov && S.ov.counts;
    return '<div class="card"><div style="font-size:18px;font-weight:800">' + esc(c.companyName || (S.ws.enterprise || {}).companyName || '—') + '</div>'
      + '<div class="muted">Verified company on SOKONI Education. You buy training for your staff; SOKONI providers deliver it.</div></div>'
      + '<div class="stats"><div class="stat"><span class="muted">Staff in training</span><b>' + esc(n ? n.activeLearners : '—') + '</b></div>'
      + '<div class="stat"><span class="muted">Open invites</span><b>' + esc(n ? n.openInvites : '—') + '</b></div>'
      + '<div class="stat"><span class="muted">Seats declared</span><b>' + esc(c.staffSeats != null ? c.staffSeats : '—') + '</b></div></div>'
      + '<div class="card" style="margin-top:14px"><b>Get started</b><p class="muted">1. Create an invite code (Training invites). 2. Give it to an employee. 3. They enter it in their own SOKONI account under Education → My learning.</p>'
      + '<button type="button" class="btn" data-ent-nav="training">Create an invite</button></div>';
  }
  function viewEmployees() {
    if (S.assigns === null) return '<div class="card"><p class="muted">Employees are unavailable right now (—).</p></div>';
    var rows = S.assigns.map(function (a) {
      return '<div class="row"><div><strong>' + esc(a.displayName || '—') + '</strong>' + (a.label ? ' <span class="muted">(' + esc(a.label) + ')</span>' : '') + ' · ' + esc(STATUS[a.status] || '—') + '</div>'
        + (a.status === 'active' ? '<button type="button" class="btn2" data-ent-end="' + esc(a.assignmentId) + '">End training</button>' : '') + '</div>';
    }).join('');
    return '<div class="card"><b>Employees in training</b><p class="muted">You see the name each employee chose — never their profile, age, contacts or other learning.</p>'
      + (rows || '<p class="muted">No staff have joined yet. Create an invite code under Training invites.</p>') + '</div>';
  }
  function viewTraining() {
    var rows = (S.invites || []).map(function (i) {
      return '<div class="row"><div><span class="code">' + esc(i.code) + '</span>' + (i.label ? ' <span class="muted">' + esc(i.label) + '</span>' : '') + ' · ' + esc(STATUS[i.status] || '—') + '</div>'
        + (i.status === 'open' ? '<button type="button" class="btn2" data-ent-revoke="' + esc(i.code) + '">Withdraw</button>' : '') + '</div>';
    }).join('');
    return '<div class="card"><b>Invite an employee</b><p class="muted">Each code works once, for 14 days. The employee enters it in their own SOKONI account.</p>'
      + '<input class="input" id="entInviteLabel" maxlength="80" placeholder="Your note, e.g. employee name or department (optional)">'
      + '<button type="button" class="btn" data-ent-invite>Create invite code</button><p id="entInviteOut" class="code" aria-live="polite"></p></div>'
      + '<div class="card"><b>Your invites</b>' + (S.invites === null ? '<p class="muted">Invites are unavailable right now (—).</p>' : (rows || '<p class="muted">No invites yet.</p>')) + '</div>';
  }
  function viewCompany() {
    var e = S.ws.enterprise || {};
    return '<div class="card"><b>Company profile</b><p class="muted">Company name: ' + esc(e.companyName || '—') + '</p>'
      + '<p class="muted">Your registration number and KRA PIN were verified by SOKONI when your application was approved. To change them, contact SOKONI support.</p></div>';
  }

  function renderView() {
    var root = $('entRoot'); if (!root) return;
    var key = S.view;
    var st = stateOf(key);
    if ($('entTitle')) $('entTitle').textContent = labelOf(key);
    if (st !== 'AVAILABLE') { root.innerHTML = '<div class="card"><b>' + esc(labelOf(key)) + '</b><p class="muted">' + (st === 'NOT_IMPLEMENTED' ? 'Coming soon.' : 'Unavailable (—).') + '</p></div>'; return; }
    root.innerHTML = key === 'employees' ? viewEmployees() : key === 'training' ? viewTraining() : key === 'companyProfile' ? viewCompany() : viewOverview();
  }

  function go(key) {
    if (stateOf(key) !== 'AVAILABLE') return;   /* the server's module state is the gate; "Soon" items do nothing */
    S.view = key; renderNav(); renderView(); drawer(false);
    try { G.history && G.history.replaceState && G.history.replaceState(null, '', '#' + key); } catch (_) {}
  }

  function drawer(open) {
    var side = $('entSide'), scrim = $('entScrim'), btn = $('entMenu');
    if (side) side.classList[open ? 'add' : 'remove']('open');
    if (scrim) scrim.classList[open ? 'add' : 'remove']('on');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function shellMessage(html) {
    if ($('entNav')) $('entNav').innerHTML = '';
    if ($('entCoName')) $('entCoName').textContent = '—';
    $('entRoot').innerHTML = html;
  }

  function load() {
    return fn('educationWorkspace')({}).then(function (ws) {
      var e = ws && ws.enterprise;
      if (!e || e.state !== 'ACTIVE') {
        shellMessage('<div class="card"><p>' + esc(e && e.state === 'SUSPENDED' ? 'This company account is suspended on SOKONI.' : 'This account is not a SOKONI-verified company.') + '</p>'
          + '<p class="muted">Companies that buy staff training apply once; SOKONI verifies the company registration and KRA PIN.</p>'
          + '<button type="button" class="btn" data-ent-apply>Apply as a company</button> <a class="btn2" href="education.html#learn">Back to Education</a></div>');
        return;
      }
      S.ws = ws;
      if ($('entCoName')) $('entCoName').textContent = e.companyName || '—';
      return Promise.all([ent('overview').catch(function () { return null; }), ent('assignments').catch(function () { return null; }), ent('inviteList').catch(function () { return null; })])
        .then(function (r) {
          S.ov = r[0]; S.assigns = r[1] ? r[1].assignments || [] : null; S.invites = r[2] ? r[2].invites || [] : null;
          var h = String((G.location && G.location.hash) || '').replace('#', '');
          if (h && stateOf(h) === 'AVAILABLE') S.view = h;
          renderNav(); renderView();
        });
    }).catch(function () {
      shellMessage('<div class="card"><p>Your company dashboard is unavailable right now (—).</p></div>');
    });
  }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var nv = t.closest('[data-ent-nav]'); if (nv) { go(nv.getAttribute('data-ent-nav')); return; }
    if (t.closest('[data-ent-apply]')) { if (G.HubRegister) G.HubRegister.open({ hub: 'education', category: 'education-enterprise' }); else G.location.href = 'complete-application.html'; return; }
    var b = t.closest('[data-ent-invite]');
    if (b) {
      var lab = $('entInviteLabel'); b.disabled = true;
      ent('inviteCreate', { label: lab ? lab.value : '' }).then(function (r) {
        return load().then(function () { var out = $('entInviteOut'); if (out && r && r.code) out.textContent = 'Code: ' + r.code + ' (one use, ' + r.expiresInDays + ' days)'; });
      }).catch(function (x) { b.disabled = false; G.alert && G.alert(errText(x)); });
      return;
    }
    var rv = t.closest('[data-ent-revoke]');
    if (rv) { rv.disabled = true; ent('inviteRevoke', { code: rv.getAttribute('data-ent-revoke') }).then(load).catch(function (x) { rv.disabled = false; G.alert && G.alert(errText(x)); }); return; }
    var en = t.closest('[data-ent-end]');
    if (en) { en.disabled = true; ent('assignmentEnd', { assignmentId: en.getAttribute('data-ent-end') }).then(load).catch(function (x) { en.disabled = false; G.alert && G.alert(errText(x)); }); }
  }

  function init() {
    document.body.addEventListener('click', onClick);
    var m = $('entMenu'); if (m) m.addEventListener('click', function () { drawer(!$('entSide').classList.contains('open')); });
    var sc = $('entScrim'); if (sc) sc.addEventListener('click', function () { drawer(false); });
    G.firebase.auth().onAuthStateChanged(function (u) {
      if (!u) { shellMessage('<div class="card"><p>Sign in to manage your company\'s training.</p><a class="btn" href="login.html?return=education-enterprise.html">Sign in</a></div>'); return; }
      load();
    });
  }

  G.SokoniEducationEnterprise = { init: init, go: go, _state: S, _renderNav: renderNav, _renderView: renderView, _load: load };
})(typeof window !== 'undefined' ? window : this);
