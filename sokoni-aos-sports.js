/* ============================================================================
   AdminOS — Sports review queue (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Submitted TEAMS and submitted / under-review TOURNAMENTS, read through sportsDispatch {op:'admin.queue'} (admin claim
   required). Decisions call sportsDispatch admin.teamDecide / admin.tournamentDecide — the server validates the state,
   writes the decision, notifies the owner (idempotent) and audits it (adminAudit). The browser never writes a status.
   Self-contained: loads the first time its panel is shown; sokoni-aos.js is untouched.
   ============================================================================ */
(function (W) {
  'use strict';
  var PANEL = 'panel-sports';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var day = function (ms) { return ms ? new Date(Number(ms)).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—'; };
  function call (data) { return W.firebase.functions().httpsCallable('sportsDispatch')(data).then(function (r) { return r.data; }); }

  function render (host) {
    host.innerHTML = '<div class="panel-toolbar"><h2>Sports — review queue</h2><button class="aos-btn-sm" type="button" id="aosSpRefresh">Refresh</button></div>' +
      '<p style="font-size:12px;color:var(--aos-muted,#9aa);margin:0 0 10px">Approving a team makes it live and verified; approving a tournament lets its organiser open registration. Every decision is audited.</p>' +
      '<div id="aosSpOut" aria-live="polite"><div class="aos-spinner"><div></div></div></div>';
    host.querySelector('#aosSpRefresh').addEventListener('click', function () { load(host); });
    host.addEventListener('click', onAction);
    load(host);
  }

  async function load (host) {
    var out = host.querySelector('#aosSpOut');
    out.innerHTML = '<div class="aos-spinner"><div></div></div>';
    var r;
    try { r = await call({ op: 'admin.queue' }); }
    catch (err) { out.innerHTML = '<div class="aos-note">The Sports queue could not be loaded (' + esc((err && err.code) || 'error') + '). This is not an empty queue — try again.</div>'; return; }
    var teams = (r && r.teams) || [], tours = (r && r.tournaments) || [];
    out.innerHTML =
      '<h3 style="font-size:14px;margin:6px 0">Teams awaiting a decision (' + teams.length + ')</h3>' +
      (teams.length ? teams.map(teamCard).join('') : '<div style="font-size:13px;margin-bottom:10px">No teams are waiting.</div>') +
      '<h3 style="font-size:14px;margin:14px 0 6px">Tournaments awaiting review (' + tours.length + ')</h3>' +
      (tours.length ? tours.map(tourCard).join('') : '<div style="font-size:13px">No tournaments are waiting.</div>');
  }

  function actions (kind, id, status) {
    var b = function (decision, label) { return '<button class="aos-btn-sm" type="button" data-sp-kind="' + kind + '" data-sp-id="' + esc(id) + '" data-sp-decision="' + decision + '">' + label + '</button>'; };
    return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
      (kind === 'tournament' && status === 'submitted' ? b('review', 'Mark under review') : '') + b('approve', 'Approve') + b('reject', 'Reject') +
      '</div><div data-sp-msg="' + esc(id) + '" style="font-size:12px;margin-top:6px"></div>';
  }
  function teamCard (t) {
    return '<div class="aos-card" style="padding:10px 12px;margin-bottom:8px"><strong>' + esc(t.name) + '</strong> · ' + esc(t.sport) +
      (t.category ? ' · ' + esc(t.category) : '') + (t.county ? ' · ' + esc(t.county) : '') +
      '<div style="font-size:12px;color:var(--aos-muted,#9aa)">Owner ' + esc(t.ownerUid) + ' · captain ' + esc(t.captainUid) + '</div>' + actions('team', t.id, t.status) + '</div>';
  }
  function tourCard (t) {
    return '<div class="aos-card" style="padding:10px 12px;margin-bottom:8px"><strong>' + esc(t.name) + '</strong> · ' + esc(t.sport) +
      ' <span class="aos-pill">' + esc(t.status === 'under_review' ? 'Under review' : 'Submitted') + '</span>' +
      '<div style="font-size:12px;color:var(--aos-muted,#9aa)">Organiser ' + esc(t.organiserUid) + ' · ' + esc(t.capacity) + ' teams · entry fee ' +
      (Number(t.entryFeeKES) > 0 ? 'KES ' + esc(t.entryFeeKES) + ' (payments not live yet — paid registrations stay pending)' : 'free') +
      ' · registration ' + day(t.regOpensAt) + ' – ' + day(t.regClosesAt) + ' · starts ' + day(t.startsAt) + '</div>' + actions('tournament', t.id, t.status) + '</div>';
  }

  async function onAction (e) {
    var btn = e.target.closest('[data-sp-decision]'); if (!btn) return;
    var kind = btn.getAttribute('data-sp-kind'), id = btn.getAttribute('data-sp-id'), decision = btn.getAttribute('data-sp-decision');
    var host = document.getElementById(PANEL);
    var msg = host.querySelector('[data-sp-msg="' + (W.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    var reason = '';
    if (decision === 'reject') {
      reason = (W.prompt && W.prompt('Reason for rejecting (shown to the applicant):', '')) || '';
      if (!reason.trim()) { if (msg) msg.textContent = 'A reason is required to reject.'; return; }
    }
    btn.disabled = true;
    try {
      var data = kind === 'team' ? { op: 'admin.teamDecide', teamId: id, decision: decision, reason: reason } : { op: 'admin.tournamentDecide', tournamentId: id, decision: decision, reason: reason };
      var r = await call(data);
      if (msg) msg.textContent = 'Done — now ' + String((r && r.status) || decision).replace(/_/g, ' ') + '.';
      setTimeout(function () { load(host); }, 600);
    } catch (err) {
      if (msg) msg.textContent = 'Not changed: ' + ((err && err.message) || 'error');
      btn.disabled = false;
    }
  }

  function boot () {
    var host = document.getElementById(PANEL);
    if (!host) return;
    var loaded = false;
    var go = function () { if (!loaded && !host.hidden) { loaded = true; render(host); } };
    new MutationObserver(go).observe(host, { attributes: true, attributeFilter: ['hidden'] });
    go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  W.SokoniAOSSports = { _teamCard: teamCard, _tourCard: tourCard, _esc: esc };
})(window);
