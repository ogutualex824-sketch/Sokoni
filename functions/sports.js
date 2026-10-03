/* ============================================================================
   SPORTS — the server authority for the genuinely-Sports objects (owner 2026-10-03; 2f)
   ----------------------------------------------------------------------------
   Teams, memberships, tournaments, registrations, ONE canonical fixture per match, results and standings.
   Everything else is reused (docs/SPORTS_DEPENDENCY_MAP_2026-10-03.md): venues → the general venue engine,
   coaches → provider booking, money → existing payment / receipt / wallet, messaging → messages.js anchored types,
   notifications → notify.js (dedupeKey). The browser never approves, never moves a state, never writes a fixture
   or a result; it asks this module.

   DATA (field names are a contract — messaging and AdminOS read them)
     teams/{teamId}
       name, sport, category, county, ownerUid, captainUid, managerUids[], rosterMax,
       status: draft | submitted | approved | rejected | archived, verification: pending | verified,
       decidedBy, decidedAt, decisionReason, createdAt, updatedAt
     sportsTeamMembers/{teamId}_{uid}            ← create(): one membership per (team, player), never duplicated
       teamId, uid, role: captain | manager | player, status: invited | active | declined | removed | left,
       invitedBy, history[{status, by, at}], updatedAt
     tournaments/{tournamentId}
       name, sport, category, organiserUid, capacity, entryFeeKES, regOpensAt, regClosesAt, startsAt,
       status: draft | submitted | under_review | approved | rejected | registration_open | registration_closed |
               fixtures_published | in_progress | completed | archived,
       standings{teamId: {p,w,d,l,gf,ga,pts}}, decidedBy, decidedAt, decisionReason, createdAt, updatedAt
     sportsTournamentRegs/{tournamentId}_{teamId}  ← create(): no duplicate registration
       tournamentId, teamId, captainUid (snapshot at apply), status: pending | pending_payment | registered |
       rejected | withdrawn, decidedBy, updatedAt
     sportsFixtures/{tournamentId}_R{round}_{n}   ← THE fixture; every view reads this one record
       tournamentId, round, homeTeamId, awayTeamId, venueId, startsAt, status: scheduled | confirmed | live |
       completed | postponed | cancelled, result{home, away, status: submitted | confirmed | disputed | resolved,
       submittedBy, submittedFor, confirmedBy}, history[{event, by, at, ...}]

   ENTRY FEES: a tournament with entryFeeKES > 0 parks registrations in pending_payment and they CANNOT be approved
   until a held tournament-entry payment path is certified (owner rule: incomplete commercial capability stays OFF).
   ============================================================================ */
'use strict';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_ROSTER_MAX = 40;
const T_FLOW = Object.freeze({   /* owner-driven transitions (admin decides submitted/under_review → approved/rejected) */
  approved: ['registration_open'], registration_open: ['registration_closed'],
  registration_closed: [], fixtures_published: ['in_progress'], in_progress: ['completed'], completed: ['archived'],
});
const FIXTURE_STATUS = Object.freeze(['scheduled', 'confirmed', 'live', 'completed', 'postponed', 'cancelled']);

class SportsError extends Error { constructor (code, message) { super(message); this.code = code; } }
const fail = (code, msg) => { throw new SportsError(code, msg); };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n || 120);
const memberId = (teamId, uid) => String(teamId) + '_' + String(uid);
const regId = (tid, teamId) => String(tid) + '_' + String(teamId);

function _ctx (deps) {
  const d = deps || {};
  return {
    now: d.now || (() => new Date()),
    ts: d.serverTs || (() => new Date()),
    notify: d.notify || null,            /* (msg) => Promise; never allowed to fail an operation */
    syncConv: d.syncConv || null,        /* (type, parentId) => Promise — messaging participant re-derivation */
    ensureConv: d.ensureConv || null,    /* (type, parentId) => Promise — server-side conversation creation */
  };
}
async function _quiet (fn) { try { if (fn) await fn(); } catch (_) { /* side effects never fail the operation */ } }
const _hist = (arr, entry) => (Array.isArray(arr) ? arr : []).concat([entry]).slice(-200);

/* ── TEAMS ─────────────────────────────────────────────────────────────────────── */
async function teamRegister (db, uid, data, deps) {
  const c = _ctx(deps);
  const name = clean(data.name, 80), sport = clean(data.sport, 40).toLowerCase();
  if (!uid) fail('unauthenticated', 'Sign in to register a team.');
  if (name.length < 2 || !sport) fail('invalid-argument', 'Team name and sport are required.');
  const ref = db.collection('teams').doc();
  const now = c.ts();
  await db.runTransaction(async (t) => {
    t.create(ref, { name, sport, category: clean(data.category, 40) || null, county: clean(data.county, 40) || null,
      ownerUid: uid, captainUid: uid, managerUids: [], rosterMax: DEFAULT_ROSTER_MAX,
      status: data.submit ? 'submitted' : 'draft', verification: 'pending', createdAt: now, updatedAt: now });
    t.create(db.collection('sportsTeamMembers').doc(memberId(ref.id, uid)), { teamId: ref.id, uid, role: 'captain', status: 'active',
      invitedBy: uid, history: [{ status: 'active', by: uid, at: now }], updatedAt: now });
  });
  return { ok: true, teamId: ref.id, status: data.submit ? 'submitted' : 'draft' };
}

