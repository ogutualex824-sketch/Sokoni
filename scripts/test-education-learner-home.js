#!/usr/bin/env node
/* EDUCATION E2 — the learner dashboard (owner brief 2026-10-03).
 *   node scripts/test-education-learner-home.js        BASE=e2080d1 node scripts/test-education-learner-home.js (must FAIL)
 * EXECUTES the real sokoni-education.js in a vm against stub educationWorkspace answers: every tile state, workspace link
 * and teaching tool comes from the server answer; nothing is inferred; "—" when the server does not answer. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\neducation learner dashboard   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const HTML = read('education.html');
const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const els = {};
const mk = (id) => { const cls = new Set(); return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, onclick: null, appendChild() {}, remove() {}, querySelector: () => null, focus() {}, scrollIntoView() {},
  classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle() {} }, setAttribute() {}, addEventListener() {} }; };
const document = { getElementById: (id) => (ids.has(id) ? (els[id] = els[id] || mk(id)) : null), querySelectorAll: () => [], querySelector: () => null, createElement: () => mk('_'), addEventListener() {}, body: mk('body') };
let reply = null; let authCb = null;
const firebase = { auth: () => ({ onAuthStateChanged: (cb) => { authCb = cb; } }), functions: () => ({ httpsCallable: (n) => async (d) => (typeof reply === 'function' ? reply(n, d) : { data: {} }) }) };
const window = { location: { href: '' } };
const ctx = vm.createContext({ window, document, firebase, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise, URL, Intl, Date, Math, JSON, Number, String, Array, Object, Set, Map, encodeURIComponent, navigator: {}, location: window.location, localStorage: { getItem: () => null, setItem() {} } });
let SE = null; try { vm.runInContext(read('sokoni-education.js'), ctx); SE = window.SokoniEducation; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const has = SE && typeof SE.renderLearnerHome === 'function';
const L = (mods) => Object.fromEntries(Object.entries(mods));
const WS = (o) => Object.assign({ learner: { access: { ageStatus: 'unverified', interactive: false }, modules: L({ myLearning: { state: 'AVAILABLE' }, discover: { state: 'AVAILABLE' }, courses: { state: 'AVAILABLE' }, profile: { state: 'AVAILABLE' },
  liveClasses: { state: 'LOCKED', reason: 'AGE_OR_GUARDIAN_REQUIRED' }, tutoring: { state: 'LOCKED' }, messages: { state: 'LOCKED' }, bookings: { state: 'NOT_IMPLEMENTED' }, certificates: { state: 'NOT_IMPLEMENTED' },
  receipts: { state: 'NOT_IMPLEMENTED' }, settings: { state: 'NOT_IMPLEMENTED' } }) }, dashboards: [{ actor: 'learner', state: 'AVAILABLE' }], applications: [] }, o || {});

(async () => {
  try { SE.init(); } catch (_) {}
  ck('H-0', ids.has('learn') && ids.has('eduLearnerHome') && has, 'education.html carries the learner dashboard (#learn) rendered by SokoniEducation');
  if (has) {
    const sec = els.learn || document.getElementById('learn');
    reply = (n) => (n === 'educationWorkspace' ? { data: WS() } : { data: {} });
    if (authCb) authCb({ uid: 'kid' });
    await new Promise((r) => setTimeout(r, 5));
    let H = (els.eduLearnerHome || {}).innerHTML || '';
    ck('H-1', !sec.classList.contains('hidden') && /Free self-paced courses/.test(H), 'signed in: the dashboard shows the SERVER\'s access state', H.slice(0, 160));
    ck('H-2', /data-state="LOCKED" data-module="liveClasses"[^>]*disabled/.test(H) && /Needs an age check or a guardian link/.test(H), 'live classes are LOCKED and disabled for an unverified learner (the server said so)');
    ck('H-3', /data-state="NOT_IMPLEMENTED" data-module="certificates"[^>]*disabled/.test(H) && /Coming soon/.test(H), 'unbuilt modules say "Coming soon" and do nothing — never shown as working');
    ck('H-4', /data-state="AVAILABLE" data-module="myLearning"[^>]*onclick/.test(H), 'available modules open');
    const tb = els.eduTeachBtn || {};
    ck('H-5', /Apply to teach/.test(tb.textContent || '') && !tb.classList.contains('hidden'), 'a learner WITHOUT an approved teacher workspace is offered the APPLICATION, not the course editor', tb.textContent);

    reply = (n) => (n === 'educationWorkspace' ? { data: WS({ learner: { access: { ageStatus: 'verified_adult', interactive: true }, modules: { liveClasses: { state: 'NOT_IMPLEMENTED' } } },
      dashboards: [{ actor: 'learner', state: 'AVAILABLE' }, { actor: 'teacher', state: 'AVAILABLE', route: 'provider-dashboard.html' }, { actor: 'enterprise', state: 'NOT_IMPLEMENTED', route: null }],
      applications: [{ id: 'A1', category: 'school', status: 'pending', missing: ['Registration <b>number</b>'] }] }) } : { data: {} });
    await SE.loadLearnerHome();
    H = els.eduLearnerHome.innerHTML;
    ck('H-6', /href="provider-dashboard\.html">Teacher workspace/.test(H), 'an APPROVED teacher (server dashboards list) gets the link to their workspace');
    ck('H-7', /Company training: being built/.test(H) && !/href="[^"]*enterprise/.test(H), 'the enterprise dashboard is named as being built, never linked to a provider shell');
    ck('H-8', /Institution application<\/strong> · pending/.test(H) && /SOKONI needs: Registration &lt;b&gt;number/.test(H) && /complete-application\.html/.test(H), 'the applicant sees their application status, what is missing (escaped) and where to track it');
    ck('H-9', /Teach on SOKONI/.test(els.eduTeachBtn.textContent), 'an approved teacher gets the teaching tool');

    reply = () => { throw new Error('down'); };
    await SE.loadLearnerHome();
    H = els.eduLearnerHome.innerHTML;
    ck('H-10', /\(—\)/.test(H) && !/Free self-paced|Age verified|workspace/i.test(H.replace(/dashboard is unavailable/, '')) && els.eduTeachBtn.classList.contains('hidden'),
      'server unavailable: "—", no access level, no workspace link and NO teaching tool inferred', H);
    authCb && authCb(null);
    ck('H-11', sec.classList.contains('hidden'), 'signed out: the dashboard is hidden');
  } else {
    for (let i = 1; i <= 11; i++) ck('H-' + i, false, 'learner dashboard present');
  }
  const JS = read('sokoni-education.js');
  ck('H-12', !/teachBtn\)\s+teachBtn\.classList\.remove\('hidden'\);/.test(JS.slice(JS.indexOf('function _watchAuth'), JS.indexOf('function _watchAuth') + 1500)), 'sign-in alone no longer reveals the Teach button (it waits for the server answer)');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
