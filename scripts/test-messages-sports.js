#!/usr/bin/env node
/* SPORTS — server-anchored conversations (sokoni-2f contract, b2 amendments + owner decisions 2026-10-03).
 * Executes the REAL messages.js helpers (ensureAnchoredConversation / syncAnchoredParticipants) and handlers
 * (createConversation / sendMessage) in-process. Participants are ALWAYS derived from teams / sportsTeamMembers /
 * tournaments / sportsTournamentRegs — never from a client. Each protection has a deliberate break on a NAMED row.
 *   node scripts/test-messages-sports.js        BASE=<ref> (pre-Sports must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';

if (process.argv[2] === '--child') {
  const FN = process.argv[3];
  const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
  const { call } = require('./lib/inmem-firestore');
  const { DOCS } = H;
  const MM = require(path.join(FN, 'messages.js')); const M = MM._h;
  ['cap1', 'mgr1', 'p1', 'p2', 'p3', 'org', 'cap2', 'out'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('teams/T1', { name: 'Lions', ownerUid: 'cap1', captainUid: 'cap1', managerUids: ['mgr1'], status: 'approved', rosterMax: 40 });
  DOCS.set('teams/T2', { name: 'Eagles', ownerUid: 'cap2', captainUid: 'cap2', managerUids: [], status: 'approved' });
  const mem = (team, uid, status) => DOCS.set('sportsTeamMembers/' + team + '_' + uid, { teamId: team, uid, role: 'player', status });
  mem('T1', 'p1', 'active'); mem('T1', 'p2', 'active'); mem('T1', 'p3', 'invited');
  DOCS.set('tournaments/TN', { name: 'Cup', organiserUid: 'org', status: 'registration_open' });
  DOCS.set('sportsTournamentRegs/TN_T1', { tournamentId: 'TN', teamId: 'T1', captainUid: 'cap1', status: 'registered' });
  DOCS.set('sportsTournamentRegs/TN_T2', { tournamentId: 'TN', teamId: 'T2', captainUid: 'cap2', status: 'pending' });
  const open = (uid, type, id, extra) => call(M.createConversation, uid, Object.assign({ transactionType: type, transactionId: id }, extra || {}));
  const send = (uid, convId) => call(M.sendMessage, uid, { conversationId: convId, type: 'text', text: 'hi' });
  const parts = (id) => ((DOCS.get('conversations/' + id) || {}).participants || []).slice().sort();
  (async () => {
    const out = {};
    const pre = await open('cap1', 'sports_team', 'T1');
    out.S1 = { code: pre.code || 'ok', det: pre.det && pre.det.code, created: DOCS.has('conversations/sports_team_T1') };
    const e1 = await MM.ensureAnchoredConversation('sports_team', 'T1');
    out.S2 = { ok: !!(e1 && e1.ok), parts: parts('sports_team_T1'), idx: DOCS.has('userConversations/p1/items/sports_team_T1') };
    mem('T1', 'p2', 'removed');
    const s3pre = await send('p2', 'sports_team_T1');                 /* BEFORE any sync: re-derived at send */
    const sy = await MM.syncAnchoredParticipants('sports_team', 'T1');
    out.S3 = { preSend: s3pre.code || 'ok', removed: sy && sy.removed, parts: parts('sports_team_T1'), idxGone: !DOCS.has('userConversations/p2/items/sports_team_T1') };
    mem('T1', 'p3', 'active');
    const sy2 = await MM.syncAnchoredParticipants('sports_team', 'T1');
    const s4 = await send('p3', 'sports_team_T1');
    out.S4 = { added: sy2 && sy2.added, send: s4.ok ? 'ok' : s4.code };
    await MM.ensureAnchoredConversation('sports_tournament', 'TN');
    const s5o = await send('org', 'sports_tournament_TN'), s5c = await send('cap1', 'sports_tournament_TN');
    out.S5 = { parts: parts('sports_tournament_TN'), org: s5o.ok ? 'ok' : s5o.code, cap: s5c.code || 'ok', capDet: s5c.det && s5c.det.code };
    await MM.ensureAnchoredConversation('sports_registration', 'TN_T1');
    const s6o = await open('cap2', 'sports_registration', 'TN_T1'), s6s = await send('cap2', 'sports_registration_TN_T1'), s6ok = await send('mgr1', 'sports_registration_TN_T1');
    out.S6 = { parts: parts('sports_registration_TN_T1'), open: s6o.code || 'ok', send: s6s.code || 'ok', ownSend: s6ok.ok ? 'ok' : s6ok.code };
    DOCS.set('teams/T1', Object.assign({}, DOCS.get('teams/T1'), { status: 'archived' }));
    const sy3 = await MM.syncAnchoredParticipants('sports_team', 'T1');
    const s7 = await send('cap1', 'sports_team_T1');
    out.S7 = { ro: sy3 && sy3.readOnly, status: (DOCS.get('conversations/sports_team_T1') || {}).status, send: s7.code || 'ok', history: DOCS.has('conversations/sports_team_T1') };
    const s8 = await open('out', 'sports_registration', 'TN_T1', { participantUids: ['out', 'org'] });
    out.S8 = { code: s8.code || 'ok', parts: parts('sports_registration_TN_T1') };
    console.log('RESULT_JSON ' + JSON.stringify(out));
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  return;
}