async function teamSubmit (db, uid, teamId) {
  const ref = db.collection('teams').doc(String(teamId));
  return db.runTransaction(async (t) => {
    const s = await t.get(ref); if (!s.exists) fail('not-found', 'Team not found.');
    const tm = s.data();
    if (tm.ownerUid !== uid) fail('permission-denied', 'Only the team owner can submit it.');
    if (tm.status !== 'draft' && tm.status !== 'rejected') fail('failed-precondition', 'This team is already ' + tm.status + '.');
    t.update(ref, { status: 'submitted', updatedAt: new Date() });
    return { ok: true, status: 'submitted' };
  });
}

/** Admin decision (AdminOS). Approve makes the team live; reject returns it to its owner with a reason. */
async function adminTeamDecide (db, adminUid, data, deps) {
  const c = _ctx(deps);
  const ref = db.collection('teams').doc(String(data.teamId));
  const decision = data.decision === 'approve' ? 'approved' : data.decision === 'reject' ? 'rejected' : null;
  if (!decision) fail('invalid-argument', 'decision must be approve or reject.');
  const out = await db.runTransaction(async (t) => {
    const s = await t.get(ref); if (!s.exists) fail('not-found', 'Team not found.');
    const tm = s.data();
    if (tm.status !== 'submitted') fail('failed-precondition', 'Only a submitted team can be decided (it is ' + tm.status + ').');
    t.update(ref, { status: decision, verification: decision === 'approved' ? 'verified' : 'pending', decidedBy: adminUid, decidedAt: c.ts(),
      decisionReason: clean(data.reason, 300) || null, updatedAt: c.ts() });
    return { ok: true, status: decision, ownerUid: tm.ownerUid, name: tm.name };
  });
  if (decision === 'approved') await _quiet(c.ensureConv && (() => c.ensureConv('sports_team', ref.id)));
  await _quiet(c.notify && (() => c.notify({ uid: out.ownerUid, type: 'sports_team_decision', title: 'Team ' + decision,
    body: out.name + ' was ' + decision + '.', dedupeKey: 'sports_team_decision_' + ref.id + '_' + decision })));
  return { ok: true, status: decision };
}

function _isLeader (team, uid) { return team.captainUid === uid || team.ownerUid === uid || (Array.isArray(team.managerUids) && team.managerUids.includes(uid)); }

async function teamInvite (db, uid, data, deps) {
  const c = _ctx(deps);
  const teamRef = db.collection('teams').doc(String(data.teamId));
  const player = String(data.playerUid || '');
  if (!ID_RE.test(player)) fail('invalid-argument', 'Choose a player to invite.');
  const mRef = db.collection('sportsTeamMembers').doc(memberId(data.teamId, player));
  await db.runTransaction(async (t) => {
    const [ts, ms] = await Promise.all([t.get(teamRef), t.get(mRef)]);
    if (!ts.exists) fail('not-found', 'Team not found.');
    const tm = ts.data();
    if (tm.status !== 'approved') fail('failed-precondition', 'Only an approved team can invite players.');
    if (!_isLeader(tm, uid)) fail('permission-denied', 'Only the captain or a manager can invite players.');
    if (ms.exists && ['invited', 'active'].includes(ms.data().status)) fail('already-exists', 'That player is already invited or on the team.');
    const now = c.ts();
    const row = { teamId: teamRef.id, uid: player, role: 'player', status: 'invited', invitedBy: uid, updatedAt: now,
      history: _hist(ms.exists ? ms.data().history : [], { status: 'invited', by: uid, at: now }) };
    if (ms.exists) t.set(mRef, row); else t.create(mRef, row);
  });
  await _quiet(c.notify && (() => c.notify({ uid: player, type: 'sports_team_invite', title: 'Team invitation', body: 'You have been invited to join a team.',
    dedupeKey: 'sports_invite_' + memberId(data.teamId, player) + '_' + Date.now().toString(36).slice(0, 5) })));
  return { ok: true, status: 'invited' };
}

async function teamRespond (db, uid, data, deps) {
  const c = _ctx(deps);
  const teamRef = db.collection('teams').doc(String(data.teamId));
  const mRef = db.collection('sportsTeamMembers').doc(memberId(data.teamId, uid));
  const next = data.accept === true ? 'active' : 'declined';
  await db.runTransaction(async (t) => {
    const [ts, ms] = await Promise.all([t.get(teamRef), t.get(mRef)]);
    if (!ts.exists || !ms.exists || ms.data().status !== 'invited') fail('failed-precondition', 'There is no invitation to answer.');
    if (next === 'active') {
      const tm = ts.data();
      if (tm.status !== 'approved') fail('failed-precondition', 'That team is not active.');
      const active = await t.get(db.collection('sportsTeamMembers').where('teamId', '==', teamRef.id).where('status', '==', 'active'));
      if ((active.docs || []).length >= (tm.rosterMax || DEFAULT_ROSTER_MAX)) fail('resource-exhausted', 'The team roster is full.');
    }
    t.update(mRef, { status: next, updatedAt: c.ts(), history: _hist(ms.data().history, { status: next, by: uid, at: c.ts() }) });
  });
  await _quiet(c.syncConv && (() => c.syncConv('sports_team', teamRef.id)));
  return { ok: true, status: next };
}

