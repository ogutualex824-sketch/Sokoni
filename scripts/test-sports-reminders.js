#!/usr/bin/env node
'use strict';
/* Sports match reminders (functions/sports.js remindFixtures) — owner brief point 7
     M1  a fixture 24h away → every ACTIVE member of both teams gets the 24h reminder (invited / removed do not)
     M2  a fixture 3h away → the 3h reminder
     M3  postponed / cancelled / completed fixtures are never reminded
     M4  overlapping runs / retries: the dedupeKey is identical (fixture + window + person + startsAt) → notify dedupes
     M5  a RESCHEDULED fixture (new startsAt) gets a NEW key → reminded again
     M6  a notify failure never breaks the run
   node scripts/test-sports-reminders.js */
const path = require('path');
const S = require(path.join(path.resolve(__dirname, '..'), 'functions', 'sports.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
const OPS = { '==': (a, b) => a === b, '>': (a, b) => a > b, '<=': (a, b) => a <= b };
function fakeDb (seed) {
  const docs = new Map(Object.entries(seed));
  const q = (c, fl) => ({ where: (f, op, v) => q(c, fl.concat([[f, op, v]])), limit: () => q(c, fl),
    get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(c + '/') && fl.every(([f, op, v]) => OPS[op]((docs.get(k) || {})[f], v))).map((k) => ({ id: k.split('/')[1], data: () => docs.get(k) })) }) });
  return { _docs: docs, collection: (c) => q(c, []) };
}
const NOW = Date.parse('2026-11-14T10:00:00Z'), H = 3600000;
const members = {
  'sportsTeamMembers/A_a1': { teamId: 'A', uid: 'a1', status: 'active' }, 'sportsTeamMembers/A_a2': { teamId: 'A', uid: 'a2', status: 'invited' },
  'sportsTeamMembers/B_b1': { teamId: 'B', uid: 'b1', status: 'active' }, 'sportsTeamMembers/B_b2': { teamId: 'B', uid: 'b2', status: 'removed' },
};
const fx = (id, startsAt, status) => ({ ['sportsFixtures/' + id]: { homeTeamId: 'A', awayTeamId: 'B', startsAt, status: status || 'scheduled' } });

(async () => {
  let sent = [];
  const deps = (extra) => Object.assign({ now: () => new Date(NOW), notify: async (m) => { sent.push(m); } }, extra || {});
  let db = fakeDb(Object.assign({}, members, fx('F24', NOW + 24 * H - 5 * 60000), fx('F3', NOW + 3 * H - 60000), fx('FP', NOW + 24 * H - 60000, 'postponed'),
    fx('FC', NOW + 3 * H - 60000, 'cancelled'), fx('FD', NOW + 3 * H - 60000, 'completed'), fx('FFAR', NOW + 48 * H)));
  await S.remindFixtures(db, deps());
  const to = (fid, w) => sent.filter((m) => m.dedupeKey.startsWith('sports_remind_' + fid + '_' + w + '_')).map((m) => m.uid).sort();
  ck('M1 24h reminder → active members of both teams only (not invited / removed)', JSON.stringify(to('F24', '24h')) === JSON.stringify(['a1', 'b1']), to('F24', '24h'));
  ck('M2 3h reminder sent for the 3h fixture', JSON.stringify(to('F3', '3h')) === JSON.stringify(['a1', 'b1']));
  ck('M3 postponed / cancelled / completed / far-future fixtures are not reminded', !sent.some((m) => /_(FP|FC|FD|FFAR)_/.test(m.dedupeKey)));
  const keys1 = sent.map((m) => m.dedupeKey).sort();
  sent = []; await S.remindFixtures(db, deps());
  ck('M4 an overlapping run produces the SAME dedupeKeys (notify dedupes on them)', JSON.stringify(sent.map((m) => m.dedupeKey).sort()) === JSON.stringify(keys1));
  db._docs.set('sportsFixtures/F24', Object.assign({}, db._docs.get('sportsFixtures/F24'), { startsAt: NOW + 24 * H - 2 * 60000 }));
  sent = []; await S.remindFixtures(db, deps());
  ck('M5 a rescheduled fixture gets a NEW key → reminded again', sent.some((m) => m.dedupeKey.startsWith('sports_remind_F24_24h_') && !keys1.includes(m.dedupeKey)));
  let r; try { r = await S.remindFixtures(db, deps({ notify: async () => { throw new Error('down'); } })); } catch (e) { r = { crashed: e.message }; }
  ck('M6 a notify failure never breaks the run', r && !r.crashed && r.scanned >= 2, r);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
