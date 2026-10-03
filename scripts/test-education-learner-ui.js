#!/usr/bin/env node
/* EDUCATION — learner profile UI (owner decisions 2026-10-03).
 *   node scripts/test-education-learner-ui.js        BASE=131c1eb node scripts/test-education-learner-ui.js (must FAIL)
 * EXECUTES the real sokoni-education.js in a vm with a stub callable layer: what the page shows comes from the
 * educationLearner response; the page never sends age / guardian / status; unknown renders "—"; output is escaped. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\neducation learner UI   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HTML = read('education.html');
const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const els = {};
const mk = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, appendChild() {}, remove() {}, querySelector: () => null, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, setAttribute() {}, addEventListener() {} });
const document = { getElementById: (id) => (ids.has(id) || els[id] ? (els[id] = els[id] || mk(id)) : null), querySelectorAll: () => [], querySelector: () => null, createElement: () => mk('_'), addEventListener() {}, body: mk('body') };
const sent = []; let reply = null;
const firebase = { auth: () => ({ onAuthStateChanged: (cb) => cb({ uid: 'kid' }) }), functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); if (typeof reply === 'function') return reply(n, d); return { data: {} }; } }) };
const window = { location: { href: '' } };
const ctx = vm.createContext({ window, document, firebase, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise, URL, Intl, Date, Math, JSON, Number, String, Array, Object, Set, Map, encodeURIComponent, navigator: {}, location: window.location, localStorage: { getItem: () => null, setItem() {} } });
let SE = null; try { vm.runInContext(read('sokoni-education.js'), ctx); SE = window.SokoniEducation; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const has = (k) => SE && typeof SE[k] === 'function';

(async () => {
  try { SE.init(); } catch (_) {}
  ck('U-0', ids.has('eduLearnerProfile') && has('loadLearnerProfile'), 'the My Learning panel carries the learner profile section');
  if (has('loadLearnerProfile')) {
    els.eduLearnerProfile = els.eduLearnerProfile || mk('eduLearnerProfile'); els.eduGuardedList = mk('eduGuardedList');  /* rendered inside the panel at runtime */
    reply = (n, d) => (d.op === 'load' ? { data: { ok: true, profile: { displayName: '<img src=x onerror=alert(1)>', interests: ['music'] }, access: { ageStatus: 'unverified', interactive: false, selfPacedFree: true } } }
      : d.op === 'guardianOf' ? { data: { ok: true, learners: [{ learnerUid: "x'),alert(1)//", displayName: '<b>Kid</b>' }] } } : { data: { ok: true } });
    await SE.loadLearnerProfile(); await new Promise((r) => setTimeout(r, 0));
    const H = els.eduLearnerProfile.innerHTML;
    ck('U-1', /Free self-paced courses/.test(H) && /Verify my age/.test(H) && /Get a guardian code/.test(H), 'an UNVERIFIED learner (server says so) sees free self-paced only + the age check + the guardian code', H.slice(0, 200));
    ck('U-2', !/<img src=x/.test(H) && /&lt;img/.test(H), 'the learner\'s own text is escaped (no markup injection into the panel)');
    const G = (els.eduGuardedList || {}).innerHTML || '';
    ck('U-3', !/<b>Kid<\/b>/.test(G) && /data-learner-uid="x&#39;\),alert\(1\)\/\/"/.test(G) && /revokeGuardian\(this\.dataset\.learnerUid\)/.test(G), 'the guardian list escapes names and passes the uid through a data attribute (never spliced into script)', G);

    reply = (n, d) => (d.op === 'load' ? { data: { ok: true, profile: null, access: { ageStatus: 'verified_adult', interactive: true } } } : { data: { ok: true, learners: [] } });
    await SE.loadLearnerProfile();
    const H2 = els.eduLearnerProfile.innerHTML;
    ck('U-4', /Age verified/.test(H2) && !/Get a guardian code/.test(H2), 'a server-verified adult is told so and is not offered a guardian code');

    reply = () => { throw new Error('unavailable'); };
    await SE.loadLearnerProfile();
    ck('U-5', /\(—\)/.test(els.eduLearnerProfile.innerHTML) && !/Free self-paced|Age verified|Guardian linked/.test(els.eduLearnerProfile.innerHTML), 'when the server cannot answer, access is shown as unknown (—), never guessed');

    sent.length = 0; reply = () => ({ data: { ok: true } });
    ['eduLpName', 'eduLpLevel', 'eduLpSubjects', 'eduLpLang', 'eduLpLoc', 'eduLpGoals', 'eduLpSave'].forEach((i) => { els[i] = els[i] || mk(i); });
    els.eduLpName.value = 'Wanjiru'; els.eduLpSubjects.value = 'Maths, Physics';
    await SE.saveLearnerProfile();
    const save = sent.find(([n, d]) => n === 'educationLearner' && d.op === 'save');
    const keys = save ? Object.keys(save[1].profile) : [];
    ck('U-6', !!save && keys.every((k) => ['displayName', 'photoUrl', 'interests', 'subjects', 'level', 'formats', 'language', 'location', 'goals'].includes(k)) && save[1].profile.subjects.join() === 'Maths,Physics',
      'save sends ONLY profile fields — never age, guardian, status or role', keys);
    sent.length = 0; els.eduAgeDob = mk('eduAgeDob'); els.eduAgeId = mk('eduAgeId'); els.eduAgeDob.value = '2000-01-01'; els.eduAgeId.value = '12345678';
    await SE.verifyLearnerAge();
    ck('U-7', sent.some(([n]) => n === 'ageVerifySubmit') && !sent.some(([n, d]) => n === 'educationLearner' && d.op === 'save'), 'the age check goes to the platform\'s ONE age authority (ageVerifySubmit), not to the profile');
  } else {
    ['U-1', 'U-2', 'U-3', 'U-4', 'U-5', 'U-6', 'U-7'].forEach((id) => ck(id, false, 'learner profile UI present'));
  }
  ck('U-8', /shared-header\.js/.test(HTML), 'CONTROL: the page still self-updates (shared-header → sw-register)');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