async function teamRemove (db, uid, data, deps) {
  const c = _ctx(deps);
  const target = String(data.playerUid || uid);
  const teamRef = db.collection('teams').doc(String(data.teamId));
  const mRef = db.collection('sportsTeamMembers').doc(memberId(data.teamId, target));
  await db.runTransaction(async (t) => {
    const [ts, ms] = await Promise.all([t.get(teamRef), t.get(mRef)]);
    if (!ts.exists || !ms.exists || !['active', 'invited'].includes(ms.data().status)) fail('failed-precondition', 'That player is not on the team.');
    const tm = ts.data();
    const self = target === uid;
    if (!self && !_isLeader(tm, uid)) fail('permission-denied', 'Only the captain or a manager can remove a player.');
    if (target === tm.captainUid) fail('failed-precondition', 'The captain cannot be removed. Transfer the captaincy first.');
    const next = self ? 'left' : 'removed';
    t.update(mRef, { status: next, updatedAt: c.ts(), history: _hist(ms.data().history, { status: next, by: uid, at: c.ts() }) });
    if (Array.isArray(tm.managerUids) && tm.managerUids.includes(target)) t.update(teamRef, { managerUids: tm.managerUids.filter((x) => x !== target), updatedAt: c.ts() });
  });
  await _quiet(c.syncConv && (() => c.syncConv('sports_team', teamRef.id)));
  return { ok: true };
}

/** Captain grants / withdraws the MANAGER role — a team-granted role, never a platform privilege. */
async function teamSetManager (db, uid, data) {
  const teamRef = db.collection('teams').doc(String(data.teamId));
  const target = String(data.playerUid || '');
  return db.runTransaction(async (t) => {
    const [ts, ms] = await Promise.all([t.get(teamRef), t.get(db.collection('sportsTeamMembers').doc(memberId(data.teamId, target)))]);
    if (!ts.exists) fail('not-found', 'Team not found.');
    const tm = ts.data();
    if (tm.captainUid !== uid) fail('permission-denied', 'Only the captain can change managers.');
    if (!ms.exists || ms.data().status !== 'active') fail('failed-precondition', 'Only an active player can be a manager.');
    const set = new Set(tm.managerUids || []);
    if (data.manager === true) set.add(target); else set.delete(target);
    t.update(teamRef, { managerUids: [...set], updatedAt: new Date() });
    return { ok: true, managerUids: [...set] };
  });
}

/* ── TOURNAMENTS ───────────────────────────────────────────────────────────────── */
function _ms (v) { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; }

async function tournamentCreate (db, uid, data, deps) {
  const c = _ctx(deps);
  const name = clean(data.name, 100), sport = clean(data.sport, 40).toLowerCase();
  const regOpensAt = _ms(data.regOpensAt), regClosesAt = _ms(data.regClosesAt), startsAt = _ms(data.startsAt);
  const capacity = Number(data.capacity), fee = Number(data.entryFeeKES || 0);
  if (!uid) fail('unauthenticated', 'Sign in to create a tournament.');
  if (name.length < 3 || !sport) fail('invalid-argument', 'Name and sport are required.');
  if (!regOpensAt || !regClosesAt || !startsAt || !(regOpensAt < regClosesAt && regClosesAt <= startsAt)) fail('invalid-argument', 'Dates must run: registration opens → closes → tournament starts.');
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 512) fail('invalid-argument', 'Capacity must be 2–512 teams.');
  if (!Number.isInteger(fee) || fee < 0 || fee > 1000000) fail('invalid-argument', 'Entry fee must be a whole number of shillings.');
  const ref = db.collection('tournaments').doc();
  await ref.set({ name, sport, category: clean(data.category, 40) || null, organiserUid: uid, capacity, entryFeeKES: fee,
    regOpensAt, regClosesAt, startsAt, rules: clean(data.rules, 2000) || null, status: 'draft', standings: {}, createdAt: c.ts(), updatedAt: c.ts() });
  return { ok: true, tournamentId: ref.id, status: 'draft' };
}

async function tournamentSubmit (db, uid, tid) {
  const ref = db.collection('tournaments').doc(String(tid));
  return db.runTransaction(async (t) => {
    const s = await t.get(ref); if (!s.exists) fail('not-found', 'Tournament not found.');
    const tr = s.data();
    if (tr.organiserUid !== uid) fail('permission-denied', 'Only the organiser can submit this tournament.');
    if (tr.status !== 'draft' && tr.status !== 'rejected') fail('failed-precondition', 'This tournament is already ' + tr.status + '.');
    t.update(ref, { status: 'submitted', updatedAt: new Date() });
    return { ok: true, status: 'submitted' };
  });
}

