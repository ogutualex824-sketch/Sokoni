#!/usr/bin/env node
/* EDUCATION E2 — the learner dashboard shell (education-learn.html + sokoni-education-learn.js).
 *   node scripts/test-education-learn-shell.js        BASE=421bd21 node scripts/test-education-learn-shell.js (must FAIL)
 * Owner: "like merchant-v2.html with the side bar … yes lener dash also". EXECUTES the module in a vm against stub server
 * answers: the sidebar is the server's learner modules (LOCKED / Soon never open), the overview carries access,
 * workspaces and applications from the server, the profile view is SokoniEducation's ONE form, unknown renders "—". */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\neducation learner shell   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HTML = read('education-learn.html');
ck('F-1', /<aside class="side" id="entSide"/.test(HTML) && /id="entMenu"/.test(HTML) && /grid-template-columns:var\(--rail-w\) minmax\(0,1fr\)/.test(HTML), 'merchant-v2 frame: sidebar drawer/rail + header menu');
ck('F-2', /<script src="\/sw-register\.js" defer><\/script>/.test(HTML), 'self-updates (sw-register.js)');
ck('F-3', /<script src="sokoni-education\.js" defer><\/script>/.test(HTML), 'loads SokoniEducation — the ONE profile / guardian / employer-training form (no second copy)');

const SRC = read('sokoni-education-learn.js');
const els = {}; ['entNav', 'entRoot', 'entTitle', 'entCoName', 'entSub', 'entSide', 'entScrim', 'entMenu'].forEach((i) => { els[i] = { id: i, innerHTML: '', textContent: '', classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {} }; });
const document = { getElementById: (i) => els[i] || null, body: { addEventListener: (t, h) => { els._click = h; } } };
let reply = null, authCb = null, profileLoads = 0;
const G = { location: { hash: '', href: '' }, history: { replaceState() {} },
  SokoniEducation: { loadLearnerProfile: () => { profileLoads++; } },
  firebase: { auth: () => ({ onAuthStateChanged: (cb) => { authCb = cb; } }), functions: () => ({ httpsCallable: (n) => async (d) => ({ data: await reply(n, d) }) }) } };
let M = null; try { vm.runInNewContext(SRC, { window: G, document, Object, String, Number, Promise, JSON, Math, Array }); M = G.SokoniEducationLearn; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const tick = () => new Promise((r) => setTimeout(r, 5));
const WS = { learner: { access: { ageStatus: 'unverified', interactive: false }, modules: { myLearning: { state: 'AVAILABLE' }, discover: { state: 'AVAILABLE' }, courses: { state: 'AVAILABLE' }, profile: { state: 'AVAILABLE' },
  liveClasses: { state: 'LOCKED' }, tutoring: { state: 'LOCKED' }, messages: { state: 'LOCKED' }, bookings: { state: 'NOT_IMPLEMENTED' }, certificates: { state: 'NOT_IMPLEMENTED' }, receipts: { state: 'NOT_IMPLEMENTED' }, settings: { state: 'NOT_IMPLEMENTED' } } },
  dashboards: [{ actor: 'learner', state: 'AVAILABLE' }, { actor: 'teacher', state: 'AVAILABLE', route: 'provider-dashboard.html' }],
  applications: [{ id: 'A1', category: 'school', status: 'pending', missing: ['Registration <b>number</b>'] }] };
(async () => {
  if (!M) { for (let i = 1; i <= 9; i++) ck('L-' + i, false, 'module present'); }
  else {
    M.init();
    reply = (n) => (n === 'educationWorkspace' ? WS : n === 'getMyEnrollments' ? { enrollments: [{ progress: 40, course: { title: '<i>Algebra</i>', lessonCount: 5 } }] } : {});
    authCb({ uid: 'kid' }); await tick(); await tick();
    const N = els.entNav.innerHTML;
    ck('L-1', /data-ln-nav="liveClasses" aria-disabled="true"[^>]*>[\s\S]*?🔒/.test(N) && /data-ln-nav="certificates" aria-disabled="true"[\s\S]*?Soon/.test(N) && /data-ln-nav="myLearning"(?! aria-disabled)/.test(N),
      'the sidebar is the SERVER\'s learner modules: LOCKED shows 🔒, unbuilt shows Soon, available opens');
    ck('L-2', /class="side-group">Learn/.test(N) && /class="side-group">You/.test(N), 'grouped like merchant-v2');
    ck('L-3', /Free self-paced courses/.test(els.entRoot.innerHTML) && els.entSub.textContent === 'Self-paced access', 'overview + sidebar subtitle state the SERVER\'s access');
    M.go('liveClasses');
    ck('L-4', /needs an age check or a guardian link/.test(els.entRoot.innerHTML) && !/data-ln-/.test(els.entRoot.innerHTML.replace(/data-ln-nav/g, '')), 'a LOCKED module explains why and opens nothing');
    M.go('myLearning');
    ck('L-5', /&lt;i&gt;Algebra/.test(els.entRoot.innerHTML) && /40% complete/.test(els.entRoot.innerHTML), 'My learning lists the server\'s enrolments (escaped)');
    M.go('overview');
    const O = els.entRoot.innerHTML;
    ck('L-6', /href="provider-dashboard\.html">Teacher workspace/.test(O) && /SOKONI needs: Registration &lt;b&gt;number/.test(O) && /complete-application\.html/.test(O), 'overview: approved workspace link + application status / missing documents (escaped) + tracking');
    M.go('profile');
    ck('L-7', /id="eduLearnerProfile"/.test(els.entRoot.innerHTML) && profileLoads === 1, 'Profile mounts SokoniEducation\'s ONE learner profile form');
    G.location.href = ''; M.go('discover');
    ck('L-8', G.location.href === 'education.html', 'Discover leaves for the catalogue (an exit, like merchant-v2)');
    reply = () => { throw new Error('down'); };
    await M._load();
    ck('L-9', /unavailable right now \(—\)/.test(els.entRoot.innerHTML) && els.entNav.innerHTML === '' && els.entSub.textContent === '—', 'server unavailable: "—", no sidebar, nothing inferred');
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
