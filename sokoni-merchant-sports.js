/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT V2 · SPORTS WORKSPACE  (owner 2026-10-03; 2f)
   ══════════════════════════════════════════════════════════════════════════════
   The Sports dashboards inside the merchant shell (owner: "make MerchantV2 the canonical shell and inject a Sports
   navigation configuration"). Five routes (Sports group in sokoni-merchant-routes.js) mount THIS module with ctx.view.

   SERVER (consumed as-is): functions/sports.js → callable sportsDispatch (commercial-fn aee1ed8 … 968904e).
     reads   me.overview → {roles{player,captain,organiser}, teams[], invitations[], organising[], registrations[], fixtures[]}
             tournaments.open {sport?} · tournament.view {tournamentId}
     writes  team.register / invite / respond / remove / setManager · registration.apply / decide / withdraw ·
             tournament.create / submit / transition · fixtures.publish · fixture.update · result.submit / confirm / dispute
   ROLE-AWARE: every section adapts to roles DERIVED BY THE SERVER from real relationships (team membership, team-granted
   captain/manager role, organised tournaments). The browser never claims a role and never writes Firestore.
   REUSED, not rebuilt: messages (team / tournament conversations live in the inbox), venue bookings (venue-booking.html,
   the general venue engine), receipts and wallet (the existing finance surfaces), products (the canonical marketplace).
   DATA INTEGRITY: everything shown comes from what this page loaded from the server; unknown is '—', never 0.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var VIEWS = ['overview', 'team', 'fixtures', 'tournaments', 'organise'];
  var STATUS = { draft: 'Draft', submitted: 'Submitted for review', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected',
    registration_open: 'Registration open', registration_closed: 'Registration closed', fixtures_published: 'Fixtures published',
    in_progress: 'In progress', completed: 'Completed', archived: 'Archived', pending: 'Pending', pending_payment: 'Awaiting entry-fee payment (not live yet)',
    registered: 'Registered', withdrawn: 'Withdrawn', invited: 'Invited', active: 'Active', scheduled: 'Scheduled', confirmed: 'Confirmed',
    live: 'Live', postponed: 'Postponed', cancelled: 'Cancelled' };
  var NEXT = { approved: 'registration_open', registration_open: 'registration_closed', fixtures_published: 'in_progress', in_progress: 'completed', completed: 'archived' };
  var NEXT_LABEL = { registration_open: 'Open registration', registration_closed: 'Close registration', in_progress: 'Start tournament', completed: 'Mark completed', archived: 'Archive' };

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function when (ms) { return ms ? new Date(Number(ms)).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
  function label (s) { return STATUS[s] || String(s || '—').replace(/_/g, ' '); }
  function fixtureLine (f, teamName) {
    var r = f.result ? ' · ' + esc(f.result.home) + '–' + esc(f.result.away) + ' (' + esc(label(f.result.status)) + ')' : '';
    return esc(teamName(f.homeTeamId)) + ' vs ' + esc(teamName(f.awayTeamId)) + ' · ' + esc(when(f.startsAt)) + ' · ' + esc(label(f.status)) + r;
  }
  function serverMsg (e) { return (e && e.message) ? String(e.message).replace(/^.*?:\s*/, '') : 'That could not be completed.'; }

  function mount (host, ctx) {
    var c = ctx || {};
    var view = VIEWS.indexOf(c.view) >= 0 ? c.view : 'overview';
    var st = { me: null, err: null, open: null, view: null, msg: '' };
    var dead = false;
    function call (data) { return c.dispatch(data).then(function (r) { return (r && r.data) || r; }); }
    function teamName (id) { var t = st.me && (st.me.teams || []).find(function (x) { return x.teamId === id; }); return t ? t.name : 'Team ' + String(id).slice(0, 6); }
    function load () {
      st.err = null;
      return call({ op: 'me.overview' }).then(function (r) { st.me = r; }, function (e) { st.err = serverMsg(e); })
        .then(function () { if (view === 'tournaments') return call({ op: 'tournaments.open' }).then(function (r) { st.open = r.tournaments || []; }, function () { st.open = null; }); })
        .then(function () { if (!dead) render(); });
    }
    function act (data, okMsg) {
      st.msg = 'Working…'; render();
      return call(data).then(function (r) { st.msg = okMsg || 'Done.'; return load().then(function () { return r; }); },
        function (e) { st.msg = 'Not changed: ' + serverMsg(e); render(); });
    }

    function render () {
      if (dead) return;
      if (st.err) { host.innerHTML = '<div class="state"><span class="ico">⚠️</span><b>Sports could not load</b><small>' + esc(st.err) + ' This is not an empty account — try again.</small><button class="act ghost" data-sp="reload">↻ Try again</button></div>'; return; }
      if (!st.me) { host.innerHTML = '<div class="state"><span class="ico">⏳</span><b>Loading Sports…</b></div>'; return; }
      var me = st.me, R = me.roles || {};
      var html = '<div class="sp-wrap" style="padding:14px;max-width:960px">' + (st.msg ? '<div class="sp-msg" role="status" style="margin-bottom:10px;font-size:13px">' + esc(st.msg) + '</div>' : '');
      if (view === 'overview') {
        html += '<h2>Sports</h2><div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px">' +
          (R.player ? '<span class="chip">Player</span>' : '') + (R.captain ? '<span class="chip">Captain / manager</span>' : '') + (R.organiser ? '<span class="chip">Tournament organiser</span>' : '') +
          (!R.player && !R.captain && !R.organiser ? '<span class="chip">No Sports role yet — register a team or create a tournament</span>' : '') + '</div>';
        if ((me.invitations || []).length) html += '<h3>Invitations</h3>' + me.invitations.map(function (t) {
          return '<div class="card" style="padding:10px;margin-bottom:8px"><b>' + esc(t.name) + '</b> · ' + esc(t.sport) +
            '<div style="margin-top:6px;display:flex;gap:6px"><button class="act" data-sp="accept" data-team="' + esc(t.teamId) + '">Accept</button><button class="act ghost" data-sp="decline" data-team="' + esc(t.teamId) + '">Decline</button></div></div>';
        }).join('');
        html += '<h3>Upcoming matches</h3>' + ((me.fixtures || []).length ? me.fixtures.slice(0, 10).map(function (f) { return '<div class="card" style="padding:8px 10px;margin-bottom:6px">' + fixtureLine(f, teamName) + '</div>'; }).join('')
          : '<div class="muted">No matches yet.</div>');
        html += '<h3>Elsewhere in SOKONI</h3><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a class="act ghost" href="messages.html">Team &amp; tournament messages</a><a class="act ghost" href="venue-booking.html">Book a venue</a>' +
          '<a class="act ghost" href="category.html?cat=sports">Sports products</a><a class="act ghost" href="services.html?q=coach">Find a coach</a></div>';
      } else if (view === 'team') {
        var led = (me.teams || []).filter(function (t) { return t.myRole === 'captain' || t.myRole === 'manager'; });
        html += '<h2>My team</h2>' + ((me.teams || []).filter(function (t) { return t.myStatus !== 'invited'; }).map(function (t) {
          var lead = t.myRole === 'captain' || t.myRole === 'manager';
          return '<div class="card" style="padding:10px;margin-bottom:8px"><b>' + esc(t.name) + '</b> · ' + esc(t.sport) + ' · ' + esc(label(t.status)) +
            (t.verification === 'verified' ? ' · <span class="chip">Verified</span>' : '') + ' · you: ' + esc(t.myRole) +
            (t.status === 'draft' || t.status === 'rejected' ? '<div style="margin-top:6px"><button class="act" data-sp="team-submit" data-team="' + esc(t.teamId) + '">Submit for review</button></div>' : '') +
            (lead && t.status === 'approved' ? '<form data-sp-form="invite" data-team="' + esc(t.teamId) + '" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input name="playerUid" required maxlength="128" placeholder="Player\'s SOKONI user id" aria-label="Player user id"><button class="act">Invite</button></form>' : '') +
            '<div style="margin-top:6px"><button class="act ghost" data-sp="leave" data-team="' + esc(t.teamId) + '">' + (t.myRole === 'captain' ? 'Captain — transfer before leaving' : 'Leave team') + '</button></div></div>';
        }).join('') || '<div class="muted" style="margin-bottom:10px">You are not on a team yet.</div>');
        html += '<h3>Register a team</h3><form data-sp-form="register" style="display:grid;gap:6px;max-width:420px">' +
          '<input name="name" required minlength="2" maxlength="80" placeholder="Team name" aria-label="Team name"><input name="sport" required maxlength="40" placeholder="Sport (e.g. football)" aria-label="Sport">' +
          '<input name="county" maxlength="40" placeholder="County (optional)" aria-label="County"><label><input type="checkbox" name="submit" checked> Submit for review now</label>' +
          '<button class="act">Register team</button><small class="muted">A team goes live — and can enter tournaments — only after SOKONI approves it.</small></form>';
        if (!led.length) html += '';
      } else if (view === 'fixtures') {
        var leadIds = (me.teams || []).filter(function (t) { return t.myRole === 'captain' || t.myRole === 'manager'; }).map(function (t) { return t.teamId; });
        html += '<h2>Fixtures</h2>' + ((me.fixtures || []).length ? me.fixtures.map(function (f) {
          var mine = leadIds.indexOf(f.homeTeamId) >= 0 || leadIds.indexOf(f.awayTeamId) >= 0;
          var res = f.result ? f.result.status : null;
          var actions = '';
          if (mine && (!res || res === 'submitted') && ['scheduled', 'confirmed', 'live', 'completed'].indexOf(f.status) >= 0 && res !== 'confirmed') {
            actions += '<form data-sp-form="result" data-fixture="' + esc(f.fixtureId) + '" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
              '<input name="home" type="number" min="0" max="999" required aria-label="Home score" style="width:70px"><input name="away" type="number" min="0" max="999" required aria-label="Away score" style="width:70px"><button class="act">Submit result</button></form>';
          }
          if (mine && res === 'submitted') actions += '<div style="display:flex;gap:6px;margin-top:6px"><button class="act" data-sp="confirm" data-fixture="' + esc(f.fixtureId) + '">Confirm result</button><button class="act ghost" data-sp="dispute" data-fixture="' + esc(f.fixtureId) + '">Dispute</button></div>';
          return '<div class="card" style="padding:10px;margin-bottom:8px">' + fixtureLine(f, teamName) + actions + '</div>';
        }).join('') : '<div class="muted">No fixtures yet.</div>') + '<small class="muted">The other team (or the organiser) confirms a result; only the organiser resolves a dispute. Every change is recorded.</small>';
      } else if (view === 'tournaments') {
        var myLed = (me.teams || []).filter(function (t) { return (t.myRole === 'captain' || t.myRole === 'manager') && t.status === 'approved'; });
        html += '<h2>Tournaments</h2><h3>Open for registration</h3>' + (st.open == null ? '<div class="muted">Open tournaments could not be loaded — not an empty list.</div>' :
          (st.open.length ? st.open.map(function (t) {
            var sel = myLed.filter(function (m) { return m.sport === t.sport; });
            return '<div class="card" style="padding:10px;margin-bottom:8px"><b>' + esc(t.name) + '</b> · ' + esc(t.sport) + ' · ' + esc(t.capacity) + ' teams · ' +
              (Number(t.entryFeeKES) > 0 ? 'entry KES ' + esc(t.entryFeeKES) + ' (payment not live yet)' : 'free entry') + ' · registration closes ' + esc(when(t.regClosesAt)) +
              (sel.length ? '<form data-sp-form="apply" data-tournament="' + esc(t.tournamentId) + '" style="display:flex;gap:6px;margin-top:6px"><select name="teamId" aria-label="Team">' +
                sel.map(function (m) { return '<option value="' + esc(m.teamId) + '">' + esc(m.name) + '</option>'; }).join('') + '</select><button class="act">Register team</button></form>'
                : '<div class="muted" style="margin-top:4px">You need to captain or manage an approved ' + esc(t.sport) + ' team to register.</div>') + '</div>';
          }).join('') : '<div class="muted">No tournaments are open right now.</div>'));
        html += '<h3>My registrations</h3>' + ((me.registrations || []).length ? me.registrations.map(function (r) {
          return '<div class="card" style="padding:8px 10px;margin-bottom:6px">' + esc(teamName(r.teamId)) + ' · tournament ' + esc(String(r.tournamentId).slice(0, 8)) + ' · ' + esc(label(r.status)) +
            (['pending', 'pending_payment', 'registered'].indexOf(r.status) >= 0 ? ' <button class="act ghost" data-sp="withdraw" data-reg="' + esc(r.registrationId) + '">Withdraw</button>' : '') + '</div>';
        }).join('') : '<div class="muted">No registrations yet.</div>');
      } else if (view === 'organise') {
        html += '<h2>Organise</h2>' + ((me.organising || []).length ? me.organising.map(function (t) {
          var nx = NEXT[t.status];
          return '<div class="card" style="padding:10px;margin-bottom:8px"><b>' + esc(t.name) + '</b> · ' + esc(t.sport) + ' · ' + esc(label(t.status)) +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
            (t.status === 'draft' || t.status === 'rejected' ? '<button class="act" data-sp="t-submit" data-tournament="' + esc(t.tournamentId) + '">Submit for review</button>' : '') +
            (nx ? '<button class="act" data-sp="t-next" data-to="' + nx + '" data-tournament="' + esc(t.tournamentId) + '">' + esc(NEXT_LABEL[nx]) + '</button>' : '') +
            (t.status === 'registration_closed' ? '<button class="act" data-sp="publish" data-tournament="' + esc(t.tournamentId) + '">Publish fixtures (round robin)</button>' : '') +
            '<button class="act ghost" data-sp="t-view" data-tournament="' + esc(t.tournamentId) + '">Standings &amp; fixtures</button></div></div>';
        }).join('') : '<div class="muted" style="margin-bottom:10px">You are not organising a tournament.</div>');
        if (st.view) {
          var tv = st.view, rows = Object.keys(tv.tournament.standings || {}).map(function (k) { return Object.assign({ teamId: k }, tv.tournament.standings[k]); })
            .sort(function (a, b) { return (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)); });
          html += '<h3>' + esc(tv.tournament.name) + ' — standings</h3><table class="tbl"><thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead><tbody>' +
            (rows.length ? rows.map(function (r) { return '<tr><td>' + esc(String(r.teamId).slice(0, 10)) + '</td><td>' + r.p + '</td><td>' + r.w + '</td><td>' + r.d + '</td><td>' + r.l + '</td><td>' + (r.gf - r.ga) + '</td><td><b>' + r.pts + '</b></td></tr>'; }).join('')
              : '<tr><td colspan="7">No standings until fixtures are published.</td></tr>') + '</tbody></table>';
        }
        html += '<h3>Create a tournament</h3><form data-sp-form="create" style="display:grid;gap:6px;max-width:460px">' +
          '<input name="name" required minlength="3" maxlength="100" placeholder="Tournament name" aria-label="Tournament name"><input name="sport" required maxlength="40" placeholder="Sport" aria-label="Sport">' +
          '<label>Registration opens <input name="regOpensAt" type="datetime-local" required></label><label>Registration closes <input name="regClosesAt" type="datetime-local" required></label>' +
          '<label>Tournament starts <input name="startsAt" type="datetime-local" required></label><input name="capacity" type="number" min="2" max="512" required placeholder="Team capacity" aria-label="Capacity">' +
          '<input name="entryFeeKES" type="number" min="0" step="1" value="0" aria-label="Entry fee (KES)"><small class="muted">Entry-fee payments are not live yet: paid registrations stay pending until they are.</small>' +
          '<button class="act">Create (draft)</button></form>';
      }
      host.innerHTML = html + '</div>';
    }

    function onClick (e) {
      var b = e.target.closest && e.target.closest('[data-sp]'); if (!b) return;
      var k = b.getAttribute('data-sp'), team = b.getAttribute('data-team'), tid = b.getAttribute('data-tournament'), fid = b.getAttribute('data-fixture');
      if (k === 'reload') return load();
      if (k === 'accept') return act({ op: 'team.respond', teamId: team, accept: true }, 'Welcome to the team.');
      if (k === 'decline') return act({ op: 'team.respond', teamId: team, accept: false }, 'Invitation declined.');
      if (k === 'team-submit') return act({ op: 'team.submit', teamId: team }, 'Submitted for review.');
      if (k === 'leave') return act({ op: 'team.remove', teamId: team }, 'You left the team.');
      if (k === 'confirm') return act({ op: 'result.confirm', fixtureId: fid }, 'Result confirmed.');
      if (k === 'dispute') return act({ op: 'result.dispute', fixtureId: fid, reason: (global.prompt && global.prompt('What is wrong with this result?', '')) || '' }, 'Result disputed — the organiser will resolve it.');
      if (k === 'withdraw') return act({ op: 'registration.withdraw', registrationId: b.getAttribute('data-reg') }, 'Registration withdrawn.');
      if (k === 't-submit') return act({ op: 'tournament.submit', tournamentId: tid }, 'Submitted for review.');
      if (k === 't-next') return act({ op: 'tournament.transition', tournamentId: tid, to: b.getAttribute('data-to') }, 'Updated.');
      if (k === 'publish') return act({ op: 'fixtures.publish', tournamentId: tid }, 'Fixtures published — players are notified.');
      if (k === 't-view') { return call({ op: 'tournament.view', tournamentId: tid }).then(function (r) { st.view = r; render(); }, function (er) { st.msg = 'Not available: ' + serverMsg(er); render(); }); }
    }
    function onSubmit (e) {
      var f = e.target; var kind = f && f.getAttribute && f.getAttribute('data-sp-form'); if (!kind) return;
      e.preventDefault();
      var v = function (n) { var el = f.elements[n]; return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
      var dt = function (n) { var s = v(n); return s ? new Date(s).getTime() : null; };
      if (kind === 'register') return act({ op: 'team.register', name: v('name'), sport: v('sport'), county: v('county'), submit: !!v('submit') }, 'Team registered.');
      if (kind === 'invite') return act({ op: 'team.invite', teamId: f.getAttribute('data-team'), playerUid: v('playerUid') }, 'Invitation sent.');
      if (kind === 'result') return act({ op: 'result.submit', fixtureId: f.getAttribute('data-fixture'), home: Number(v('home')), away: Number(v('away')) }, 'Result submitted — the other side confirms it.');
      if (kind === 'apply') return act({ op: 'registration.apply', tournamentId: f.getAttribute('data-tournament'), teamId: v('teamId') }, 'Registration sent to the organiser.');
      if (kind === 'create') return act({ op: 'tournament.create', name: v('name'), sport: v('sport'), regOpensAt: dt('regOpensAt'), regClosesAt: dt('regClosesAt'), startsAt: dt('startsAt'),
        capacity: Number(v('capacity')), entryFeeKES: Number(v('entryFeeKES') || 0) }, 'Tournament created as a draft — submit it for review.');
    }
    host.addEventListener('click', onClick);
    host.addEventListener('submit', onSubmit);
    render(); load();
    return {
      view: view,
      refresh: function () { load(); },
      destroy: function () { dead = true; try { host.removeEventListener('click', onClick); host.removeEventListener('submit', onSubmit); } catch (_) {} },
      _st: st, _render: render,
    };
  }

  global.SokoniMerchantSports = { mount: mount, VIEWS: VIEWS, _pure: { esc: esc, label: label, fixtureLine: fixtureLine, NEXT: NEXT } };
})(typeof window !== 'undefined' ? window : this);