async function adminTournamentDecide (db, adminUid, data, deps) {
  const c = _ctx(deps);
  const ref = db.collection('tournaments').doc(String(data.tournamentId));
  const decision = data.decision === 'approve' ? 'approved' : data.decision === 'reject' ? 'rejected' : data.decision === 'review' ? 'under_review' : null;
  if (!decision) fail('invalid-argument', 'decision must be review, approve or reject.');
  const out = await db.runTransaction(async (t) => {
    const s = await t.get(ref); if (!s.exists) fail('not-found', 'Tournament not found.');
    const tr = s.data();
    const allowed = decision === 'under_review' ? ['submitted'] : ['submitted', 'under_review'];
    if (!allowed.includes(tr.status)) fail('failed-precondition', 'This tournament is ' + tr.status + '.');
    t.update(ref, { status: decision, decidedBy: adminUid, decidedAt: c.ts(), decisionReason: clean(data.reason, 300) || null, updatedAt: c.ts() });
    return { organiserUid: tr.organiserUid, name: tr.name };
  });
  if (decision !== 'under_review') await _quiet(c.notify && (() => c.notify({ uid: out.organiserUid, type: 'sports_tournament_decision', title: 'Tournament ' + decision,
    body: out.name + ' was ' + decision + '.', dedupeKey: 'sports_tournament_decision_' + ref.id + '_' + decision })));
  if (decision === 'approved') await _quiet(c.ensureConv && (() => c.ensureConv('sports_tournament', ref.id)));
  return { ok: true, status: decision };
}

/** Organiser moves the tournament forward along T_FLOW only. fixtures_published happens only via publishFixtures. */
async function tournamentTransition (db, uid, data) {
  const ref = db.collection('tournaments').doc(String(data.tournamentId));
  const to = String(data.to || '');
  return db.runTransaction(async (t) => {
    const s = await t.get(ref); if (!s.exists) fail('not-found', 'Tournament not found.');
    const tr = s.data();
    if (tr.organiserUid !== uid) fail('permission-denied', 'Only the organiser can change this tournament.');
    if (!(T_FLOW[tr.status] || []).includes(to)) fail('failed-precondition', 'A ' + tr.status + ' tournament cannot move to ' + to + '.');
    t.update(ref, { status: to, updatedAt: new Date() });
    return { ok: true, status: to };
  });
}

/* ── REGISTRATIONS ─────────────────────────────────────────────────────────────── */
async function registrationApply (db, uid, data, deps) {
  const c = _ctx(deps);
  const tRef = db.collection('tournaments').doc(String(data.tournamentId));
  const teamRef = db.collection('teams').doc(String(data.teamId));
  const rRef = db.collection('sportsTournamentRegs').doc(regId(data.tournamentId, data.teamId));
  const out = await db.runTransaction(async (t) => {
    const [trS, tmS, rS] = await Promise.all([t.get(tRef), t.get(teamRef), t.get(rRef)]);
    if (!trS.exists || !tmS.exists) fail('not-found', 'Tournament or team not found.');
    const tr = trS.data(), tm = tmS.data();
    if (!_isLeader(tm, uid)) fail('permission-denied', 'Only the team captain or a manager can register the team.');
    if (tm.status !== 'approved') fail('failed-precondition', 'Only an approved team can enter a tournament.');
    if (tr.status !== 'registration_open') fail('failed-precondition', 'Registration is not open for this tournament.');
    const now = c.now().getTime();
    if (now < tr.regOpensAt || now > tr.regClosesAt) fail('failed-precondition', 'Registration is closed for this tournament.');
    if (String(tm.sport) !== String(tr.sport)) fail('failed-precondition', 'This team plays ' + tm.sport + '; the tournament is ' + tr.sport + '.');
    if (rS.exists && !['withdrawn', 'rejected'].includes(rS.data().status)) fail('already-exists', 'This team is already registered for the tournament.');
    const taken = await t.get(db.collection('sportsTournamentRegs').where('tournamentId', '==', tRef.id).where('status', '==', 'registered'));
    if ((taken.docs || []).length >= tr.capacity) fail('resource-exhausted', 'The tournament is full.');
    const status = Number(tr.entryFeeKES) > 0 ? 'pending_payment' : 'pending';
    const row = { tournamentId: tRef.id, teamId: teamRef.id, captainUid: tm.captainUid, status, updatedAt: c.ts() };
    if (rS.exists) t.set(rRef, row); else t.create(rRef, row);
    return { status, organiserUid: tr.organiserUid };
  });
  await _quiet(c.notify && (() => c.notify({ uid: out.organiserUid, type: 'sports_registration_update', title: 'New registration', body: 'A team applied to your tournament.',
    dedupeKey: 'sports_reg_apply_' + rRef.id })));
  return { ok: true, registrationId: rRef.id, status: out.status };
}

