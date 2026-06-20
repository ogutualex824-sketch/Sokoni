/* ============================================================
   SOKONI Sports Hub — Enhanced Team, Player & Tournament JS
   Loaded after all inline scripts; safely overrides functions.
============================================================ */
(function () {
  'use strict';

  /* ── XSS-safe string escape ── */
  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  window._esc = _esc;

  /* ── Toast helper (re-use existing or fallback) ── */
  function _toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else { const t = document.getElementById('toast'); if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); } }
  }

  /* ── Modal helpers (re-use existing) ── */
  function _openModal(id)  { const el = document.getElementById(id); if (el) { el.classList.add('open'); el.style.display = 'flex'; } }
  function _closeModal(id) { const el = document.getElementById(id); if (el) { el.classList.remove('open'); el.style.display = 'none'; } }

  /* ===========================================================
     1. PLAYER MANAGEMENT — toggle / edit / delete
  =========================================================== */

  function _renderPlayerRow(p, i) {
    const isActive = p.status === 'active';
    const toggleTip = isActive ? 'Mark Injured' : 'Mark Active';
    const toggleStyle = isActive
      ? 'background:rgba(255,120,0,0.09);border-color:rgba(255,120,0,0.28);color:#ff9800;'
      : 'background:rgba(57,255,20,0.09);border-color:rgba(57,255,20,0.28);color:#39ff14;';
    const toggleIcon = isActive ? '🤕' : '✅';
    return `<div class="player-row" id="prow-${i}">
      <div class="player-num">${p.num || '—'}</div>
      <div style="flex:1;min-width:0;">
        <div class="player-name">${_esc(p.name)}</div>
        <div class="player-pos">${_esc(p.pos)}${p.phone ? ` <span style="color:#25d366;font-size:9px;margin-left:6px;">${_esc(p.phone)}</span>` : ''}</div>
      </div>
      <span class="player-status ${isActive ? 'status-active' : 'status-injured'}">${isActive ? 'Active' : 'Injured'}</span>
      <div style="display:flex;gap:4px;margin-left:8px;flex-shrink:0;">
        <button type="button" onclick="togglePlayerStatus(${i})" title="${toggleTip}"
          style="padding:4px 10px;border-radius:7px;border:1px solid;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;${toggleStyle}">${toggleIcon}</button>
        <button type="button" onclick="openEditPlayer(${i})" title="Edit"
          style="padding:4px 9px;border-radius:7px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.5);font-size:11px;cursor:pointer;font-family:inherit;">✏️</button>
        <button type="button" onclick="deletePlayer(${i})" title="Remove"
          style="padding:4px 9px;border-radius:7px;border:1px solid rgba(255,80,80,0.2);background:rgba(255,80,80,0.06);color:#ff6464;font-size:11px;cursor:pointer;font-family:inherit;">✕</button>
      </div>
    </div>`;
  }

  function refreshSquadList() {
    const el = document.getElementById('squadPlayerList');
    if (el) el.innerHTML = squadData.map((p, i) => _renderPlayerRow(p, i)).join('');
  }
  window.refreshSquadList = refreshSquadList;

  window.togglePlayerStatus = function (i) {
    if (!squadData[i]) return;
    squadData[i].status = squadData[i].status === 'active' ? 'injured' : 'active';
    if (typeof _saveSquad === 'function') _saveSquad();
    refreshSquadList();
    if (typeof renderCaptainRoster === 'function') renderCaptainRoster();
    _toast(squadData[i].name + ' → ' + (squadData[i].status === 'active' ? '✅ Active' : '🤕 Injured'));
  };

  window.openEditPlayer = function (i) {
    const p = squadData[i]; if (!p) return;
    document.getElementById('epIdx').value = i;
    document.getElementById('epName').value = p.name || '';
    document.getElementById('epNum').value  = p.num  || '';
    document.getElementById('epPos').value  = p.pos  || 'Midfielder';
    document.getElementById('epPhone').value  = p.phone  || '';
    document.getElementById('epStatus').value = p.status || 'active';
    _openModal('editPlayerModal');
  };

  window.saveEditPlayer = function () {
    const i = parseInt(document.getElementById('epIdx').value, 10);
    if (isNaN(i) || !squadData[i]) return;
    const name = document.getElementById('epName').value.trim();
    if (!name) { _toast('⚠️ Name is required'); return; }
    squadData[i] = Object.assign({}, squadData[i], {
      name,
      num:    parseInt(document.getElementById('epNum').value,   10) || squadData[i].num,
      pos:    document.getElementById('epPos').value    || squadData[i].pos,
      phone:  document.getElementById('epPhone').value.trim(),
      status: document.getElementById('epStatus').value || squadData[i].status,
    });
    if (typeof _saveSquad === 'function') _saveSquad();
    _closeModal('editPlayerModal');
    refreshSquadList();
    if (typeof renderCaptainRoster === 'function') renderCaptainRoster();
    _toast('✅ ' + name + ' updated');
  };

  window.deletePlayer = function (i) {
    const p = squadData[i]; if (!p) return;
    if(!_c){_skConfirm('Remove '+p.name+' from squad?',()=>_doRmPlayer(p,true));return;}
    squadData.splice(i, 1);
    if (typeof _saveSquad === 'function') _saveSquad();
    refreshSquadList();
    if (typeof renderCaptainRoster === 'function') renderCaptainRoster();
    _toast('Player removed');
  };

  /* ===========================================================
     2. MY TEAM — real user data, not hardcoded
  =========================================================== */

  function _getSportsUserSafe() {
    if (typeof _getSportsUser === 'function') return _getSportsUser();
    try { const u = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); if (u) return { id: u.email || u.uid || u.name || 'guest', name: u.name || 'You' }; } catch(e) {}
    let g = localStorage.getItem('sokoniGuestId');
    if (!g) { g = 'G' + Date.now(); localStorage.setItem('sokoniGuestId', g); }
    return { id: g, name: 'You' };
  }

  function getMyTeam() {
    const u = _getSportsUserSafe();
    try {
      const teams = JSON.parse(localStorage.getItem('sokoniTeams') || '[]');
      return teams.find(t => t.ownerId === u.id) || null;
    } catch(e) { return null; }
  }
  window.getMyTeam = getMyTeam;

  /* Override renderSquad with real-user team + action buttons */
  window.renderSquad = function () {
    const el = document.getElementById('myTeamSection'); if (!el) return;
    const myTeam = getMyTeam();

    if (!myTeam) {
      el.innerHTML = `<div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">🏅</div>
        <div style="font-size:18px;font-weight:900;margin-bottom:8px;">No Team Yet</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:20px;">Register your team to manage your squad, send 15-min alerts and post fixtures.</div>
        <button type="button" onclick="openModal('registerTeamModal')" style="padding:12px 28px;background:linear-gradient(135deg,#39ff14,#28cc0f);color:#050f05;font-weight:900;border:none;border-radius:14px;cursor:pointer;font-family:inherit;font-size:14px;">➕ Register My Team</button>
      </div>`;
      return;
    }

    const wins = myTeam.wins || 0, draws = myTeam.draws || 0, losses = myTeam.losses || 0;
    const played = wins + draws + losses, pts = wins * 3 + draws;
    const activeCount   = squadData.filter(p => p.status === 'active').length;
    const injuredCount  = squadData.filter(p => p.status === 'injured').length;

    el.innerHTML = `<div class="my-team-card">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
        <div style="width:70px;height:70px;border-radius:16px;background:linear-gradient(135deg,#061a06,#0d200d);display:flex;align-items:center;justify-content:center;font-size:36px;border:2px solid rgba(57,255,20,0.3);">${myTeam.icon || '🏅'}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:20px;font-weight:900;">${_esc(myTeam.name)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);">${_esc(myTeam.format || '5-a-Side')} · ${_esc(myTeam.area || 'Nairobi')}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:2px;">Captain: ${_esc(myTeam.captain || 'You')}</div>
        </div>
        <button type="button" onclick="openEditTeam()" style="padding:7px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">✏️ Edit Team</button>
      </div>
      <div class="my-team-stats">
        <div class="my-team-stat"><div class="my-team-stat-val">${played}</div><div class="my-team-stat-lbl">Played</div></div>
        <div class="my-team-stat"><div class="my-team-stat-val">${wins}</div><div class="my-team-stat-lbl">Won</div></div>
        <div class="my-team-stat"><div class="my-team-stat-val" style="color:#39ff14;">${pts}</div><div class="my-team-stat-lbl">Points</div></div>
        <div class="my-team-stat"><div class="my-team-stat-val" style="color:${injuredCount>0?'#ff9800':'#39ff14'};">${activeCount}<span style="font-size:10px;color:rgba(255,255,255,0.3);">/${squadData.length}</span></div><div class="my-team-stat-lbl">Available</div></div>
      </div>
      ${injuredCount > 0 ? `<div style="background:rgba(255,120,0,0.07);border:1px solid rgba(255,120,0,0.2);border-radius:10px;padding:8px 14px;margin-bottom:14px;font-size:12px;color:#ff9800;font-weight:700;">🤕 ${injuredCount} player${injuredCount>1?'s':''} injured — check squad below</div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.04em;">Squad (${squadData.length})</div>
        <button type="button" onclick="openModal('addPlayerModal')" style="padding:6px 14px;background:rgba(57,255,20,0.09);border:1px solid rgba(57,255,20,0.25);color:#39ff14;font-size:11px;font-weight:800;border-radius:9px;cursor:pointer;font-family:inherit;">+ Add Player</button>
      </div>
      <div id="squadPlayerList">${squadData.map((p, i) => _renderPlayerRow(p, i)).join('')}</div>
      ${!squadData.length ? '<div class="empty-state" style="padding:30px 10px;"><p>No players yet — add your first player above!</p></div>' : ''}
    </div>`;
  };

  window.openEditTeam = function () {
    const t = getMyTeam(); if (!t) return;
    document.getElementById('etId').value      = t.id      || '';
    document.getElementById('etName').value    = t.name    || '';
    document.getElementById('etCaptain').value = t.captain || '';
    document.getElementById('etPhone').value   = t.phone   || '';
    document.getElementById('etArea').value    = t.area    || '';
    document.getElementById('etFormat').value  = t.format  || '5-a-Side';
    document.getElementById('etIcon').value    = t.icon    || '';
    _openModal('editTeamModal');
  };

  window.saveEditTeam = function () {
    const id   = document.getElementById('etId').value;
    const name = document.getElementById('etName').value.trim();
    if (!name) { _toast('⚠️ Team name required'); return; }
    try {
      let teams = JSON.parse(localStorage.getItem('sokoniTeams') || '[]');
      const idx = teams.findIndex(t => t.id === id);
      if (idx > -1) {
        teams[idx] = Object.assign({}, teams[idx], {
          name,
          captain: document.getElementById('etCaptain').value.trim(),
          phone:   document.getElementById('etPhone').value.trim(),
          area:    document.getElementById('etArea').value.trim(),
          format:  document.getElementById('etFormat').value,
          icon:    document.getElementById('etIcon').value.trim() || teams[idx].icon || '🏅',
        });
        localStorage.setItem('sokoniTeams', JSON.stringify(teams));
      }
    } catch(e) {}
    _closeModal('editTeamModal');
    window.renderSquad();
    if (typeof renderTeamsBrowse === 'function') renderTeamsBrowse();
    _toast('✅ Team updated!');
  };

  /* ===========================================================
     3. TEAMS BROWSE — user teams merged with demo teams
  =========================================================== */

  window.renderTeamsBrowse = function () {
    const el = document.getElementById('teamsBrowseList'); if (!el) return;
    const u = _getSportsUserSafe();
    let userTeams = [];
    try { userTeams = JSON.parse(localStorage.getItem('sokoniTeams') || '[]'); } catch(e) {}
    const demoFiltered = (typeof TEAMS !== 'undefined' ? TEAMS : []).filter(d => !userTeams.some(u => u.name === d.name));
    const all = [
      ...userTeams.map(t => ({
        id: t.id, name: t.name, area: t.area || 'Nairobi', format: t.format || '5-a-Side',
        icon: t.icon || '🏅', played: (t.wins || 0) + (t.draws || 0) + (t.losses || 0),
        won: t.wins || 0, goals: t.goals || 0, rank: '—', rating: null,
        isUser: t.ownerId === u.id
      })),
      ...demoFiltered
    ];
    if (!all.length) { el.innerHTML = '<div class="empty-state">👥<p>No teams yet. Register yours above!</p></div>'; return; }
    el.innerHTML = all.map(t => `
      <div class="team-card" style="${t.isUser ? 'border-color:rgba(57,255,20,0.28);background:rgba(57,255,20,0.025);' : ''}">
        <div class="team-badge-icon">${t.icon}</div>
        <div class="team-info">
          <div class="team-name">${_esc(t.name)}${t.isUser ? ' <span style="font-size:9px;color:#39ff14;background:rgba(57,255,20,0.1);border:1px solid rgba(57,255,20,0.25);border-radius:5px;padding:1px 6px;margin-left:4px;vertical-align:middle;">MY TEAM</span>' : ''}</div>
          <div class="team-meta">${_esc(t.area)} · ${_esc(t.format)}</div>
          <div class="team-stat-row">
            <div class="team-stat"><div class="team-stat-val">${t.played}</div><div class="team-stat-lbl">Played</div></div>
            <div class="team-stat"><div class="team-stat-val">${t.won}</div><div class="team-stat-lbl">Won</div></div>
            <div class="team-stat"><div class="team-stat-val">${t.goals}</div><div class="team-stat-lbl">Goals</div></div>
            ${t.rating != null ? `<div class="team-stat"><div class="team-stat-val" style="color:#fbbf24;">⭐${t.rating}</div><div class="team-stat-lbl">Rating</div></div>` : ''}
          </div>
        </div>
        <div class="team-actions">
          ${t.rank !== '—' ? `<span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:20px;background:rgba(57,255,20,0.12);border:1px solid rgba(57,255,20,0.25);color:#39ff14;">#${t.rank}</span>` : ''}
          <button type="button" class="team-challenge-btn" onclick="openChallengeModal('${_esc(t.name)}')">⚔️ Challenge</button>
        </div>
      </div>`).join('');
  };

  window.openChallengeModal = function (teamName) {
    const selEl = document.getElementById('chOpponent');
    if (selEl) {
      let userTeams = []; try { userTeams = JSON.parse(localStorage.getItem('sokoniTeams') || '[]'); } catch(e) {}
      const names = [...new Set([...(typeof TEAMS !== 'undefined' ? TEAMS.map(t => t.name) : []), ...userTeams.map(t => t.name)])];
      selEl.innerHTML = names.map(n => `<option value="${_esc(n)}"${n === teamName ? ' selected' : ''}>${_esc(n)}</option>`).join('');
    }
    const chTurf = document.getElementById('chTurf');
    if (chTurf && typeof TURFS !== 'undefined') chTurf.innerHTML = TURFS.map(t => `<option>${_esc(t.icon + ' ' + t.name)}</option>`).join('');
    const cd = document.getElementById('chDate'); if (cd && !cd.value) cd.value = new Date().toISOString().slice(0, 10);
    _openModal('challengeModal');
  };

  /* ===========================================================
     4. TOURNAMENTS — create / register / list
  =========================================================== */

  function _getAllTournaments() {
    try {
      const user = JSON.parse(localStorage.getItem('sokoniTournaments') || '[]');
      const demo = typeof TOURNAMENTS_DATA !== 'undefined' ? TOURNAMENTS_DATA : [];
      return [...user, ...demo.filter(d => !user.some(u => u.id === d.id))];
    } catch(e) { return typeof TOURNAMENTS_DATA !== 'undefined' ? [...TOURNAMENTS_DATA] : []; }
  }

  /* Fix: expose TOURNAMENTS alias used by old viewTournamentDetail code */
  Object.defineProperty(window, 'TOURNAMENTS', {
    get: _getAllTournaments, configurable: true
  });

  function _saveTournamentToStore(t) {
    try {
      let arr = JSON.parse(localStorage.getItem('sokoniTournaments') || '[]');
      const idx = arr.findIndex(x => x.id === t.id);
      if (idx > -1) arr[idx] = t; else arr.unshift(t);
      localStorage.setItem('sokoniTournaments', JSON.stringify(arr));
    } catch(e) {}
  }

  function _getTourneyRegs() { try { return JSON.parse(localStorage.getItem('sokoniTourneyReg') || '{}'); } catch(e) { return {}; } }
  function _saveTourneyRegs(obj) { localStorage.setItem('sokoniTourneyReg', JSON.stringify(obj)); }

  window.createTournament = function () {
    const name     = (document.getElementById('ctName')?.value   || '').trim();
    const prize    = (document.getElementById('ctPrize')?.value  || '').trim();
    const fee      = (document.getElementById('ctFee')?.value    || '').trim();
    const maxTeams = parseInt(document.getElementById('ctMax')?.value || '8', 10) || 8;
    const startDate= document.getElementById('ctStart')?.value   || '';
    const endDate  = document.getElementById('ctEnd')?.value     || '';
    const sport    = document.getElementById('ctSport')?.value   || 'football';
    const format   = document.getElementById('ctFormat')?.value  || '5-a-Side';
    const msgEl    = document.getElementById('ctMsg');
    if (!name || !startDate) {
      if (msgEl) { msgEl.textContent = '⚠️ Name and start date are required'; msgEl.style.color = '#ff9800'; }
      return;
    }
    const u = _getSportsUserSafe();
    const t = { id: 'T' + Date.now(), name, prize: prize || 'Trophy', fee: fee || 'Free', sport, format,
      max: maxTeams, teams: 0, date: startDate + (endDate ? ' – ' + endDate : ''),
      status: 'open', createdBy: u.id, registeredTeams: [] };
    _saveTournamentToStore(t);
    _closeModal('createTournamentModal');
    ['ctName','ctPrize','ctFee','ctStart','ctEnd'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    if (msgEl) msgEl.textContent = '';
    renderTournamentsPanel();
    _toast('🏆 Tournament created!');
  };

  window.registerToTournament = function (tId) {
    const myTeam = getMyTeam();
    if (!myTeam) { _toast('⚠️ Register your team first (Teams → My Team)'); return; }
    const regs = _getTourneyRegs();
    if (!regs[tId]) regs[tId] = [];
    if (regs[tId].includes(myTeam.name)) { _toast('Already registered!'); return; }
    /* check capacity */
    const t = _getAllTournaments().find(x => x.id === tId);
    const existingCount = (t && t.registeredTeams ? t.registeredTeams.length : 0) + regs[tId].length;
    if (t && existingCount >= (t.max || t.maxTeams || 99)) { _toast('Tournament is full!'); return; }
    regs[tId].push(myTeam.name);
    _saveTourneyRegs(regs);
    renderTournamentsPanel();
    _toast('✅ ' + myTeam.name + ' registered for ' + (t ? t.name : 'tournament') + '!');
  };

  window.viewTournamentTeams = function (tId) {
    const t = _getAllTournaments().find(x => x.id === tId); if (!t) return;
    const regs    = _getTourneyRegs();
    const regList = [...(t.registeredTeams || []), ...(regs[tId] || [])];
    const u       = _getSportsUserSafe();
    const myTeam  = getMyTeam();
    const isRegistered = myTeam && regList.includes(myTeam.name);
    const isMine  = t.createdBy && t.createdBy === u.id;
    const tdTitle = document.getElementById('tdModalTitle') || document.getElementById('tourneyDetailTitle');
    const tdBody  = document.getElementById('tdModalBody')  || document.getElementById('tourneyDetailBody');
    if (tdTitle) tdTitle.textContent = t.name;
    if (tdBody) tdBody.innerHTML = `
      <div style="background:rgba(57,255,20,0.05);border:1px solid rgba(57,255,20,0.15);border-radius:16px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
          <span class="tc-status tcs-${t.status}">${t.status==='live'?'🔴 LIVE':t.status==='open'?'✅ Open':'❌ Full'}</span>
          <span style="font-size:14px;font-weight:900;color:#ffc107;">🏆 ${_esc(t.prize||'Trophy')}</span>
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,0.45);">${_esc(t.format||'')} · ${_esc(t.date||'')} · Entry: ${_esc(t.fee||'Free')}</div>
        ${isMine ? '<div style="margin-top:6px;font-size:10px;color:rgba(57,255,20,0.6);font-weight:700;">Organised by you</div>' : ''}
      </div>
      <div style="margin-bottom:14px;">
        <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Registered Teams (${regList.length}/${t.max||t.maxTeams||'?'})</div>
        ${regList.length ? regList.map((n, i) => `
          <div style="padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
            <span style="font-size:11px;font-weight:900;color:#39ff14;min-width:20px;">${i+1}</span>
            <span style="font-size:13px;font-weight:800;">${_esc(n)}</span>
            ${n === (myTeam && myTeam.name) ? '<span style="font-size:9px;color:#39ff14;background:rgba(57,255,20,0.1);border:1px solid rgba(57,255,20,0.2);border-radius:4px;padding:1px 6px;margin-left:auto;">MY TEAM</span>' : ''}
          </div>`).join('') : '<div class="empty-state" style="padding:30px;"><p>No teams registered yet — be the first!</p></div>'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${t.status==='open' && !isRegistered ? `<button type="button" onclick="registerToTournament('${t.id}');closeModal('tourneyDetailModal');" style="flex:1;padding:11px;background:linear-gradient(135deg,#39ff14,#28cc0f);color:#050f05;font-weight:900;border:none;border-radius:12px;cursor:pointer;font-family:inherit;font-size:13px;">📝 Register My Team</button>` : ''}
        ${isRegistered ? `<div style="flex:1;padding:11px;background:rgba(57,255,20,0.06);border:1px solid rgba(57,255,20,0.2);border-radius:12px;text-align:center;font-size:13px;font-weight:700;color:#39ff14;">✅ Registered</div>` : ''}
        <button type="button" onclick="closeModal('tourneyDetailModal');showPanel('fixtures',null);" style="flex:1;padding:11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.55);border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">📋 View Fixtures</button>
      </div>`;
    const modalId = document.getElementById('tourneyDetailModal') ? 'tourneyDetailModal' : 'tourneyDetailModal';
    _openModal(modalId);
    if (typeof openModal === 'function') openModal('tourneyDetailModal');
  };

  window.renderTournamentsPanel = function (filter) {
    const el = document.getElementById('tourneyList'); if (!el) return;
    const f = filter || window._tourneyFilter || 'all';
    const u = _getSportsUserSafe();
    const myTeam = getMyTeam();
    const regs = _getTourneyRegs();
    let list = _getAllTournaments();
    if (f === 'open')  list = list.filter(t => t.status === 'open');
    else if (f === 'live') list = list.filter(t => t.status === 'live');
    else if (f === 'mine') { const u2 = _getSportsUserSafe(); list = list.filter(t => t.createdBy === u2.id); }
    else if (f !== 'all') list = list.filter(t => t.sport === f);
    if (!list.length) { el.innerHTML = '<div class="empty-state">🏆<p>No tournaments found. Create one!</p></div>'; return; }
    el.innerHTML = list.map(t => {
      const regList = [...(t.registeredTeams || []), ...(regs[t.id] || [])];
      const isRegistered = myTeam && regList.includes(myTeam.name);
      const isMine = t.createdBy && t.createdBy === u.id;
      return `<div class="tourney-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <div style="flex:1;min-width:0;">
            <div class="tc-title">${_esc(t.name)}</div>
            <div class="tc-meta">${_esc(t.format || '')} · ${_esc(t.date || '')}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:3px;">Entry: ${_esc(t.fee || 'Free')} · ${regList.length}/${t.max || t.maxTeams || '?'} teams${isMine ? ' · <span style="color:rgba(57,255,20,0.6);">Yours</span>' : ''}</div>
          </div>
          <span class="tc-status tcs-${t.status}">${t.status === 'live' ? '🔴 LIVE' : t.status === 'open' ? '✅ Open' : '❌ Full'}</span>
        </div>
        <div class="tc-prize">🏆 ${_esc(t.prize || 'Trophy')}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button type="button" onclick="viewTournamentTeams('${t.id}')" style="padding:8px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.55);font-size:12px;font-weight:700;border-radius:10px;cursor:pointer;font-family:inherit;">👥 Teams & Info</button>
          ${isRegistered
            ? '<span style="padding:8px 14px;background:rgba(57,255,20,0.08);border:1px solid rgba(57,255,20,0.2);color:#39ff14;font-size:12px;font-weight:700;border-radius:10px;">✅ Registered</span>'
            : t.status === 'open'
              ? `<button type="button" class="tc-register-btn" onclick="registerToTournament('${t.id}')">📝 Register Team</button>`
              : '<span style="padding:8px 14px;font-size:12px;color:rgba(255,100,100,0.7);">❌ Full</span>'}
        </div>
      </div>`;
    }).join('');
  };

  /* Override filterTourneys to use new renderer */
  window.filterTourneys = function (sport, btn) {
    window._tourneyFilter = sport || 'all';
    document.querySelectorAll('#panel-tournaments .sh-filter-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderTournamentsPanel(sport);
  };

  /* ===========================================================
     5. HOOK INTO PANEL SWITCHING — trigger renders on tab open
  =========================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    /* Wrap showTeamSub */
    const _origTeamSub = window.showTeamSub;
    window.showTeamSub = function (name, btn) {
      if (_origTeamSub) _origTeamSub(name, btn);
      if (name === 'myteam')    window.renderSquad();
      if (name === 'browse')    window.renderTeamsBrowse();
      if (name === 'challenges' && typeof renderChallenges === 'function') renderChallenges();
      if (name === 'history'    && typeof renderMatchHistory === 'function') renderMatchHistory();
    };

    /* Wrap showPanel */
    const _origShowPanel = window.showPanel;
    window.showPanel = function (name, btn, skipHistory) {
      if (_origShowPanel) _origShowPanel(name, btn, skipHistory);
      if (name === 'tournaments') renderTournamentsPanel();
      if (name === 'teams')       window.renderTeamsBrowse();
    };

    /* Initial renders */
    renderTournamentsPanel();
    window.renderTeamsBrowse();

    /* If "My Team" sub-panel is already visible, render it */
    const myTeamEl = document.getElementById('sub-myteam');
    if (myTeamEl && myTeamEl.classList.contains('active')) window.renderSquad();
  });

})();