const evaluate = (FN) => { const o = cp.spawnSync(process.execPath, [__filename, '--child', FN], { env: Object.assign({}, process.env, { NODE_PATH: NM }), encoding: 'utf8' });
  const line = (o.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON ')); return line ? JSON.parse(line.slice(12)) : { crash: (o.stderr || o.stdout || '').slice(-600) }; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = (x) => ({
  'S1 a client cannot create an anchored conversation (server-only; nothing written)': !!x.S1 && x.S1.code === 'failed-precondition' && x.S1.det === 'ANCHORED_SERVER_ONLY' && !x.S1.created,
  'S2 team conversation participants = active members ∪ captain ∪ managers (invited excluded), indexed per user': !!x.S2 && x.S2.ok && eq(x.S2.parts, ['cap1', 'mgr1', 'p1', 'p2']) && x.S2.idx,
  'S3 a removed member is refused at send even before the sync; the sync drops them and their index': !!x.S3 && x.S3.preSend === 'permission-denied' && eq(x.S3.removed, ['p2']) && eq(x.S3.parts, ['cap1', 'mgr1', 'p1']) && x.S3.idxGone,
  'S4 a newly active member is added by the sync and can send': !!x.S4 && eq(x.S4.added, ['p3']) && x.S4.send === 'ok',
  'S5 tournament = announcements only: organiser sends; a registered captain reads but CANNOT reply (owner); pending teams excluded': !!x.S5 && eq(x.S5.parts, ['cap1', 'mgr1', 'org']) && x.S5.org === 'ok' && x.S5.cap === 'permission-denied' && x.S5.capDet === 'ANCHORED_ANNOUNCE_ONLY',
  'S6 a registration channel is private: another team\'s captain can neither open nor send; the team\'s own manager can': !!x.S6 && eq(x.S6.parts, ['cap1', 'mgr1', 'org']) && x.S6.open === 'permission-denied' && x.S6.send === 'permission-denied' && x.S6.ownSend === 'ok',
  'S7 an archived team turns its conversation read-only (history kept, sends refused)': !!x.S7 && x.S7.ro === true && x.S7.status === 'read_only' && x.S7.send === 'failed-precondition' && x.S7.history,
  'S8 a participant list in the request is ignored (an outsider stays out)': !!x.S8 && x.S8.code === 'permission-denied' && x.S8.parts.indexOf('out') < 0,
});
let pass = 0, fail = 0;
const ck = (id, ok, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nSports — server-anchored conversations   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')); cp.execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.split(path.sep).join('/') + '"', { cwd: ROOT, shell: 'bash' }); FN = path.join(d, 'functions'); }
const x = evaluate(FN);
if (x.crash) { console.log('CRASH (fail closed): ' + x.crash); process.exit(2); }
const R = rows(x);
for (const [k, v] of Object.entries(R)) ck(k, v, x);
if (Object.values(R).every(Boolean)) {
  console.log('\n  [mutations]');
  const MUT = [
    ['client may create anchored conversations', "if (!aSnap.exists) throw new HttpsError('failed-precondition', 'This conversation is created by SOKONI when the team or registration is approved.', { code: 'ANCHORED_SERVER_ONLY' });", '', ['S1']],
    ['send trusts the stored participant list (re-derivation AND sender check removed)', "      if (!d || d.participants.indexOf(req.auth.uid) === -1) throw new HttpsError('permission-denied', 'Not a party to this conversation');\n      if (d.readOnly) throw new HttpsError('failed-precondition', 'This conversation is read-only.', { code: 'ANCHORED_READ_ONLY' });\n      if (d.senders.indexOf(req.auth.uid) === -1) throw", "      if (d && d.readOnly) throw new HttpsError('failed-precondition', 'This conversation is read-only.', { code: 'ANCHORED_READ_ONLY' });\n      if (false) throw", ['S3']],
    ['captains may reply in the announcement channel', "senders: _uniq([td.organiserUid])", "senders: parts", ['S5']],
    ['registration channel includes every registered team', "    const parts = _uniq([td.organiserUid].concat(tc.crew));\n    return { participants: parts, senders: parts, readOnly: rd.status !== 'registered'", "    const allRegs = await db.collection('sportsTournamentRegs').where('tournamentId', '==', String(rd.tournamentId || '')).get(); let all = []; for (const r of allRegs.docs) { const c = await _teamCrew(db, (r.data() || {}).teamId); if (c) all = all.concat(c.crew); }\n    const parts = _uniq([td.organiserUid].concat(all));\n    return { participants: parts, senders: parts, readOnly: rd.status !== 'registered'", ['S6']],
    ['archive does not make it read-only', "readOnly: tc.team.status === 'archived', title: (tc.team.name || 'Team') + ' — team'", "readOnly: false, title: (tc.team.name || 'Team') + ' — team'", ['S7']],
  ];
  for (const [name, a, b, rws] of MUT) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-'));
    cp.execSync('cp -r "' + FN.split(path.sep).join('/') + '" "' + d.split(path.sep).join('/') + '/functions"', { shell: 'bash' });
    const f = path.join(d, 'functions', 'messages.js'); const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); fail++; continue; }
    fs.writeFileSync(f, s.replace(a, () => b));
    const y = evaluate(path.join(d, 'functions'));
    const yr = y.crash ? {} : rows(y);
    rws.forEach((rid) => { const k = Object.keys(R).find((z) => z.startsWith(rid + ' ')); const red = !y.crash && yr[k] === false;
      console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + rid + (y.crash ? ' (crash)' : '')); if (!red) fail++; });
  }
} else console.log('\n  [mutations] skipped — the contract does not hold on this tree.');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