async function registrationDecide (db, uid, data, deps) {
  const c = _ctx(deps);
  const rRef = db.collection('sportsTournamentRegs').doc(String(data.registrationId));
  const approve = data.approve === true;
  const out = await db.runTransaction(async (t) => {
    const rS = await t.get(rRef); if (!rS.exists) fail('not-found', 'Registration not found.');
    const r = rS.data();
    const trS = await t.get(db.collection('tournaments').doc(r.tournamentId));
    const tr = trS.data() || {};
    if (tr.organiserUid !== uid) fail('permission-denied', 'Only the organiser decides registrations.');
    if (r.status === 'pending_payment' && approve) fail('failed-precondition', 'Entry-fee payment is not available yet, so this registration cannot be approved.');
    if (!['pending', 'pending_payment'].includes(r.status)) fail('failed-precondition', 'This registration is ' + r.status + '.');
    if (approve) {
      const taken = await t.get(db.collection('sportsTournamentRegs').where('tournamentId', '==', r.tournamentId).where('status', '==', 'registered'));
      if ((taken.docs || []).length >= tr.capacity) fail('resource-exhausted', 'The tournament is full.');
    }
    const status = approve ? 'registered' : 'rejected';
    t.update(rRef, { status, decidedBy: uid, updatedAt: c.ts() });
    return { status, captainUid: r.captainUid, tournamentId: r.tournamentId };
  });
  await _quiet(c.syncConv && (() => c.syncConv('sports_tournament', out.tournamentId)));
  if (out.status === 'registered') await _quiet(c.ensureConv && (() => c.ensureConv('sports_registration', rRef.id)));
  await _quiet(c.notify && (() => c.notify({ uid: out.captainUid, type: 'sports_registration_update', title: 'Registration ' + out.status,
    body: 'Your tournament registration was ' + out.status + '.', dedupeKey: 'sports_reg_decide_' + rRef.id + '_' + out.status })));
  return { ok: true, status: out.status };
}

async function registrationWithdraw (db, uid, data, deps) {
  const c = _ctx(deps);
  const rRef = db.collection('sportsTournamentRegs').doc(String(data.registrationId));
  const out = await db.runTransaction(async (t) => {
    const rS = await t.get(rRef); if (!rS.exists) fail('not-found', 'Registration not found.');
    const r = rS.data();
    const tmS = await t.get(db.collection('teams').doc(r.teamId));
    if (!_isLeader(tmS.data() || {}, uid)) fail('permission-denied', 'Only the team captain or a manager can withdraw.');
    if (!['pending', 'pending_payment', 'registered'].includes(r.status)) fail('failed-precondition', 'This registration is ' + r.status + '.');
    const trS = await t.get(db.collection('tournaments').doc(r.tournamentId));
    if (['fixtures_published', 'in_progress', 'completed', 'archived'].includes((trS.data() || {}).status)) fail('failed-precondition', 'Fixtures are published; contact the organiser.');
    t.update(rRef, { status: 'withdrawn', updatedAt: c.ts() });
    return { tournamentId: r.tournamentId };
  });
  await _quiet(c.syncConv && (() => c.syncConv('sports_tournament', out.tournamentId)));
  return { ok: true, status: 'withdrawn' };
}

/* ── FIXTURES ──────────────────────────────────────────────────────────────────── */
/** Round-robin pairing (circle method). Pure: teamIds → [{round, home, away}]. */
function roundRobin (teamIds) {
  const ids = teamIds.slice();
  if (ids.length % 2) ids.push(null);
  const rounds = [], n = ids.length;
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const h = ids[i], a = ids[n - 1 - i];
      if (h && a) rounds.push({ round: r + 1, home: r % 2 ? a : h, away: r % 2 ? h : a });
    }
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

/** Organiser publishes fixtures once registration is closed. Supplied pairings OR round-robin of registered teams. */
async function fixturesPublish (db, uid, data, deps) {
  const c = _ctx(deps);
  const tRef = db.collection('tournaments').doc(String(data.tournamentId));
  const regs = await db.collection('sportsTournamentRegs').where('tournamentId', '==', tRef.id).where('status', '==', 'registered').get();
  const teams = (regs.docs || []).map((d) => d.data().teamId);
  const out = await db.runTransaction(async (t) => {
    const s = await t.get(tRef); if (!s.exists) fail('not-found', 'Tournament not found.');
    const tr = s.data();
    if (tr.organiserUid !== uid) fail('permission-denied', 'Only the organiser publishes fixtures.');
    if (tr.status !== 'registration_closed') fail('failed-precondition', 'Close registration before publishing fixtures.');
    if (teams.length < 2) fail('failed-precondition', 'At least two registered teams are needed.');
    const pairs = Array.isArray(data.fixtures) && data.fixtures.length ? data.fixtures.map((f) => ({ round: Number(f.round) || 1, home: String(f.homeTeamId), away: String(f.awayTeamId), startsAt: _ms(f.startsAt), venueId: f.venueId ? clean(f.venueId, 128) : null }))
      : roundRobin(teams);
    for (const p of pairs) {
      if (!teams.includes(p.home) || !teams.includes(p.away) || p.home === p.away) fail('invalid-argument', 'Every fixture must pair two different registered teams.');
    }
    const perRound = {};
    const ids = [];
    for (const p of pairs) {
      perRound[p.round] = (perRound[p.round] || 0) + 1;
      const id = tRef.id + '_R' + p.round + '_' + perRound[p.round];
      ids.push(id);
      t.create(db.collection('sportsFixtures').doc(id), { tournamentId: tRef.id, round: p.round, homeTeamId: p.home, awayTeamId: p.away,
        venueId: p.venueId || null, startsAt: p.startsAt || null, status: 'scheduled', result: null,
        history: [{ event: 'created', by: uid, at: c.ts() }], createdAt: c.ts(), updatedAt: c.ts() });
    }
    t.update(tRef, { status: 'fixtures_published', standings: Object.fromEntries(teams.map((x) => [x, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }])), updatedAt: c.ts() });
    return { ids };
  });
  return { ok: true, fixtures: out.ids };
}

