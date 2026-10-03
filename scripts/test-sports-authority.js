#!/usr/bin/env node
'use strict';
/* ============================================================================
   Sports server authority (functions/sports.js) — acceptance path + deliberate breaks (owner 2026-10-03)
   Team:        register → AdminOS approve → invite → accept → manager role → remove / leave
   Tournament:  create → submit → AdminOS approve → open → approved team registers → organiser approves →
                close → fixtures (one record each) → update → result → confirm → standings
   Every protection in the owner brief has a row that must FAIL closed.
   NODE_PATH=<functions/node_modules> node scripts/test-sports-authority.js
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

function fakeDb () {
  const docs = new Map(); let auto = 0;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => { const v = clone(docs.get(p)); return { id: p.split('/').pop(), exists: v !== undefined, data: () => v }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p), set: async (v) => docs.set(p, clone(v)), update: async (v) => docs.set(p, Object.assign({}, docs.get(p), clone(v))) });
  const q = (c, filters) => ({ _q: true, where: (f, op, v) => q(c, filters.concat([[f, v]])), limit: () => q(c, filters),
    get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2 && filters.every(([f, v]) => (docs.get(k) || {})[f] === v)).map(snap) }) });
  const coll = (c) => Object.assign({ doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))) }, q(c, []));
  return { _docs: docs, collection: coll,
    async runTransaction (fn) {
      const w = [];
      const t = { get: async (r) => (r._q ? r.get() : snap(r.path)),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, clone(v)); }),
        set: (r, v) => w.push(() => docs.set(r.path, clone(v))),
        update: (r, v) => w.push(() => docs.set(r.path, Object.assign({}, docs.get(r.path), clone(v)))) };
      const out = await fn(t); const before = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    } };
}
const S = require(path.join(FN, 'sports.js'));
const sent = [], synced = [], ensured = [];
let NOW = Date.parse('2026-11-01T10:00:00Z');
const deps = { now: () => new Date(NOW), notify: async (m) => { sent.push(m); }, syncConv: async (t, id) => { synced.push(t + ':' + id); }, ensureConv: async (t, id) => { ensured.push(t + ':' + id); } };
const db = fakeDb();
const A = (uid, admin) => ({ uid, admin: !!admin });
const call = async (auth, data) => { try { return { ok: true, r: await S.dispatch(db, auth, data, deps) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const refused = (x, code) => x.ok === false && (!code || x.code === code);

(async () => {
  /* ── TEAM ── */
  let x = await call(A('cap1'), { op: 'team.register', name: 'Kibera Lions', sport: 'Football', submit: false });
  const T1 = x.r.teamId;
  ck('T1 register → draft team owned by the caller; captain membership ACTIVE; sport normalised', x.ok && db._docs.get('teams/' + T1).status === 'draft'
    && db._docs.get('teams/' + T1).sport === 'football' && db._docs.get('sportsTeamMembers/' + T1 + '_cap1').status === 'active' && db._docs.get('sportsTeamMembers/' + T1 + '_cap1').role === 'captain');
  ck('T2a a stranger cannot submit someone else\'s team', refused(await call(A('mal'), { op: 'team.submit', teamId: T1 }), 'permission-denied'));
  await call(A('cap1'), { op: 'team.submit', teamId: T1 });
  ck('T2b the browser cannot approve its own team (admin op refused without the admin claim)', refused(await call(A('cap1'), { op: 'admin.teamDecide', teamId: T1, decision: 'approve' }), 'permission-denied')
    && db._docs.get('teams/' + T1).status === 'submitted');
  ck('T2c an unapproved team cannot invite players', refused(await call(A('cap1'), { op: 'team.invite', teamId: T1, playerUid: 'p1' }), 'failed-precondition'));
  x = await call(A('admin1', true), { op: 'admin.teamDecide', teamId: T1, decision: 'approve' });
  ck('T2d AdminOS approve → approved + verified; owner notified once (dedupeKey); team conversation created server-side',
    x.ok && db._docs.get('teams/' + T1).status === 'approved' && db._docs.get('teams/' + T1).verification === 'verified'
    && sent.some((m) => m.type === 'sports_team_decision' && m.dedupeKey === 'sports_team_decision_' + T1 + '_approved') && ensured.includes('sports_team:' + T1));
  ck('T2e a decided team cannot be decided again', refused(await call(A('admin1', true), { op: 'admin.teamDecide', teamId: T1, decision: 'reject' }), 'failed-precondition'));

  ck('T3a a stranger cannot edit another team\'s roster (invite refused)', refused(await call(A('mal'), { op: 'team.invite', teamId: T1, playerUid: 'p1' }), 'permission-denied'));
  x = await call(A('cap1'), { op: 'team.invite', teamId: T1, playerUid: 'p1' });
  ck('T3b captain invites → membership invited; player notified', x.ok && db._docs.get('sportsTeamMembers/' + T1 + '_p1').status === 'invited' && sent.some((m) => m.type === 'sports_team_invite' && m.uid === 'p1'));
  ck('T3c duplicate invitation refused (no duplicate membership)', refused(await call(A('cap1'), { op: 'team.invite', teamId: T1, playerUid: 'p1' }), 'already-exists'));
  ck('T4a a player cannot join without an invitation', refused(await call(A('p9'), { op: 'team.respond', teamId: T1, accept: true }), 'failed-precondition'));
  x = await call(A('p1'), { op: 'team.respond', teamId: T1, accept: true });
  ck('T4b invited player accepts → active; messaging participants re-derived', x.ok && db._docs.get('sportsTeamMembers/' + T1 + '_p1').status === 'active' && synced.includes('sports_team:' + T1));
  ck('T5a a non-leader cannot remove another player', refused(await call(A('p1'), { op: 'team.remove', teamId: T1, playerUid: 'cap1' }), 'permission-denied'));
  ck('T5b the captain cannot be removed', refused(await call(A('cap1'), { op: 'team.remove', teamId: T1, playerUid: 'cap1' }), 'failed-precondition'));
  ck('T6a only the captain grants the manager role (a player cannot make themselves manager)', refused(await call(A('p1'), { op: 'team.setManager', teamId: T1, playerUid: 'p1', manager: true }), 'permission-denied'));
  await call(A('cap1'), { op: 'team.setManager', teamId: T1, playerUid: 'p1', manager: true });
  x = await call(A('p1'), { op: 'team.invite', teamId: T1, playerUid: 'p2' });
  ck('T6b a team-granted manager can invite (team-scoped role, not platform-wide)', x.ok && db._docs.get('sportsTeamMembers/' + T1 + '_p2').status === 'invited');
  await call(A('p2'), { op: 'team.respond', teamId: T1, accept: true });
  x = await call(A('p2'), { op: 'team.remove', teamId: T1 });
  ck('T5c a player can leave (status left, history kept)', x.ok && db._docs.get('sportsTeamMembers/' + T1 + '_p2').status === 'left' && db._docs.get('sportsTeamMembers/' + T1 + '_p2').history.length === 3);
  /* roster cap */
  db._docs.set('teams/' + T1, Object.assign(db._docs.get('teams/' + T1), { rosterMax: 2 }));
  await call(A('cap1'), { op: 'team.invite', teamId: T1, playerUid: 'p3' });
  ck('T4c a full roster refuses a new acceptance', refused(await call(A('p3'), { op: 'team.respond', teamId: T1, accept: true }), 'resource-exhausted'));
  db._docs.set('teams/' + T1, Object.assign(db._docs.get('teams/' + T1), { rosterMax: 40 }));

  /* three more approved football teams + one basketball team, one unapproved */
  const mkTeam = async (cap, sport, approve) => {
    const r = (await call(A(cap), { op: 'team.register', name: 'Team ' + cap, sport, submit: true })).r;
    if (approve) await call(A('admin1', true), { op: 'admin.teamDecide', teamId: r.teamId, decision: 'approve' });
    return r.teamId;
  };
  const T2 = await mkTeam('cap2', 'football', true), T3 = await mkTeam('cap3', 'football', true), T4 = await mkTeam('cap4', 'football', true);
  const TB = await mkTeam('capB', 'basketball', true), TU = await mkTeam('capU', 'football', false);

  /* ── TOURNAMENT ── */
  const dates = { regOpensAt: '2026-11-01T00:00:00Z', regClosesAt: '2026-11-10T00:00:00Z', startsAt: '2026-11-15T00:00:00Z' };
  ck('TR1a dates out of order are refused', refused(await call(A('org1'), Object.assign({ op: 'tournament.create', name: 'Cup', sport: 'football', capacity: 8 }, dates, { regClosesAt: '2026-10-01T00:00:00Z' })), 'invalid-argument'));
  x = await call(A('org1'), Object.assign({ op: 'tournament.create', name: 'Nairobi Cup', sport: 'football', capacity: 4, entryFeeKES: 0 }, dates));
  const TR = x.r.tournamentId;
  ck('TR1b create → draft owned by the organiser', x.ok && db._docs.get('tournaments/' + TR).status === 'draft' && db._docs.get('tournaments/' + TR).organiserUid === 'org1');
  ck('TR2a the browser cannot set status=approved (admin op refused; transition from draft refused)',
    refused(await call(A('org1'), { op: 'admin.tournamentDecide', tournamentId: TR, decision: 'approve' }), 'permission-denied')
    && refused(await call(A('org1'), { op: 'tournament.transition', tournamentId: TR, to: 'registration_open' }), 'failed-precondition'));
  ck('TR2b only the organiser submits', refused(await call(A('mal'), { op: 'tournament.submit', tournamentId: TR }), 'permission-denied'));
  await call(A('org1'), { op: 'tournament.submit', tournamentId: TR });
  ck('TR2c registration on an unapproved tournament is refused', refused(await call(A('cap1'), { op: 'registration.apply', tournamentId: TR, teamId: T1 }), 'failed-precondition'));
  await call(A('admin1', true), { op: 'admin.tournamentDecide', tournamentId: TR, decision: 'approve' });
  ck('TR2d a stranger cannot open registration', refused(await call(A('mal'), { op: 'tournament.transition', tournamentId: TR, to: 'registration_open' }), 'permission-denied'));
  ck('TR2e approved cannot jump to fixtures_published / in_progress', refused(await call(A('org1'), { op: 'tournament.transition', tournamentId: TR, to: 'in_progress' }), 'failed-precondition'));
  await call(A('org1'), { op: 'tournament.transition', tournamentId: TR, to: 'registration_open' });

  ck('R1 an UNAPPROVED team cannot enter', refused(await call(A('capU'), { op: 'registration.apply', tournamentId: TR, teamId: TU }), 'failed-precondition'));
  ck('R2 wrong sport refused (basketball team → football cup)', refused(await call(A('capB'), { op: 'registration.apply', tournamentId: TR, teamId: TB }), 'failed-precondition'));
  ck('R3 a stranger cannot register someone else\'s team', refused(await call(A('mal'), { op: 'registration.apply', tournamentId: TR, teamId: T1 }), 'permission-denied'));
  x = await call(A('cap1'), { op: 'registration.apply', tournamentId: TR, teamId: T1 });
  ck('R4 approved team + open registration → pending; organiser notified', x.ok && x.r.status === 'pending' && sent.some((m) => m.type === 'sports_registration_update' && m.uid === 'org1'));
  ck('R5 duplicate registration refused', refused(await call(A('cap1'), { op: 'registration.apply', tournamentId: TR, teamId: T1 }), 'already-exists'));
  ck('R6 only the organiser decides a registration', refused(await call(A('cap1'), { op: 'registration.decide', registrationId: S.regId(TR, T1), approve: true }), 'permission-denied'));
  for (const [cap, tm] of [['cap2', T2], ['cap3', T3], ['cap4', T4]]) await call(A(cap), { op: 'registration.apply', tournamentId: TR, teamId: tm });
  for (const tm of [T1, T2, T3, T4]) await call(A('org1'), { op: 'registration.decide', registrationId: S.regId(TR, tm), approve: true });
  ck('R7 approved registrations → registered; tournament conversation participants synced; private registration channel ensured',
    [T1, T2, T3, T4].every((tm) => db._docs.get('sportsTournamentRegs/' + S.regId(TR, tm)).status === 'registered') && synced.includes('sports_tournament:' + TR) && ensured.includes('sports_registration:' + S.regId(TR, T1)));
  const T5 = await mkTeam('cap5', 'football', true);
  ck('R8 capacity: a fifth team into a 4-team cup is refused', refused(await call(A('cap5'), { op: 'registration.apply', tournamentId: TR, teamId: T5 }), 'resource-exhausted'));
  NOW = Date.parse('2026-11-11T00:00:00Z');
  ck('R9 registration after the deadline is refused', refused(await call(A('cap5'), { op: 'registration.apply', tournamentId: TR, teamId: T5 }), 'failed-precondition'));

  /* entry fee → fail closed */
  NOW = Date.parse('2026-11-02T00:00:00Z');
  const TRF = (await call(A('org2'), Object.assign({ op: 'tournament.create', name: 'Paid Cup', sport: 'football', capacity: 8, entryFeeKES: 2000 }, dates))).r.tournamentId;
  await call(A('org2'), { op: 'tournament.submit', tournamentId: TRF });
  await call(A('admin1', true), { op: 'admin.tournamentDecide', tournamentId: TRF, decision: 'approve' });
  await call(A('org2'), { op: 'tournament.transition', tournamentId: TRF, to: 'registration_open' });
  x = await call(A('cap5'), { op: 'registration.apply', tournamentId: TRF, teamId: T5 });
  ck('R10 entry fee > 0 → pending_payment, and it CANNOT be approved while the payment path is off', x.ok && x.r.status === 'pending_payment'
    && refused(await call(A('org2'), { op: 'registration.decide', registrationId: S.regId(TRF, T5), approve: true }), 'failed-precondition'));

  /* ── FIXTURES ── */
  ck('F1 fixtures cannot be published while registration is open', refused(await call(A('org1'), { op: 'fixtures.publish', tournamentId: TR }), 'failed-precondition'));
  await call(A('org1'), { op: 'tournament.transition', tournamentId: TR, to: 'registration_closed' });
  ck('F2 a fixture pairing an unregistered team is refused', refused(await call(A('org1'), { op: 'fixtures.publish', tournamentId: TR, fixtures: [{ round: 1, homeTeamId: T1, awayTeamId: T5 }] }), 'invalid-argument'));
  ck('F3 only the organiser publishes', refused(await call(A('cap1'), { op: 'fixtures.publish', tournamentId: TR }), 'permission-denied'));
  x = await call(A('org1'), { op: 'fixtures.publish', tournamentId: TR });
  const fx = Object.keys(Object.fromEntries(db._docs)).filter((k) => k.startsWith('sportsFixtures/' + TR + '_'));
  const pairs = new Set(fx.map((k) => { const f = db._docs.get(k); return [f.homeTeamId, f.awayTeamId].sort().join('|'); }));
  ck('F4 round robin: 4 teams → 6 fixtures, every pair exactly once, ONE record each; tournament fixtures_published; standings seeded',
    x.ok && fx.length === 6 && pairs.size === 6 && db._docs.get('tournaments/' + TR).status === 'fixtures_published' && Object.keys(db._docs.get('tournaments/' + TR).standings).length === 4);
  const F = fx.map((k) => k.split('/')[1]).find((id) => { const f = db._docs.get('sportsFixtures/' + id); return [f.homeTeamId, f.awayTeamId].includes(T1); });
  const f0 = db._docs.get('sportsFixtures/' + F);
  ck('F5 a captain cannot change a fixture', refused(await call(A('cap1'), { op: 'fixture.update', fixtureId: F, startsAt: '2026-11-16T15:00:00Z' }), 'permission-denied'));
  const before = sent.length;
  x = await call(A('org1'), { op: 'fixture.update', fixtureId: F, startsAt: '2026-11-16T15:00:00Z', venueId: 'venue_9' });
  ck('F6 organiser changes time/venue → history appended; every active member of BOTH teams notified (server-derived)',
    x.ok && db._docs.get('sportsFixtures/' + F).history.length === 2 && sent.slice(before).filter((m) => m.type === 'sports_fixture_update').length >= 3);

  /* ── RESULTS ── */
  const homeCap = { [T1]: 'cap1', [T2]: 'cap2', [T3]: 'cap3', [T4]: 'cap4' };
  const hc = homeCap[f0.homeTeamId], ac = homeCap[f0.awayTeamId];
  ck('X1 a stranger cannot submit a result', refused(await call(A('mal'), { op: 'result.submit', fixtureId: F, home: 2, away: 1 }), 'permission-denied'));
  await call(A(hc), { op: 'result.submit', fixtureId: F, home: 2, away: 1 });
  ck('X2 the submitting side cannot confirm its own report', refused(await call(A(hc), { op: 'result.confirm', fixtureId: F }), 'permission-denied'));
  x = await call(A(ac), { op: 'result.confirm', fixtureId: F });
  const st = db._docs.get('tournaments/' + TR).standings;
  ck('X3 the other side confirms → completed; standings: home W 3pts, away L; scores counted', x.ok && db._docs.get('sportsFixtures/' + F).status === 'completed'
    && st[f0.homeTeamId].pts === 3 && st[f0.homeTeamId].gf === 2 && st[f0.awayTeamId].l === 1 && st[f0.awayTeamId].pts === 0, st);
  ck('X4 a confirmed result is final — a second submit is refused (no silent rewrite)', refused(await call(A(ac), { op: 'result.submit', fixtureId: F, home: 0, away: 5 }), 'failed-precondition'));
  ck('X5 a duplicate confirm is refused; standings counted ONCE', refused(await call(A(ac), { op: 'result.confirm', fixtureId: F }), 'failed-precondition') && db._docs.get('tournaments/' + TR).standings[f0.homeTeamId].p === 1);
  /* dispute path */
  const G = fx.map((k) => k.split('/')[1]).find((id) => id !== F && db._docs.get('sportsFixtures/' + id).status === 'scheduled');
  const g0 = db._docs.get('sportsFixtures/' + G);
  await call(A(homeCap[g0.homeTeamId]), { op: 'result.submit', fixtureId: G, home: 1, away: 1 });
  ck('X6 only the OTHER side can dispute', refused(await call(A(homeCap[g0.homeTeamId]), { op: 'result.dispute', fixtureId: G }), 'permission-denied'));
  await call(A(homeCap[g0.awayTeamId]), { op: 'result.dispute', fixtureId: G, reason: 'score was 1-2' });
  ck('X7 a disputed result can be resolved only by the organiser', refused(await call(A(homeCap[g0.awayTeamId]), { op: 'result.confirm', fixtureId: G }), 'permission-denied'));
  await call(A('org1'), { op: 'result.submit', fixtureId: G, home: 1, away: 2 });
  x = await call(A('org1'), { op: 'result.confirm', fixtureId: G });
  ck('X8 organiser corrects + resolves → audit history keeps submit/dispute/correction/confirm; standings reflect 1-2',
    x.ok && db._docs.get('sportsFixtures/' + G).history.filter((h) => /^result_/.test(h.event)).length === 4 && db._docs.get('tournaments/' + TR).standings[g0.awayTeamId].pts === 3);

  /* ── AdminOS queue ── */
  await call(A('capQ'), { op: 'team.register', name: 'Queue FC', sport: 'football', submit: true });
  const q = await call(A('admin1', true), { op: 'admin.queue' });
  ck('Q1 admin.queue lists submitted teams (projection, no contact fields); a non-admin is refused',
    q.ok && q.r.teams.some((t) => t.name === 'Queue FC' && t.status === 'submitted') && q.r.teams.every((t) => !('phone' in t) && !('email' in t))
    && refused(await call(A('capQ'), { op: 'admin.queue' }), 'permission-denied'));

  /* ── dispatch guard + pure helper ── */
  ck('D1 unauthenticated / unknown op refused', refused(await call(null, { op: 'team.register', name: 'X', sport: 'f' }), 'unauthenticated') && refused(await call(A('u'), { op: 'team.delete' }), 'invalid-argument'));
  const rr = S.roundRobin(['a', 'b', 'c']);
  ck('D2 roundRobin with an odd count: 3 teams → 3 matches, every pair once, no bye fixtures', rr.length === 3 && new Set(rr.map((p) => [p.home, p.away].sort().join())).size === 3);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
