#!/usr/bin/env node
/* EDUCATION E1 (2026-10-03) — the body Sign Out is gone, paid enrolment is OFF until IntaSend (owner decision), and
 * the create-course toast tells the truth.
 *   node scripts/test-education-e1.js        BASE=72dca56 node scripts/test-education-e1.js (must FAIL)
 * EXECUTES the real sokoni-education.js in a vm against a minimal DOM + firebase stub: drives onAuthStateChanged for a
 * signed-in user and renders a paid and a free course. Part B checks education.html's markup. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\neducation E1   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const HTML = read('education.html');
const els = {};
const mkEl = (id) => {
  const cls = new Set(); const e = { id, textContent: '', innerHTML: '', className: '', disabled: false, onclick: null, href: '', style: {}, value: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)) },
    addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} };
  return e;
};
/* only ids that exist in the page's markup resolve, exactly like the browser */
const idsInPage = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const document = {
  getElementById: (id) => (idsInPage.has(id) ? (els[id] = els[id] || mkEl(id)) : null),
  createElement: () => mkEl('_'), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], body: mkEl('body'),
};
let authCb = null; const signOutCalls = [];
const calls = [];
const firebase = {
  auth: () => ({ onAuthStateChanged: (cb) => { authCb = cb; }, signOut: () => { signOutCalls.push(1); return Promise.resolve(); }, currentUser: null }),
  app: () => ({ functions: () => ({ httpsCallable: (n) => async (d) => { calls.push(n); return { data: n === 'listCourses' ? { courses: [], hasMore: false } : n === 'getMyEnrollments' ? { enrollments: [] } : {} }; } }) }),
  functions: () => ({ httpsCallable: (n) => async (d) => { calls.push(n); return { data: n === 'listCourses' ? { courses: [], hasMore: false } : { enrollments: [] } }; } }),
};
const window = { location: { href: '' }, firebase, setTimeout, clearTimeout };
const ctx = vm.createContext({ window, document, firebase, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise, URL, Intl, Date, Math, JSON, Number, String, Array, Object, Set, Map, encodeURIComponent, navigator: {}, location: window.location, localStorage: { getItem: () => null, setItem() {} } });
let SE = null;
try { vm.runInContext(read('sokoni-education.js'), ctx, { filename: 'sokoni-education.js' }); SE = window.SokoniEducation; } catch (e) { console.log('  LOAD ERROR ' + e.message); }

(async () => {
  try { SE.init(); } catch (e) { /* init touches more DOM than this stub models; auth wiring is what we drive */ }
  ck('A-0', typeof authCb === 'function', 'CONTROL: the page subscribes to auth state (the stub is actually driving the real code)');
  if (authCb) authCb({ uid: 'learner1', displayName: 'L' });
  const body = Object.values(els).filter((e) => /sign\s*out/i.test(String(e.textContent)));
  ck('A-1', body.length === 0, 'signed in: NO body element reads "Sign Out" (the shared header owns sign-out)', body.map((e) => e.id));
  ck('A-2', !idsInPage.has('eduAuthAction'), 'education.html no longer carries the #eduAuthAction body link');
  ck('A-3', els.eduMyLearningBtn && !els.eduMyLearningBtn.classList.contains('hidden'), 'CONTROL: signed-in state still shows My Learning');
  /* any onclick wired by auth must not sign out */
  for (const e of Object.values(els)) if (typeof e.onclick === 'function') { try { e.onclick({ preventDefault() {} }); } catch (_) {} }
  ck('A-4', signOutCalls.length === 0, 'no body control calls firebase.auth().signOut() (it skipped the storage wipe and navigated mid-sign-out)', signOutCalls.length);
  ck('A-5', /shared-header\.js/.test(HTML), 'CONTROL: the shared header (canonical account-menu Sign Out + sw-register) is still loaded');

  /* B: paid enrolment is off; free enrolment is unchanged */
  const paid = { courseId: 'c1', title: 'Paid', price: 1500, lessonCount: 2, level: 'beginner', status: 'published' };
  try { SE.renderCourseDetail(paid, false, []); } catch (e) { console.log('  render error ' + e.message); }
  const b = els.eduEnrollBtn || {};
  ck('B-1', b.disabled === true && b.onclick == null, 'a PAID course cannot be enrolled from the page (button disabled, no handler)', { d: b.disabled, t: b.textContent });
  ck('B-2', /coming soon/i.test(b.textContent) && /1,?500/.test(b.textContent), 'it says paid enrolment is coming soon and still shows the price', b.textContent);
  try { SE.renderCourseDetail(Object.assign({}, paid, { courseId: 'c2', price: 0 }), false, []); } catch (_) {}
  ck('B-3', b.disabled === false && typeof b.onclick === 'function' && /free/i.test(b.textContent), 'CONTROL: a FREE course still enrols', b.textContent);

  /* C: honest create toast */
  const JS = read('sokoni-education.js');
  ck('C-1', !/submitted for review/.test(JS) && /saved as a draft/.test(JS), 'creating a course says "saved as a draft" (it IS a draft; nothing submits it for review yet)');
  ck('C-2', !/top up your wallet/i.test(JS), 'nothing tells a learner to top up the wallet to pay for a course (the wallet path is being retired)');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