/** Organiser updates the ONE fixture (time / venue / status). Every change is appended to its history and notified. */
async function fixtureUpdate (db, uid, data, deps) {
  const c = _ctx(deps);
  const fRef = db.collection('sportsFixtures').doc(String(data.fixtureId));
  const out = await db.runTransaction(async (t) => {
    const fS = await t.get(fRef); if (!fS.exists) fail('not-found', 'Fixture not found.');
    const f = fS.data();
    const trS = await t.get(db.collection('tournaments').doc(f.tournamentId));
    if ((trS.data() || {}).organiserUid !== uid) fail('permission-denied', 'Only the organiser changes fixtures.');
    if (['completed', 'cancelled'].includes(f.status)) fail('failed-precondition', 'This fixture is ' + f.status + '.');
    const patch = {};
    if (data.startsAt !== undefined) { const ms = _ms(data.startsAt); if (!ms) fail('invalid-argument', 'Bad start time.'); patch.startsAt = ms; }
    if (data.venueId !== undefined) patch.venueId = data.venueId ? clean(data.venueId, 128) : null;
    if (data.status !== undefined) {
      if (!FIXTURE_STATUS.includes(data.status) || data.status === 'completed') fail('invalid-argument', 'Use a result to complete a fixture.');
      patch.status = data.status;
    }
    if (!Object.keys(patch).length) fail('invalid-argument', 'Nothing to change.');
    patch.history = _hist(f.history, Object.assign({ event: 'updated', by: uid, at: c.ts() }, patch));
    patch.updatedAt = c.ts();
    t.update(fRef, patch);
    return { f, patch };
  });
  const parties = await _fixtureParties(db, out.f);
  const changed = Object.keys(out.patch).filter((k) => !['history', 'updatedAt'].includes(k)).sort().join('_');
  for (const p of parties) {
    await _quiet(c.notify && (() => c.notify({ uid: p, type: 'sports_fixture_update', title: 'Fixture updated', body: 'A fixture you play in was updated.',
      dedupeKey: 'sports_fixture_' + fRef.id + '_' + changed + '_' + (out.patch.history.length) + '_' + p })));
  }
  return { ok: true };
}

/** Everyone who should hear about a fixture: active members of both teams (server-derived, never the request). */
async function _fixtureParties (db, f) {
  const out = new Set();
  for (const teamId of [f.homeTeamId, f.awayTeamId]) {
    const ms = await db.collection('sportsTeamMembers').where('teamId', '==', teamId).where('status', '==', 'active').get();
    (ms.docs || []).forEach((d) => out.add(d.data().uid));
  }
  return [...out];
}

/* ── RESULTS + STANDINGS ───────────────────────────────────────────────────────── */
/** A participating team's captain/manager — or the organiser — submits; the OTHER side (or the organiser) confirms. */
async function resultSubmit (db, uid, data, deps) {
  const c = _ctx(deps);
  const fRef = db.collection('sportsFixtures').doc(String(data.fixtureId));
  const home = Number(data.home), away = Number(data.away);
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 999 || away > 999) fail('invalid-argument', 'Scores must be whole numbers.');
  await db.runTransaction(async (t) => {
    const fS = await t.get(fRef); if (!fS.exists) fail('not-found', 'Fixture not found.');
    const f = fS.data();
    if (['cancelled', 'postponed'].includes(f.status)) fail('failed-precondition', 'This fixture is ' + f.status + '.');
    if (f.result && ['confirmed', 'resolved'].includes(f.result.status)) fail('failed-precondition', 'This result is final. Raise a dispute instead.');
    const [trS, hS, aS] = await Promise.all([t.get(db.collection('tournaments').doc(f.tournamentId)), t.get(db.collection('teams').doc(f.homeTeamId)), t.get(db.collection('teams').doc(f.awayTeamId))]);
    const organiser = (trS.data() || {}).organiserUid === uid;
    const side = _isLeader(hS.data() || {}, uid) ? f.homeTeamId : _isLeader(aS.data() || {}, uid) ? f.awayTeamId : null;
    if (!organiser && !side) fail('permission-denied', 'Only the organiser or a participating team\'s captain / manager can submit the result.');
    t.update(fRef, { result: { home, away, status: 'submitted', submittedBy: uid, submittedFor: organiser ? 'organiser' : side, confirmedBy: null },
      history: _hist(f.history, { event: 'result_submitted', by: uid, home, away, at: c.ts() }), updatedAt: c.ts() });
  });
  return { ok: true, status: 'submitted' };
}

async function resultConfirm (db, uid, data, deps) {
  const c = _ctx(deps);
  const fRef = db.collection('sportsFixtures').doc(String(data.fixtureId));
  const out = await db.runTransaction(async (t) => {
    const fS = await t.get(fRef); if (!fS.exists) fail('not-found', 'Fixture not found.');
    const f = fS.data();
    if (!f.result || !['submitted', 'disputed'].includes(f.result.status)) fail('failed-precondition', 'There is no result to confirm.');
    const tRef = db.collection('tournaments').doc(f.tournamentId);
    const [trS, hS, aS] = await Promise.all([t.get(tRef), t.get(db.collection('teams').doc(f.homeTeamId)), t.get(db.collection('teams').doc(f.awayTeamId))]);
    const tr = trS.data() || {};
    const organiser = tr.organiserUid === uid;
    const side = _isLeader(hS.data() || {}, uid) ? f.homeTeamId : _isLeader(aS.data() || {}, uid) ? f.awayTeamId : null;
    /* the submitter's own side can never confirm its own report; a dispute is resolved only by the organiser */
    if (f.result.status === 'disputed' && !organiser) fail('permission-denied', 'Only the organiser resolves a disputed result.');
    if (!organiser && (!side || side === f.result.submittedFor || f.result.submittedBy === uid)) fail('permission-denied', 'The other team (or the organiser) must confirm this result.');
    const finalStatus = f.result.status === 'disputed' ? 'resolved' : 'confirmed';
    const already = f.status === 'completed';
    const st = Object.assign({}, tr.standings || {});
    if (!already) {
      const H = Object.assign({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }, st[f.homeTeamId]);
      const A = Object.assign({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }, st[f.awayTeamId]);
      const h = f.result.home, a = f.result.away;
      H.p++; A.p++; H.gf += h; H.ga += a; A.gf += a; A.ga += h;
      if (h > a) { H.w++; A.l++; H.pts += 3; } else if (h < a) { A.w++; H.l++; A.pts += 3; } else { H.d++; A.d++; H.pts++; A.pts++; }
      st[f.homeTeamId] = H; st[f.awayTeamId] = A;
      t.update(tRef, { standings: st, updatedAt: c.ts() });
    }
    t.update(fRef, { status: 'completed', result: Object.assign({}, f.result, { status: finalStatus, confirmedBy: uid }),
      history: _hist(f.history, { event: 'result_' + finalStatus, by: uid, at: c.ts() }), updatedAt: c.ts() });
    return { f, finalStatus };
  });
  const parties = await _fixtureParties(db, out.f);
  for (const p of parties) {
    await _quiet(c.notify && (() => c.notify({ uid: p, type: 'sports_result_update', title: 'Result ' + out.finalStatus, body: 'A match result was ' + out.finalStatus + '.',
      dedupeKey: 'sports_result_' + fRef.id + '_' + out.finalStatus + '_' + p })));
  }
  return { ok: true, status: out.finalStatus };
}

/** A participating side (not the submitter) disputes a submitted result; the organiser resolves it with resultConfirm. */
async function resultDispute (db, uid, data, deps) {
  const c = _ctx(deps);
  const fRef = db.collection('sportsFixtures').doc(String(data.fixtureId));
  await db.runTransaction(async (t) => {
    const fS = await t.get(fRef); if (!fS.exists) fail('not-found', 'Fixture not found.');
    const f = fS.data();
    if (!f.result || f.result.status !== 'submitted') fail('failed-precondition', 'Only a submitted (unconfirmed) result can be disputed.');
    const [hS, aS] = await Promise.all([t.get(db.collection('teams').doc(f.homeTeamId)), t.get(db.collection('teams').doc(f.awayTeamId))]);
    const side = _isLeader(hS.data() || {}, uid) ? f.homeTeamId : _isLeader(aS.data() || {}, uid) ? f.awayTeamId : null;
    if (!side || side === f.result.submittedFor) fail('permission-denied', 'Only the other team can dispute this result.');
    t.update(fRef, { result: Object.assign({}, f.result, { status: 'disputed' }),
      history: _hist(f.history, { event: 'result_disputed', by: uid, reason: clean(data.reason, 300) || null, at: c.ts() }), updatedAt: c.ts() });
  });
  return { ok: true, status: 'disputed' };
}

/* ── MATCH REMINDERS ───────────────────────────────────────────────────────────── */
/* Reminders hang off THE fixture record. Every RUN_EVERY_MS the job finds fixtures whose start falls inside a reminder
   window and notifies the active members of both teams. The dedupeKey names fixture + window + person + startsAt, so a
   retry or an overlapping run never sends twice, while a RESCHEDULED match (new startsAt) is reminded again.
   Postponed / cancelled / completed fixtures are never reminded. */
const REMINDER_WINDOWS = Object.freeze([{ key: '24h', ms: 24 * 3600000 }, { key: '3h', ms: 3 * 3600000 }]);
const RUN_EVERY_MS = 15 * 60000;
async function remindFixtures (db, deps) {
  const c = _ctx(deps);
  const now = c.now().getTime();
  const out = { scanned: 0, sent: 0 };
  for (const w of REMINDER_WINDOWS) {
    /* fixtures starting in (now + w − RUN_EVERY, now + w] — one range field, so one index */
    const snap = await db.collection('sportsFixtures').where('startsAt', '>', now + w.ms - RUN_EVERY_MS).where('startsAt', '<=', now + w.ms).limit(500).get();
    for (const d of snap.docs || []) {
      const f = d.data() || {};
      if (!['scheduled', 'confirmed'].includes(f.status)) continue;
      out.scanned++;
      for (const uid of await _fixtureParties(db, f)) {
        await _quiet(c.notify && (async () => {
          await c.notify({ uid, type: 'sports_fixture_reminder', title: w.key === '24h' ? 'Match tomorrow' : 'Match in 3 hours',
            body: 'You have a match coming up.', dedupeKey: 'sports_remind_' + d.id + '_' + w.key + '_' + uid + '_' + f.startsAt });
          out.sent++;
        }));
      }
    }
  }
  return out;
}

/* ── dispatch ──────────────────────────────────────────────────────────────────── */
const OPS = {
  'team.register': (db, a, d, deps) => teamRegister(db, a.uid, d, deps),
  'team.submit': (db, a, d) => teamSubmit(db, a.uid, d.teamId),
  'team.invite': (db, a, d, deps) => teamInvite(db, a.uid, d, deps),
  'team.respond': (db, a, d, deps) => teamRespond(db, a.uid, d, deps),
  'team.remove': (db, a, d, deps) => teamRemove(db, a.uid, d, deps),
  'team.setManager': (db, a, d) => teamSetManager(db, a.uid, d),
  'tournament.create': (db, a, d, deps) => tournamentCreate(db, a.uid, d, deps),
  'tournament.submit': (db, a, d) => tournamentSubmit(db, a.uid, d.tournamentId),
  'tournament.transition': (db, a, d) => tournamentTransition(db, a.uid, d),
  'registration.apply': (db, a, d, deps) => registrationApply(db, a.uid, d, deps),
  'registration.decide': (db, a, d, deps) => registrationDecide(db, a.uid, d, deps),
  'registration.withdraw': (db, a, d, deps) => registrationWithdraw(db, a.uid, d, deps),
  'fixtures.publish': (db, a, d, deps) => fixturesPublish(db, a.uid, d, deps),
  'fixture.update': (db, a, d, deps) => fixtureUpdate(db, a.uid, d, deps),
  'result.submit': (db, a, d, deps) => resultSubmit(db, a.uid, d, deps),
  'result.confirm': (db, a, d, deps) => resultConfirm(db, a.uid, d, deps),
  'result.dispute': (db, a, d, deps) => resultDispute(db, a.uid, d, deps),
  'admin.teamDecide': (db, a, d, deps) => { if (!a.admin) fail('permission-denied', 'Admins only.'); return adminTeamDecide(db, a.uid, d, deps); },
  'admin.tournamentDecide': (db, a, d, deps) => { if (!a.admin) fail('permission-denied', 'Admins only.'); return adminTournamentDecide(db, a.uid, d, deps); },
};

async function dispatch (db, auth, data, deps) {
  if (!auth || !auth.uid) fail('unauthenticated', 'Sign in to use Sports.');
  const op = OPS[String((data || {}).op || '')];
  if (!op) fail('invalid-argument', 'Unknown Sports operation.');
  return op(db, auth, data || {}, deps);
}

let sportsDispatch, sportsFixtureReminders;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  sportsFixtureReminders = onSchedule({ schedule: 'every 15 minutes', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300 }, async () => {
    const admin = require('firebase-admin');
    const out = await remindFixtures(admin.firestore(), { notify: (m) => require('./notify').notify(m) });
    require('firebase-functions/logger').info('[sports] reminders', out);
  });
  sportsDispatch = onCall({ region: 'us-central1', maxInstances: 20, enforceAppCheck: true }, async (req) => {
    const admin = require('firebase-admin');
    const tk = (req.auth && req.auth.token) || {};
    const auth = req.auth ? { uid: req.auth.uid, admin: tk.admin === true || tk.superAdmin === true } : null;
    const db = admin.firestore();
    const deps = {
      serverTs: () => admin.firestore.FieldValue.serverTimestamp(),
      notify: (m) => require('./notify').notify(m),
      /* messaging helpers land on b2's line (messages.syncAnchoredParticipants / ensureAnchoredConversation); until then
         they are absent and these are no-ops — the conversation types do not exist yet either. */
      syncConv: (type, id) => { const m = require('./messages'); return typeof m.syncAnchoredParticipants === 'function' ? m.syncAnchoredParticipants(type, id) : null; },
      ensureConv: (type, id) => { const m = require('./messages'); return typeof m.ensureAnchoredConversation === 'function' ? m.ensureAnchoredConversation(type, id) : null; },
    };
    try {
      const r = await dispatch(db, auth, req.data || {}, deps);
      if (auth && auth.admin && String((req.data || {}).op || '').startsWith('admin.')) {
        await db.collection('adminAudit').add({ action: 'sports_' + req.data.op, by: auth.uid, target: req.data.teamId || req.data.tournamentId || null,
          decision: req.data.decision || null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      return r;
    } catch (e) {
      if (e instanceof SportsError) throw new HttpsError(e.code, e.message);
      require('firebase-functions/logger').error('[sports] op failed', { op: (req.data || {}).op, err: String(e && e.message || e).slice(0, 200) });
      throw new HttpsError('internal', 'That Sports action could not be completed. Nothing was changed.');
    }
  });
}

module.exports = { OPS, dispatch, roundRobin, SportsError, memberId, regId, sportsDispatch, sportsFixtureReminders, remindFixtures, REMINDER_WINDOWS,
  _internal: { teamRegister, adminTeamDecide, teamInvite, teamRespond, teamRemove, tournamentCreate, registrationApply, registrationDecide,
    fixturesPublish, fixtureUpdate, resultSubmit, resultConfirm, resultDispute } };
